import {
  SqliteTaskStore,
  type TaskControlBlock,
  type TaskSnapshot,
  type TaskStore,
} from '../../src/index.js';
import type { TaskEvent } from '../../src/kernel/task-event.js';

/**
 * 桌面端任务存储：在 SqliteTaskStore 之上叠加变更通知。
 *
 * 底层的持久化、原子写与恢复查询全部委托给 SqliteTaskStore；本类只负责：
 * - 在每次 persist 后触发 UI 刷新回调；
 * - 提供 `list()` 供 RuntimeService 构造视图快照。
 *
 * 传入 `:memory:` 时退化为纯内存库，可用于开发或测试。
 */
export class ObservableTaskStore implements TaskStore {
  readonly #inner: SqliteTaskStore;
  #onChanged: (() => void) | undefined;

  constructor(location: string) {
    this.#inner = new SqliteTaskStore({ location });
  }

  setChangeListener(listener: () => void): void {
    this.#onChanged = listener;
  }

  list(): TaskSnapshot[] {
    return this.#inner.listSnapshots();
  }

  readRuntimeMetadata(key: string): string | undefined {
    return this.#inner.readRuntimeMetadata(key);
  }

  writeRuntimeMetadata(key: string, body: string): void {
    this.#inner.writeRuntimeMetadata(key, body);
  }

  async persist(task: TaskControlBlock): Promise<void> {
    await this.#inner.persist(task);
    this.#onChanged?.();
  }

  async load(taskId: string): Promise<TaskSnapshot | undefined> {
    return await this.#inner.load(taskId);
  }

  async events(taskId: string): Promise<readonly TaskEvent[]> {
    return await this.#inner.events(taskId);
  }

  close(): void {
    this.#inner.close();
  }
}
