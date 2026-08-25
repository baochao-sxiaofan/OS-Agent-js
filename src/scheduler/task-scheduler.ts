import type {
  ContextItem,
  ToolCallContextItem,
} from '../kernel/context.js';
import type { AsyncWorkRegistration } from '../kernel/async-work.js';
import type {
  ContextCompactionRequest,
  ContextCompactor,
} from '../context/context-compactor.js';
import { createContextCompactionRequest } from '../context/context-compactor.js';
import {
  ContextWindowManager,
  type ContextWindowPolicy,
} from '../context/context-window-manager.js';
import {
  TaskControlBlock,
  type AgentCreationOrigin,
  type CreateAgentRequest,
} from '../kernel/task-control-block.js';
import type { TaskState, Termination } from '../kernel/task-state.js';
import type {
  ModelProvider,
  ModelRequest,
  SubagentSpawnRequest,
  ToolCallRequest,
} from '../model/model-provider.js';
import { TURN_SUMMARY_PROTOCOL } from '../model/model-provider.js';
import type { TaskStore } from '../persistence/task-store.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import { ToolNotFoundError, ToolRegistry } from '../tools/tool-registry.js';
import type { Tool } from '../tools/tool.js';
import {
  AdmissionController,
  SystemClock,
  type AdmissionDecision,
  type AdmissionLease,
  type Clock,
} from './admission-controller.js';
import {
  AgentPool,
  type SpawnRejectionReason,
} from './agent-pool.js';
import { ReadyQueue } from './ready-queue.js';

export type SchedulerRunResult = {
  activeOperations: number;
  pendingReadyTasks: number;
  stalled: boolean;
};

export type SchedulerMetricsSnapshot = {
  readyQueue: {
    current: number;
    peak: number;
  };
  liveAgents: {
    current: number;
    peak: number;
  };
  providerRequests: {
    active: number;
    peakActive: number;
  };
};

