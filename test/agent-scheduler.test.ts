import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { salesAgent } from '../examples/agent-context.js';
import {
  AgentState,
  createAgentControlBlock,
  InvalidAgentTransitionError,
} from '../src/agent-control-block/index.js';
import {
  createAgentScheduler,
  type AgentRun,
  type AgentScheduler,
} from '../src/agent-scheduler/index.js';

function setup(options: Parameters<typeof createAgentScheduler>[0] = {}) {
  const agent = createAgentControlBlock({ ...salesAgent, state: AgentState.SLEEPING });
  const scheduler = createAgentScheduler(options);
  scheduler.register(agent);
  return { scheduler, agent };
}

function wake(scheduler: AgentScheduler, eventId = 'message-1'): AgentRun {
  scheduler.notify(1, { eventId, eventRef: `messages://${eventId}` });
  const run = scheduler.takeNextRun();
  expect(run).not.toBeNull();
  return run!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('ACB 状态边界', () => {
  it('通过 ACB 接口校验四态并隔离快照修改', () => {
    const input = { ...salesAgent, state: AgentState.SLEEPING };
    const agent = createAgentControlBlock(input);
    expect(() => agent.transition(AgentState.RUNNING)).toThrow(InvalidAgentTransitionError);
    agent.transition(AgentState.READY);
    agent.transition(AgentState.RUNNING);
    agent.transition(AgentState.BLOCKED);
    expect(() => agent.transition(AgentState.SLEEPING)).toThrow(InvalidAgentTransitionError);
    agent.transition(AgentState.READY);
    agent.transition(AgentState.RUNNING);
    agent.transition(AgentState.SLEEPING);
    Object.assign(agent.snapshot().context.level1, { instructions: ['外部修改'] });
    expect(() => Object.assign(agent, { agentId: 2 })).toThrow();
    expect(agent.agentId).toBe(1);
    expect(agent.snapshot().context.level1.instructions).toEqual(salesAgent.context.level1.instructions);
    expect(input.state).toBe(AgentState.SLEEPING);
  });

  it.each([0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1])('拒绝非法整数身份 %s', (agentId) => {
    expect(() => createAgentControlBlock({ ...salesAgent, agentId })).toThrow();
  });
});

describe('异步操作与批次调度', () => {
  it('全部操作结束立即入队，失败也算结束，模型处理完结果后才能休眠', () => {
    const { scheduler, agent } = setup();
    const run = wake(scheduler);
    const [a, b] = scheduler.registerOperations(run, [{}, {}]);
    scheduler.finishRun(run, 'idle');
    expect(agent.getState()).toBe(AgentState.BLOCKED);
    scheduler.completeOperation(a!.operation, { type: 'succeeded', resultRef: 'results://a' });
    expect(scheduler.takeNextRun()).toBeNull();
    scheduler.completeOperation(b!.operation, { type: 'failed', error: '读取失败' });
    expect(agent.getState()).toBe(AgentState.READY);
    const next = scheduler.takeNextRun()!;
    expect(next.batch.results.map((entry) => entry.outcome.type)).toEqual(['succeeded', 'failed']);
    expect(scheduler.inspect(1).completedResults).toEqual([]);
    expect(agent.getState()).toBe(AgentState.RUNNING);
    scheduler.finishRun(next, 'idle');
    expect(agent.getState()).toBe(AgentState.SLEEPING);
    expect(scheduler.takeNextRun()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('30 秒投递部分结果，后续完成不能修改尚未发送的批次', () => {
    const { scheduler, agent } = setup();
    const run = wake(scheduler);
    const [a, b, c] = scheduler.registerOperations(run, [{}, {}, {}]);
    scheduler.finishRun(run, 'idle');
    scheduler.completeOperation(a!.operation, { type: 'succeeded', resultRef: 'results://a' });
    vi.advanceTimersByTime(29_999);
    expect(scheduler.takeNextRun()).toBeNull();
    vi.advanceTimersByTime(1);
    const sealed = scheduler.inspect(1).queuedBatch!;
    expect(sealed.results).toHaveLength(1);
    expect(agent.getState()).toBe(AgentState.READY);
    expect(sealed.pendingOperations.map((operation) => operation.operationId)).toEqual([
      b!.operation.operationId, c!.operation.operationId,
    ]);
    expect(scheduler.inspect(1).pendingOperations).toHaveLength(2);

    scheduler.completeOperation(b!.operation, { type: 'succeeded', resultRef: 'results://b' });
    expect(scheduler.inspect(1).queuedBatch).toEqual(sealed);
    expect(sealed.pendingOperations).toHaveLength(2);
    expect(scheduler.inspect(1).pendingOperations).toHaveLength(1);
    expect(scheduler.inspect(1).completedResults).toHaveLength(1);
    expect(Object.isFrozen(sealed.results)).toBe(true);
    expect(Object.isFrozen(sealed.pendingOperations)).toBe(true);
    expect(() => Object.assign(sealed.results[0]!.outcome, { resultRef: '篡改' })).toThrow();
    const partialRun = scheduler.takeNextRun()!;
    scheduler.completeOperation(c!.operation, { type: 'succeeded', resultRef: 'results://c' });
    expect(scheduler.takeNextRun()).toBeNull();
    scheduler.finishRun(partialRun, 'idle');
    const next = scheduler.takeNextRun()!;
    expect(next.batch.results.map((entry) => entry.operation.operationId)).toEqual([
      b!.operation.operationId, c!.operation.operationId,
    ]);
    expect(partialRun.batch).toEqual(sealed);
  });

  it('回调先后落在封存边界两侧时既不丢失也不重复投递', async () => {
    const { scheduler } = setup();
    const run = wake(scheduler);
    const [a, b, c] = scheduler.registerOperations(run, [{}, {}, {}]);
    scheduler.finishRun(run, 'idle');
    scheduler.completeOperation(a!.operation, { type: 'succeeded', resultRef: 'results://a' });
    const bCallback = Promise.resolve().then(() =>
      scheduler.completeOperation(b!.operation, { type: 'succeeded', resultRef: 'results://b' }));
    await bCallback;
    vi.advanceTimersByTime(30_000);
    await Promise.resolve().then(() =>
      scheduler.completeOperation(c!.operation, { type: 'succeeded', resultRef: 'results://c' }));
    const first = scheduler.takeNextRun()!;
    expect(first.batch.results.map((entry) => entry.operation.operationId)).toEqual([
      a!.operation.operationId, b!.operation.operationId,
    ]);
    expect(scheduler.inspect(1).completedResults[0]?.operation.operationId).toBe(c!.operation.operationId);
    scheduler.finishRun(first, 'idle');
    const second = scheduler.takeNextRun()!;
    expect(second.batch.results).toHaveLength(1);
    expect(second.batch.results[0]?.operation.operationId).toBe(c!.operation.operationId);
  });

  it('运行期间到期不重复入队，结束后立即交付已经等待足够久的部分结果', () => {
    const { scheduler } = setup();
    const run = wake(scheduler);
    const [a] = scheduler.registerOperations(run, [{}, { timeoutMs: 300_000 }]);
    scheduler.completeOperation(a!.operation, { type: 'succeeded', resultRef: 'results://a' });
    vi.advanceTimersByTime(60_000);
    expect(scheduler.takeNextRun()).toBeNull();
    scheduler.finishRun(run, 'idle');
    const next = scheduler.takeNextRun()!;
    expect(next.batch.results).toHaveLength(1);
    expect(scheduler.inspect(1).pendingOperations).toHaveLength(1);
  });

  it('批处理期限从首个结果起算，后续完成不重置窗口', () => {
    const { scheduler } = setup();
    const run = wake(scheduler);
    const [a, b] = scheduler.registerOperations(run, [{}, {}, {}]);
    scheduler.finishRun(run, 'idle');
    scheduler.completeOperation(a!.operation, { type: 'succeeded', resultRef: 'results://a' });
    vi.advanceTimersByTime(20_000);
    scheduler.completeOperation(b!.operation, { type: 'succeeded', resultRef: 'results://b' });
    vi.advanceTimersByTime(10_000);
    expect(scheduler.takeNextRun()?.batch.results).toHaveLength(2);
  });

  it('没有新结果时不因批处理时间到而发送空请求', () => {
    const { scheduler, agent } = setup();
    const run = wake(scheduler);
    scheduler.registerOperations(run, [{ timeoutMs: 300_000 }]);
    scheduler.finishRun(run, 'idle');
    vi.advanceTimersByTime(90_000);
    expect(agent.getState()).toBe(AgentState.BLOCKED);
    expect(scheduler.takeNextRun()).toBeNull();
    expect(scheduler.inspect(1).batchDueAt).toBeNull();
  });

  it('超时解除永久等待，取消回调重入及远端迟到结果均不能覆盖超时批次', () => {
    const { scheduler, agent } = setup({ operationTimeoutMs: 5000 });
    const run = wake(scheduler);
    const [operation] = scheduler.registerOperations(run, [{}]);
    let accepted = true;
    operation!.signal.addEventListener('abort', () => {
      accepted = scheduler.completeOperation(operation!.operation, { type: 'cancelled', reason: '响应取消' });
    });
    scheduler.finishRun(run, 'idle');
    vi.advanceTimersByTime(5000);
    expect(operation!.signal.aborted).toBe(true);
    expect(accepted).toBe(false);
    expect(agent.getState()).toBe(AgentState.READY);
    const next = scheduler.takeNextRun()!;
    expect(next.batch.results[0]?.outcome).toEqual({ type: 'timed_out' });
    expect(scheduler.completeOperation(operation!.operation, {
      type: 'succeeded', resultRef: 'results://late',
    })).toBe(false);
    expect(scheduler.inspect(1).completedResults).toHaveLength(0);
  });

  it('事件循环延迟时按截止时间裁决迟到结果，而不依赖定时器先执行', () => {
    const { scheduler } = setup({ operationTimeoutMs: 1000 });
    const run = wake(scheduler);
    const [operation] = scheduler.registerOperations(run, [{}]);
    scheduler.finishRun(run, 'idle');
    vi.setSystemTime(Date.now() + 2000);
    expect(scheduler.completeOperation(operation!.operation, {
      type: 'succeeded', resultRef: 'results://late',
    })).toBe(false);
    expect(scheduler.takeNextRun()?.batch.results[0]?.outcome.type).toBe('timed_out');
  });

  it('运行中可以登记新的操作，不会把已在运行的旧操作重复加入', () => {
    const { scheduler } = setup();
    const run = wake(scheduler);
    const [a, b] = scheduler.registerOperations(run, [{}, {}]);
    scheduler.finishRun(run, 'idle');
    scheduler.completeOperation(a!.operation, { type: 'succeeded', resultRef: 'results://a' });
    vi.advanceTimersByTime(30_000);
    const next = scheduler.takeNextRun()!;
    const [c] = scheduler.registerOperations(next, [{}]);
    scheduler.finishRun(next, 'idle');
    expect(scheduler.inspect(1).pendingOperations.map((operation) => operation.operationId)).toEqual([
      b!.operation.operationId, c!.operation.operationId,
    ]);
  });

  it('已交付操作的重复回调不会产生新结果', () => {
    const { scheduler } = setup();
    const run = wake(scheduler);
    const [operation] = scheduler.registerOperations(run, [{}]);
    scheduler.finishRun(run, 'idle');
    const outcome = { type: 'succeeded' as const, resultRef: 'results://a' };
    expect(scheduler.completeOperation(operation!.operation, outcome)).toBe(true);
    const next = scheduler.takeNextRun()!;
    scheduler.finishRun(next, 'idle');
    expect(scheduler.completeOperation(operation!.operation, outcome)).toBe(false);
    expect(scheduler.takeNextRun()).toBeNull();
  });

  it('Context 仍需要推进时即使没有异步操作也继续，空闲后不空转', () => {
    const { scheduler, agent } = setup();
    const run = wake(scheduler);
    scheduler.finishRun(run, 'continue');
    const next = scheduler.takeNextRun()!;
    expect(next.batch.continuation).toBe(true);
    expect(next.batch.results).toEqual([]);
    scheduler.finishRun(next, 'idle');
    vi.advanceTimersByTime(600_000);
    expect(agent.getState()).toBe(AgentState.SLEEPING);
    expect(scheduler.takeNextRun()).toBeNull();
  });
});

describe('消息、运行额度与对外边界', () => {
  it('READY 和 RUNNING 期间的消息保留到下一批，不被休眠意图覆盖', () => {
    const { scheduler, agent } = setup();
    scheduler.notify(1, { eventId: 'a', eventRef: 'messages://a' });
    scheduler.notify(1, { eventId: 'b', eventRef: 'messages://b' });
    const first = scheduler.takeNextRun()!;
    expect(first.batch.events.map((event) => event.eventId)).toEqual(['a']);
    scheduler.notify(1, { eventId: 'c', eventRef: 'messages://c' });
    expect(scheduler.notify(1, { eventId: 'a', eventRef: 'messages://a' })).toBe(false);
    expect(scheduler.takeNextRun()).toBeNull();
    scheduler.finishRun(first, 'idle');
    expect(agent.getState()).toBe(AgentState.READY);
    expect(scheduler.takeNextRun()?.batch.events.map((event) => event.eventId)).toEqual(['b', 'c']);
  });

  it('归还失败批次不吞结果、不追加新输入，并拒绝旧运行凭据', () => {
    const { scheduler } = setup();
    const first = wake(scheduler);
    scheduler.notify(1, { eventId: 'b', eventRef: 'messages://b' });
    scheduler.returnRun(first);
    const retried = scheduler.takeNextRun()!;
    expect(retried.batch).toEqual(first.batch);
    expect(retried.runId).not.toBe(first.runId);
    expect(() => scheduler.finishRun(first, 'idle')).toThrow();
    scheduler.finishRun(retried, 'idle');
    expect(scheduler.takeNextRun()?.batch.events[0]?.eventId).toBe('b');
  });

  it('全局运行额度与先进先出保证其他 Agent 可以运行', async () => {
    const { scheduler } = setup({ maxConcurrentRuns: 1 });
    scheduler.register(createAgentControlBlock({ ...salesAgent, agentId: 2 }));
    scheduler.notify(1, { eventId: 'a', eventRef: 'messages://a' });
    const first = scheduler.takeNextRun()!;
    expect(first.agentId).toBe(2);
    expect(scheduler.takeNextRun()).toBeNull();
    let ready = false;
    const waiting = scheduler.waitForReady().then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    scheduler.finishRun(first, 'continue');
    await waiting;
    const next = scheduler.takeNextRun()!;
    expect(next.agentId).toBe(1);
    scheduler.finishRun(next, 'idle');
    expect(scheduler.takeNextRun()?.agentId).toBe(2);
  });

  it('无工作时等待通知，等待方可以取消而不影响 Agent', async () => {
    const { scheduler, agent } = setup();
    const controller = new AbortController();
    const wait = scheduler.waitForReady(controller.signal);
    const rejected = expect(wait).rejects.toThrow('取消等待');
    controller.abort(new Error('取消等待'));
    await rejected;
    expect(agent.getState()).toBe(AgentState.SLEEPING);
    const notified = scheduler.waitForReady();
    scheduler.notify(1, { eventId: 'a', eventRef: 'messages://a' });
    await notified;
  });

  it('批量登记失败不会留下半组操作，缓冲上限包含已封存结果', () => {
    const { scheduler } = setup({ maxBufferedOperations: 2 });
    const run = wake(scheduler);
    expect(() => scheduler.registerOperations(run, [{}, { timeoutMs: -1 }])).toThrow();
    expect(scheduler.inspect(1).pendingOperations).toEqual([]);
    const handles = scheduler.registerOperations(run, [{}, {}]);
    expect(() => scheduler.registerOperations(run, [{}])).toThrow();
    scheduler.finishRun(run, 'idle');
    for (const handle of handles) {
      scheduler.completeOperation(handle.operation, { type: 'succeeded', resultRef: 'results://ok' });
    }
    const next = scheduler.takeNextRun()!;
    expect(() => scheduler.registerOperations(next, [{}])).toThrow();
  });

  it('事件缓冲满时拒绝但不吞消息，消费以后可以再次提交', () => {
    const { scheduler } = setup({ maxBufferedEvents: 1 });
    const run = wake(scheduler);
    expect(() => scheduler.notify(1, { eventId: 'b', eventRef: 'messages://b' })).toThrow();
    scheduler.finishRun(run, 'idle');
    expect(scheduler.notify(1, { eventId: 'b', eventRef: 'messages://b' })).toBe(true);
  });

  it('不能重复注册或带丢失在途状态注册；忙碌时不能移除', () => {
    const { scheduler, agent } = setup();
    expect(() => scheduler.register(agent)).toThrow();
    expect(() => scheduler.register(createAgentControlBlock({
      ...salesAgent, agentId: 2, state: AgentState.BLOCKED,
    }))).toThrow();
    const run = wake(scheduler);
    expect(() => scheduler.unregister(1)).toThrow();
    scheduler.finishRun(run, 'idle');
    scheduler.unregister(1);
    expect(() => scheduler.inspect(1)).toThrow();
  });
});
