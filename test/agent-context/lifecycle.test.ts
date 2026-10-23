import { describe, expect, it } from 'vitest';
import { createContextView, estimateContextTokens } from '../../src/agent-context/index.js';
import { apply, descend, finishSummary, policy, setupContext, summary } from './helpers.js';

describe('分层任务与独立总结状态', () => {
  it('逐层总结后交回父层，只有根层完成空闲总结才停止运行', () => {
    const { context } = setupContext();
    descend(context, 3);
    apply(context, { type: 'plan', objectives: ['读取资料', '整理结果'] });
    const firstPlan = context.cursor();
    apply(context, { type: 'advance' });
    expect(context.snapshot().level3?.taskChain.tasks.map((task) => task.state)).toEqual(['RUNNING', 'WAITING']);
    expect(() => apply(context, { type: 'complete' })).toThrow('未完成');
    apply(context, { type: 'step_completed', result: summary() });
    apply(context, { type: 'advance' });
    apply(context, { type: 'step_completed', result: summary() });
    apply(context, { type: 'complete' });
    expect(context.cursor()).toEqual(firstPlan);
    expect(context.snapshot().level3).not.toBeNull();
    expect(context.snapshot().level2?.taskChain.tasks[0]?.state).toBe('RUNNING');
    const source = finishSummary(context);
    expect(context.snapshot().level3).toBeNull();
    expect(context.snapshot().level2?.taskChain.tasks[0]?.state).toBe('COMPLETED');
    expect(context.read(source.sourceRef)?.kind).toBe('frame');
    expect(context.needsRun()).toBe(true);
    apply(context, { type: 'complete' });
    finishSummary(context);
    expect(context.snapshot().level2).toBeNull();
    expect(context.needsRun()).toBe(true);
    apply(context, { type: 'idle' });
    expect(context.needsRun()).toBe(true);
    finishSummary(context);
    expect(context.needsRun()).toBe(false);
    expect(context.snapshot().level1.instructions).toEqual(['遵守宿主规则']);
    expect(context.snapshot().level1.currentTask.objective).toBe('持续协助用户');
  });

  it('未完成目标只压缩本层，保留步骤进度与原始历史', () => {
    const { context } = setupContext();
    descend(context, 3);
    apply(context, { type: 'plan', objectives: ['持续处理'] });
    apply(context, { type: 'advance' });
    context.receive([{ key: 'source', target: context.cursor(), entries: [
      { id: 'message-1', createdAt: 1, kind: 'message', role: 'user', content: '原始工作记录' },
    ] }]);
    context.prepare();
    const cursor = context.cursor();
    apply(context, { type: 'compact' });
    const pending = finishSummary(context);
    expect(context.cursor()).toEqual(cursor);
    expect(context.snapshot().level3?.taskChain.tasks[0]?.state).toBe('RUNNING');
    expect(context.snapshot().level3?.memory.recentEntries).toEqual([]);
    const source = context.read(pending.sourceRef);
    expect(source?.kind === 'frame' && source.context.level3?.memory.recentEntries[0]?.kind).toBe('message');
    expect(context.needsRun()).toBe(true);
  });

  it('到达容量阈值自动安排总结，摘要过大不会消费现场', () => {
    const small = { maxTokens: 6_000, compactAtTokens: 4_000, targetTokens: 2_000, maxTasks: 5 };
    const { context } = setupContext(undefined, { ...policy, budgets: { 1: small, 2: small, 3: small } });
    context.receive([{ key: 'big', entries: [
      { id: 'm', createdAt: 1, kind: 'message', role: 'user', content: 'a'.repeat(3800) },
    ] }]);
    const prepared = context.prepare();
    expect(prepared.pendingSummary?.purpose).toBe('compact');
    const pending = context.beginSummaryAttempt();
    expect(() => context.commitSummary('too-big', pending.id, summary(pending.sourceRef, 'a'.repeat(2200))))
      .toThrow('目标容量');
    expect(context.checkpoint().pendingSummary?.id).toBe(pending.id);
    finishSummary(context);
    expect(estimateContextTokens(context.snapshot().level1)).toBeLessThanOrEqual(small.targetTokens);
  });

  it('拒绝陈旧引用、越权字段和第四层分配；中断通过总结交回父层', () => {
    const { context } = setupContext();
    descend(context, 3);
    apply(context, { type: 'plan', objectives: ['旧步骤'] });
    const old = context.cursor();
    apply(context, { type: 'replan', objectives: ['新步骤'], reason: '需求变化' });
    expect(() => context.apply('old', old, { type: 'advance' })).toThrow('版本');
    expect(() => context.apply('forged', context.cursor(),
      { type: 'continue', instructions: ['改写'] } as never)).toThrow('字段');
    apply(context, { type: 'advance' });
    expect(context.snapshot().level3?.level).toBe(3);
    apply(context, { type: 'interrupt', reason: '当前输入不足' });
    finishSummary(context);
    expect(context.snapshot().level2?.taskChain.tasks[0]?.state).toBe('INTERRUPTED');
    const serialized = JSON.stringify(createContextView(context.snapshot()));
    expect(serialized).not.toContain('"id"');
    expect(serialized).not.toContain('"frameId"');
    expect(serialized).not.toContain('"planRevision"');
  });

  it('拒绝伪造来源和私有推理，快照与传入消息不共享引用', () => {
    const { context } = setupContext();
    const delivery = { key: 'immutable', entries: [
      { id: 'm', createdAt: 1, kind: 'message' as const, role: 'user' as const, content: '原文' },
    ] };
    context.receive([delivery]);
    delivery.entries[0]!.content = '篡改';
    context.prepare();
    expect(context.snapshot().level1.memory.recentEntries[0]).toMatchObject({ content: '原文' });
    Object.assign(context.snapshot().level1, { instructions: ['篡改'] });
    expect(context.snapshot().level1.instructions).toEqual(['遵守宿主规则']);
    apply(context, { type: 'idle' });
    const pending = context.beginSummaryAttempt();
    expect(() => context.commitSummary('fake', pending.id, {
      ...summary(pending.sourceRef), artifactRefs: ['invented://artifact'],
    })).toThrow('引用');
    expect(() => context.commitSummary('reasoning', pending.id, {
      ...summary(pending.sourceRef), reasoning: '私有推理',
    } as never)).toThrow('字段');
    expect(() => apply(context, { type: 'continue' })).toThrow('总结完成前');
  });
});
