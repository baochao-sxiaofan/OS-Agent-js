import { randomUUID } from 'node:crypto';
import { AgentState, type AgentId, type AgentSchedulingHandle } from '../../agent-control-block/index.js';
import {
  AgentSchedulerError,
  type AgentDispatchBatch,
  type AgentRun,
  type AgentRunIntent,
  type AgentScheduleSnapshot,
  type AgentScheduler,
  type AgentSchedulerOptions,
  type AgentWakeEvent,
  type AsyncOperation,
  type AsyncOperationHandle,
  type AsyncOperationOptions,
  type AsyncOperationOutcome,
  type AsyncOperationResult,
} from '../api.js';

type PendingOperation = {
  operation: AsyncOperation;
  controller: AbortController;
};

type AgentRecord = {
  agent: AgentSchedulingHandle;
  pending: Map<string, PendingOperation>;
  completed: Map<string, AsyncOperationResult>;
  events: Map<string, AgentWakeEvent>;
  recentEvents: Set<string>;
  batch: AgentDispatchBatch | null;
  run: AgentRun | null;
  continuation: boolean;
  batchDueAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
};

const defaults: Required<AgentSchedulerOptions> = {
  batchWindowMs: 30_000,
  operationTimeoutMs: 120_000,
  maxConcurrentRuns: 4,
  maxBufferedOperations: 256,
  maxBufferedEvents: 256,
  recentEventLimit: 1024,
};

export function createAgentScheduler(options: AgentSchedulerOptions = {}): AgentScheduler {
  const configuration = { ...defaults, ...options };
  for (const [name, value] of Object.entries(configuration)) {
    positiveInteger(value, name);
  }
  return new Scheduler(configuration);
}

/**
 * 单进程调度实现。所有权威变更同步串行完成，中间没有 await 或外部回调。
 * 发送方只能领取已封存批次；这里不依赖 Context、工具实现或模型请求器。
 */
class Scheduler implements AgentScheduler {
  readonly #options: Required<AgentSchedulerOptions>;
  readonly #agents = new Map<AgentId, AgentRecord>();
  readonly #queue: AgentId[] = [];
  readonly #readyWaiters = new Set<() => void>();
  #running = 0;

  constructor(options: Required<AgentSchedulerOptions>) {
    this.#options = options;
  }

  register(agent: AgentSchedulingHandle): void {
    positiveInteger(agent.agentId, 'agentId');
    if (this.#agents.has(agent.agentId)) {
      throw new AgentSchedulerError('duplicate_agent', '该 Agent 已经注册。');
    }
    const state = agent.getState();
    if (state !== AgentState.READY && state !== AgentState.SLEEPING) {
      throw new AgentSchedulerError('invalid_state', '注册需要 READY 或 SLEEPING 状态；在途操作不能凭空恢复。');
    }
    const record: AgentRecord = {
      agent, pending: new Map(), completed: new Map(), events: new Map(),
      recentEvents: new Set(), batch: null, run: null,
      continuation: state === AgentState.READY, batchDueAt: null, timer: null,
    };
    this.#agents.set(agent.agentId, record);
    this.#reconcile(record);
  }

  unregister(agentId: AgentId): void {
    const record = this.#record(agentId);
    if (record.agent.getState() !== AgentState.SLEEPING || record.pending.size ||
        record.completed.size || record.events.size || record.batch || record.run) {
      throw new AgentSchedulerError('invalid_state', '存在未处理工作，不能移除 Agent。');
    }
    if (record.timer) clearTimeout(record.timer);
    this.#agents.delete(agentId);
  }

  notify(agentId: AgentId, event: AgentWakeEvent): boolean {
    const record = this.#record(agentId);
    nonempty(event.eventId, 'eventId');
    nonempty(event.eventRef, 'eventRef');
    if (record.recentEvents.has(event.eventId) || record.events.has(event.eventId) ||
        record.batch?.events.some((entry) => entry.eventId === event.eventId)) return false;
    if (record.events.size + (record.batch?.events.length ?? 0) >= this.#options.maxBufferedEvents) {
      throw new AgentSchedulerError('capacity_exceeded', '待处理外部事件已达上限，调用方应保留并稍后重投。');
    }
    record.events.set(event.eventId, Object.freeze({ eventId: event.eventId, eventRef: event.eventRef }));
    record.recentEvents.add(event.eventId);
    while (record.recentEvents.size > this.#options.recentEventLimit) {
      const oldest = record.recentEvents.values().next().value;
      if (oldest !== undefined) record.recentEvents.delete(oldest);
    }
    this.#reconcile(record);
    return true;
  }

