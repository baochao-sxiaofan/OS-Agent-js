import { randomUUID } from 'node:crypto';

import type { ModelUsage } from '../model/model-provider.js';
import type { JsonValue } from '../types/json.js';
import type {
  ContextItem,
  ContextSummaryKind,
  ContextSummaryRecord,
  TurnSummary,
} from './context.js';
import { assertTaskTransition } from './state-machine.js';
import type { TaskEvent } from './task-event.js';
import type { TaskState, Termination } from './task-state.js';

type TaskEventPayload<TEvent extends TaskEvent = TaskEvent> =
  TEvent extends TaskEvent
    ? Omit<TEvent, 'eventId' | 'occurredAt' | 'sequence' | 'taskId'>
    : never;

export type TaskBudget = {
  maxCostUsd: number;
  spentCostUsd: number;
};

export type CreateTaskOptions = {
  id?: string;
  goal: string;
  priority?: number;
  capabilities?: readonly string[];
  context?: readonly ContextItem[];
  maxModelAttempts?: number;
  budget?: {
    maxCostUsd: number;
  };
  createdAt?: number;
};

export type CreateChildTaskOptions = Omit<
  CreateTaskOptions,
  'createdAt' | 'priority'
> & {
  priority?: number;
};

export type TaskSnapshot = {
  id: string;
  rootTaskId: string;
  parentTaskId?: string;
  depth: number;
  goal: string;
  priority: number;
  capabilities: string[];
  context: ContextItem[];
  contextSummaries?: ContextSummaryRecord[];
  nextContextSummaryStartIndex?: number;
  state: TaskState;
  budget: TaskBudget;
  modelAttempts: number;
  maxModelAttempts: number;
  createdAt: number;
  updatedAt: number;
  events: TaskEvent[];
};

export class TaskControlBlock {
  readonly id: string;
  readonly rootTaskId: string;
  readonly parentTaskId: string | undefined;
  readonly depth: number;
  readonly goal: string;
  readonly priority: number;
  readonly createdAt: number;

  #capabilities: Set<string>;
  #context: ContextItem[];
  #contextSummaries: ContextSummaryRecord[];
  #nextContextSummaryStartIndex: number;
  #state: TaskState;
  #budget: TaskBudget;
  #modelAttempts: number;
  #maxModelAttempts: number;
  #updatedAt: number;
  #events: TaskEvent[];

