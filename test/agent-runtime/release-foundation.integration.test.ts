import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentContextManager, restoreAgentContextManager, InMemoryContextStore,
  type ContextEntry, type ContextPolicy,
} from '../../src/agent-context/index.js';
import { AgentState, createAgentControlBlock } from '../../src/agent-control-block/index.js';
import { createAgentRoundRunner, type AgentRoundOptions } from '../../src/agent-round/index.js';
import {
  createAgentScheduler, type AgentScheduler, type AgentSchedulerCheckpoint, type AgentSchedulerOptions,
} from '../../src/agent-scheduler/index.js';
import type { ModelCompletion, ModelCompletionRequest } from '../../src/model-requester/index.js';
import { createAgentRuntime, type RuntimeAgent } from '../../src/agent-runtime/index.js';
import { AdmissionWait, defaultLimits, RequestAdmission, trackedRequester } from '../../src/agent-runtime/internal/limits.js';
import { RuntimeStore } from '../../src/agent-runtime/internal/store.js';

const schedulers: AgentScheduler[] = [];
afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const budget = { maxTokens: 20_000, compactAtTokens: 15_000, targetTokens: 8_000, maxTasks: 10 };
function fixture(policy: Partial<ContextPolicy> = {}, schedulerOptions: AgentSchedulerOptions = {}) {
  const store = new InMemoryContextStore();
  const context = createAgentContextManager({
    key: 'foundation', store, objective: '长期职责', instructions: [],
    policy: { budgets: { 1: budget, 2: budget, 3: budget },
      maxInbox: 16, maxDeliveryBytes: 30_000, maxSummaryAttempts: 3, ...policy },
  });
  const agent = createAgentControlBlock({
    agentId: 1, character: 'test', agentName: 'test', state: AgentState.READY,
    capacity: [], skills: [], context: context.snapshot(), createdAt: 0, modelConfigId: 'test',
  }, context);
  const scheduler = createAgentScheduler(schedulerOptions);
  schedulers.push(scheduler);
  scheduler.register(agent);
  const requests: ModelCompletionRequest[] = [];
  const inputsReceived = vi.fn<NonNullable<AgentRoundOptions['inputsReceived']>>();
  const work = vi.fn<AgentRoundOptions['work']>(async () => ({ decision: { type: 'finish_turn' } }));
  const options: AgentRoundOptions = {
    agentId: 1, context, scheduler, maxRequestTokens: 50_000, maxOutputTokens: 4000,
    requester: { provider: 'deepseek', model: 'offline', async request(input) {
      requests.push(input);
      return summaryCompletion();
    } },
    resolveEvent: async (event) => ({ entries: [entry(event.eventId)] }),
    resolveResult: async (result) => ({ entries: [entry(result.operation.operationId)] }),
    inputsReceived, work,
  };
  return { store, context, agent, scheduler, requests, inputsReceived, work, options,
    runner: createAgentRoundRunner(options) };
}

function entry(id: string, content = id): ContextEntry {
  return { id, createdAt: 1, kind: 'message', role: 'user', content };
}

function summaryCompletion(): ModelCompletion {
  return { provider: 'deepseek', model: 'offline', finishReason: 'tool_calls',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    message: { role: 'assistant', content: '', toolCalls: [{ id: 'summary', name: 'submit_summary',
      arguments: { outcome: '已保留工作结论', observations: [], decisions: [], artifactRefs: [],
        unresolved: [], nextResponsibilities: [], lessonCandidates: [], sourceRefs: ['s0'] } }] } };
}

function sealEvents(scheduler: AgentScheduler, ids: readonly string[]) {
  const current = scheduler.takeNextRun()!;
  for (const id of ids) scheduler.notify(1, { eventId: id, eventRef: id });
  scheduler.finishRun(current, 'idle');
  return scheduler.takeNextRun()!;
}

function pending(f: ReturnType<typeof fixture>) {
  f.context.apply('idle', f.context.cursor(), { type: 'idle' });
}