  takeNextRun(): AgentRun | null {
    if (!this.#hasCapacity()) return null;
    const agentId = this.#queue[0];
    if (agentId === undefined) return null;
    const record = this.#record(agentId);
    if (!record.batch || record.run) {
      throw new AgentSchedulerError('invalid_state', '就绪队列与封存批次不一致。');
    }
    const run: AgentRun = Object.freeze({
      agentId, runId: randomUUID(), batch: record.batch,
    });
    record.agent.transition(AgentState.RUNNING);
    this.#queue.shift();
    record.run = run;
    this.#running += 1;
    return run;
  }

  waitForReady(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#queue.length && this.#hasCapacity()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const ready = (): void => {
        signal?.removeEventListener('abort', aborted);
        this.#readyWaiters.delete(ready);
        resolve();
      };
      const aborted = (): void => {
        this.#readyWaiters.delete(ready);
        reject(signal?.reason);
      };
      this.#readyWaiters.add(ready);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }

  registerOperations(run: AgentRun, operations: readonly AsyncOperationOptions[]): readonly AsyncOperationHandle[] {
    const record = this.#activeRecord(run);
    const buffered = record.pending.size + record.completed.size + (record.batch?.results.length ?? 0);
    if (buffered + operations.length > this.#options.maxBufferedOperations) {
      throw new AgentSchedulerError('capacity_exceeded', '未消费异步操作已达上限，请先处理已有结果。');
    }
    const now = Date.now();
    // 整组参数先验证，再统一登记，避免某个操作回调早于同组其他操作的登记。
    const pending = operations.map((options): PendingOperation => {
      const timeoutMs = options.timeoutMs ?? this.#options.operationTimeoutMs;
      positiveInteger(timeoutMs, 'timeoutMs');
      const deadline = now + timeoutMs;
      positiveInteger(deadline, 'deadline');
      return {
        operation: Object.freeze({
          agentId: run.agentId, operationId: randomUUID(), originRunId: run.runId,
          startedAt: now, deadline, state: 'RUNNING',
        }),
        controller: new AbortController(),
      };
    });
    for (const item of pending) record.pending.set(item.operation.operationId, item);
    this.#armTimer(record);
    return Object.freeze(pending.map((item) => Object.freeze({
      operation: item.operation, signal: item.controller.signal,
    })));
  }

  completeOperation(operation: AsyncOperation, outcome: AsyncOperationOutcome): boolean {
    const record = this.#agents.get(operation.agentId);
    const pending = record?.pending.get(operation.operationId);
    if (!record || !pending || pending.operation.originRunId !== operation.originRunId) return false;
    const result = copyOutcome(outcome);
    const now = Date.now();
    const expired = pending.operation.deadline <= now;
    this.#recordResult(record, pending, expired ? { type: 'timed_out' } : result, now);
    this.#reconcile(record);
    // 取消可能同步触发执行模块的回调，必须先提交结果和队列变化再发出信号。
    if (expired || result.type === 'timed_out') pending.controller.abort(new Error('异步操作等待超时。'));
    return !expired;
  }

  finishRun(run: AgentRun, intent: AgentRunIntent): void {
    const record = this.#activeRecord(run);
    if (intent !== 'continue' && intent !== 'idle') {
      throw new AgentSchedulerError('invalid_input', '运行意图必须为 continue 或 idle。');
    }
    record.run = null;
    record.batch = null;
    record.continuation = intent === 'continue';
    this.#running -= 1;
    this.#reconcile(record);
    this.#signalReady();
  }

  returnRun(run: AgentRun): void {
    const record = this.#activeRecord(run);
    // 原批次保留，不与 Map2 合并；请求级重试由发送方自行决定。
    record.agent.transition(AgentState.READY);
    record.run = null;
    this.#running -= 1;
    this.#queue.push(run.agentId);
    this.#armTimer(record);
    this.#signalReady();
  }

  inspect(agentId: AgentId): AgentScheduleSnapshot {
    const record = this.#record(agentId);
    return Object.freeze({
      agentId, state: record.agent.getState(),
      pendingOperations: Object.freeze([...record.pending.values()].map((item) => item.operation)),
      completedResults: Object.freeze([...record.completed.values()]),
      pendingEvents: Object.freeze([...record.events.values()]),
      queuedBatch: record.run ? null : record.batch,
      running: record.run, batchDueAt: record.batchDueAt,
    });
  }

  #record(agentId: AgentId): AgentRecord {
    const record = this.#agents.get(agentId);
    if (!record) throw new AgentSchedulerError('unknown_agent', 'Agent 尚未注册。');
    return record;
  }

