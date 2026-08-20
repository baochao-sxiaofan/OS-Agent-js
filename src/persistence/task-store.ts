import type {
  TaskControlBlock,
  TaskSnapshot,
} from '../kernel/task-control-block.js';
import type { TaskEvent } from '../kernel/task-event.js';

export interface TaskStore {
  persist(task: TaskControlBlock): Promise<void>;

  load(taskId: string): Promise<TaskSnapshot | undefined>;

  events(taskId: string): Promise<readonly TaskEvent[]>;
}

export class InMemoryTaskStore implements TaskStore {
  readonly #snapshots = new Map<string, TaskSnapshot>();
  readonly #events = new Map<string, TaskEvent[]>();

  async persist(task: TaskControlBlock): Promise<void> {
    const snapshot = task.snapshot();
    const storedEvents = this.#events.get(task.id) ?? [];
    const newEvents = snapshot.events.filter(
      (event) => event.sequence > storedEvents.length,
    );

    storedEvents.push(...structuredClone(newEvents));
    this.#events.set(task.id, storedEvents);
    this.#snapshots.set(task.id, structuredClone(snapshot));
  }

  async load(taskId: string): Promise<TaskSnapshot | undefined> {
    const snapshot = this.#snapshots.get(taskId);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  async events(taskId: string): Promise<readonly TaskEvent[]> {
    return structuredClone(this.#events.get(taskId) ?? []);
  }
}
