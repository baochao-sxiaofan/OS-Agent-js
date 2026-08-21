import type { ContextItem } from '../kernel/context.js';
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
  type CreateChildTaskOptions,
  type CreateTaskOptions,
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
import type { JsonValue } from '../types/json.js';
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

export type TaskSchedulerOptions = {
  provider: ModelProvider;
  admission: AdmissionController;
  tools: ToolRegistry;
  store: TaskStore;
  agentPool?: AgentPool;
  contextCompactor?: ContextCompactor;
  contextWindowPolicy?: ContextWindowPolicy;
  readyQueue?: ReadyQueue;
  // 与准入控制共享的时钟，便于测试注入。
  clock?: Clock;
  // 自动唤醒时使用的等待实现，默认基于 setTimeout。
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type SubagentSpawnFailureReason =
  | SpawnRejectionReason
  | 'capability_escalation'
  | 'invalid_spawn_request'
  | 'invalid_parent_state'
  | 'spawn_in_progress';

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

export class TaskScheduler {
  readonly #provider: ModelProvider;
  readonly #admission: AdmissionController;
  readonly #tools: ToolRegistry;
  readonly #store: TaskStore;
  readonly #agentPool: AgentPool;
  readonly #readyQueue: ReadyQueue;
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
  readonly #spawningParents = new Set<string>();
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

  async submit(options: CreateTaskOptions): Promise<TaskControlBlock> {
    const task = TaskControlBlock.create(options);
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
    childOptions: readonly CreateChildTaskOptions[],
  ): Promise<SpawnChildrenResult> {
    const parent = this.requireTask(parentTaskId);
    if (parent.state.status !== 'RUNNING') {
      return {
        spawned: false,
        reason: 'invalid_parent_state',
        message: `Task ${parent.id} cannot spawn from ${parent.state.status}.`,
      };
    }
    if (this.#spawningParents.has(parent.id)) {
      return {
        spawned: false,
        reason: 'spawn_in_progress',
        message: `Task ${parent.id} is already creating subagents.`,
      };
    }
    if (childOptions.length === 0) {
      return await this.rejectSubagentSpawn(
        parent,
        'invalid_spawn_request',
        'At least one child task is required.',
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

    const decision = this.#agentPool.tryReserveChildren(
      parent,
      childOptions.length,
    );
    if (!decision.reserved) {
      return await this.rejectSubagentSpawn(
        parent,
        decision.reason,
        decision.message,
      );
    }

    this.#spawningParents.add(parent.id);
    try {
      const children = childOptions.map((options) =>
        TaskControlBlock.createChild(parent, options),
      );
      decision.reservation.commit(children);

      for (const child of children) {
        this.#tasks.set(child.id, child);
        this.#abortControllers.set(child.id, new AbortController());
        this.#ensureCompletion(child.id);
        parent.recordSubagentSpawned(child.id, child.depth);
        await this.#store.persist(child);
      }

      parent.transition(
        {
          status: 'BLOCKED',
          enteredAt: Date.now(),
          reason: 'subagent',
          waitingFor: children.map((child) => child.id),
        },
        'subagents_spawned',
      );
      await this.#store.persist(parent);

      for (const child of children) {
        await this.prepareTaskForQueue(child);
      }

      return {
        spawned: true,
        tasks: children,
      };
    } finally {
      decision.reservation.close();
      this.#spawningParents.delete(parent.id);
    }
  }

  async restore(taskId: string): Promise<TaskControlBlock | undefined> {
    const snapshot = await this.#store.load(taskId);
    if (!snapshot) {
      return undefined;
    }

    const task = TaskControlBlock.restore(snapshot);
    this.#agentPool.registerRestored(task);
    this.#tasks.set(task.id, task);
    this.#abortControllers.set(task.id, new AbortController());
    if (task.state.status !== 'TERMINATED') {
      this.#ensureCompletion(task.id);
    }

    if (task.state.status === 'RUNNING') {
      task.transition(
        {
          status: 'READY',
          enteredAt: Date.now(),
          reason: 'restored',
        },
        'recovered_incomplete_model_request',
      );
      await this.#store.persist(task);
    }
    if (task.state.status === 'READY' && !this.#readyQueue.has(task.id)) {
      await this.prepareTaskForQueue(task);
    }
    return task;
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

    const childTaskIds = this.#agentPool.childrenOf(taskId);
    this.#abortControllers.get(taskId)?.abort(new Error(reason));
    this.#readyQueue.remove(taskId);
    this.#pendingContextCompactions.delete(taskId);
    this.#preparedContexts.delete(taskId);
    await this.terminateTask(task, {
      kind: 'cancelled',
      reason,
    });
    for (const childTaskId of childTaskIds) {
      await this.cancel(childTaskId, `Parent task ${taskId} was cancelled.`);
    }
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
          await this.spawnChildren(
            task.id,
            response.children.map((child) =>
              this.toCreateChildTaskOptions(child),
            ),
          );
          return;
        case 'tool_calls':
          this.blockForToolCalls(task, response.calls);
          task.completeModelTurn(response.turnSummary);
          await this.#store.persist(task);
          this.launchToolCalls(task, response.calls);
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
      await this.handleModelFailure(task, error);
    }
  }

  private blockForToolCalls(
    task: TaskControlBlock,
    calls: readonly ToolCallRequest[],
  ): void {
    for (const call of calls) {
      task.recordToolCall(call.callId, call.toolName);
      task.appendContext({
        type: 'tool_call',
        callId: call.callId,
        toolName: call.toolName,
        input: call.input,
      });
    }
    task.transition(
      {
        status: 'BLOCKED',
        enteredAt: Date.now(),
        reason: 'tool',
        waitingFor: calls.map((call) => call.callId),
      },
      'model_requested_tools',
    );
  }

  private launchToolCalls(
    task: TaskControlBlock,
    calls: readonly ToolCallRequest[],
  ): void {
    const operation = this.executeToolCalls(task, calls);
    this.trackOperation(`tools:${task.id}`, operation);
  }

  private async executeToolCalls(
    task: TaskControlBlock,
    calls: readonly ToolCallRequest[],
  ): Promise<void> {
    try {
      const resolvedCalls = calls.map((call) => ({
        call,
        tool: this.resolveAuthorizedTool(task, call),
      }));
      const readOnlyCalls = resolvedCalls.filter(
        ({ tool }) => tool.effect === 'read_only',
      );
      const effectfulCalls = resolvedCalls.filter(
        ({ tool }) => tool.effect !== 'read_only',
      );

      const readOnlyResults = await Promise.all(
        readOnlyCalls.map(async ({ call, tool }) => ({
          call,
          output: await this.executeResolvedTool(task, call, tool),
        })),
      );
      const resultByCallId = new Map(
        readOnlyResults.map(({ call, output }) => [call.callId, output]),
      );
      for (const { call, tool } of effectfulCalls) {
        resultByCallId.set(
          call.callId,
          await this.executeResolvedTool(task, call, tool),
        );
      }

      if (task.state.status === 'TERMINATED') {
        return;
      }

      for (const call of calls) {
        const output = resultByCallId.get(call.callId);
        if (output === undefined) {
          throw new Error(`Missing result for tool call ${call.callId}`);
        }
        task.recordToolResult(call.callId, call.toolName, output);
        task.appendContext({
          type: 'tool_result',
          callId: call.callId,
          toolName: call.toolName,
          output,
        });
      }
      task.transition(
        {
          status: 'READY',
          enteredAt: Date.now(),
          reason: 'tool_result_available',
        },
        'all_tool_results_available',
      );
      await this.prepareTaskForQueue(task);
      await this.#store.persist(task);
    } catch (error) {
      if (task.state.status === 'TERMINATED') {
        return;
      }
      await this.terminateTask(task, {
        kind: 'failed',
        error: this.errorMessage(error),
      });
    }
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
    const nextState: TaskState = {
      status: 'TERMINATED',
      enteredAt: Date.now(),
      termination,
    };
    task.transition(nextState, `task_${termination.kind}`);
    task.recordTermination(termination);
    this.#readyQueue.remove(task.id);
    this.#pendingContextCompactions.delete(task.id);
    this.#preparedContexts.delete(task.id);
    this.#agentPool.release(task.id);
    await this.#store.persist(task);
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
    if (
      !parent ||
      parent.state.status !== 'BLOCKED' ||
      parent.state.reason !== 'subagent' ||
      !parent.state.waitingFor.includes(child.id)
    ) {
      return;
    }

    const resultAlreadyRecorded = parent.context.some(
      (item) =>
        item.type === 'subagent_result' && item.childTaskId === child.id,
    );
    if (!resultAlreadyRecorded) {
      parent.appendContext({
        type: 'subagent_result',
        childTaskId: child.id,
        result: termination,
      });
      parent.recordSubagentResult(child.id, termination);
    }

    const completedChildIds = new Set(
      parent.context
        .filter((item) => item.type === 'subagent_result')
        .map((item) => item.childTaskId),
    );
    const allChildrenCompleted = parent.state.waitingFor.every((taskId) =>
      completedChildIds.has(taskId),
    );
    if (allChildrenCompleted) {
      parent.transition(
        {
          status: 'READY',
          enteredAt: Date.now(),
          reason: 'subagent_result_available',
        },
        'all_subagent_results_available',
      );
      await this.prepareTaskForQueue(parent, {
        parentWakeupBoost: true,
      });
    }
    await this.#store.persist(parent);
  }

  private toCreateChildTaskOptions(
    request: SubagentSpawnRequest,
  ): CreateChildTaskOptions {
    return {
      goal: request.goal,
      ...(request.taskId === undefined ? {} : { id: request.taskId }),
      ...(request.priority === undefined
        ? {}
        : { priority: request.priority }),
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
        currentDepth: task.depth,
        maxDepth: this.#agentPool.policy.maxDepth,
        availableAgentSlots: this.#agentPool.availableLiveSlots,
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
}