  private constructor(snapshot: TaskSnapshot) {
    this.id = snapshot.id;
    this.rootTaskId = snapshot.rootTaskId;
    this.parentTaskId = snapshot.parentTaskId;
    this.depth = snapshot.depth;
    this.goal = snapshot.goal;
    this.priority = snapshot.priority;
    this.createdAt = snapshot.createdAt;
    this.#capabilities = new Set(snapshot.capabilities);
    this.#context = structuredClone(snapshot.context);
    this.#contextSummaries = structuredClone(
      snapshot.contextSummaries ?? [],
    );
    this.#nextContextSummaryStartIndex =
      snapshot.nextContextSummaryStartIndex ?? 0;
    this.#state = structuredClone(snapshot.state);
    this.#budget = { ...snapshot.budget };
    this.#modelAttempts = snapshot.modelAttempts;
    this.#maxModelAttempts = snapshot.maxModelAttempts;
    this.#updatedAt = snapshot.updatedAt;
    this.#events = structuredClone(snapshot.events);
  }

  static create(options: CreateTaskOptions): TaskControlBlock {
    const createdAt = options.createdAt ?? Date.now();
    const initialState: TaskState = {
      status: 'READY',
      enteredAt: createdAt,
      reason: 'submitted',
    };
    const taskId = options.id ?? randomUUID();
    const createdEvent: TaskEvent = {
      type: 'task_created',
      eventId: randomUUID(),
      taskId,
      occurredAt: createdAt,
      sequence: 1,
      goal: options.goal,
      initialState,
    };

    return new TaskControlBlock({
      id: taskId,
      rootTaskId: taskId,
      depth: 1,
      goal: options.goal,
      priority: options.priority ?? 0,
      capabilities: [...(options.capabilities ?? [])],
      context: [...(options.context ?? [])],
      contextSummaries: [],
      nextContextSummaryStartIndex: 0,
      state: initialState,
      budget: {
        maxCostUsd: options.budget?.maxCostUsd ?? Number.MAX_VALUE,
        spentCostUsd: 0,
      },
      modelAttempts: 0,
      maxModelAttempts: options.maxModelAttempts ?? 3,
      createdAt,
      updatedAt: createdAt,
      events: [createdEvent],
    });
  }

  static createChild(
    parent: TaskControlBlock,
    options: CreateChildTaskOptions,
  ): TaskControlBlock {
    const createdAt = Date.now();
    const taskId = options.id ?? randomUUID();
    const initialState: TaskState = {
      status: 'READY',
      enteredAt: createdAt,
      reason: 'submitted',
    };
    const createdEvent: TaskEvent = {
      type: 'task_created',
      eventId: randomUUID(),
      taskId,
      occurredAt: createdAt,
      sequence: 1,
      goal: options.goal,
      initialState,
    };

    return new TaskControlBlock({
      id: taskId,
      rootTaskId: parent.rootTaskId,
      parentTaskId: parent.id,
      depth: parent.depth + 1,
      goal: options.goal,
      priority: options.priority ?? parent.priority,
      capabilities: [...(options.capabilities ?? [])],
      context: [...(options.context ?? [])],
      contextSummaries: [],
      nextContextSummaryStartIndex: 0,
      state: initialState,
      budget: {
        maxCostUsd: options.budget?.maxCostUsd ?? Number.MAX_VALUE,
        spentCostUsd: 0,
      },
      modelAttempts: 0,
      maxModelAttempts: options.maxModelAttempts ?? 3,
      createdAt,
      updatedAt: createdAt,
      events: [createdEvent],
    });
  }

  static restore(snapshot: TaskSnapshot): TaskControlBlock {
    return new TaskControlBlock(snapshot);
  }

  get state(): Readonly<TaskState> {
    return this.#state;
  }

  get context(): readonly ContextItem[] {
    return this.#context;
  }

  get contextSummaries(): readonly ContextSummaryRecord[] {
    return this.#contextSummaries;
  }

  get capabilities(): readonly string[] {
    return [...this.#capabilities];
  }

  get budget(): Readonly<TaskBudget> {
    return this.#budget;
  }

  get modelAttempts(): number {
    return this.#modelAttempts;
  }

  get maxModelAttempts(): number {
    return this.#maxModelAttempts;
  }

  get updatedAt(): number {
    return this.#updatedAt;
  }

  get events(): readonly TaskEvent[] {
    return this.#events;
  }

  hasCapability(capability: string): boolean {
    return this.#capabilities.has(capability);
  }

  transition(next: TaskState, reason: string): void {
    assertTaskTransition(this.#state, next);
    const previousStatus = this.#state.status;
    this.#state = structuredClone(next);
    this.#updatedAt = next.enteredAt;
    this.recordEvent({
      type: 'state_transitioned',
      from: previousStatus,
      to: next,
      reason,
    });
  }

  appendContext(item: ContextItem): void {
    this.#context.push(structuredClone(item));
    this.#updatedAt = Date.now();
  }

  completeModelTurn(summary?: TurnSummary): void {
    const sourceStartIndex = this.#nextContextSummaryStartIndex;
    const sourceEndIndex = this.#context.length;
    if (summary !== undefined) {
      this.addContextSummary(
        'turn',
        sourceStartIndex,
        sourceEndIndex,
        summary,
      );
    }
    this.#nextContextSummaryStartIndex = sourceEndIndex;
  }

  recordSecondaryContextSummary(
    summary: TurnSummary,
    sourceEndIndex: number,
    usage: ModelUsage,
  ): void {
    if (sourceEndIndex < 0 || sourceEndIndex > this.#context.length) {
      throw new Error('Secondary context summary range is invalid.');
    }
    this.#budget.spentCostUsd += usage.costUsd;
    this.recordEvent({
      type: 'context_compaction_recorded',
      usage,
    });
    this.addContextSummary(
      'secondary',
      0,
      sourceEndIndex,
      summary,
    );
  }

  startModelAttempt(): number {
    this.#modelAttempts += 1;
    return this.#modelAttempts;
  }

  canRetryModel(): boolean {
    return this.#modelAttempts < this.#maxModelAttempts;
  }

  recordCapacityWait(reasons: string[], retryAt?: number): void {
    this.recordEvent({
      type: 'capacity_wait_recorded',
      reasons: [...reasons],
      ...(retryAt === undefined ? {} : { retryAt }),
    });
  }

  recordModelResponse(
    responseType:
      | 'final'
      | 'needs_parent_action'
      | 'spawn_subagents'
      | 'tool_calls',
    usage: ModelUsage,
  ) {
    this.#budget.spentCostUsd += usage.costUsd;
    this.recordEvent({
      type: 'model_response_recorded',
      responseType,
      usage,
    });
  }

  recordToolCall(callId: string, toolName: string): void {
    this.recordEvent({
      type: 'tool_call_recorded',
      callId,
      toolName,
    });
  }

  recordToolResult(
    callId: string,
    toolName: string,
    output: JsonValue,
  ): void {
    this.recordEvent({
      type: 'tool_result_recorded',
      callId,
      toolName,
      output,
    });
  }

  recordTermination(termination: Termination): void {
    this.recordEvent({
      type: 'task_terminated',
      termination,
    });
  }

  recordSubagentSpawned(childTaskId: string, childDepth: number): void {
    this.recordEvent({
      type: 'subagent_spawned',
      childTaskId,
      childDepth,
    });
  }

  recordSubagentResult(childTaskId: string, result: Termination): void {
    this.recordEvent({
      type: 'subagent_result_recorded',
      childTaskId,
      result,
    });
  }

  snapshot(): TaskSnapshot {
    return {
      id: this.id,
      rootTaskId: this.rootTaskId,
      ...(this.parentTaskId === undefined
        ? {}
        : { parentTaskId: this.parentTaskId }),
      depth: this.depth,
      goal: this.goal,
      priority: this.priority,
      capabilities: [...this.#capabilities],
      context: structuredClone(this.#context),
      contextSummaries: structuredClone(this.#contextSummaries),
      nextContextSummaryStartIndex: this.#nextContextSummaryStartIndex,
      state: structuredClone(this.#state),
      budget: { ...this.#budget },
      modelAttempts: this.#modelAttempts,
      maxModelAttempts: this.#maxModelAttempts,
      createdAt: this.createdAt,
      updatedAt: this.#updatedAt,
      events: structuredClone(this.#events),
    };
  }

  private addContextSummary(
    kind: ContextSummaryKind,
    sourceStartIndex: number,
    sourceEndIndex: number,
    summary: TurnSummary,
  ): void {
    const createdAt = Date.now();
    const record: ContextSummaryRecord = {
      id: randomUUID(),
      kind,
      sourceStartIndex,
      sourceEndIndex,
      summary: structuredClone(summary),
      createdAt,
    };
    this.#contextSummaries.push(record);
    this.recordEvent({
      type: 'context_summary_recorded',
      kind,
      sourceStartIndex,
      sourceEndIndex,
      summary: structuredClone(summary),
    });
  }

  private recordEvent(
    event: TaskEventPayload,
  ): void {
    const occurredAt = Date.now();
    const taskEvent = {
      ...event,
      eventId: randomUUID(),
      taskId: this.id,
      occurredAt,
      sequence: this.#events.length + 1,
    } as TaskEvent;
    this.#events.push(taskEvent);
    this.#updatedAt = occurredAt;
  }
}
