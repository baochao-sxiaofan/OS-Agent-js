import { DatabaseSync } from 'node:sqlite';

import type {
  TaskControlBlock,
  TaskSnapshot,
} from '../kernel/task-control-block.js';
import type { TaskEvent } from '../kernel/task-event.js';
import type { TaskStore } from './task-store.js';

/**
 * SqliteTaskStore 的构造选项。
 */
export type SqliteTaskStoreOptions = {
  /**
   * SQLite 数据库文件路径。
   *
   * 传入 `:memory:` 可创建仅存在于内存的库，主要用于测试；
   * 桌面端应传入 Electron `userData` 目录下的持久化文件路径。
   */
  location: string;
};

/**
 * 基于内置 `node:sqlite` 的任务持久化实现。
 *
 * 设计要点（与 InMemoryTaskStore 语义对齐，可无缝替换）：
 * - 单一 SQLite 文件即唯一事实源，避免多存储双写导致的不一致。
 * - 快照与事件以 JSON 文本存入 `body` 字段，兼顾结构灵活与可读性；
 *   另外冗余 `root_task_id`、`status` 等索引列，供崩溃恢复时按树或状态查询。
 * - 每次 persist 把「快照 upsert + 事件增量 append」放进同一个事务，
 *   保证一次状态跃迁对应一次原子写：要么整体落盘、要么整体不落盘。
 * - 事件按 `sequence` 去重追加，重复 persist 幂等，契合崩溃后重放恢复。
 * - 使用 WAL 模式优化高频小事务写入，并由 SQLite 负责刷盘 durability。
 */
export class SqliteTaskStore implements TaskStore {
  readonly #db: DatabaseSync;

  constructor(options: SqliteTaskStoreOptions) {
    this.#db = new DatabaseSync(options.location);
    // WAL：高频小事务下的写入性能与并发读表现更好。
    this.#db.exec('PRAGMA journal_mode = WAL');
    // NORMAL：在 WAL 下兼顾 durability 与性能，避免每次 fsync 的开销。
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        task_id TEXT PRIMARY KEY,
        root_task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        body TEXT NOT NULL
      )
    `);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        task_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (task_id, sequence)
      )
    `);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_metadata (
        key TEXT PRIMARY KEY,
        body TEXT NOT NULL
      )
    `);
    // 按任务树查询（恢复整棵树）时使用。
    this.#db.exec(
      'CREATE INDEX IF NOT EXISTS idx_snapshots_root ON snapshots (root_task_id)',
    );
  }

  /**
   * 原子持久化一个任务的最新快照与新增事件。
   *
   * 事件采用增量追加：只写入 `sequence` 大于库中已存最大值的事件，
   * 因此对同一状态重复调用是幂等的。
   */
  async persist(task: TaskControlBlock): Promise<void> {
    const snapshot = task.snapshot();
    const latestSequence = this.#latestEventSequence(snapshot.id);
    const newEvents = snapshot.events.filter(
      (event) => event.sequence > latestSequence,
    );

    const upsertSnapshot = this.#db.prepare(`
      INSERT INTO snapshots (task_id, root_task_id, status, updated_at, body)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        root_task_id = excluded.root_task_id,
        status = excluded.status,
        updated_at = excluded.updated_at,
        body = excluded.body
    `);
    const insertEvent = this.#db.prepare(
      'INSERT OR IGNORE INTO events (task_id, sequence, body) VALUES (?, ?, ?)',
    );

    // 单事务写入：快照与新增事件一起落盘，避免崩溃时两者不一致。
    this.#db.exec('BEGIN');
    try {
      upsertSnapshot.run(
        snapshot.id,
        snapshot.rootTaskId,
        snapshot.state.status,
        snapshot.updatedAt,
        JSON.stringify(snapshot),
      );
      for (const event of newEvents) {
        insertEvent.run(
          snapshot.id,
          event.sequence,
          JSON.stringify(event),
        );
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async load(taskId: string): Promise<TaskSnapshot | undefined> {
    const row = this.#db
      .prepare('SELECT body FROM snapshots WHERE task_id = ?')
      .get(taskId) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as TaskSnapshot) : undefined;
  }

  async events(taskId: string): Promise<readonly TaskEvent[]> {
    const rows = this.#db
      .prepare(
        'SELECT body FROM events WHERE task_id = ? ORDER BY sequence ASC',
      )
      .all(taskId) as { body: string }[];
    return rows.map((row) => JSON.parse(row.body) as TaskEvent);
  }

  /**
   * 列出全部已持久化的任务快照。
   *
   * 供桌面端等上层做全量展示或恢复时遍历使用。
   */
  listSnapshots(): TaskSnapshot[] {
    const rows = this.#db
      .prepare('SELECT body FROM snapshots')
      .all() as { body: string }[];
    return rows.map((row) => JSON.parse(row.body) as TaskSnapshot);
  }

  /**
   * 读取与任务快照共用同一 SQLite 事实源的宿主运行时元数据。
   *
   * Core 不解释正文格式；桌面控制平面用它持久化 Conversation 与 workspace
   * 映射，避免任务快照和独立配置文件发生双写漂移。
   */
  readRuntimeMetadata(key: string): string | undefined {
    const row = this.#db
      .prepare('SELECT body FROM runtime_metadata WHERE key = ?')
      .get(key) as { body: string } | undefined;
    return row?.body;
  }

  /** 原子覆盖一项宿主运行时元数据。 */
  writeRuntimeMetadata(key: string, body: string): void {
    this.#db
      .prepare(`
        INSERT INTO runtime_metadata (key, body)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET body = excluded.body
      `)
      .run(key, body);
  }

  /**
   * 关闭底层数据库连接，释放文件句柄。
   */
  close(): void {
    this.#db.close();
  }

  #latestEventSequence(taskId: string): number {
    const row = this.#db
      .prepare(
        'SELECT MAX(sequence) AS latest FROM events WHERE task_id = ?',
      )
      .get(taskId) as { latest: number | null } | undefined;
    return row?.latest ?? 0;
  }
}
