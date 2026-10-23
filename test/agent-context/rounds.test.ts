import { describe, expect, it, vi } from 'vitest';
import { salesAgent } from '../../examples/agent-context.js';
import { AgentState, createAgentControlBlock } from '../../src/agent-control-block/index.js';
import { createAgentRoundRunner, type AgentRoundOptions } from '../../src/agent-round/index.js';
import { createAgentScheduler } from '../../src/agent-scheduler/index.js';
import { createModelRequester, type ModelCompletionRequest } from '../../src/model-requester/index.js';
import { apply, descend, setupContext, summary } from './helpers.js';

function fixture(work?: AgentRoundOptions['work']) {
  const { context, store } = setupContext();
  descend(context);
  const agent = createAgentControlBlock({
    ...salesAgent, state: AgentState.READY, context: context.snapshot(),
  }, context);
  const scheduler = createAgentScheduler();
  scheduler.register(agent);
  const requests: ModelCompletionRequest[] = [];
  const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as ModelCompletionRequest;
    requests.push(body);
    const pending = context.checkpoint().pendingSummary;
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: {
        role: 'assistant', content: pending ? '' : '完成业务动作',
        ...(pending ? { tool_calls: [{ id: 'summary', type: 'function',
          function: { name: 'submit_summary', arguments: JSON.stringify(summary(pending.sourceRef)) } }] } : {}),
        reasoning_details: [{ type: 'reasoning.text', text: 'vendor-private' }],
      } }],
    }));
  });
  const requester = createModelRequester({
    provider: 'minimax', model: 'MiniMax-M3', apiKey: 'test-only',
    baseUrl: 'https://provider.invalid/v1', fetchImplementation: transport,
  });
  const business = vi.fn<AgentRoundOptions['work']>(work ?? (async (round) => {
    await round.request({ messages: [{ role: 'user', content: JSON.stringify(round.view) }] });
    return { decision: { type: context.snapshot().level2 ? 'complete' : 'idle' } };
  }));
  const options: AgentRoundOptions = {
    agentId: 1, context, scheduler, requester, maxRequestTokens: 50_000, maxOutputTokens: 4_000,
    work: business,
    resolveEvent: async (event) => ({ entries: [{
      id: event.eventId, createdAt: 1, kind: 'message', role: 'user', content: `正文:${event.eventRef}`,
    }] }),
    resolveResult: async (result) => ({ entries: [{
      id: result.operation.operationId, createdAt: 1, kind: 'event',
      name: 'operation_result', data: result.outcome,
    }] }),
  };
  return { context, store, agent, scheduler, requests, transport, business, options,
    runner: createAgentRoundRunner(options) };
}

