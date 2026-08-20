import type { TaskControlBlock } from '../kernel/task-control-block.js';

type QueueEntry = {
  task: TaskControlBlock;
  order: number;
};

export class DuplicateQueueEntryError extends Error {
  constructor(taskId: string) {
    super(`Task is already in the ready queue: ${taskId}`);
    this.name = 'DuplicateQueueEntryError';
  }
}

export class ReadyQueue {
  readonly #taskIds = new Set<string>();
  #entries: QueueEntry[] = [];
  #nextOrder = 0;

  get size(): number {
    return this.#entries.length;
  }

  enqueue(task: TaskControlBlock): void {
    if (task.state.status !== 'READY') {
      throw new Error(
        `Only READY tasks can be queued; ${task.id} is ${task.state.status}`,
      );
    }
    if (this.#taskIds.has(task.id)) {
      throw new DuplicateQueueEntryError(task.id);
    }

    this.#entries.push({
      task,
      order: this.#nextOrder,
    });
    this.#nextOrder += 1;
    this.#taskIds.add(task.id);
  }

  peek(): TaskControlBlock | undefined {
    this.sortEntries();
    return this.#entries[0]?.task;
  }

  dequeue(): TaskControlBlock | undefined {
    this.sortEntries();
    const entry = this.#entries.shift();
    if (!entry) {
      return undefined;
    }
    this.#taskIds.delete(entry.task.id);
    return entry.task;
  }

  has(taskId: string): boolean {
    return this.#taskIds.has(taskId);
  }

  remove(taskId: string): boolean {
    const entryIndex = this.#entries.findIndex(
      (entry) => entry.task.id === taskId,
    );
    if (entryIndex < 0) {
      return false;
    }
    this.#entries.splice(entryIndex, 1);
    this.#taskIds.delete(taskId);
    return true;
  }

  snapshot(): readonly TaskControlBlock[] {
    this.sortEntries();
    return this.#entries.map((entry) => entry.task);
  }

  private sortEntries(): void {
    this.#entries.sort(
      (left, right) =>
        right.task.priority - left.task.priority || left.order - right.order,
    );
  }
}