function tracked(f: ReturnType<typeof fixture>, store: RuntimeStore, admission: RequestAdmission) {
  let agent: RuntimeAgent = {
    schemaVersion: 2, control: f.agent.snapshot(), contextKey: 'foundation', ownerId: 'owner', workspaceId: 'work',
    ceiling: [], grants: [], status: 'active', rounds: 0, totalTokens: 0, costUsd: 0,
    lastAction: '', repeatedActions: 0, lastError: null,
  };
  const requester = trackedRequester({
    requester: f.options.requester, store, admission, limits: () => admission.limits,
    agent: () => agent, update: (value) => { agent = value; },
    batch: () => {
      const summary = f.context.checkpoint().pendingSummary;
      return summary ? `summary:${summary.id}` : f.scheduler.inspect(1).running!.batch.batchId;
    },
  });
  return { requester, agent: () => agent,
    dispatchRequest: (input: ModelCompletionRequest, signal: AbortSignal | undefined, beforeSend: () => void) =>
      requester.dispatchRequest(input, signal, beforeSend) };
}

describe('发布基础链路的可靠输入与请求边界', () => {
  it('同组重复键按唯一新操作计容量并共享取消凭据', () => {
    const { scheduler } = fixture({}, { maxBufferedOperations: 1 });
    const run = scheduler.takeNextRun()!;
    const [first, second] = scheduler.registerOperations(run, [
      { operationId: 'same' }, { operationId: 'same' },
    ]);
    expect(first!.operation).toBe(second!.operation);
    expect(first!.signal).toBe(second!.signal);
    expect(scheduler.inspect(1).pendingOperations).toHaveLength(1);
    scheduler.cancelOperations(1, '停止操作');
    expect(first!.signal.aborted).toBe(true);
    expect(second!.signal.aborted).toBe(true);
    const repeated = scheduler.registerOperations(run, [{ operationId: 'same' }, { operationId: 'same' }]);
    expect(repeated.every((handle) => handle.signal.aborted)).toBe(true);
    expect(scheduler.inspect(1).completedResults).toHaveLength(1);
  });

  it('整组验证或容量失败不登记部分操作，复用旧句柄不增加容量', () => {
    const { scheduler } = fixture({}, { maxBufferedOperations: 1 });
    const run = scheduler.takeNextRun()!;
    expect(() => scheduler.registerOperations(run, [
      { operationId: 'new' }, { operationId: 'invalid', timeoutMs: 0 },
    ])).toThrow();
    expect(scheduler.inspect(1).pendingOperations).toHaveLength(0);
    expect(() => scheduler.registerOperations(run, [
      { operationId: 'one' }, { operationId: 'two' },
    ])).toThrow('上限');
    expect(scheduler.inspect(1).pendingOperations).toHaveLength(0);
    const original = scheduler.registerOperations(run, [{ operationId: 'one' }])[0]!;
    const reused = scheduler.registerOperations(run, [{ operationId: 'one' }, { operationId: 'one' }]);
    expect(reused.every((handle) => handle.signal === original.signal)).toBe(true);
  });

  it('Context 已收件而旧调度快照仍休眠时保留宿主 READY，并保持真正休眠恢复', () => {
    const { context, agent } = fixture();
    let saved: AgentSchedulerCheckpoint | undefined;
    const persistence = { load: () => structuredClone(saved),
      save: (value: AgentSchedulerCheckpoint) => { saved = structuredClone(value); } };
    const first = createAgentScheduler({}, persistence);
    schedulers.push(first);
    first.register(createAgentControlBlock(agent.snapshot(), context));
    context.apply('finished', context.cursor(), { type: 'finish_turn' });
    first.finishRun(first.takeNextRun()!, 'idle');
    const sleeping = structuredClone(saved)!;
    context.receive([{ key: 'feedback-before-notify', target: context.cursor(), entries: [entry('feedback')] }]);
    const recovered = createAgentScheduler({}, persistence);
    schedulers.push(recovered);
    recovered.register(createAgentControlBlock({ ...agent.snapshot(), state: AgentState.READY }, context));
    expect(recovered.inspect(1).state).toBe(AgentState.READY);
    expect(recovered.takeNextRun()?.batch.continuation).toBe(true);
    const quiet = createAgentScheduler({}, { load: () => sleeping, save: () => {} });
    schedulers.push(quiet);
    quiet.register(createAgentControlBlock({ ...agent.snapshot(), state: AgentState.SLEEPING }, context));
    expect(quiet.inspect(1).state).toBe(AgentState.SLEEPING);
    expect(quiet.takeNextRun()).toBeNull();
  });

  it('实际 RPM 准入多次拒绝不消耗总结次数，窗口恢复后仍可发出唯一总结请求', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const f = fixture({ maxSummaryAttempts: 1 });
    pending(f);
    const store = new RuntimeStore(':memory:');
    const admission = new RequestAdmission({ ...defaultLimits, requestsPerMinute: 1 }, store);
    store.putMetadata('admission', [{ at: Date.now(), tokens: 1 }]);
    const tracking = tracked(f, store, admission);
    const runner = createAgentRoundRunner({ ...f.options, dispatchRequest: tracking.dispatchRequest });
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        await expect(runner.execute(f.scheduler.takeNextRun()!)).rejects.toBeInstanceOf(AdmissionWait);
        expect(f.context.checkpoint().pendingSummary).toMatchObject({ attempts: 0, lastError: null });
      }
      expect(f.requests).toHaveLength(0);
      expect(tracking.agent().rounds).toBe(0);
      vi.setSystemTime(161_001);
      await expect(runner.execute(f.scheduler.takeNextRun()!)).resolves.toBe('summary');
      expect(f.requests).toHaveLength(1);
      expect(tracking.agent().rounds).toBe(1);
      expect(f.context.checkpoint().pendingSummary).toBeNull();
    } finally { store.close(); }
  });

  it('真正发送失败持久消耗尝试，耗尽后发送钩子阻断网络', async () => {
    const f = fixture({ maxSummaryAttempts: 1 });
    pending(f);
    let calls = 0;
    const runner = createAgentRoundRunner({ ...f.options,
      dispatchRequest: async (_input, _signal, beforeSend) => {
        beforeSend();
        calls++;
        expect(f.context.checkpoint().pendingSummary?.attempts).toBe(1);
        throw new Error('已发送失败');
      },
    });
    await expect(runner.execute(f.scheduler.takeNextRun()!)).rejects.toThrow('已发送失败');
    expect(f.context.checkpoint().pendingSummary).toMatchObject({ attempts: 1, lastError: '已发送失败' });
    await expect(runner.execute(f.scheduler.takeNextRun()!)).rejects.toMatchObject({ code: 'retry_exhausted' });
    expect(calls).toBe(1);
  });

  it('最后一次已发送回复持久缓存后中断，重放不再计数并完成总结', async () => {
    const f = fixture({ maxSummaryAttempts: 1 });
    pending(f);
    const summaryKey = `summary:${f.context.checkpoint().pendingSummary!.id}`;
    const store = new RuntimeStore(':memory:');
    const tracking = tracked(f, store, new RequestAdmission(defaultLimits, store));
    let interrupted = false;
    const runner = createAgentRoundRunner({ ...f.options,
      dispatchRequest: async (input, signal, beforeSend) => {
        const completion = await tracking.dispatchRequest(input, signal, beforeSend);
        if (!interrupted) {
          interrupted = true;
          throw new Error('回复已落盘后中断');
        }
        return completion;
      },
    });
    try {
      await expect(runner.execute(f.scheduler.takeNextRun()!)).rejects.toThrow('中断');
      expect(f.context.checkpoint().pendingSummary?.attempts).toBe(1);
      expect(store.completion(summaryKey)).toBeDefined();
      await expect(runner.execute(f.scheduler.takeNextRun()!)).resolves.toBe('summary');
      expect(f.requests).toHaveLength(1);
      expect(tracking.agent().rounds).toBe(1);
    } finally { store.close(); }
  });

  it('完整请求预算预检失败时不消耗总结尝试', async () => {
    const f = fixture();
    pending(f);
    const dispatch = vi.fn<NonNullable<AgentRoundOptions['dispatchRequest']>>();
    const runner = createAgentRoundRunner({ ...f.options, maxRequestTokens: 1, dispatchRequest: dispatch });
    await expect(runner.execute(f.scheduler.takeNextRun()!)).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(f.context.checkpoint().pendingSummary?.attempts).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('满 inbox 仍可总结，归还原批次后接收全部输入才确认，新到事件留在下一批', async () => {
    const f = fixture({ maxInbox: 1 });
    pending(f);
    const sourceRef = f.context.checkpoint().pendingSummary!.sourceRef;
    f.context.receive([{ key: 'deferred', entries: [entry('deferred')] }]);
    const run = sealEvents(f.scheduler, ['new']);
    const runner = createAgentRoundRunner({ ...f.options, requester: {
      ...f.options.requester, async request(input, signal) {
        f.scheduler.notify(1, { eventId: 'during-summary', eventRef: 'during-summary' });
        return f.options.requester.request(input, signal);
      },
    } });
    await expect(runner.execute(run)).resolves.toBe('summary');
    expect(f.context.checkpoint().pendingSummary).toBeNull();
    expect(f.context.checkpoint().inbox.map((input) => input.key)).toEqual(['deferred']);
    expect(f.context.roundReceipt(run.batch.batchId)).toBeUndefined();
    expect(f.context.summaryReceipt(run.batch.batchId)).toBeDefined();
    expect(f.inputsReceived).not.toHaveBeenCalled();
    expect(JSON.stringify(f.context.read(sourceRef))).not.toContain('deferred');
    expect(JSON.stringify(f.requests[0])).not.toContain('during-summary');
    const retry = f.scheduler.takeNextRun()!;
    expect(retry.batch).toBe(run.batch);
    expect(retry.runId).not.toBe(run.runId);
    await expect(runner.execute(retry)).resolves.toBe('replayed');
    expect(f.inputsReceived).toHaveBeenCalledTimes(1);
    expect(f.context.roundReceipt(run.batch.batchId)).toBeDefined();
    expect(f.requests).toHaveLength(1);
    const next = f.scheduler.takeNextRun()!;
    expect(next.batch.events.map((event) => event.eventId)).toEqual(['during-summary']);
    await runner.execute(next);
    const visible = JSON.stringify(f.work.mock.calls[0]![0].view);
    expect(visible).toContain('deferred');
    expect(visible).toContain('during-summary');
    expect(visible).toContain('"content":"new"');
  });

  it('同批事件和操作结果超过 inbox 容量时分段持久接收，部分接收不确认来源', async () => {
    const f = fixture({ maxInbox: 1 });
    pending(f);
    const current = f.scheduler.takeNextRun()!;
    const handle = f.scheduler.registerOperations(current, [{ operationId: 'result' }])[0]!;
    f.scheduler.completeOperation(handle.operation, { type: 'succeeded', resultRef: 'result-body' });
    f.scheduler.notify(1, { eventId: 'event', eventRef: 'event' });
    f.scheduler.finishRun(current, 'idle');
    const run = f.scheduler.takeNextRun()!;
    await expect(f.runner.execute(run)).resolves.toBe('summary');
    expect(f.context.checkpoint().inbox.map((input) => input.key)).toEqual(['event:event']);
    expect(f.inputsReceived).not.toHaveBeenCalled();
    expect(f.context.roundReceipt(run.batch.batchId)).toBeUndefined();
    const retry = f.scheduler.takeNextRun()!;
    expect(retry.batch.results).toHaveLength(1);
    await expect(f.runner.execute(retry)).resolves.toBe('replayed');
    expect(f.inputsReceived).toHaveBeenCalledTimes(1);
    expect(f.context.checkpoint().inbox).toHaveLength(0);
    expect(f.context.snapshot().level1.memory.recentEntries.map((item) => item.id)).toEqual(['event', 'result']);
    expect(f.requests).toHaveLength(1);
  });

  it('无待总结时可排空既有 inbox 并分段接收大批次，不重投原文', async () => {
    const f = fixture({ maxInbox: 1 });
    f.context.receive([{ key: 'older', entries: [entry('older')] }]);
    const run = sealEvents(f.scheduler, ['one', 'two', 'three']);
    await expect(f.runner.execute(run)).resolves.toBe('work');
    expect(f.inputsReceived).toHaveBeenCalledTimes(1);
    expect(f.context.snapshot().level1.memory.recentEntries.map((item) => item.id))
      .toEqual(['older', 'one', 'two', 'three']);
    expect(f.context.checkpoint().inbox).toHaveLength(0);
  });

  it('同一保留批次可推进多次压缩，各总结独立提交且最后才确认输入', async () => {
    const compactBudget = { maxTokens: 2400, compactAtTokens: 1500, targetTokens: 1000, maxTasks: 10 };
    const f = fixture({ maxInbox: 1, budgets: { 1: compactBudget, 2: compactBudget, 3: compactBudget } });
    const store = new RuntimeStore(':memory:');
    const tracking = tracked(f, store, new RequestAdmission(defaultLimits, store));
    const runner = createAgentRoundRunner({ ...f.options,
      dispatchRequest: tracking.dispatchRequest,
      resolveEvent: async (event) => ({ entries: [entry(event.eventId, `${event.eventId}:${'x'.repeat(1200)}`)] }),
    });
    const run = sealEvents(f.scheduler, ['one', 'two', 'three']);
    const summaryIds: string[] = [];
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = attempt === 0 ? run : f.scheduler.takeNextRun()!;
        expect(current.batch.batchId).toBe(run.batch.batchId);
        const result = await runner.execute(current);
        if (result === 'replayed') break;
        expect(result).toBe('summary');
        const nextSource = f.context.snapshot().level1.memory.historyRef!;
        summaryIds.push(nextSource);
        expect(f.inputsReceived).not.toHaveBeenCalled();
        expect(f.context.roundReceipt(run.batch.batchId)).toBeUndefined();
      }
      expect(summaryIds).toHaveLength(2);
      expect(new Set(summaryIds).size).toBe(2);
      expect(f.requests).toHaveLength(2);
      expect(store.request(run.batch.batchId)).toBeUndefined();
      expect(store.events(1).filter((event) => event.type === 'model_completed')).toHaveLength(2);
      expect(f.inputsReceived).toHaveBeenCalledTimes(1);
      expect(f.context.roundReceipt(run.batch.batchId)).toBeDefined();
    } finally { store.close(); }
  });

  it('总结阶段提交后归还中断，重建上下文和调度后仍接收未入箱输入且不重发总结', async () => {
    const f = fixture({ maxInbox: 1 });
    pending(f);
    f.context.receive([{ key: 'older', entries: [entry('older')] }]);
    const run = sealEvents(f.scheduler, ['unreceived']);
    const returned = vi.spyOn(f.scheduler, 'returnRun').mockImplementationOnce(() => { throw new Error('归还中断'); });
    await expect(f.runner.execute(run)).rejects.toThrow('归还中断');
    returned.mockRestore();
    expect(f.context.roundReceipt(run.batch.batchId)).toBeUndefined();
    const state = { ...f.scheduler.inspect(1), schemaVersion: 1 as const,
      continuation: false, recentEventIds: ['unreceived'] };
    const context = restoreAgentContextManager({ key: 'foundation', store: f.store });
    const scheduler = createAgentScheduler({}, { load: () => state, save: () => {} });
    schedulers.push(scheduler);
    scheduler.register(createAgentControlBlock({ ...f.agent.snapshot(), state: AgentState.READY }, context));
    const runner = createAgentRoundRunner({ ...f.options, context, scheduler });
    await expect(runner.execute(scheduler.takeNextRun()!)).resolves.toBe('replayed');
    expect(f.requests).toHaveLength(1);
    expect(f.inputsReceived).toHaveBeenCalledTimes(1);
    expect(context.snapshot().level1.memory.recentEntries.map((item) => item.id)).toEqual(['older', 'unreceived']);
  });

  it('总结落盘但批次确认事务失败，重试只确认回执不请求或重做业务', async () => {
    const f = fixture();
    pending(f);
    const run = f.scheduler.takeNextRun()!;
    const commit = f.store.commit.bind(f.store);
    let interrupted = false;
    vi.spyOn(f.store, 'commit').mockImplementation((key, revision, checkpoint, writes, receipts) => {
      if (!interrupted && receipts.some((receipt) => receipt.key === `round:${run.batch.batchId}`)) {
        interrupted = true;
        throw new Error('确认事务中断');
      }
      commit(key, revision, checkpoint, writes, receipts);
    });
    await expect(f.runner.execute(run)).rejects.toThrow('确认事务中断');
    expect(f.context.checkpoint().pendingSummary).toBeNull();
    expect(f.context.summaryReceipt(run.batch.batchId)).toBeDefined();
    expect(f.context.roundReceipt(run.batch.batchId)).toBeUndefined();
    await expect(f.runner.execute(f.scheduler.takeNextRun()!)).resolves.toBe('replayed');
    expect(f.requests).toHaveLength(1);
    expect(f.work).not.toHaveBeenCalled();
  });

  it('来源确认回调失败时保留已入箱输入，重试不重复输入且不提前写完成回执', async () => {
    const f = fixture({ maxInbox: 1 });
    pending(f);
    const run = sealEvents(f.scheduler, ['received']);
    f.inputsReceived.mockImplementationOnce(() => { throw new Error('来源确认中断'); });
    await expect(f.runner.execute(run)).rejects.toThrow('来源确认中断');
    expect(f.context.roundReceipt(run.batch.batchId)).toBeUndefined();
    expect(f.context.checkpoint().inbox).toHaveLength(1);
    expect(f.requests).toHaveLength(0);
    await expect(f.runner.execute(f.scheduler.takeNextRun()!)).resolves.toBe('summary');
    expect(f.context.checkpoint().inbox).toHaveLength(1);
    expect(f.inputsReceived).toHaveBeenCalledTimes(2);
    expect(f.requests).toHaveLength(1);
  });

  it('完整 Runtime 两 Agent 共享 RPM=1 时正常等待后均完成总结，不因准入耗尽而暂停', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'foundation-runtime-'));
    let workCalls = 0;
    let summaryCalls = 0;
    const runtime = createAgentRuntime({
      database: join(directory, 'runtime.sqlite'), workspaces: { work: directory },
      contextPolicy: { budgets: { 1: budget, 2: budget, 3: budget },
        maxSummaryAttempts: 1, maxInbox: 16, maxDeliveryBytes: 30_000 },
      limits: { requestsPerMinute: 1, retryBaseMs: 1, repeatedActionLimit: 20 },
      requester: { provider: 'deepseek', model: 'offline', async request(input) {
        if (input.tools?.some((tool) => tool.name === 'submit_summary')) {
          summaryCalls++;
          return summaryCompletion();
        }
        workCalls++;
        return { ...summaryCompletion(), message: { role: 'assistant', content: '',
          toolCalls: [{ id: `work-${workCalls}`, name: 'context_idle', arguments: {} }] } };
      } },
    });
    try {
      await runtime.initialize();
      for (let index = 1; index <= 2; index++) await runtime.createAgent({
        ownerId: 'owner', workspaceId: 'work', character: 'code_auditor',
        objective: `agent-${index}`, capabilities: [],
      });
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const flush = async () => {
        for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
      };
      runtime.start();
      await flush();
      for (let window = 0; window < 6; window++) {
        await vi.advanceTimersByTimeAsync(60_010);
        await flush();
      }
      expect(workCalls).toBe(2);
      expect(summaryCalls).toBe(2);
      for (let id = 1; id <= 2; id++) {
        expect(runtime.inspect(id, 'owner')).toMatchObject({ status: 'active', rounds: 2,
          control: { state: AgentState.SLEEPING } });
        expect(runtime.interrupts(id, 'owner').some((interrupt) => interrupt.message.includes('retry_exhausted'))).toBe(false);
      }
    } finally {
      await runtime.close();
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