  #activeRecord(run: AgentRun): AgentRecord {
    const record = this.#record(run.agentId);
    if (!record.run || record.run.runId !== run.runId || record.run.batch.batchId !== run.batch.batchId) {
      throw new AgentSchedulerError('stale_run', '运行凭据已经失效，不能处理另一轮结果。');
    }
    if (record.agent.getState() !== AgentState.RUNNING) {
      throw new AgentSchedulerError('invalid_state', 'ACB 状态被调度器之外的调用方修改。');
    }
    return record;
  }

  #recordResult(record: AgentRecord, pending: PendingOperation, outcome: AsyncOperationOutcome, now: number): void {
    record.pending.delete(pending.operation.operationId);
    record.completed.set(pending.operation.operationId, Object.freeze({
      operation: pending.operation, completedAt: now, outcome: Object.freeze(outcome),
    }));
    record.batchDueAt ??= now + this.#options.batchWindowMs;
  }

  #reconcile(record: AgentRecord): void {
    // READY 和 RUNNING 都占有同一封存批次；期间只允许往新收集容器追加。
    if (!record.batch) {
      const hasResults = record.completed.size > 0;
      const resultsReady = hasResults &&
        (record.pending.size === 0 || (record.batchDueAt !== null && record.batchDueAt <= Date.now()));
      if (record.continuation || record.events.size > 0 || resultsReady) {
        this.#seal(record);
      } else {
        const next = record.pending.size > 0 ? AgentState.BLOCKED : AgentState.SLEEPING;
        if (record.agent.getState() !== next) record.agent.transition(next);
      }
    }
    this.#armTimer(record);
    this.#signalReady();
  }

  #seal(record: AgentRecord): void {
    const batch: AgentDispatchBatch = Object.freeze({
      agentId: record.agent.agentId, batchId: randomUUID(), sealedAt: Date.now(),
      results: Object.freeze([...record.completed.values()]),
      events: Object.freeze([...record.events.values()]),
      pendingOperations: Object.freeze([...record.pending.values()].map((item) => item.operation)),
      continuation: record.continuation,
    });
    const nextCompleted = new Map<string, AsyncOperationResult>();
    const nextEvents = new Map<string, AgentWakeEvent>();
    if (record.agent.getState() !== AgentState.READY) record.agent.transition(AgentState.READY);
    // 同步提交：旧 Map2 转为不可变批次，新 Map2 接收后续回调，队列只写入一次。
    record.completed = nextCompleted;
    record.events = nextEvents;
    record.batch = batch;
    record.batchDueAt = null;
    record.continuation = false;
    this.#queue.push(record.agent.agentId);
  }

  #armTimer(record: AgentRecord): void {
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
    let at = Number.POSITIVE_INFINITY;
    for (const pending of record.pending.values()) at = Math.min(at, pending.operation.deadline);
    // 已占用的批次不能再次入队。过期批处理时间保留到当前轮结束，避免零延时空转。
    if (!record.batch && record.batchDueAt !== null) at = Math.min(at, record.batchDueAt);
    if (!Number.isFinite(at)) return;
    record.timer = setTimeout(() => this.#onTimer(record), Math.min(2_147_483_647, Math.max(0, at - Date.now())));
    record.timer.unref();
  }

  #onTimer(record: AgentRecord): void {
    record.timer = null;
    const now = Date.now();
    const expired: PendingOperation[] = [];
    for (const pending of record.pending.values()) {
      if (pending.operation.deadline <= now) {
        this.#recordResult(record, pending, { type: 'timed_out' }, now);
        expired.push(pending);
      }
    }
    this.#reconcile(record);
    for (const pending of expired) pending.controller.abort(new Error('异步操作等待超时。'));
  }

  #hasCapacity(): boolean {
    return this.#running < this.#options.maxConcurrentRuns;
  }

  #signalReady(): void {
    if (this.#queue.length && this.#hasCapacity()) {
      for (const ready of [...this.#readyWaiters]) ready();
    }
  }
}

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AgentSchedulerError('invalid_input', `${field} 必须为正安全整数。`);
  }
}

function nonempty(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentSchedulerError('invalid_input', `${field} 不能为空。`);
  }
}

function copyOutcome(outcome: AsyncOperationOutcome): AsyncOperationOutcome {
  switch (outcome.type) {
    case 'succeeded':
      nonempty(outcome.resultRef, 'resultRef');
      return { type: 'succeeded', resultRef: outcome.resultRef };
    case 'failed':
      nonempty(outcome.error, 'error');
      if (outcome.resultRef !== undefined) nonempty(outcome.resultRef, 'resultRef');
      return {
        type: 'failed', error: outcome.error,
        ...(outcome.resultRef === undefined ? {} : { resultRef: outcome.resultRef }),
      };
    case 'cancelled':
      nonempty(outcome.reason, 'reason');
      return { type: 'cancelled', reason: outcome.reason };
    case 'timed_out':
      return { type: 'timed_out' };
    default:
      throw new AgentSchedulerError('invalid_input', '未知的异步操作结果。');
  }
}
