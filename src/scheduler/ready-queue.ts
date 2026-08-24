import {
  MAX_AGENT_DEPTH,
  type TaskControlBlock,
} from '../kernel/task-control-block.js';
import { SystemClock, type Clock } from './admission-controller.js';

const MAX_SCHEDULING_DEPTH = MAX_AGENT_DEPTH;

type SchedulingDepth = 1 | 2 | 3;

type QueueEntry = {
  task: TaskControlBlock;
  order: number;
  enqueuedAt: number;
  parentWakeupBoost: boolean;
};

export type ReadyQueuePolicy = {
  depthWeights: Readonly<Record<SchedulingDepth, number>>;
  agingThresholdMs: number;
};

export type EnqueueOptions = {
  parentWakeupBoost?: boolean;
};

export class DuplicateQueueEntryError extends Error {
  constructor(taskId: string) {
    super(`Task is already in the ready queue: ${taskId}`);
    this.name = 'DuplicateQueueEntryError';
  }
}

export class ReadyQueue {
  readonly #taskIds = new Set<string>();
  readonly #entries: QueueEntry[] = [];
  readonly #schedule: SchedulingDepth[];
  #nextOrder = 0;
  #peakSize = 0;
  #scheduleCursor = 0;

  constructor(
    readonly policy: ReadyQueuePolicy = {
      depthWeights: {
        1: 1,
        2: 2,
        3: 4,
      },
      agingThresholdMs: 60_000,
    },
    readonly clock: Clock = new SystemClock(),
  ) {
    if (policy.agingThresholdMs <= 0) {
      throw new Error('Ready queue aging threshold must be greater than zero.');
    }
    this.#schedule = this.buildSchedule(policy.depthWeights);
  }

  get size(): number {
    return this.#entries.length;
  }

  get peakSize(): number {
    return this.#peakSize;
  }

  enqueue(task: TaskControlBlock, options: EnqueueOptions = {}): void {
    if (task.state.status !== 'READY') {
      throw new Error(
        `Only READY tasks can be queued; ${task.id} is ${task.state.status}`,
      );
    }
    if (task.depth < 1 || task.depth > MAX_SCHEDULING_DEPTH) {
      throw new Error(
        `Task ${task.id} has unsupported scheduling depth ${task.depth}.`,
      );
    }
    if (this.#taskIds.has(task.id)) {
      throw new DuplicateQueueEntryError(task.id);
    }

    this.#entries.push({
      task,
      order: this.#nextOrder,
      enqueuedAt: this.clock.now(),
      parentWakeupBoost: options.parentWakeupBoost ?? false,
    });
    this.#nextOrder += 1;
    this.#taskIds.add(task.id);
    this.#peakSize = Math.max(this.#peakSize, this.#entries.length);
  }

  peek(): TaskControlBlock | undefined {
    return this.selectNextEntry()?.entry.task;
  }

  dequeue(): TaskControlBlock | undefined {
    const selected = this.selectNextEntry();
    if (!selected) {
      return undefined;
    }
    this.#entries.splice(selected.entryIndex, 1);
    this.#taskIds.delete(selected.entry.task.id);
    this.#scheduleCursor =
      (selected.scheduleIndex + 1) % this.#schedule.length;
    return selected.entry.task;
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
    const now = this.clock.now();
    return [...this.#entries]
      .sort(
        (left, right) =>
          this.effectiveDepth(right, now) -
            this.effectiveDepth(left, now) ||
          left.order - right.order,
      )
      .map((entry) => entry.task);
  }

  private selectNextEntry():
    | {
        entry: QueueEntry;
        entryIndex: number;
        scheduleIndex: number;
      }
    | undefined {
    if (this.#entries.length === 0) {
      return undefined;
    }

    const now = this.clock.now();
    for (let offset = 0; offset < this.#schedule.length; offset += 1) {
      const scheduleIndex =
        (this.#scheduleCursor + offset) % this.#schedule.length;
      const desiredDepth = this.#schedule[scheduleIndex];
      if (desiredDepth === undefined) {
        continue;
      }
      const candidates = this.#entries
        .map((entry, entryIndex) => ({ entry, entryIndex }))
        .filter(
          ({ entry }) => this.effectiveDepth(entry, now) === desiredDepth,
        )
        .sort(
          (left, right) =>
            Number(right.entry.parentWakeupBoost) -
              Number(left.entry.parentWakeupBoost) ||
            left.entry.order - right.entry.order,
        );
      const selected = candidates[0];
      if (selected) {
        return {
          ...selected,
          scheduleIndex,
        };
      }
    }
    return undefined;
  }

  private effectiveDepth(entry: QueueEntry, now: number): SchedulingDepth {
    if (entry.parentWakeupBoost) {
      return MAX_SCHEDULING_DEPTH;
    }
    const agingBoost = Math.floor(
      Math.max(0, now - entry.enqueuedAt) / this.policy.agingThresholdMs,
    );
    return Math.min(
      MAX_SCHEDULING_DEPTH,
      entry.task.depth + agingBoost,
    ) as SchedulingDepth;
  }

  private buildSchedule(
    weights: Readonly<Record<SchedulingDepth, number>>,
  ): SchedulingDepth[] {
    const schedule: SchedulingDepth[] = [];
    for (
      let depth = MAX_SCHEDULING_DEPTH;
      depth >= 1;
      depth -= 1
    ) {
      const schedulingDepth = depth as SchedulingDepth;
      const weight = weights[schedulingDepth];
      if (!Number.isInteger(weight) || weight <= 0) {
        throw new Error(
          `Ready queue weight for depth ${depth} must be a positive integer.`,
        );
      }
      schedule.push(
        ...Array.from({ length: weight }, () => schedulingDepth),
      );
    }
    return schedule;
  }
}
