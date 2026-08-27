import {
  MAX_AGENT_DEPTH,
  type TaskControlBlock,
} from '../kernel/task-control-block.js';

export type AgentPoolPolicy = {
  maxDepth: number;
  maxLiveAgents: number;
  maxSpawnedPerRoot: number;
};

export type SpawnRejectionReason =
  | 'live_pool_exhausted'
  | 'max_depth_exceeded'
  | 'parent_not_live'
  | 'root_spawn_limit_exceeded';

export type SpawnReservationDecision =
  | {
      reserved: true;
      reservation: SpawnReservation;
    }
  | {
      reserved: false;
      reason: SpawnRejectionReason;
      message: string;
    };

export class SpawnReservation {
  #settled = false;

  constructor(
    readonly count: number,
    readonly commitReservation: (
      childTasks: readonly TaskControlBlock[],
    ) => void,
    readonly releaseReservation: () => void,
  ) {}

  commit(childTasks: readonly TaskControlBlock[]): void {
    if (this.#settled) {
      throw new Error('Spawn reservation has already been settled.');
    }
    if (childTasks.length !== this.count) {
      throw new Error(
        `Spawn reservation expected ${this.count} children, received ${childTasks.length}.`,
      );
    }
    this.#settled = true;
    this.commitReservation(childTasks);
  }

  close(): void {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    this.releaseReservation();
  }
}

export class AgentPool {
  readonly #liveTaskIds = new Set<string>();
  readonly #restoredTaskIds = new Set<string>();
  readonly #parentByChild = new Map<string, string>();
  readonly #childrenByParent = new Map<string, Set<string>>();
  readonly #spawnedByRoot = new Map<string, number>();
  readonly #reservedByRoot = new Map<string, number>();
  #reservedLiveSlots = 0;
  #peakLiveCount = 0;

  constructor(readonly policy: AgentPoolPolicy) {
    if (
      !Number.isInteger(policy.maxDepth) ||
      !Number.isInteger(policy.maxLiveAgents) ||
      !Number.isInteger(policy.maxSpawnedPerRoot) ||
      policy.maxDepth <= 0 ||
      policy.maxDepth > MAX_AGENT_DEPTH ||
      policy.maxLiveAgents <= 0 ||
      policy.maxSpawnedPerRoot < 0
    ) {
      throw new Error(
        `Agent pool limits must be valid integers and maxDepth must be between 1 and ${MAX_AGENT_DEPTH}.`,
      );
    }
  }

  get liveCount(): number {
    return this.#liveTaskIds.size;
  }

  get peakLiveCount(): number {
    return this.#peakLiveCount;
  }

  get availableLiveSlots(): number {
    return Math.max(
      0,
      this.policy.maxLiveAgents -
        this.#liveTaskIds.size -
        this.#reservedLiveSlots,
    );
  }

  registerRoot(task: TaskControlBlock): void {
    if (task.parentTaskId !== undefined || task.depth !== 1) {
      throw new Error(`Task ${task.id} is not a root task.`);
    }
    if (this.#liveTaskIds.has(task.id)) {
      throw new Error(`Root task is already live: ${task.id}`);
    }
    if (this.availableLiveSlots <= 0) {
      throw new Error('Agent pool has no free live slots for a root task.');
    }
    this.#liveTaskIds.add(task.id);
    this.updatePeakLiveCount();
    this.#spawnedByRoot.set(task.rootTaskId, 0);
  }

