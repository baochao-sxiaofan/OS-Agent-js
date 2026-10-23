import { DatabaseSync } from 'node:sqlite';
import type { ContextCheckpoint, ContextReceipt, ContextRecord, ContextStore, ContextStoreWrite } from '../management.js';
import { validateCheckpoint } from '../internal/checkpoint.js';
import { validateRecord } from '../internal/records.js';
import { requireContext } from '../internal/validation.js';

/** 独立于旧 TCB 表；快照、归档和轮次回执使用同一 SQLite 事务。 */
export class SqliteContextStore implements ContextStore {
  readonly #db: DatabaseSync;

  constructor(location: string) {
    this.#db = new DatabaseSync(location);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS agent_context_states (
        agent_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_context_records (
        agent_key TEXT NOT NULL, ref TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (agent_key, ref)
      );
      CREATE TABLE IF NOT EXISTS agent_context_receipts (
        agent_key TEXT NOT NULL, receipt_key TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (agent_key, receipt_key)
      );
    `);
  }

  load(key: string): ContextCheckpoint | undefined {
    const row = this.#db.prepare('SELECT body FROM agent_context_states WHERE agent_key = ?').get(key);
    if (!row) return undefined;
    const value: unknown = JSON.parse(String(row.body));
    validateCheckpoint(value);
    return value;
  }

  /** 仅供可信宿主枚举已持久化的上下文命名空间，不返回原始记录。 */
  keys(): string[] {
    return this.#db.prepare('SELECT agent_key FROM agent_context_states ORDER BY agent_key')
      .all().map((row) => String(row.agent_key));
  }

  read(key: string, ref: string): ContextRecord | undefined {
    const row = this.#db.prepare('SELECT body FROM agent_context_records WHERE agent_key = ? AND ref = ?').get(key, ref);
    if (!row) return undefined;
    const value: unknown = JSON.parse(String(row.body));
    validateRecord(value);
    return value;
  }

  receipt(key: string, id: string): ContextReceipt | undefined {
    const row = this.#db.prepare('SELECT body FROM agent_context_receipts WHERE agent_key = ? AND receipt_key = ?').get(key, id);
    if (!row) return undefined;
    const value = JSON.parse(String(row.body)) as ContextReceipt;
    requireContext(value.key === id && (value.intent === 'continue' || value.intent === 'idle'), '轮次回执损坏。');
    return value;
  }

  commit(key: string, expectedRevision: number | null, checkpoint: ContextCheckpoint,
    writes: readonly ContextStoreWrite[], receipts: readonly ContextReceipt[]): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#db.prepare('SELECT revision FROM agent_context_states WHERE agent_key = ?').get(key);
      requireContext((row?.revision ?? null) === expectedRevision, '检查点版本冲突，请重新恢复。', 'storage_conflict');
      requireContext(checkpoint.revision === (expectedRevision === null ? 0 : expectedRevision + 1),
        '检查点版本必须逐次递增。', 'storage_conflict');
      this.#db.prepare(`
        INSERT INTO agent_context_states (agent_key, revision, body) VALUES (?, ?, ?)
        ON CONFLICT(agent_key) DO UPDATE SET revision = excluded.revision, body = excluded.body
      `).run(key, checkpoint.revision, JSON.stringify(checkpoint));
      for (const write of writes) this.#db.prepare(
        'INSERT INTO agent_context_records (agent_key, ref, body) VALUES (?, ?, ?)',
      ).run(key, write.ref, JSON.stringify(write.record));
      for (const receipt of receipts) this.#db.prepare(
        'INSERT INTO agent_context_receipts (agent_key, receipt_key, body) VALUES (?, ?, ?)',
      ).run(key, receipt.key, JSON.stringify(receipt));
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.#db.close(); }
}
