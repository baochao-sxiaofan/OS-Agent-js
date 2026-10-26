import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type {
  ConversationMailbox, ConversationMember, ConversationMessage, ConversationPolicy,
  CreateConversation, RuntimeConversation, SendConversationMessage,
} from '../conversations.js';
import { RuntimeFault } from './limits.js';

const memberSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('agent'), id: z.number().int().positive() }).strict(),
]);
const conversationSchema = z.object({
  id: z.string().min(1), ownerId: z.string().min(1), workspaceId: z.string().min(1),
  kind: z.enum(['direct', 'group']), title: z.string().max(100),
  members: z.array(memberSchema).min(2).max(32), participation: z.enum(['all', 'mentioned']),
  createdAt: z.number().int().nonnegative(),
}).strict();
const messageSchema = z.object({
  id: z.string().min(1), sequence: z.number().int().positive(), conversationId: z.string().min(1),
  sender: memberSchema, content: z.string().min(1), createdAt: z.number().int().nonnegative(),
  replyTo: z.string().nullable(), mentions: z.array(z.number().int().positive()), phaseId: z.string().min(1),
}).strict();
const batchSchema = z.object({
  id: z.string().min(1), agentId: z.number().int().positive(), conversationId: z.string().min(1),
  upper: z.number().int().positive(), phaseId: z.string().min(1),
  messages: z.array(messageSchema).min(1), status: z.enum(['queued', 'delivered', 'done']),
}).strict();
export type ConversationBatch = Omit<z.infer<typeof batchSchema>, 'messages'> & { messages: ConversationMessage[] };

export function memberKey(member: ConversationMember): string { return `${member.kind}:${member.id}`; }
export function isMember(conversation: RuntimeConversation, member: ConversationMember): boolean {
  return conversation.members.some((item) => memberKey(item) === memberKey(member));
}

/** 持久邮箱、固定投递批次和发件幂等共用事务，不依赖 UI 或模型调度器。 */
export class ConversationStore {
  readonly #db: DatabaseSync;
  readonly policy: ConversationPolicy;