  registerRestored(task: TaskControlBlock): void {
    if (this.#restoredTaskIds.has(task.id)) {
      return;
    }
    const isLive = task.state.status !== 'TERMINATED';
    if (isLive && this.availableLiveSlots <= 0) {
      throw new Error(`Agent pool cannot restore task ${task.id}: pool is full.`);
    }
    this.#restoredTaskIds.add(task.id);
    if (!this.#spawnedByRoot.has(task.rootTaskId)) {
      this.#spawnedByRoot.set(task.rootTaskId, 0);
    }
    if (task.parentTaskId !== undefined) {
      this.#spawnedByRoot.set(
        task.rootTaskId,
        this.spawnedCount(task.rootTaskId) + 1,
      );
    }
    if (!isLive) {
      return;
    }
    this.#liveTaskIds.add(task.id);
    this.updatePeakLiveCount();
    if (task.parentTaskId !== undefined) {
      this.#parentByChild.set(task.id, task.parentTaskId);
      const children =
        this.#childrenByParent.get(task.parentTaskId) ?? new Set<string>();
      children.add(task.id);
      this.#childrenByParent.set(task.parentTaskId, children);
    }
  }

  tryReserveChildren(
    parent: TaskControlBlock,
    count: number,
  ): SpawnReservationDecision {
    if (!this.#liveTaskIds.has(parent.id)) {
      return {
        reserved: false,
        reason: 'parent_not_live',
        message: 'The requesting Agent is no longer live.',
      };
    }
    if (parent.depth >= this.policy.maxDepth) {
      return {
        reserved: false,
        reason: 'max_depth_exceeded',
        message: `Task depth ${parent.depth} reached max depth ${this.policy.maxDepth}.`,
      };
    }
    if (count <= 0 || !Number.isInteger(count)) {
      throw new Error('Spawn count must be a positive integer.');
    }
    if (count > this.availableLiveSlots) {
      return {
        reserved: false,
        reason: 'live_pool_exhausted',
        message: `Agent pool has ${this.availableLiveSlots} free slots but ${count} are required.`,
      };
    }

    const rootTaskId = parent.rootTaskId;
    const spawned = this.#spawnedByRoot.get(rootTaskId) ?? 0;
    const reserved = this.#reservedByRoot.get(rootTaskId) ?? 0;
    if (spawned + reserved + count > this.policy.maxSpawnedPerRoot) {
      return {
        reserved: false,
        reason: 'root_spawn_limit_exceeded',
        message: 'The current task tree reached its cumulative spawn limit.',
      };
    }

    this.#reservedLiveSlots += count;
    this.#reservedByRoot.set(rootTaskId, reserved + count);

    const release = () => {
      this.#reservedLiveSlots -= count;
      this.#decrementRootReservation(rootTaskId, count);
    };

    return {
      reserved: true,
      reservation: new SpawnReservation(
        count,
        (childTasks) => {
          release();
          const childTaskIds = new Set(
            childTasks.map((child) => child.id),
          );
          if (childTaskIds.size !== childTasks.length) {
            throw new Error('Spawned child task IDs must be unique.');
          }
          for (const child of childTasks) {
            if (
              child.parentTaskId !== parent.id ||
              child.rootTaskId !== rootTaskId ||
              child.depth !== parent.depth + 1
            ) {
              throw new Error(
                `Child task ${child.id} does not match its reserved lineage.`,
              );
            }
            if (this.#liveTaskIds.has(child.id)) {
              throw new Error(`Child task is already live: ${child.id}`);
            }
          }

          const children =
            this.#childrenByParent.get(parent.id) ?? new Set<string>();
          for (const child of childTasks) {
            this.#liveTaskIds.add(child.id);
            this.#parentByChild.set(child.id, parent.id);
            children.add(child.id);
          }
          this.updatePeakLiveCount();
          this.#childrenByParent.set(parent.id, children);
          this.#spawnedByRoot.set(
            rootTaskId,
            this.spawnedCount(rootTaskId) + count,
          );
        },
        release,
      ),
    };
  }

  release(taskId: string): boolean {
    if (!this.#liveTaskIds.delete(taskId)) {
      return false;
    }
    const parentTaskId = this.#parentByChild.get(taskId);
    if (parentTaskId !== undefined) {
      this.#parentByChild.delete(taskId);
      const children = this.#childrenByParent.get(parentTaskId);
      children?.delete(taskId);
      if (children?.size === 0) {
        this.#childrenByParent.delete(parentTaskId);
      }
    }
    return true;
  }

  isLive(taskId: string): boolean {
    return this.#liveTaskIds.has(taskId);
  }

  childrenOf(parentTaskId: string): readonly string[] {
    return [...(this.#childrenByParent.get(parentTaskId) ?? [])];
  }

  spawnedCount(rootTaskId: string): number {
    return this.#spawnedByRoot.get(rootTaskId) ?? 0;
  }

  canTaskSpawn(task: TaskControlBlock): boolean {
    return (
      this.#liveTaskIds.has(task.id) &&
      task.depth < this.policy.maxDepth &&
      this.availableLiveSlots > 0 &&
      this.spawnedCount(task.rootTaskId) +
        (this.#reservedByRoot.get(task.rootTaskId) ?? 0) <
        this.policy.maxSpawnedPerRoot
    );
  }

  #decrementRootReservation(rootTaskId: string, count: number): void {
    const remaining = (this.#reservedByRoot.get(rootTaskId) ?? 0) - count;
    if (remaining <= 0) {
      this.#reservedByRoot.delete(rootTaskId);
      return;
    }
    this.#reservedByRoot.set(rootTaskId, remaining);
  }

  private updatePeakLiveCount(): void {
    this.#peakLiveCount = Math.max(
      this.#peakLiveCount,
      this.#liveTaskIds.size,
    );
  }
}
