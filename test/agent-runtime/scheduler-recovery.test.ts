import { describe, expect, it, vi } from 'vitest';
import { salesAgent } from '../../examples/agent-context.js';
import { AgentState, createAgentControlBlock } from '../../src/agent-control-block/index.js';
import { createAgentScheduler, type AgentSchedulerCheckpoint } from '../../src/agent-scheduler/index.js';

describe('调度快照与暂停恢复', () => {
  it('运行期间安装暂停不撤销凭据，结束时阻断下一批；终态操作重复登记不执行', () => {
    const scheduler = createAgentScheduler();
    scheduler.register(createAgentControlBlock({ ...salesAgent, state: AgentState.READY }));
    const run = scheduler.takeNextRun()!;
    const handle = scheduler.registerOperations(run, [{ operationId: 'stable' }])[0]!;
    scheduler.completeOperation(handle.operation, { type: 'succeeded', resultRef: 'saved' });
    const repeated = scheduler.registerOperations(run, [{ operationId: 'stable' }])[0]!;
    expect(repeated.signal.aborted).toBe(true);
    expect(scheduler.inspect(1).pendingOperations).toHaveLength(0);
    scheduler.suspend(1, { reason: '宿主暂停', resumeAt: null });
    expect(scheduler.inspect(1).state).toBe('RUNNING');
    scheduler.finishRun(run, 'continue');
    expect(scheduler.inspect(1).state).toBe('BLOCKED');
    expect(scheduler.takeNextRun()).toBeNull();
    scheduler.resume(1);
    expect(scheduler.takeNextRun()?.batch.results).toHaveLength(1);
    scheduler.close();
  });

  it('在途模型凭据恢复保留批次，暂停期间事件不会提前运行', () => {
    let saved: AgentSchedulerCheckpoint | undefined;
    const persistence = { load: () => structuredClone(saved), save: (value: AgentSchedulerCheckpoint) => { saved = structuredClone(value); } };
    const first = createAgentScheduler({}, persistence);
    first.register(createAgentControlBlock({ ...salesAgent, state: AgentState.READY }));
    const run = first.takeNextRun()!;
    first.notify(1, { eventId: 'later', eventRef: 'later-ref' });
    first.close();
    const second = createAgentScheduler({}, persistence);
    second.register(createAgentControlBlock({ ...salesAgent, state: AgentState.READY }));
    const recovered = second.takeNextRun()!;
    expect(recovered.batch.batchId).toBe(run.batch.batchId);
    expect(recovered.runId).not.toBe(run.runId);
    second.returnRun(recovered);
    second.suspend(1, { reason: '等待审批', resumeAt: null });
    expect(second.inspect(1).state).toBe('BLOCKED');
    expect(second.takeNextRun()).toBeNull();
    second.resume(1);
    second.finishRun(second.takeNextRun()!, 'idle');
    expect(second.takeNextRun()?.batch.events[0]?.eventId).toBe('later');
    second.close();
  });

  it('延期只在到期后入队，存储失败阻断进一步调度', () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn();
      const scheduler = createAgentScheduler({}, { load: () => undefined, save });
      scheduler.register(createAgentControlBlock({ ...salesAgent, state: AgentState.READY }));
      const run = scheduler.takeNextRun()!;
      scheduler.returnRun(run);
      scheduler.suspend(1, { reason: '退避', resumeAt: Date.now() + 1000 });
      vi.advanceTimersByTime(999);
      expect(scheduler.takeNextRun()).toBeNull();
      vi.advanceTimersByTime(1);
      expect(scheduler.takeNextRun()).not.toBeNull();
      save.mockImplementationOnce(() => { throw new Error('disk failed'); });
      expect(() => scheduler.notify(1, { eventId: 'new', eventRef: 'ref' })).toThrow('disk failed');
      expect(() => scheduler.takeNextRun()).toThrow('disk failed');
      scheduler.close();
    } finally { vi.useRealTimers(); }
  });
});