describe('普通轮与总结轮共用调度路径', () => {
  it('不同 runId 分别发送业务和总结请求，父层处理后再总结休眠', async () => {
    const { runner, scheduler, agent, context, business, transport } = fixture();
    const workRun = scheduler.takeNextRun()!;
    await expect(runner.execute(workRun)).resolves.toBe('work');
    expect(context.checkpoint().pendingSummary?.purpose).toBe('complete');
    expect(agent.getState()).toBe(AgentState.READY);
    expect(agent.snapshot().context).toEqual(context.snapshot());
    const summaryRun = scheduler.takeNextRun()!;
    expect(summaryRun.runId).not.toBe(workRun.runId);
    expect(summaryRun.batch.results).toEqual([]);
    expect(summaryRun.batch.pendingOperations).toEqual([]);
    await expect(runner.execute(summaryRun)).resolves.toBe('summary');
    expect(context.snapshot().level2).toBeNull();
    expect(business).toHaveBeenCalledTimes(1);
    await runner.execute(scheduler.takeNextRun()!);
    expect(context.checkpoint().pendingSummary?.purpose).toBe('idle');
    expect(agent.getState()).toBe(AgentState.READY);
    await runner.execute(scheduler.takeNextRun()!);
    expect(agent.getState()).toBe(AgentState.SLEEPING);
    expect(transport).toHaveBeenCalledTimes(4);
    expect(business).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(context.checkpoint())).not.toContain('vendor-private');
    expect(scheduler.takeNextRun()).toBeNull();
  });

  it('总结批次及请求期间的新消息都在后续普通轮处理，不污染封存输入', async () => {
    const { runner, scheduler, context, requests, transport } = fixture();
    const first = scheduler.takeNextRun()!;
    scheduler.notify(1, { eventId: 'during-work', eventRef: 'messages://first' });
    await runner.execute(first);
    const source = context.checkpoint().pendingSummary!.sourceRef;
    const next = scheduler.takeNextRun()!;
    expect(next.batch.events).toHaveLength(1);
    const original = transport.getMockImplementation()!;
    transport.mockImplementationOnce(async (...args) => {
      scheduler.notify(1, { eventId: 'during-summary', eventRef: 'messages://second' });
      return original(...args);
    });
    await runner.execute(next);
    expect(context.checkpoint().inbox).toHaveLength(1);
    expect(JSON.stringify(requests[1])).not.toContain('正文:');
    expect(JSON.stringify(context.read(source))).not.toContain('正文:');
    await runner.execute(scheduler.takeNextRun()!);
    expect(JSON.stringify(requests[2])).toContain('messages://first');
    expect(JSON.stringify(requests[2])).toContain('messages://second');
    expect(context.checkpoint().inbox).toEqual([]);
    await runner.execute(scheduler.takeNextRun()!);
  });

  it('总结失败归还同批次，保留来源与消息，不重做业务动作并限制重试次数', async () => {
    const { runner, scheduler, context, business, transport, agent } = fixture();
    await runner.execute(scheduler.takeNextRun()!);
    const pending = context.checkpoint().pendingSummary!;
    transport.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: 'invalid-json' } }],
    })));
    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(runner.execute(scheduler.takeNextRun()!)).rejects.toThrow();
      expect(context.checkpoint().pendingSummary).toMatchObject({
        id: pending.id, sourceRef: pending.sourceRef, attempts: attempt,
      });
      expect(context.snapshot().level2).not.toBeNull();
      expect(agent.getState()).toBe(AgentState.READY);
    }
    const calls = transport.mock.calls.length;
    await expect(runner.execute(scheduler.takeNextRun()!)).rejects.toMatchObject({ code: 'retry_exhausted' });
    expect(transport).toHaveBeenCalledTimes(calls);
    expect(business).toHaveBeenCalledTimes(1);
  });

  it('提交成功但调度确认失败时只重放回执，不重复请求或合并', async () => {
    const { runner, scheduler, context, business, transport } = fixture();
    await runner.execute(scheduler.takeNextRun()!);
    const finish = vi.spyOn(scheduler, 'finishRun').mockImplementationOnce(() => { throw new Error('确认中断'); });
    await expect(runner.execute(scheduler.takeNextRun()!)).rejects.toThrow('确认中断');
    expect(context.snapshot().level2).toBeNull();
    const calls = transport.mock.calls.length;
    finish.mockRestore();
    await expect(runner.execute(scheduler.takeNextRun()!)).resolves.toBe('replayed');
    expect(transport).toHaveBeenCalledTimes(calls);
    expect(business).toHaveBeenCalledTimes(1);
  });

  it('硬预算和取消在发送前阻断，单张凭据不能偷发第二次请求', async () => {
    const first = fixture();
    const small = createAgentRoundRunner({ ...first.options, maxRequestTokens: 1 });
    await expect(small.execute(first.scheduler.takeNextRun()!)).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(first.transport).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort(new Error('取消'));
    await expect(first.runner.execute(first.scheduler.takeNextRun()!, controller.signal)).rejects.toThrow('取消');
    expect(first.transport).not.toHaveBeenCalled();
    const second = fixture(async (round) => {
      await round.request({ messages: [{ role: 'user', content: '第一轮' }] });
      await round.request({ messages: [{ role: 'user', content: '不应发送' }] });
      return { decision: { type: 'complete' } };
    });
    await expect(second.runner.execute(second.scheduler.takeNextRun()!)).rejects.toThrow('一次');
    expect(second.transport).toHaveBeenCalledTimes(1);
  });

  it('完成目标时拒绝遗留在途业务操作，无唤醒路径不能等待', async () => {
    const waiting = fixture(async () => ({ decision: { type: 'wait' } }));
    await expect(waiting.runner.execute(waiting.scheduler.takeNextRun()!)).rejects.toThrow('唤醒路径');
    const pending = fixture(async ({ run }) => {
      pending.scheduler.registerOperations(run, [{}]);
      return { decision: { type: 'complete' } };
    });
    await expect(pending.runner.execute(pending.scheduler.takeNextRun()!)).rejects.toThrow('在途操作');
    for (const operation of pending.scheduler.inspect(1).pendingOperations) {
      pending.scheduler.completeOperation(operation, { type: 'cancelled', reason: '测试结束' });
    }
  });
});

it('根层空闲总结失败后重试成功才可休眠', async () => {
  const { context, runner, scheduler, agent } = fixture();
  apply(context, { type: 'complete' });
  await runner.execute(scheduler.takeNextRun()!);
  await runner.execute(scheduler.takeNextRun()!);
  expect(context.checkpoint().pendingSummary?.purpose).toBe('idle');
  await runner.execute(scheduler.takeNextRun()!);
  expect(agent.getState()).toBe(AgentState.SLEEPING);
});