  constructor(location: string, policy: Partial<ConversationPolicy> = {}) {
    this.policy = { quietMs: 500, maxWaitMs: 2000, groupQuietMs: 1200, maxAutomaticMessages: 12, ...policy };
    for (const [key, value] of Object.entries(this.policy)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`非法会话限制：${key}`);
    }
    this.#db = new DatabaseSync(location);
    this.#db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS chat_conversations (id TEXT PRIMARY KEY, direct_key TEXT UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_messages_conversation ON chat_messages(conversation_id, sequence);
      CREATE TABLE IF NOT EXISTS chat_outbox (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, message_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_mailboxes (agent_id INTEGER NOT NULL, conversation_id TEXT NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0, first_at INTEGER, due_at INTEGER, priority INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(agent_id, conversation_id));
      CREATE TABLE IF NOT EXISTS chat_batches (id TEXT PRIMARY KEY, agent_id INTEGER NOT NULL,
        conversation_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS chat_active_batch ON chat_batches(agent_id) WHERE status!='done';
      CREATE TABLE IF NOT EXISTS chat_dismissed_agents (id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS chat_phases (id TEXT PRIMARY KEY, sent INTEGER NOT NULL DEFAULT 0);
    `);
  }

  get(id: string): RuntimeConversation {
    const row = this.#db.prepare('SELECT body FROM chat_conversations WHERE id=?').get(id);
    if (!row) throw new Error('会话不存在。');
    return conversationSchema.parse(JSON.parse(String(row.body)));
  }
  list(owner: string, member: ConversationMember): RuntimeConversation[] {
    return this.#db.prepare('SELECT body FROM chat_conversations ORDER BY rowid').all()
      .map((row) => conversationSchema.parse(JSON.parse(String(row.body))))
      .filter((item) => item.ownerId === owner && isMember(item, member));
  }
  create(input: CreateConversation): RuntimeConversation {
    const conversation = conversationSchema.parse({
      ...input, id: randomUUID(), title: input.title ?? '', participation: input.participation ?? 'all', createdAt: Date.now(),
    });
    const identities = conversation.members.map(memberKey);
    if (new Set(identities).size !== identities.length || conversation.kind === 'direct' && identities.length !== 2) {
      throw new Error('成员重复或私聊成员数量无效。');
    }
    const key = conversation.kind === 'direct'
      ? JSON.stringify([input.ownerId, input.workspaceId, identities.sort()]) : null;
    if (key) {
      const row = this.#db.prepare('SELECT id FROM chat_conversations WHERE direct_key=?').get(key);
      if (row) return this.get(String(row.id));
    }
    this.#transaction(() => {
      this.#db.prepare('INSERT INTO chat_conversations VALUES (?,?,?)').run(conversation.id, key, JSON.stringify(conversation));
      for (const member of conversation.members) if (member.kind === 'agent') {
        this.#db.prepare('INSERT INTO chat_mailboxes (agent_id,conversation_id) VALUES (?,?)').run(member.id, conversation.id);
      }
    });
    return conversation;
  }
  messages(id: string, after = 0): ConversationMessage[] {
    return this.#db.prepare('SELECT body FROM chat_messages WHERE conversation_id=? AND sequence>? ORDER BY sequence')
      .all(id, after).map((row) => messageSchema.parse(JSON.parse(String(row.body))));
  }
  message(id: string): ConversationMessage | undefined {
    const row = this.#db.prepare('SELECT body FROM chat_messages WHERE id=?').get(id);
    return row ? messageSchema.parse(JSON.parse(String(row.body))) : undefined;
  }

  send(conversationId: string, sender: ConversationMember, input: SendConversationMessage, phase?: string,
    maxDeliveryBytes = Infinity): ConversationMessage {
    const conversation = this.get(conversationId);
    if (sender.kind === 'agent' && this.isDismissed(sender.id)) throw new RuntimeFault('permission', 'Agent 已解雇。');
    if (conversation.kind === 'direct' && conversation.members.some((member) => member.kind === 'agent' && this.isDismissed(member.id))) {
      throw new RuntimeFault('permission', 'Agent 已解雇，私聊仅保留历史。');
    }
    if (!isMember(conversation, sender)) throw new RuntimeFault('permission', '发送者不是会话成员。');
    if (!input.content.trim() || Buffer.byteLength(input.content) > 12000 ||
        !input.idempotencyKey.trim() || input.idempotencyKey.length > 300) {
      throw new RuntimeFault('protocol', '消息内容或幂等键无效；正文最多 12000 字节。', true);
    }
    const mentions = [...new Set(input.mentions ?? [])].sort((a, b) => a - b);
    if (mentions.some((id) => this.isDismissed(id) || !isMember(conversation, { kind: 'agent', id }))) {
      throw new RuntimeFault('permission', '只能点名本会话的 Agent。');
    }
    const reply = input.replyTo ? this.message(input.replyTo) : undefined;
    if (input.replyTo && reply?.conversationId !== conversationId) {
      throw new RuntimeFault('permission', '回复引用不属于当前会话。');
    }
    const key = createHash('sha256').update(JSON.stringify([conversation.ownerId, memberKey(sender), input.idempotencyKey])).digest('hex');
    const fingerprint = JSON.stringify([conversationId, input.content, input.replyTo ?? null, mentions]);
    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT * FROM chat_outbox WHERE id=?').get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('幂等键已用于不同消息。');
        return this.message(String(existing.message_id))!;
      }
      const phaseId = sender.kind === 'user' ? randomUUID() : phase;
      if (!phaseId) throw new Error('Agent 发言缺少宿主交流预算。');
      this.#db.prepare('INSERT OR IGNORE INTO chat_phases (id) VALUES (?)').run(phaseId);
      if (sender.kind === 'agent') {
        const result = this.#db.prepare('UPDATE chat_phases SET sent=sent+1 WHERE id=? AND sent<?')
          .run(phaseId, this.policy.maxAutomaticMessages);
        if (!result.changes) throw new RuntimeFault('loop', '本次交流的自动发言预算已用完，等待用户推进。');
      }
      const id = randomUUID();
      const result = this.#db.prepare('INSERT INTO chat_messages (id,conversation_id,body) VALUES (?,?,?)')
        .run(id, conversationId, '{}');
      const message: ConversationMessage = { id, conversationId, sequence: Number(result.lastInsertRowid),
        sender, content: input.content, createdAt: Date.now(), replyTo: input.replyTo ?? null, mentions, phaseId };
      if (Buffer.byteLength(JSON.stringify(message)) + 1200 > maxDeliveryBytes) {
        throw new RuntimeFault('protocol', '消息超过接收成员的上下文投递容量，请缩短正文。', true);
      }
      this.#db.prepare('UPDATE chat_messages SET body=? WHERE id=?').run(JSON.stringify(message), id);
      this.#db.prepare('INSERT INTO chat_outbox VALUES (?,?,?)').run(key, fingerprint, id);
      for (const member of conversation.members) {
        if (member.kind !== 'agent' || this.isDismissed(member.id) || memberKey(member) === memberKey(sender)) continue;
        const addressed = mentions.includes(member.id) || reply?.sender.kind === 'agent' && reply.sender.id === member.id;
        if (conversation.kind === 'group' && conversation.participation === 'mentioned' && !addressed) continue;
        const quiet = conversation.kind === 'direct' || addressed ? this.policy.quietMs : this.policy.groupQuietMs;
        // 低优先级消息不能延后已点名邮箱的截止时间，首次到达的最大等待上限仍有效。
        this.#db.prepare(`UPDATE chat_mailboxes SET first_at=COALESCE(first_at,?),
          due_at=MIN(COALESCE(first_at,?)+?,CASE WHEN priority>? THEN MIN(due_at,?) ELSE ? END),
          priority=MAX(priority,?)
          WHERE agent_id=? AND conversation_id=?`).run(message.createdAt, message.createdAt,
          this.policy.maxWaitMs, addressed ? 1 : 0, message.createdAt + quiet,
          message.createdAt + quiet, addressed ? 1 : 0, member.id, conversationId);
      }
      return message;
    });
  }

  active(agentId: number): ConversationBatch | undefined {
    const row = this.#db.prepare("SELECT body FROM chat_batches WHERE agent_id=? AND status!='done'").get(agentId);
    return row ? batchSchema.parse(JSON.parse(String(row.body))) : undefined;
  }
  batch(id: string): ConversationBatch | undefined {
    const row = this.#db.prepare('SELECT body FROM chat_batches WHERE id=?').get(id);
    return row ? batchSchema.parse(JSON.parse(String(row.body))) : undefined;
  }
  due(agentId: number): number | undefined {
    const row = this.#db.prepare('SELECT MIN(due_at) AS due FROM chat_mailboxes WHERE agent_id=?').get(agentId);
    return row?.due == null ? undefined : Number(row.due);
  }
  seal(agentId: number, maxBytes: number): ConversationBatch | undefined {
    if (this.isDismissed(agentId)) return undefined;
    if (this.active(agentId)) return this.active(agentId);
    const row = this.#db.prepare(`SELECT * FROM chat_mailboxes WHERE agent_id=? AND due_at<=?
      ORDER BY priority DESC,first_at,conversation_id LIMIT 1`).get(agentId, Date.now());
    if (!row) return undefined;
    const conversationId = String(row.conversation_id);
    const incoming = this.messages(conversationId, Number(row.processed));
    const selected: ConversationMessage[] = [];
    let bytes = 800;
    for (const message of incoming) {
      const size = Buffer.byteLength(JSON.stringify(message)) + 400;
      if (bytes + size > maxBytes || selected.length >= 16) break;
      selected.push(message); bytes += size;
    }
    if (!selected.length) throw new Error('会话输入超过当前上下文投递上限。');
    const batch: ConversationBatch = { id: `chat:${randomUUID()}`, agentId, conversationId,
      upper: selected.at(-1)!.sequence, phaseId: selected.at(-1)!.phaseId, messages: selected, status: 'queued' };
    this.#transaction(() => {
      this.#db.prepare('INSERT INTO chat_batches VALUES (?,?,?,?,?)')
        .run(batch.id, agentId, conversationId, batch.status, JSON.stringify(batch));
      // 批次封存后新消息重新计时，不能改变已交付上界。
      this.#db.prepare('UPDATE chat_mailboxes SET first_at=NULL,due_at=NULL,priority=0 WHERE agent_id=? AND conversation_id=?')
        .run(agentId, conversationId);
    });
    return batch;
  }
  delivered(id: string): void {
    const batch = this.batch(id);
    if (batch?.status === 'queued') this.#saveBatch({ ...batch, status: 'delivered' });
  }
  acknowledge(id: string): void {
    const batch = this.batch(id);
    if (!batch || batch.status === 'done') return;
    this.#transaction(() => {
      this.#saveBatch({ ...batch, status: 'done' });
      this.#db.prepare('UPDATE chat_mailboxes SET processed=MAX(processed,?) WHERE agent_id=? AND conversation_id=?')
        .run(batch.upper, batch.agentId, batch.conversationId);
      // 容量截断留下的消息也必须有唤醒路径；运行期间到达的期限保持不变。
      const conversation = this.get(batch.conversationId);
      const pending = this.messages(batch.conversationId, batch.upper).filter((message) => {
        if (memberKey(message.sender) === `agent:${batch.agentId}`) return false;
        return conversation.kind === 'direct' || conversation.participation === 'all' ||
          message.mentions.includes(batch.agentId) ||
          (message.replyTo && memberKey(this.message(message.replyTo)!.sender) === `agent:${batch.agentId}`);
      });
      if (pending.length) this.#db.prepare(`UPDATE chat_mailboxes SET first_at=COALESCE(first_at,?),
        due_at=COALESCE(due_at,?) WHERE agent_id=? AND conversation_id=?`)
        .run(pending[0]!.createdAt, Date.now(), batch.agentId, batch.conversationId);
    });
  }
  mailboxes(conversationId: string): ConversationMailbox[] {
    return this.#db.prepare('SELECT * FROM chat_mailboxes WHERE conversation_id=?').all(conversationId).map((row) => ({
      agentId: Number(row.agent_id), conversationId, processedSequence: Number(row.processed),
      state: this.isDismissed(Number(row.agent_id)) ? 'dismissed' : this.active(Number(row.agent_id))?.conversationId === conversationId
        ? 'processing' : row.due_at != null ? 'aggregating' : 'processed',
      dueAt: row.due_at == null ? null : Number(row.due_at),
    }));
  }
  isDismissed(agentId: number): boolean {
    return !!this.#db.prepare('SELECT id FROM chat_dismissed_agents WHERE id=?').get(agentId);
  }
  dismiss(agentId: number): void {
    this.#transaction(() => {
      this.#db.prepare('INSERT OR IGNORE INTO chat_dismissed_agents VALUES (?)').run(agentId);
      const batch = this.active(agentId);
      if (batch) this.#saveBatch({ ...batch, status: 'done' });
      // Preserve the actual processed cursor; unprocessed messages are never acknowledged as work.
      this.#db.prepare('UPDATE chat_mailboxes SET first_at=NULL,due_at=NULL,priority=0 WHERE agent_id=?').run(agentId);
    });
  }
  #saveBatch(batch: ConversationBatch): void {
    this.#db.prepare('UPDATE chat_batches SET status=?,body=? WHERE id=?').run(batch.status, JSON.stringify(batch), batch.id);
  }
  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.#db.close(); }
}
