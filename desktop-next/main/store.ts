import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Workspace } from '../shared/contracts.js';
import { defaultTokenSettings, runtimeTokenSettingsSchema } from '../../src/agent-runtime/index.js';

const profileSchema = z.object({ name: z.string(), readCount: z.number().int().nonnegative() }).strict();
const legacyModelSchema = z.object({
  mode: z.enum(['demo', 'minimax']), model: z.string(), encryptedKey: z.string().nullable(),
  tokens: runtimeTokenSettingsSchema.default(defaultTokenSettings),
}).strict();
const connectionSchema = z.object({ model: z.string(), encryptedKey: z.string().nullable() }).strict();
const modelSchema = z.object({
  version: z.literal(2), mode: z.enum(['demo', 'minimax', 'deepseek']),
  connections: z.object({ minimax: connectionSchema, deepseek: connectionSchema }).strict(),
  tokens: runtimeTokenSettingsSchema,
}).strict();
export type StoredModel = z.infer<typeof modelSchema>;

/** 仅保存桌面显示信息和宿主配置；消息与执行状态以 Runtime 数据库为准。 */
export class DesktopStore {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, read_count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_reads (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
    `);
  }
  profile(id: number) {
    const row = this.#db.prepare('SELECT name,read_count AS readCount FROM contacts WHERE id=?').get(id);
    return row ? profileSchema.parse(row) : undefined;
  }
  setProfile(id: number, name: string, readCount: number): void {
    this.#db.prepare('INSERT INTO contacts VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,read_count=excluded.read_count')
      .run(id, name, readCount);
  }
  readSequence(id: string): number {
    return Number(this.#db.prepare('SELECT sequence FROM conversation_reads WHERE id=?').get(id)?.sequence ?? 0);
  }
  markRead(id: string, sequence: number): void {
    this.#db.prepare(`INSERT INTO conversation_reads VALUES (?,?)
      ON CONFLICT(id) DO UPDATE SET sequence=MAX(sequence,excluded.sequence)`).run(id, sequence);
  }
  workspaces(): Workspace[] {
    return this.#db.prepare('SELECT id,path FROM workspaces').all()
      .map((row) => z.object({ id: z.string(), path: z.string() }).parse(row));
  }
  addWorkspace(workspace: Workspace): void {
    this.#db.prepare('INSERT OR IGNORE INTO workspaces VALUES (?,?)').run(workspace.id, workspace.path);
  }
  model(): StoredModel {
    const row = this.#db.prepare("SELECT body FROM settings WHERE id='model'").get();
    if (row) {
      const value: unknown = JSON.parse(String(row.body));
      const current = modelSchema.safeParse(value);
      if (current.success) return current.data;
      const legacy = legacyModelSchema.parse(value);
      // 原有凭据只属于 MiniMax，迁移不能复制给新供应商。
      return { version: 2, mode: legacy.mode, tokens: legacy.tokens, connections: {
        minimax: { model: legacy.model, encryptedKey: legacy.encryptedKey },
        deepseek: { model: '', encryptedKey: null },
      } };
    }
    return { version: 2, mode: 'demo', connections: {
      minimax: { model: 'MiniMax-M2.5', encryptedKey: null }, deepseek: { model: '', encryptedKey: null },
    }, tokens: { ...defaultTokenSettings } };
  }
  saveModel(settings: StoredModel): void {
    this.#db.prepare("INSERT INTO settings VALUES ('model',?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(JSON.stringify(modelSchema.parse(settings)));
  }
  close(): void { this.#db.close(); }
}
