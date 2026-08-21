import type {
  TaskControlBlock,
  TaskSnapshot,
  TaskStore,
} from '../../src/index.js';
import type { TaskEvent } from '../../src/kernel/task-event.js';

export class ObservableTaskStore implements TaskStore {
  readonly #snapshots = new Map<string, TaskSnapshot>();
  readonly #events = new Map<string, TaskEvent[]>();
  #onChanged: (() => void) | undefined;

  setChangeListener(listener: () => void): void {
    this.#onChanged = listener;
  }

  list(): TaskSnapshot[] {
    return [...this.#snapshots.values()].map((snapshot) =>
      structuredClone(snapshot),
    );
  }

  async persist(task: TaskControlBlock): Promise<void> {
    const snapshot = task.snapshot();
    const storedEvents = this.#events.get(task.id) ?? [];
    const latestSequence =
      storedEvents.at(-1)?.sequence ?? 0;
    const newEvents = snapshot.events.filter(
      (event) => event.sequence > latestSequence,
    );

    storedEvents.push(...structuredClone(newEvents));
    this.#events.set(task.id, storedEvents);
    this.#snapshots.set(task.id, structuredClone(snapshot));
    this.#onChanged?.();
  }

  async load(taskId: string): Promise<TaskSnapshot | undefined> {
    const snapshot = this.#snapshots.get(taskId);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  async events(taskId: string): Promise<readonly TaskEvent[]> {
    return structuredClone(this.#events.get(taskId) ?? []);
  }
}