export type TaskSchedulerOptions = {
  provider: ModelProvider;
  admission: AdmissionController;
  tools: ToolRegistry;
  store: TaskStore;
  agentPool?: AgentPool;
  contextCompactor?: ContextCompactor;
  contextWindowPolicy?: ContextWindowPolicy;
  readyQueue?: ReadyQueue;
  asyncWorkPolicy?: AsyncWorkPolicy;
  // 与准入控制共享的时钟，便于测试注入。
  clock?: Clock;
  // 自动唤醒时使用的等待实现，默认基于 setTimeout。
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type AsyncWorkPolicy = Readonly<{
  batchWindowMs: number;
}>;

export type SubagentSpawnFailureReason =
  | SpawnRejectionReason
  | 'capability_escalation'
  | 'invalid_spawn_request'
  | 'invalid_parent_state';

export type SpawnChildrenResult =
  | {
      spawned: true;
      tasks: readonly TaskControlBlock[];
    }
  | {
      spawned: false;
      reason: SubagentSpawnFailureReason;
      message: string;
    };

type PendingContextCompaction = {
  context: readonly ContextItem[];
  parentWakeupBoost: boolean;
  sourceEndIndex: number;
};

type AsyncWorkTimer = {
  generationId: string;
  controller: AbortController;
};

type ResolvedToolCall = {
  call: ToolCallRequest;
  tool: Tool;
};

// 任务完成句柄：外部可以 await 单个任务的终止结果，而不必依赖整体 runUntilIdle。
type CompletionDeferred = {
  promise: Promise<Termination>;
  resolve: (termination: Termination) => void;
};

function createCompletionDeferred(): CompletionDeferred {
  let resolve!: (termination: Termination) => void;
  const promise = new Promise<Termination>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// 默认的等待实现：真实时钟下用 setTimeout；测试可注入以配合 ManualClock 保持确定性。
function defaultWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export type SchedulerRunOptions = {
  signal?: AbortSignal;
};

export type RestoreTasksOptions = {
  /** 全库恢复时，是否取消持久化集合中找不到父任务的存活子任务。 */
  cancelOrphans?: boolean;
};

export class TaskScheduler {
  readonly #provider: ModelProvider;
  readonly #admission: AdmissionController;
  readonly #tools: ToolRegistry;
  readonly #store: TaskStore;
  readonly #agentPool: AgentPool;
  readonly #readyQueue: ReadyQueue;
  readonly #asyncWorkPolicy: AsyncWorkPolicy;
  readonly #contextCompactor: ContextCompactor | undefined;
  readonly #contextWindowManager: ContextWindowManager;
  readonly #tasks = new Map<string, TaskControlBlock>();
  readonly #operations = new Map<string, Promise<void>>();
  readonly #abortControllers = new Map<string, AbortController>();
  readonly #pendingContextCompactions = new Map<
    string,
    PendingContextCompaction
  >();
  readonly #preparedContexts = new Map<string, readonly ContextItem[]>();
  readonly #asyncWorkTimers = new Map<string, AsyncWorkTimer>();
  readonly #asyncWorkWakeReady = new Set<string>();
  readonly #asyncWorkMutations = new Map<string, Promise<void>>();
  // 每个任务的完成句柄：终止时 resolve，供 waitForTermination 使用。
  readonly #completions = new Map<string, CompletionDeferred>();
  readonly #clock: Clock;
  readonly #wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  // 最近一次因限流被拒的最早可重试时刻，run() 用它决定休眠多久后自动唤醒。
  #nextRetryAt: number | undefined;
  #operationSequence = 0;

  constructor(options: TaskSchedulerOptions) {
    this.#provider = options.provider;
    this.#admission = options.admission;
    this.#tools = options.tools;
    this.#store = options.store;
    this.#asyncWorkPolicy = {
      ...(options.asyncWorkPolicy ?? { batchWindowMs: 30_000 }),
    };
    if (
      !Number.isFinite(this.#asyncWorkPolicy.batchWindowMs) ||
      this.#asyncWorkPolicy.batchWindowMs <= 0
    ) {
      throw new Error('Async work batch window must be greater than zero.');
    }
    this.#clock = options.clock ?? new SystemClock();
    this.#wait = options.wait ?? defaultWait;
    this.#contextCompactor = options.contextCompactor;
    this.#contextWindowManager = new ContextWindowManager(
      options.provider.contextWindowTokens,
      options.contextWindowPolicy,
    );
    this.#agentPool =
      options.agentPool ??
      new AgentPool({
        maxDepth: 3,
        maxLiveAgents: 20,
        maxSpawnedPerRoot: 100,
      });
    this.#readyQueue = options.readyQueue ?? new ReadyQueue();
  }

  get readyQueueSize(): number {
    return this.#readyQueue.size;
  }

  get activeOperationCount(): number {
    return this.#operations.size;
  }

  get liveAgentCount(): number {
    return this.#agentPool.liveCount;
  }

  get metrics(): SchedulerMetricsSnapshot {
    return {
      readyQueue: {
        current: this.#readyQueue.size,
        peak: this.#readyQueue.peakSize,
      },
      liveAgents: {
        current: this.#agentPool.liveCount,
        peak: this.#agentPool.peakLiveCount,
      },
      providerRequests: {
        active: this.#admission.activeRequests,
        peakActive: this.#admission.peakActiveRequests,
      },
    };
  }

  async submit(request: CreateAgentRequest): Promise<TaskControlBlock> {
    const task = this.createAgent(request, { kind: 'root' });
    if (this.#tasks.has(task.id)) {
      throw new Error(`Task ID has already been used: ${task.id}`);
    }
    this.#agentPool.registerRoot(task);
    this.#tasks.set(task.id, task);
    this.#abortControllers.set(task.id, new AbortController());
    this.#ensureCompletion(task.id);
    await this.prepareTaskForQueue(task);
    await this.#store.persist(task);
    return task;
  }

  /**
   * 所有新 Agent 的统一内核创建入口。
   *
   * 创建时间来自调度器 Clock；根任务和子任务的血缘与深度由 TCB 根据 origin
   * 推导。子任务在调用这里之前仍必须先完成 AgentPool 原子预留。
   */
  private createAgent(
    request: CreateAgentRequest,
    origin: AgentCreationOrigin,
  ): TaskControlBlock {
    if (
      origin.kind === 'child' &&
      origin.parent.depth >= this.#agentPool.policy.maxDepth
    ) {
      throw new Error(
        `Task depth ${origin.parent.depth} reached max depth ${this.#agentPool.policy.maxDepth}.`,
      );
    }
    return TaskControlBlock.createAgent(
      request,
      origin,
      this.#clock.now(),
    );
  }

  getTask(taskId: string): TaskControlBlock | undefined {
    return this.#tasks.get(taskId);
  }

  // 返回单个任务的完成 Promise。任务尚未终止时挂起，终止后 resolve 出终止结果；
  // 已经终止的任务会立即 resolve，避免调用方永久等待。
  waitForTermination(taskId: string): Promise<Termination> {
    const task = this.#tasks.get(taskId);
    if (task && task.state.status === 'TERMINATED') {
      return Promise.resolve(task.state.termination);
    }
    return this.#ensureCompletion(taskId).promise;
  }

  #ensureCompletion(taskId: string): CompletionDeferred {
    let completion = this.#completions.get(taskId);
    if (!completion) {
      completion = createCompletionDeferred();
      this.#completions.set(taskId, completion);
    }
    return completion;
  }

  async spawnChildren(
    parentTaskId: string,
    childOptions: readonly CreateAgentRequest[],
  ): Promise<SpawnChildrenResult> {
    const parent = this.requireTask(parentTaskId);
    return await this.startAsyncWork(parent, [], childOptions);
  }

  private async startAsyncWork(
    parent: TaskControlBlock,
    toolCalls: readonly ToolCallRequest[],
    childOptions: readonly CreateAgentRequest[],
  ): Promise<SpawnChildrenResult> {
    if (parent.state.status !== 'RUNNING') {
      return {
        spawned: false,
        reason: 'invalid_parent_state',
        message: `Task ${parent.id} cannot spawn from ${parent.state.status}.`,
      };
    }
    if (childOptions.length === 0 && toolCalls.length === 0) {
      return await this.rejectSubagentSpawn(
        parent,
        'invalid_spawn_request',
        'At least one asynchronous work item is required.',
      );
    }
    const childTaskIds = childOptions
      .map((options) => options.id)
      .filter((taskId): taskId is string => taskId !== undefined);
    if (
      new Set(childTaskIds).size !== childTaskIds.length ||
      childTaskIds.some((taskId) => this.#tasks.has(taskId))
    ) {
      return await this.rejectSubagentSpawn(
        parent,
        'invalid_spawn_request',
        'Child task IDs must be unique and must not have been used before.',
      );
    }
    const requestedWorkIds = [
      ...toolCalls.map((call) => call.callId),
      ...childTaskIds,
    ];
    const usedWorkIds = new Set(
      parent.asyncWorkGenerations.flatMap((generation) =>
        generation.work.map((work) => work.workId),
      ),
    );
    if (
      new Set(requestedWorkIds).size !== requestedWorkIds.length ||
      requestedWorkIds.some((workId) => usedWorkIds.has(workId))
    ) {
      return await this.rejectSubagentSpawn(
        parent,
        'invalid_spawn_request',
        'Asynchronous work IDs must be unique and must not be reused.',
      );
    }

    const capabilityEscalation = childOptions
      .flatMap((options) => options.capabilities ?? [])
      .find((capability) => !parent.hasCapability(capability));
    if (capabilityEscalation !== undefined) {
      return await this.rejectSubagentSpawn(
        parent,
        'capability_escalation',
        `Child requested capability not held by parent: ${capabilityEscalation}.`,
      );
    }

    let resolvedToolCalls: ResolvedToolCall[];
    try {
      resolvedToolCalls = toolCalls.map((call) => ({
        call,
        tool: this.resolveAuthorizedTool(parent, call),
      }));
    } catch (error) {
      const message = this.errorMessage(error);
      await this.terminateTask(parent, {
        kind: 'failed',
        error: message,
      });
      return {
        spawned: false,
        reason: 'invalid_spawn_request',
        message,
      };
    }
    const reservationDecision =
      childOptions.length === 0
        ? undefined
        : this.#agentPool.tryReserveChildren(parent, childOptions.length);
    if (reservationDecision && !reservationDecision.reserved) {
      return await this.rejectSubagentSpawn(
        parent,
        reservationDecision.reason,
        reservationDecision.message,
      );
    }

    // === 同步准入临界区（对 AgentPool 的 P 操作）===
    // 从 createAgent 到子任务登记之间没有 await，在单线程事件循环内天然原子：
    // 池扣减、Work Table 登记与预留提交要么整体完成、要么因同步异常整体回滚。
    // 因此并发创建彼此不会交错，无需再依赖 spawn_in_progress 锁。
    let children: TaskControlBlock[];
    try {
      children = childOptions.map((options) =>
        this.createAgent(options, { kind: 'child', parent }),
      );
      const now = this.#clock.now();
      const work: AsyncWorkRegistration[] = [
        ...resolvedToolCalls.map(({ call }) => ({
          workId: call.callId,
          kind: 'tool' as const,
          label: call.toolName,
          toolName: call.toolName,
        })),
        ...children.map((child) => ({
          workId: child.id,
          kind: 'subagent' as const,
          label: child.goal,
          childTaskId: child.id,
        })),
      ];
      // 先建立 Work Table 再提交预留，确保 ID 冲突不会留下孤立子任务或漏扣槽位。
      parent.registerAsyncWork(work, now);
      if (reservationDecision?.reserved) {
        reservationDecision.reservation.commit(children);
      }
      for (const child of children) {
        this.#tasks.set(child.id, child);
        this.#abortControllers.set(child.id, new AbortController());
        this.#ensureCompletion(child.id);
        parent.recordSubagentSpawned(child.id, child.depth);
      }
      for (const { call } of resolvedToolCalls) {
        parent.recordToolCall(call.callId, call.toolName);
        parent.appendContext({
          type: 'tool_call',
          callId: call.callId,
          toolName: call.toolName,
          input: call.input,
        });
      }
    } catch (error) {
      // 同步登记阶段异常：预留尚未 commit，直接 close 释放（V），避免槽位泄漏。
      if (reservationDecision?.reserved) {
        reservationDecision.reservation.close();
      }
      throw error;
    }

    // === 异步“发送”阶段 ===
    // 池与 Work Table 已稳定，父任务随后阻塞。子任务的持久化与入队相当于把已
    // 建好的子 Agent 从创建队列发送出去；任一子任务发送失败都会 V 回其槽位。
    await this.settleParentAfterAsyncWorkTurn(parent);
    for (const child of children) {
      await this.sendSpawnedChild(parent, child);
    }
    if (resolvedToolCalls.length > 0) {
      this.launchAsyncToolCalls(parent, resolvedToolCalls);
    }

    return {
      spawned: true,
      tasks: children,
    };
  }

  /**
   * 发送一个已经通过准入的子 Agent：持久化并加入就绪队列。
   *
   * 这是创建流程的“发送”阶段，与同步准入临界区解耦。若发送失败，则把已占用的
   * live 槽位 V 回 AgentPool，清理登记，并把对应子任务工作标记为失败以唤醒父
   * 任务重新规划，避免父任务永久等待一个并未真正就绪的子 Agent。
   */
  private async sendSpawnedChild(
    parent: TaskControlBlock,
    child: TaskControlBlock,
  ): Promise<void> {
    try {
      await this.#store.persist(child);
      await this.prepareTaskForQueue(child);
    } catch (error) {
      this.#agentPool.release(child.id);
      this.#tasks.delete(child.id);
      this.#abortControllers.delete(child.id);
      this.#completions.delete(child.id);
      if (parent.state.status === 'TERMINATED') {
        return;
      }
      const termination: Termination = {
        kind: 'failed',
        error: `Failed to send subagent ${child.id}: ${this.errorMessage(error)}`,
      };
      parent.completeSubagentWork(child.id, termination, this.#clock.now());
      parent.recordSubagentResult(child.id, termination);
      await this.handleAsyncWorkProgress(parent);
    }
  }

  async restore(taskId: string): Promise<TaskControlBlock | undefined> {
    const [task] = await this.restoreMany([taskId]);
    return task;
  }

  /**
   * 批量恢复一组持久化任务。
   *
   * 恢复分为两个阶段：先完整重建任务表与 AgentPool 血缘，再恢复状态机、
   * 子任务结果、工具执行器和异步 timer。这样父任务的恢复行为不依赖数据库
   * 返回顺序，也不会在子任务尚未注册时误判其工作永久丢失。
   */
  async restoreMany(
    taskIds: readonly string[],
    options: RestoreTasksOptions = {},
  ): Promise<readonly TaskControlBlock[]> {
    if (new Set(taskIds).size !== taskIds.length) {
      throw new Error('Restored task IDs must be unique.');
    }
    const snapshots = (
      await Promise.all(
        taskIds.map(async (taskId) => await this.#store.load(taskId)),
      )
    ).filter((snapshot) => snapshot !== undefined);
    const tasks = snapshots
      .map((snapshot) => TaskControlBlock.restore(snapshot))
      .sort(
        (left, right) =>
          left.depth - right.depth ||
          left.createdAt - right.createdAt,
      );

    for (const task of tasks) {
      if (this.#tasks.has(task.id)) {
        throw new Error(`Task is already registered: ${task.id}`);
      }
    }

    // 第一阶段只重建内核登记，不执行任何调度动作。
    for (const task of tasks) {
      this.#agentPool.registerRestored(task);
      this.#tasks.set(task.id, task);
      this.#abortControllers.set(task.id, new AbortController());
      if (task.state.status !== 'TERMINATED') {
        this.#ensureCompletion(task.id);
      }
    }

    // 父任务已终止或缺失时，存活子树不再具备合法结果接收方，恢复为取消终态。
    for (const task of [...tasks].sort(
      (left, right) => left.depth - right.depth,
    )) {
      if (
        task.parentTaskId === undefined ||
        task.state.status === 'TERMINATED'
      ) {
        continue;
      }
      const parent = this.#tasks.get(task.parentTaskId);
      if (
        parent?.state.status === 'TERMINATED' ||
        (!parent && options.cancelOrphans === true)
      ) {
        await this.cancel(
          task.id,
          parent
            ? `Parent task ${parent.id} was already terminated during recovery.`
            : `Parent task ${task.parentTaskId} was missing during recovery.`,
        );
      }
    }

    // 已落盘终态的子任务可能尚未来得及更新父任务 Work Table，恢复时补做对账。
    for (const child of tasks) {
      this.reconcileRestoredSubagentResult(child);
    }

    // 崩溃会使进程内的模型请求失效；持久化 RUNNING 必须回到 READY 重新准入。
    for (const task of tasks) {
      if (task.state.status !== 'RUNNING') {
        continue;
      }
      task.transition(
        {
          status: 'READY',
          enteredAt: this.#clock.now(),
          reason: 'restored',
        },
        'recovered_incomplete_model_request',
      );
      await this.#store.persist(task);
    }

    // 重建已失联的工具执行器。相同 callId 会生成相同幂等键，具体幂等保证由
    // Tool/Skill 边界负责；内核只负责把仍为 running 的 Work Record 重新接上。
    for (const task of tasks) {
      await this.restorePendingToolWork(task);
    }

    // 最后恢复结果投递、批处理 timer 与 READY 队列。
    for (const task of tasks) {
      await this.restoreAsyncWorkScheduling(task);
      if (task.state.status === 'READY' && !this.#readyQueue.has(task.id)) {
        await this.prepareTaskForQueue(task);
      }
    }
    return tasks;
  }

  private reconcileRestoredSubagentResult(
    child: TaskControlBlock,
  ): void {
    if (
      child.parentTaskId === undefined ||
      child.state.status !== 'TERMINATED'
    ) {
      return;
    }
    const parent = this.#tasks.get(child.parentTaskId);
    if (!parent || parent.state.status === 'TERMINATED') {
      return;
    }
    const pending = parent.activeAsyncWorkGeneration?.work.some(
      (work) =>
        work.kind === 'subagent' &&
        work.childTaskId === child.id &&
        work.status === 'running',
    );
    if (!pending) {
      return;
    }
    parent.completeSubagentWork(
      child.id,
      child.state.termination,
      this.#clock.now(),
    );
    parent.recordSubagentResult(child.id, child.state.termination);
  }

  private async restorePendingToolWork(
    task: TaskControlBlock,
  ): Promise<void> {
    if (task.state.status === 'TERMINATED') {
      return;
    }
    const pendingToolWork =
      task.activeAsyncWorkGeneration?.work.filter(
        (work) => work.kind === 'tool' && work.status === 'running',
      ) ?? [];
    if (pendingToolWork.length === 0) {
      return;
    }

    const calls: ResolvedToolCall[] = [];
    let recoveredAsFailure = false;
    for (const work of pendingToolWork) {
      const contextItem = task.context.findLast(
        (item): item is ToolCallContextItem =>
          item.type === 'tool_call' &&
          item.callId === work.workId,
      );
      // 没有 tool_call 上下文的记录可能由外部恢复适配器负责，内核不能擅自
      // 把它判成失败；只有完整保存过调用参数的本地工具才由这里重启。
      if (!contextItem) {
        continue;
      }
      if (!isJsonObject(contextItem.input)) {
        task.failToolWork(
          work.workId,
          `Cannot recover tool work ${work.workId}: persisted tool call input is invalid.`,
          this.#clock.now(),
        );
        recoveredAsFailure = true;
        continue;
      }
      const call: ToolCallRequest = {
        callId: contextItem.callId,
        toolName: contextItem.toolName,
        input: contextItem.input,
      };
      try {
        calls.push({
          call,
          tool: this.resolveAuthorizedTool(task, call),
        });
      } catch (error) {
        task.failToolWork(
          work.workId,
          `Cannot recover tool work ${work.workId}: ${this.errorMessage(error)}`,
          this.#clock.now(),
        );
        recoveredAsFailure = true;
      }
    }
    if (recoveredAsFailure) {
      await this.handleAsyncWorkProgress(task);
    }
    if (calls.length > 0) {
      this.launchAsyncToolCalls(task, calls);
    }
  }

  private async restoreAsyncWorkScheduling(
    task: TaskControlBlock,
  ): Promise<void> {
    const generation = task.activeAsyncWorkGeneration;
    if (
      !generation ||
      !task.hasUndeliveredAsyncWorkResults() ||
      task.state.status === 'TERMINATED'
    ) {
      return;
    }
    if (task.isActiveAsyncWorkComplete()) {
      this.#asyncWorkWakeReady.add(task.id);
      if (task.state.status !== 'RUNNING') {
        await this.deliverAsyncWorkUpdate(task);
      }
      return;
    }
    if (generation.batchDueAt !== undefined) {
      this.scheduleAsyncWorkTimer(
        task,
        generation.generationId,
        generation.batchDueAt,
      );
      return;
    }

    // 定时器到期后会先清除 deadline，再投递结果。若进程恰好在两步之间退出，
    // 恢复时没有 deadline 就表示该批结果已经到期，应立即补做投递。
    this.#asyncWorkWakeReady.add(task.id);
    if (task.state.status !== 'RUNNING') {
      await this.deliverAsyncWorkUpdate(task);
    }
  }

  async wake(
    taskId: string,
    contextItems: readonly ContextItem[],
    reason = 'external_result_available',
  ): Promise<void> {
    const task = this.requireTask(taskId);
    if (task.state.status !== 'BLOCKED') {
      throw new Error(`Cannot wake task ${taskId} from ${task.state.status}`);
    }

    for (const item of contextItems) {
      task.appendContext(item);
    }
    task.transition(
      {
        status: 'READY',
        enteredAt: Date.now(),
        reason: 'tool_result_available',
      },
      reason,
    );
    await this.prepareTaskForQueue(task);
    await this.#store.persist(task);
  }

  async cancel(taskId: string, reason: string): Promise<void> {
    const task = this.requireTask(taskId);
    if (task.state.status === 'TERMINATED') {
      return;
    }

    await this.terminateTask(task, {
      kind: 'cancelled',
      reason,
    });
  }

  async runUntilIdle(): Promise<SchedulerRunResult> {
    while (true) {
      const compactionProgress = await this.scheduleContextCompactions();
      const schedulingProgress = await this.scheduleReadyTasks();
      const madeProgress = compactionProgress || schedulingProgress;
      const pendingTasks =
        this.#readyQueue.size + this.#pendingContextCompactions.size;

      if (this.#operations.size === 0) {
        if (pendingTasks > 0 && madeProgress) {
          continue;
        }
        return {
          activeOperations: 0,
          pendingReadyTasks: pendingTasks,
          stalled: pendingTasks > 0 && !madeProgress,
        };
      }

      await Promise.race(this.#operations.values());
    }
  }

  // 在 runUntilIdle 的基础上增加自动唤醒：当任务仅因 RPM/TPM 限流而停滞时，
  // 休眠到最早可重试时刻后重新调度，避免限流任务被静默挂起。
  // 只有在没有任何未来重试时刻（真正无进展）时才返回。
  async run(options: SchedulerRunOptions = {}): Promise<SchedulerRunResult> {
    const { signal } = options;
    while (true) {
      signal?.throwIfAborted();
      const result = await this.runUntilIdle();
      if (!result.stalled) {
        return result;
      }
      const retryAt = this.#nextRetryAt;
      if (retryAt === undefined) {
        return result;
      }
      this.#nextRetryAt = undefined;
      const delay = Math.max(0, retryAt - this.#clock.now());
      await this.#wait(delay, signal);
    }
  }

  private async scheduleReadyTasks(): Promise<boolean> {
    let madeProgress = false;

    while (this.#readyQueue.size > 0) {
      const task = this.#readyQueue.peek();
      if (!task) {
        break;
      }
      if (task.modelAttempts >= task.maxModelAttempts) {
        await this.terminateTask(task, {
          kind: 'failed',
          error: `Task exceeded ${task.maxModelAttempts} model attempts.`,
        });
        madeProgress = true;
        continue;
      }

      const preparedContext = this.#preparedContexts.get(task.id);
      if (!preparedContext) {
        this.#readyQueue.remove(task.id);
        await this.prepareTaskForQueue(task);
        madeProgress = true;
        continue;
      }
      const pendingRequest = this.buildModelRequest(
        task,
        task.modelAttempts + 1,
        preparedContext,
      );
      const estimate = this.#provider.estimate(pendingRequest);
      const decision = this.#admission.tryAcquire(
        estimate,
        task.budget.maxCostUsd - task.budget.spentCostUsd,
      );

      if (!decision.admitted) {
        await this.handleAdmissionDenied(task, decision);
        if (!decision.retryable) {
          madeProgress = true;
          continue;
        }
        break;
      }

      this.#readyQueue.dequeue();
      this.#preparedContexts.delete(task.id);
      const attempt = task.startModelAttempt();
      const request = this.buildModelRequest(task, attempt, preparedContext);
      task.transition(
        {
          status: 'RUNNING',
          enteredAt: Date.now(),
          providerId: this.#provider.id,
          requestAttempt: attempt,
          operation: 'model',
        },
        'model_request_admitted',
      );
      await this.#store.persist(task);
      this.launchModelRequest(task, request, decision.lease);
      madeProgress = true;
    }

    return madeProgress;
  }

  private async handleAdmissionDenied(
    task: TaskControlBlock,
    decision: Exclude<AdmissionDecision, { admitted: true }>,
  ): Promise<void> {
    task.recordCapacityWait(decision.reasons, decision.retryAt);
    if (!decision.retryable) {
      await this.terminateTask(task, {
        kind: 'failed',
        error: `Request admission failed: ${decision.reasons.join(', ')}`,
      });
      return;
    }
    // 记录最早可重试时刻，供后台 run() 在限流窗口结束后自动唤醒。
    if (decision.retryAt !== undefined) {
      this.#nextRetryAt =
        this.#nextRetryAt === undefined
          ? decision.retryAt
          : Math.min(this.#nextRetryAt, decision.retryAt);
    }
    await this.#store.persist(task);
  }

  private launchModelRequest(
    task: TaskControlBlock,
    request: ModelRequest,
    lease: AdmissionLease,
  ): void {
    const operation = this.executeModelRequest(task, request, lease);
    this.trackOperation(`model:${task.id}`, operation);
  }

  private async executeModelRequest(
    task: TaskControlBlock,
    request: ModelRequest,
    lease: AdmissionLease,
  ): Promise<void> {
    const signal = this.requireAbortController(task.id).signal;

    try {
      const response = await this.#provider.invoke(request, signal);
      lease.close();

      if (task.state.status === 'TERMINATED') {
        return;
      }

      task.recordModelResponse(response.type, response.usage);
      switch (response.type) {
        case 'final':
          task.completeModelTurn(response.turnSummary);
          await this.terminateTask(task, {
            kind: 'completed',
            output: response.output,
          });
          return;
        case 'needs_parent_action':
          task.completeModelTurn(response.turnSummary);
          await this.terminateTask(task, {
            kind: 'needs_parent_action',
            requiredWork: response.requiredWork,
            ...(response.partialOutput === undefined
              ? {}
              : { partialOutput: response.partialOutput }),
          });
          return;
        case 'spawn_subagents':
          if (response.children.length === 0) {
            throw new Error(
              'Model requested subagent spawning without child tasks.',
            );
          }
          task.completeModelTurn(response.turnSummary);
          await this.startAsyncWork(
            task,
            [],
            response.children.map((child) =>
              this.toCreateAgentRequest(child),
            ),
          );
          return;
        case 'tool_calls':
          if (response.calls.length === 0) {
            throw new Error('Model requested tools without tool calls.');
          }
          task.completeModelTurn(response.turnSummary);
          await this.startAsyncWork(task, response.calls, []);
          return;
        case 'async_work':
          if (
            response.calls.length === 0 &&
            response.children.length === 0
          ) {
            throw new Error(
              'Model requested asynchronous work without work items.',
            );
          }
          task.completeModelTurn(response.turnSummary);
          await this.startAsyncWork(
            task,
            response.calls,
            response.children.map((child) =>
              this.toCreateAgentRequest(child),
            ),
          );
          return;
        case 'wait_for_async_work':
          task.completeModelTurn(response.turnSummary);
          await this.settleParentAfterAsyncWorkTurn(task);
          return;
        default: {
          const exhaustiveResponse: never = response;
          throw new Error(
            `Unhandled model response: ${String(exhaustiveResponse)}`,
          );
        }
      }
    } catch (error) {
      lease.close();
      if (task.state.status === 'TERMINATED') {
        return;
      }
      if (
        this.#asyncWorkWakeReady.has(task.id) &&
        task.hasUndeliveredAsyncWorkResults()
      ) {
        await this.settleParentAfterAsyncWorkTurn(task);
        return;
      }
      await this.handleModelFailure(task, error);
    }
  }

  private launchAsyncToolCalls(
    task: TaskControlBlock,
    calls: readonly ResolvedToolCall[],
  ): void {
    const operation = this.executeAsyncToolCalls(task, calls);
    this.trackOperation(`tools:${task.id}`, operation);
  }

  private async executeAsyncToolCalls(
    task: TaskControlBlock,
    calls: readonly ResolvedToolCall[],
  ): Promise<void> {
    const readOnlyCalls = calls.filter(
      ({ tool }) => tool.effect === 'read_only',
    );
    const effectfulCalls = calls.filter(
      ({ tool }) => tool.effect !== 'read_only',
    );

    await Promise.all(
      readOnlyCalls.map(async (resolved) => {
        await this.executeAsyncToolCall(task, resolved);
      }),
    );
    for (const resolved of effectfulCalls) {
      await this.executeAsyncToolCall(task, resolved);
    }
  }

  private async executeAsyncToolCall(
    task: TaskControlBlock,
    { call, tool }: ResolvedToolCall,
  ): Promise<void> {
    if (this.isTaskTerminated(task)) {
      return;
    }
    try {
      const output = await this.executeResolvedTool(task, call, tool);
      if (task.state.status === 'TERMINATED') {
        return;
      }
      task.recordToolResult(call.callId, call.toolName, output);
      task.completeToolWork(call.callId, output, this.#clock.now());
    } catch (error) {
      if (task.state.status === 'TERMINATED') {
        return;
      }
      task.failToolWork(
        call.callId,
        this.errorMessage(error),
        this.#clock.now(),
      );
    }
    await this.handleAsyncWorkProgress(task);
  }

  private async handleAsyncWorkProgress(
    parent: TaskControlBlock,
  ): Promise<void> {
    await this.serializeAsyncWorkMutation(parent.id, async () => {
      await this.processAsyncWorkProgress(parent);
    });
  }

  private async processAsyncWorkProgress(
    parent: TaskControlBlock,
  ): Promise<void> {
    if (parent.state.status === 'TERMINATED') {
      return;
    }
    const generation = parent.activeAsyncWorkGeneration;
    if (!generation || !parent.hasUndeliveredAsyncWorkResults()) {
      await this.#store.persist(parent);
      return;
    }

    if (parent.isActiveAsyncWorkComplete()) {
      this.cancelAsyncWorkTimer(parent, generation.generationId);
      this.#asyncWorkWakeReady.add(parent.id);
      await this.#store.persist(parent);
      if (parent.state.status !== 'RUNNING') {
        await this.deliverAsyncWorkUpdate(parent);
      }
      return;
    }

    if (!this.#asyncWorkTimers.has(parent.id)) {
      const dueAt =
        this.#clock.now() + this.#asyncWorkPolicy.batchWindowMs;
      parent.setAsyncWorkBatchDueAt(generation.generationId, dueAt);
      this.scheduleAsyncWorkTimer(parent, generation.generationId, dueAt);
      await this.#store.persist(parent);
      return;
    }
    await this.#store.persist(parent);
  }

  private scheduleAsyncWorkTimer(
    parent: TaskControlBlock,
    generationId: string,
    dueAt: number,
  ): void {
    const controller = new AbortController();
    this.#asyncWorkTimers.set(parent.id, {
      generationId,
      controller,
    });
    const operation = (async () => {
      try {
        await this.#wait(
          Math.max(0, dueAt - this.#clock.now()),
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        throw error;
      }
      const timer = this.#asyncWorkTimers.get(parent.id);
      if (
        !timer ||
        timer.controller !== controller ||
        timer.generationId !== generationId
      ) {
        return;
      }
      await this.serializeAsyncWorkMutation(parent.id, async () => {
        const currentTimer = this.#asyncWorkTimers.get(parent.id);
        if (
          !currentTimer ||
          currentTimer.controller !== controller ||
          currentTimer.generationId !== generationId
        ) {
          return;
        }
        this.#asyncWorkTimers.delete(parent.id);
        if (parent.state.status === 'TERMINATED') {
          return;
        }
        parent.setAsyncWorkBatchDueAt(generationId, undefined);
        this.#asyncWorkWakeReady.add(parent.id);
        if (parent.state.status !== 'RUNNING') {
          await this.deliverAsyncWorkUpdate(parent);
          return;
        }
        await this.#store.persist(parent);
      });
    })();
    this.trackOperation(`async-work-timer:${parent.id}`, operation);
  }

  private cancelAsyncWorkTimer(
    parent: TaskControlBlock,
    generationId: string,
  ): void {
    const timer = this.#asyncWorkTimers.get(parent.id);
    if (timer?.generationId === generationId) {
      timer.controller.abort(new Error('Async work batch completed.'));
      this.#asyncWorkTimers.delete(parent.id);
    }
    const active = parent.activeAsyncWorkGeneration;
    if (active?.generationId === generationId) {
      parent.setAsyncWorkBatchDueAt(generationId, undefined);
    }
  }

  private async deliverAsyncWorkUpdate(
    parent: TaskControlBlock,
  ): Promise<boolean> {
    if (parent.state.status === 'TERMINATED') {
      this.#asyncWorkWakeReady.delete(parent.id);
      return false;
    }
    if (parent.state.status === 'RUNNING') {
      this.#asyncWorkWakeReady.add(parent.id);
      return false;
    }
    if (
      parent.state.status === 'BLOCKED' &&
      parent.state.reason !== 'async_work'
    ) {
      this.#asyncWorkWakeReady.add(parent.id);
      return false;
    }

    const generation = parent.activeAsyncWorkGeneration;
    if (!generation) {
      this.#asyncWorkWakeReady.delete(parent.id);
      return false;
    }
    this.cancelAsyncWorkTimer(parent, generation.generationId);
    const update = parent.claimAsyncWorkUpdate(this.#clock.now());
    if (!update) {
      this.#asyncWorkWakeReady.delete(parent.id);
      return false;
    }
    this.#asyncWorkWakeReady.delete(parent.id);
    if (parent.state.status === 'BLOCKED') {
      parent.transition(
        {
          status: 'READY',
          enteredAt: this.#clock.now(),
          reason: 'async_work_result_available',
        },
        update.allFinished
          ? 'all_async_work_results_available'
          : 'partial_async_work_results_available',
      );
    }
    await this.prepareTaskForQueue(parent, {
      parentWakeupBoost: true,
    });
    await this.#store.persist(parent);
    return true;
  }

  private async settleParentAfterAsyncWorkTurn(
    parent: TaskControlBlock,
  ): Promise<void> {
    await this.serializeAsyncWorkMutation(parent.id, async () => {
      await this.processParentAfterAsyncWorkTurn(parent);
    });
  }

  private async processParentAfterAsyncWorkTurn(
    parent: TaskControlBlock,
  ): Promise<void> {
    if (parent.state.status !== 'RUNNING') {
      return;
    }
    if (
      this.#asyncWorkWakeReady.has(parent.id) &&
      parent.hasUndeliveredAsyncWorkResults()
    ) {
      const generation = parent.activeAsyncWorkGeneration;
      if (generation) {
        this.cancelAsyncWorkTimer(parent, generation.generationId);
      }
      const update = parent.claimAsyncWorkUpdate(this.#clock.now());
      this.#asyncWorkWakeReady.delete(parent.id);
      if (update) {
        parent.transition(
          {
            status: 'READY',
            enteredAt: this.#clock.now(),
            reason: 'async_work_result_available',
          },
          update.allFinished
            ? 'all_async_work_results_available_during_model_turn'
            : 'partial_async_work_results_available_during_model_turn',
        );
        await this.prepareTaskForQueue(parent, {
          parentWakeupBoost: true,
        });
        await this.#store.persist(parent);
        return;
      }
    }

    const pendingIds = parent.activeAsyncWorkPendingIds();
    if (pendingIds.length === 0) {
      throw new Error('Task requested asynchronous waiting without pending work.');
    }
    parent.transition(
      {
        status: 'BLOCKED',
        enteredAt: this.#clock.now(),
        reason: 'async_work',
        waitingFor: pendingIds,
      },
      'waiting_for_async_work',
    );
    await this.#store.persist(parent);
  }

  private async executeResolvedTool(
    task: TaskControlBlock,
    call: ToolCallRequest,
    tool: Tool,
  ): Promise<JsonValue> {
    const validation = tool.validateInput(call.input);
    if (!validation.valid) {
      throw new Error(
        `Invalid input for tool ${tool.name}: ${validation.error}`,
      );
    }

    return await tool.execute(call.input, {
      taskId: task.id,
      signal: this.requireAbortController(task.id).signal,
      idempotencyKey: `${task.id}:${call.callId}`,
    });
  }

  private resolveAuthorizedTool(
    task: TaskControlBlock,
    call: ToolCallRequest,
  ): Tool {
    let tool: Tool;
    try {
      tool = this.#tools.get(call.toolName);
    } catch (error) {
      if (error instanceof ToolNotFoundError) {
        throw new Error(`Model requested unavailable tool: ${call.toolName}`);
      }
      throw error;
    }

    if (!task.hasCapability(tool.requiredCapability)) {
      throw new Error(
        `Task ${task.id} lacks capability ${tool.requiredCapability}`,
      );
    }
    return tool;
  }

  private async handleModelFailure(
    task: TaskControlBlock,
    error: unknown,
  ): Promise<void> {
    if (task.canRetryModel()) {
      task.transition(
        {
          status: 'READY',
          enteredAt: Date.now(),
          reason: 'model_retry',
        },
        `model_request_failed:${this.errorMessage(error)}`,
      );
      await this.prepareTaskForQueue(task);
    } else {
      await this.terminateTask(task, {
        kind: 'failed',
        error: this.errorMessage(error),
      });
      return;
    }
    await this.#store.persist(task);
  }

  private async terminateTask(
    task: TaskControlBlock,
    termination: Termination,
  ): Promise<void> {
    if (task.state.status === 'TERMINATED') {
      return;
    }
    const childTaskIds = this.#agentPool.childrenOf(task.id);
    const nextState: TaskState = {
      status: 'TERMINATED',
      enteredAt: Date.now(),
      termination,
    };
    task.transition(nextState, `task_${termination.kind}`);
    task.recordTermination(termination);
    this.#readyQueue.remove(task.id);
    const abortReason =
      termination.kind === 'cancelled'
        ? termination.reason
        : `Task ${task.id} terminated with ${termination.kind}.`;
    const abortController = this.#abortControllers.get(task.id);
    if (abortController && !abortController.signal.aborted) {
      abortController.abort(new Error(abortReason));
    }
    const asyncWorkTimer = this.#asyncWorkTimers.get(task.id);
    asyncWorkTimer?.controller.abort(new Error('Task terminated.'));
    this.#asyncWorkTimers.delete(task.id);
    this.#asyncWorkWakeReady.delete(task.id);
    this.#pendingContextCompactions.delete(task.id);
    this.#preparedContexts.delete(task.id);
    this.#agentPool.release(task.id);
    await this.#store.persist(task);
    for (const childTaskId of childTaskIds) {
      const child = this.#tasks.get(childTaskId);
      if (child && child.state.status !== 'TERMINATED') {
        await this.cancel(
          childTaskId,
          `Parent task ${task.id} terminated before its child.`,
        );
      }
    }
    // 唤醒所有等待该任务完成的调用方，避免任务终止后 waitForTermination 永久挂起。
    this.#completions.get(task.id)?.resolve(termination);
    this.#completions.delete(task.id);
    await this.notifyParentOfTermination(task, termination);
  }

  private async rejectSubagentSpawn(
    parent: TaskControlBlock,
    reason: SubagentSpawnFailureReason,
    message: string,
  ): Promise<SpawnChildrenResult> {
    parent.appendContext({
      type: 'subagent_spawn_rejected',
      reason,
      message,
    });
    parent.transition(
      {
        status: 'READY',
        enteredAt: Date.now(),
        reason: 'capacity_available',
      },
      `subagent_spawn_rejected:${reason}`,
    );
    await this.prepareTaskForQueue(parent);
    await this.#store.persist(parent);
    return {
      spawned: false,
      reason,
      message,
    };
  }

  private async notifyParentOfTermination(
    child: TaskControlBlock,
    termination: Termination,
  ): Promise<void> {
    if (child.parentTaskId === undefined) {
      return;
    }
    const parent = this.#tasks.get(child.parentTaskId);
    if (!parent || parent.state.status === 'TERMINATED') {
      return;
    }
    try {
      parent.completeSubagentWork(
        child.id,
        termination,
        this.#clock.now(),
      );
      parent.recordSubagentResult(child.id, termination);
    } catch (error) {
      if (
        this.errorMessage(error).includes(
          'Asynchronous work is already terminal',
        )
      ) {
        return;
      }
      throw error;
    }
    await this.handleAsyncWorkProgress(parent);
  }

  private toCreateAgentRequest(
    request: SubagentSpawnRequest,
  ): CreateAgentRequest {
    return {
      goal: request.goal,
      ...(request.taskId === undefined ? {} : { id: request.taskId }),
      ...(request.capabilities === undefined
        ? {}
        : { capabilities: request.capabilities }),
      ...(request.context === undefined ? {} : { context: request.context }),
      ...(request.maxModelAttempts === undefined
        ? {}
        : { maxModelAttempts: request.maxModelAttempts }),
      ...(request.maxCostUsd === undefined
        ? {}
        : { budget: { maxCostUsd: request.maxCostUsd } }),
    };
  }

  private buildModelRequest(
    task: TaskControlBlock,
    attempt: number,
    context: readonly ContextItem[],
  ): ModelRequest {
    return {
      taskId: task.id,
      goal: task.goal,
      context,
      tools: this.#tools.descriptorsFor(task.capabilities),
      attempt,
      summaryProtocol: TURN_SUMMARY_PROTOCOL,
      delegation: {
        canSpawnSubagents: this.#agentPool.canTaskSpawn(task),
      },
    };
  }

  private async prepareTaskForQueue(
    task: TaskControlBlock,
    options: { parentWakeupBoost?: boolean } = {},
  ): Promise<void> {
    if (task.state.status !== 'READY') {
      throw new Error(
        `Cannot prepare task ${task.id} from ${task.state.status}.`,
      );
    }
    this.#readyQueue.remove(task.id);
    this.#preparedContexts.delete(task.id);
    this.#pendingContextCompactions.delete(task.id);

    const attempt = task.modelAttempts + 1;
    const selection = this.#contextWindowManager.select(
      task.context,
      task.contextSummaries,
      (context) =>
        this.totalRequestTokens(
          this.#provider.estimate(
            this.buildModelRequest(task, attempt, context),
          ),
        ),
    );

    if (!selection.needsSecondaryCompaction) {
      this.#preparedContexts.set(
        task.id,
        structuredClone(selection.context),
      );
      this.#readyQueue.enqueue(task, options);
      return;
    }

    const alreadyCompactedCurrentContext = task.contextSummaries.some(
      (summary) =>
        summary.kind === 'secondary' &&
        summary.sourceStartIndex === 0 &&
        summary.sourceEndIndex === task.context.length,
    );
    if (alreadyCompactedCurrentContext) {
      await this.terminateTask(task, {
        kind: 'failed',
        error:
          'Context remains above the target after secondary compaction.',
      });
      return;
    }
    if (!this.#contextCompactor) {
      await this.terminateTask(task, {
        kind: 'failed',
        error:
          'Context exceeds the warning threshold and no context compactor is configured.',
      });
      return;
    }

    const compactionRequest = this.buildContextCompactionRequest(
      task,
      selection.context,
    );
    const compactionEstimate =
      this.#contextCompactor.estimate(compactionRequest);
    if (
      this.totalRequestTokens(compactionEstimate) >
      this.#contextCompactor.contextWindowTokens
    ) {
      await this.terminateTask(task, {
        kind: 'failed',
        error:
          'Locally summarized context cannot fit in the secondary compactor context window.',
      });
      return;
    }

    this.#pendingContextCompactions.set(task.id, {
      context: structuredClone(selection.context),
      parentWakeupBoost: options.parentWakeupBoost ?? false,
      sourceEndIndex: task.context.length,
    });
  }

  private async scheduleContextCompactions(): Promise<boolean> {
    if (!this.#contextCompactor) {
      return false;
    }
    let madeProgress = false;

    for (const [
      taskId,
      pending,
    ] of this.#pendingContextCompactions) {
      const task = this.#tasks.get(taskId);
      if (!task || task.state.status !== 'READY') {
        this.#pendingContextCompactions.delete(taskId);
        continue;
      }
      const request = this.buildContextCompactionRequest(
        task,
        pending.context,
      );
      const estimate = this.#contextCompactor.estimate(request);
      const decision = this.#admission.tryAcquire(
        estimate,
        task.budget.maxCostUsd - task.budget.spentCostUsd,
      );
      if (!decision.admitted) {
        await this.handleAdmissionDenied(task, decision);
        if (!decision.retryable) {
          this.#pendingContextCompactions.delete(taskId);
          madeProgress = true;
          continue;
        }
        break;
      }

      this.#pendingContextCompactions.delete(taskId);
      task.transition(
        {
          status: 'RUNNING',
          enteredAt: Date.now(),
          providerId: this.#contextCompactor.id,
          requestAttempt: task.modelAttempts + 1,
          operation: 'context_compaction',
        },
        'context_compaction_admitted',
      );
      await this.#store.persist(task);
      this.launchContextCompaction(
        task,
        request,
        pending,
        decision.lease,
      );
      madeProgress = true;
    }
    return madeProgress;
  }

  private launchContextCompaction(
    task: TaskControlBlock,
    request: ContextCompactionRequest,
    pending: PendingContextCompaction,
    lease: AdmissionLease,
  ): void {
    const operation = this.executeContextCompaction(
      task,
      request,
      pending,
      lease,
    );
    this.trackOperation(`context:${task.id}`, operation);
  }

  private async executeContextCompaction(
    task: TaskControlBlock,
    request: ContextCompactionRequest,
    pending: PendingContextCompaction,
    lease: AdmissionLease,
  ): Promise<void> {
    const compactor = this.#contextCompactor;
    if (!compactor) {
      lease.close();
      return;
    }
    const signal = this.requireAbortController(task.id).signal;

    try {
      const result = await compactor.compact(request, signal);
      lease.close();
      if (task.state.status === 'TERMINATED') {
        return;
      }
      task.recordSecondaryContextSummary(
        result.summary,
        pending.sourceEndIndex,
        result.usage,
      );
      task.transition(
        {
          status: 'READY',
          enteredAt: Date.now(),
          reason: 'context_compacted',
        },
        'context_compaction_completed',
      );
      await this.prepareTaskForQueue(task, {
        parentWakeupBoost: pending.parentWakeupBoost,
      });
      await this.#store.persist(task);
    } catch (error) {
      lease.close();
      if (task.state.status === 'TERMINATED') {
        return;
      }
      await this.terminateTask(task, {
        kind: 'failed',
        error: `Context compaction failed: ${this.errorMessage(error)}`,
      });
    }
  }

  private buildContextCompactionRequest(
    task: TaskControlBlock,
    context: readonly ContextItem[],
  ): ContextCompactionRequest {
    return createContextCompactionRequest({
      taskId: task.id,
      goal: task.goal,
      context,
      targetTokens: this.#contextWindowManager.targetTokens,
    });
  }

  private totalRequestTokens(
    estimate: {
      inputTokens: number;
      maxOutputTokens: number;
    },
  ): number {
    return estimate.inputTokens + estimate.maxOutputTokens;
  }

  private trackOperation(keyPrefix: string, operation: Promise<void>): void {
    this.#operationSequence += 1;
    const operationKey = `${keyPrefix}:${this.#operationSequence}`;
    const tracked = operation.finally(() => {
      this.#operations.delete(operationKey);
    });
    this.#operations.set(operationKey, tracked);
  }

  private async serializeAsyncWorkMutation<T>(
    taskId: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.#asyncWorkMutations.get(taskId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => await mutation());
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#asyncWorkMutations.set(taskId, tail);
    try {
      return await operation;
    } finally {
      if (this.#asyncWorkMutations.get(taskId) === tail) {
        this.#asyncWorkMutations.delete(taskId);
      }
    }
  }

  private requireTask(taskId: string): TaskControlBlock {
    const task = this.#tasks.get(taskId);
    if (!task) {
      throw new Error(`Task is not registered: ${taskId}`);
    }
    return task;
  }

  private requireAbortController(taskId: string): AbortController {
    const controller = this.#abortControllers.get(taskId);
    if (!controller) {
      throw new Error(`Task has no abort controller: ${taskId}`);
    }
    return controller;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isTaskTerminated(task: TaskControlBlock): boolean {
    return task.state.status === 'TERMINATED';
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}
