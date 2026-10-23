import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { ConversationMember, ConversationMessage } from '../conversations.js';
import type {
  ContactNote, ConversationRead, ConversationReadResult, ConversationSearch, ConversationSearchResult,
  ConversationSummary, HistoryExcerpt, MemorySource, SetContactNote,
} from '../memory.js';
import { estimateContextTokens } from '../../agent-context/index.js';
import { ConversationStore, isMember, memberKey } from './conversations.js';
import { contactNoteSchema, conversationSummarySchema, readSchema, searchSchema, setContactNoteSchema } from './memory-schema.js';
import { RuntimeFault } from './limits.js';

export type MemoryIdentity = { ownerId: string; member: ConversationMember };

/** 摘要、备注和检索共享原文事实源；读取不会触碰邮箱和处理游标。 */
export class ConversationMemoryStore {
  readonly db: DatabaseSync;
  constructor(location: string, readonly conversations: ConversationStore) {
    this.db = new DatabaseSync(location);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS memory_summaries (conversation_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_summary_versions (conversation_id TEXT NOT NULL, version INTEGER NOT NULL,
        body TEXT NOT NULL, PRIMARY KEY(conversation_id,version));
      CREATE TABLE IF NOT EXISTS memory_notes (owner_id TEXT NOT NULL, author TEXT NOT NULL, target TEXT NOT NULL,
        body TEXT NOT NULL, PRIMARY KEY(owner_id,author,target));
      CREATE TABLE IF NOT EXISTS memory_note_writes (owner_id TEXT NOT NULL, author TEXT NOT NULL,
        key TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(owner_id,author,key));
      CREATE TABLE IF NOT EXISTS memory_rounds (id TEXT PRIMARY KEY, body TEXT NOT NULL, outcome TEXT);
      CREATE TABLE IF NOT EXISTS memory_compact_batches (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS memory_failures (conversation_id TEXT NOT NULL, covered INTEGER NOT NULL,
        attempts INTEGER NOT NULL, retry_at INTEGER NOT NULL, PRIMARY KEY(conversation_id,covered));
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_message_fts USING fts5(content, tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS memory_message_insert AFTER INSERT ON chat_messages BEGIN
        INSERT INTO memory_message_fts(rowid,content) VALUES (new.sequence,COALESCE(json_extract(new.body,'$.content'),''));
      END;
      CREATE TRIGGER IF NOT EXISTS memory_message_update AFTER UPDATE OF body ON chat_messages BEGIN
        DELETE FROM memory_message_fts WHERE rowid=old.sequence;
        INSERT INTO memory_message_fts(rowid,content) VALUES (new.sequence,COALESCE(json_extract(new.body,'$.content'),''));
      END;
      CREATE TRIGGER IF NOT EXISTS memory_message_delete AFTER DELETE ON chat_messages BEGIN
        DELETE FROM memory_message_fts WHERE rowid=old.sequence;
      END;
      INSERT INTO memory_message_fts(rowid,content)
        SELECT sequence,json_extract(body,'$.content') FROM chat_messages
        WHERE sequence NOT IN (SELECT rowid FROM memory_message_fts);
    `);
  }
  authorize(identity: MemoryIdentity, conversationId: string): void {
    if (!this.db.prepare('SELECT id FROM chat_conversations WHERE id=?').get(conversationId)) {
      throw new RuntimeFault('permission', '会话不存在或不可访问。');
    }
    const conversation = this.conversations.get(conversationId);
    if (conversation.ownerId !== identity.ownerId || !isMember(conversation, identity.member)) {
      throw new RuntimeFault('permission', '只能读取自己参加的会话。');
    }
  }
  source(identity: MemoryIdentity, ref: MemorySource): ConversationMessage {
    this.authorize(identity, ref.conversationId);
    const message = this.conversations.message(ref.messageId);
    if (!message || message.conversationId !== ref.conversationId) {
      throw new RuntimeFault('protocol', '来源消息不存在或不属于所引用会话。', true);
    }
    return message;
  }
  summary(identity: MemoryIdentity, conversationId: string): ConversationSummary | null {
    this.authorize(identity, conversationId);
    const row = this.db.prepare('SELECT body FROM memory_summaries WHERE conversation_id=?').get(conversationId);
    return row ? conversationSummarySchema.parse(JSON.parse(String(row.body))) : null;
  }
  commitSummary(identity: MemoryIdentity, expected: number, summary: ConversationSummary): boolean {
    this.authorize(identity, summary.conversationId);
    const parsed = conversationSummarySchema.parse(summary);
    return this.transaction(() => {
      const old = this.summary(identity, summary.conversationId);
      if ((old?.coveredSequence ?? 0) !== expected) return false;
      if (summary.coveredSequence <= expected || summary.version !== (old?.version ?? 0) + 1) {
        throw new Error('摘要覆盖范围或版本未递增。');
      }
      this.db.prepare('INSERT OR REPLACE INTO memory_summaries VALUES (?,?)')
        .run(summary.conversationId, JSON.stringify(parsed));
      this.db.prepare('INSERT INTO memory_summary_versions VALUES (?,?,?)')
        .run(summary.conversationId, summary.version, JSON.stringify(parsed));
      return true;
    });
  }
  note(identity: MemoryIdentity, target: ConversationMember): ContactNote | null {
    const row = this.db.prepare('SELECT body FROM memory_notes WHERE owner_id=? AND author=? AND target=?')
      .get(identity.ownerId, memberKey(identity.member), memberKey(target));
    return row ? contactNoteSchema.parse(JSON.parse(String(row.body))) : null;
  }
  notes(identity: MemoryIdentity): ContactNote[] {
    return this.db.prepare('SELECT body FROM memory_notes WHERE owner_id=? AND author=? ORDER BY rowid DESC')
      .all(identity.ownerId, memberKey(identity.member))
      .map((row) => contactNoteSchema.parse(JSON.parse(String(row.body))));
  }
  setNote(identity: MemoryIdentity, input: SetContactNote): ContactNote {
    const value = setContactNoteSchema.parse(input);
    for (const ref of value.sourceRefs) this.source(identity, ref);
    const { idempotencyKey, expectedVersion, ...content } = value;
    const fingerprint = JSON.stringify({ ...content, expectedVersion });
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT fingerprint,body FROM memory_note_writes WHERE owner_id=? AND author=? AND key=?')
        .get(identity.ownerId, memberKey(identity.member), idempotencyKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new RuntimeFault('protocol', '备注幂等键已用于不同内容。', true);
        return contactNoteSchema.parse(JSON.parse(String(previous.body)));
      }
      const old = this.note(identity, content.target);
      if ((old?.version ?? 0) !== expectedVersion) throw new RuntimeFault('protocol', '备注版本冲突，请先重新读取。', true);
      const note: ContactNote = { ...content, ownerId: identity.ownerId, author: identity.member,
        version: expectedVersion + 1, updatedAt: Date.now() };
      this.db.prepare('INSERT OR REPLACE INTO memory_notes VALUES (?,?,?,?)')
        .run(identity.ownerId, memberKey(identity.member), memberKey(content.target), JSON.stringify(note));
      this.db.prepare('INSERT INTO memory_note_writes VALUES (?,?,?,?,?)')
        .run(identity.ownerId, memberKey(identity.member), idempotencyKey, fingerprint, JSON.stringify(note));
      return note;
    });
  }
  recent(identity: MemoryIdentity) {
    return this.conversations.list(identity.ownerId, identity.member).map((conversation) => {
      const row = this.db.prepare(`SELECT sequence,json_extract(body,'$.createdAt') AS created_at
        FROM chat_messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT 1`).get(conversation.id);
      const latestSequence = Number(row?.sequence ?? 0);
      return { conversation, latestSequence, latestMessageAt: Number(row?.created_at ?? conversation.createdAt) };
    }).sort((a, b) => b.latestSequence - a.latestSequence);
  }
  range(conversationId: string, after: number, limit: number, newest = false): ConversationMessage[] {
    const rows = this.db.prepare(`SELECT id FROM chat_messages WHERE conversation_id=? AND sequence>?
      ORDER BY sequence ${newest ? 'DESC' : 'ASC'} LIMIT ?`).all(conversationId, after, limit);
    const messages = rows.map((row) => this.conversations.message(String(row.id))!);
    return newest ? messages.reverse() : messages;
  }
  search(identity: MemoryIdentity, input: ConversationSearch): ConversationSearchResult {
    const query = searchSchema.parse(input);
    if (query.conversationId) this.authorize(identity, query.conversationId);
    const ids = query.conversationId ? [query.conversationId]
      : this.conversations.list(identity.ownerId, identity.member).map((item) => item.id);
    if (!ids.length) return { hits: [], nextBeforeSequence: null, truncated: false };
    const conditions = [`m.conversation_id IN (${ids.map(() => '?').join(',')})`];
    const params: SQLInputValue[] = [...ids];
    // FTS 语法由宿主转义；一两个汉字走字面匹配，避免分词器漏召回。
    if (Array.from(query.query).length >= 3) {
      conditions.push('m.sequence IN (SELECT rowid FROM memory_message_fts WHERE memory_message_fts MATCH ?)');
      params.push(`"${query.query.replaceAll('"', '""')}"`);
    } else {
      conditions.push("instr(lower(json_extract(m.body,'$.content')),lower(?))>0");
      params.push(query.query);
    }
    if (query.sender) {
      conditions.push("json_extract(m.body,'$.sender.kind')=? AND json_extract(m.body,'$.sender.id')=?");
      params.push(query.sender.kind, query.sender.id);
    }
    if (query.since !== undefined) { conditions.push("json_extract(m.body,'$.createdAt')>=?"); params.push(query.since); }
    if (query.until !== undefined) { conditions.push("json_extract(m.body,'$.createdAt')<=?"); params.push(query.until); }
    if (query.beforeSequence !== undefined) { conditions.push('m.sequence<?'); params.push(query.beforeSequence); }
    const limit = query.limit ?? 10;
    const rows = this.db.prepare(`SELECT m.id FROM chat_messages m WHERE ${conditions.join(' AND ')}
      ORDER BY m.sequence DESC LIMIT ?`).all(...params, limit + 1);
    const hits: HistoryExcerpt[] = [];
    for (const row of rows.slice(0, limit)) {
      const message = this.conversations.message(String(row.id))!;
      const index = message.content.toLocaleLowerCase().indexOf(query.query.toLocaleLowerCase());
      const hit = budgetedExcerpt(message, Math.max(0, index - 100));
      if (estimateContextTokens({ hits: [...hits, hit] }) > 2200) break;
      hits.push(hit);
    }
    const more = rows.length > hits.length;
    return { hits, nextBeforeSequence: more ? hits.at(-1)!.sequence : null,
      truncated: more || hits.some((hit) => hit.offset > 0 || hit.nextOffset !== null) };
  }
  read(identity: MemoryIdentity, input: ConversationRead): ConversationReadResult {
    const query = readSchema.parse(input);
    this.authorize(identity, query.conversationId);
    if ((query.offset ?? 0) > 0 && !query.messageId) throw new RuntimeFault('protocol', '偏移读取必须指定消息 ID。', true);
    let candidates: ConversationMessage[];
    if (query.messageId) {
      candidates = [this.source(identity, { conversationId: query.conversationId, messageId: query.messageId })];
    } else {
      candidates = this.range(query.conversationId, query.afterSequence ?? 0, (query.limit ?? 10) + 1);
    }
    // 按 ID 读取和分段续读同样遵守左开右闭的固定序号范围。
    candidates = candidates.filter((message) => message.sequence > (query.afterSequence ?? 0) &&
      (query.throughSequence === undefined || message.sequence <= query.throughSequence));
    const messages: HistoryExcerpt[] = [];
    let next: ConversationRead | null = null;
    for (const message of candidates) {
      if (messages.length >= (query.limit ?? 10) || estimateContextTokens(messages) > 1000) {
        next = { ...input, afterSequence: messages.at(-1)!.sequence, offset: 0 }; break;
      }
      const offset = query.messageId === message.id ? query.offset ?? 0 : 0;
      const item = budgetedExcerpt(message, offset);
      if (estimateContextTokens({ messages: [...messages, item] }) > 2200) {
        next = { ...input, afterSequence: messages.at(-1)!.sequence, offset: 0 }; break;
      }
      messages.push(item);
      if (item.nextOffset !== null) {
        next = { ...input, messageId: message.id, offset: item.nextOffset }; break;
      }
    }
    // 分段读完一条后仍可沿同一范围继续；不丢失之前的序号上界。
    if (query.messageId && candidates.length && !next) {
      const message = candidates[0]!;
      const following = this.range(query.conversationId, message.sequence, 1)[0];
      if (following && (query.throughSequence === undefined || following.sequence <= query.throughSequence)) {
        const { messageId: _id, offset: _offset, ...rest } = input;
        next = { ...rest, afterSequence: message.sequence };
      }
    }
    return { messages, next, truncated: next !== null };
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}

export function excerpt(message: ConversationMessage, offset = 0, length = 700): HistoryExcerpt {
  const content = message.content.slice(offset, offset + length);
  return { conversationId: message.conversationId, messageId: message.id, sequence: message.sequence,
    sender: message.sender, createdAt: message.createdAt, content, offset, totalLength: message.content.length,
    nextOffset: offset + content.length < message.content.length ? offset + content.length : null };
}

/** 序列化会放大控制字符；确保首条片段也能装入预算，且分页总能前进。 */
function budgetedExcerpt(message: ConversationMessage, offset: number): HistoryExcerpt {
  let length = 400;
  let item = excerpt(message, offset, length);
  while (length > 1 && estimateContextTokens(item) > 1800) {
    length = Math.floor(length / 2);
    item = excerpt(message, offset, length);
  }
  return item;
}
