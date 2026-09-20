import { DatabaseSync } from 'node:sqlite';
import type { JsonObject } from '../types/json.js';

/** Durable intent/result records; secrets must never be written here. */
export interface OperationStore {
  get(key: string): JsonObject | undefined;
  set(key: string, value: JsonObject): void;
}

export class InMemoryOperationStore implements OperationStore {
  readonly #records = new Map<string, JsonObject>();
  get(key: string): JsonObject | undefined {
    const value = this.#records.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }
  set(key: string, value: JsonObject): void { this.#records.set(key, structuredClone(value)); }
}

export class SqliteOperationStore implements OperationStore {
  readonly #db: DatabaseSync;
  constructor(location: string) {
    this.#db = new DatabaseSync(location);
    this.#db.exec('PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS tool_operations (operation_key TEXT PRIMARY KEY, body TEXT NOT NULL)');
  }
  get(key: string): JsonObject | undefined {
    const row = this.#db.prepare('SELECT body FROM tool_operations WHERE operation_key = ?').get(key) as { body: string } | undefined;
    if (!row) return undefined;
    const value: unknown = JSON.parse(row.body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid persisted operation.');
    return value as JsonObject;
  }
  set(key: string, value: JsonObject): void {
    this.#db.prepare('INSERT INTO tool_operations VALUES (?, ?) ON CONFLICT(operation_key) DO UPDATE SET body = excluded.body').run(key, JSON.stringify(value));
  }
  close(): void { this.#db.close(); }
}
