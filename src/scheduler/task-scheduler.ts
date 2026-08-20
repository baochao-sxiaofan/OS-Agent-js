import type { ContextItem } from '../kernel/context.js';
import {
  TaskControlBlock,
  type CreateTaskOptions,
} from '../kernel/task-control-block.js';
import type { TaskState, Termination } from '../kernel/task-state.js';
import type {
  ModelProvider,
  ModelRequest,
  ToolCallRequest,
} from '../model/model-provider.js';
import type { TaskStore } from '../persistence/task-store.js';
import type { JsonValue } from '../types/json.js';
import { ToolNotFoundError, ToolRegistry } from '../tools/tool-registry.js';
import type { Tool } from '../tools/tool.js';
import {
  AdmissionController,
  type AdmissionDecision,
  type AdmissionLease,
} from './admission-controller.js';
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
};

export class TaskScheduler {
  readonly #provider: ModelProvider;
  readonly #admission: AdmissionController;
  readonly #tools: ToolRegistry;
  readonly #store: TaskStore;
  readonly #readyQueue = new ReadyQueue();
  readonly #tasks = new Map<string, TaskControlBlock>();
  readonly #operations = new Map<string, Promise<void>>();
  readonly #abortControllers = new Map<string, AbortController>();
  #operationSequence = 0;

  constructor(options: TaskSchedulerOptions) {
    this.#provider = options.provider;
    this.#admission = options.admission;
    this.#tools = options.tools;
    this.#store = options.store;
  }

  get readyQueueSize(): number {
    return this.#readyQueue.size;
  }

  get activeOperationCount(): number {
    return this.#operations.size;
  }

  async submit(options: CreateTaskOptions): Promise<TaskControlBlock> {
    const task = TaskControlBlock.create(options);
    this.#tasks.set(task.id, task);
    this.#abortControllers.set(task.id, new AbortController());
    this.#readyQueue.enqueue(task);
    await this.#store.persist(task);
    return task;
  }

  getTask(taskId: string): TaskControlBlock | undefined {
    return this.#tasks.get(taskId);
  }

  async restore(taskId: string): Promise<TaskControlBlock | undefined> {
    const snapshot = await this.#store.load(taskId);
    if (!snapshot) {
      return undefined;
    }

    const task = TaskControlBlock.restore(snapshot);
    this.#tasks.set(task.id, task);
    this.#abortControllers.set(task.id, new AbortController());

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
      this.#readyQueue.enqueue(task);
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
    this.#readyQueue.enqueue(task);
    await this.#store.persist(task);
  }

  async cancel(taskId: string, reason: string): Promise<void> {
    const task = this.requireTask(taskId);
    if (task.state.status === 'TERMINATED') {
      return;
    }

    this.#abortControllers.get(taskId)?.abort(new Error(reason));
    this.#readyQueue.remove(taskId);
    this.terminate(task, {
      kind: 'cancelled',
      reason,
    });
    await this.#store.persist(task);
  }

  async runUntilIdle(): Promise<SchedulerRunResult> {
    while (true) {
      const schedulingProgress = await this.scheduleReadyTasks();

      if (this.#operations.size === 0) {
        if (this.#readyQueue.size > 0 && schedulingProgress) {
          continue;
        }
        return {
          activeOperations: 0,
          pendingReadyTasks: this.#readyQueue.size,
          stalled: this.#readyQueue.size > 0 && !schedulingProgress,
        };
      }

      await Promise.race(this.#operations.values());
    }
  }

  private async scheduleReadyTasks(): Promise<boolean> {
    let madeProgress = false;

    while (this.#readyQueue.size > 0) {
      const task = this.#readyQueue.peek();
      if (!task) {
        break;
      }

      const pendingRequest = this.buildModelRequest(
        task,
        task.modelAttempts + 1,
      );
      const estimate = this.#provider.estimate(pendingRequest);
      const decision = this.#admission.tryAcquire(
        estimate,
        task.budget.maxCostUsd - task.budget.spentCostUsd,
      );

      if (!decision.admitted) {
        await this.handleAdmissionDenied(task, decision);
        if (!decision.retryable) {
          this.#readyQueue.dequeue();
          madeProgress = true;
          continue;
        }
        break;
      }

      this.#readyQueue.dequeue();
      const attempt = task.startModelAttempt();
      const request = this.buildModelRequest(task, attempt);
      task.transition(
        {
          status: 'RUNNING',
          enteredAt: Date.now(),
          providerId: this.#provider.id,
          requestAttempt: attempt,
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
      this.terminate(task, {
        kind: 'failed',
        error: `Request admission failed: ${decision.reasons.join(', ')}`,
      });
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
      if (response.type === 'final') {
        this.terminate(task, {
          kind: 'completed',
          output: response.output,
        });
        await this.#store.persist(task);
        return;
      }

      this.blockForToolCalls(task, response.calls);
      await this.#store.persist(task);
      this.launchToolCalls(task, response.calls);
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
      this.#readyQueue.enqueue(task);
      await this.#store.persist(task);
    } catch (error) {
      if (task.state.status === 'TERMINATED') {
        return;
      }
      this.terminate(task, {
        kind: 'failed',
        error: this.errorMessage(error),
      });
      await this.#store.persist(task);
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
      this.#readyQueue.enqueue(task);
    } else {
      this.terminate(task, {
        kind: 'failed',
        error: this.errorMessage(error),
      });
    }
    await this.#store.persist(task);
  }

  private terminate(task: TaskControlBlock, termination: Termination): void {
    const nextState: TaskState = {
      status: 'TERMINATED',
      enteredAt: Date.now(),
      termination,
    };
    task.transition(nextState, `task_${termination.kind}`);
    task.recordTermination(termination);
  }

  private buildModelRequest(
    task: TaskControlBlock,
    attempt: number,
  ): ModelRequest {
    return {
      taskId: task.id,
      goal: task.goal,
      context: task.context,
      tools: this.#tools.descriptorsFor(task.capabilities),
      attempt,
    };
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
