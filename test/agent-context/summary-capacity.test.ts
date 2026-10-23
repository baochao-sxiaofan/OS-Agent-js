import { expect, it } from 'vitest';
import { estimateContextTokens, restoreAgentContextManager, summaryCapacity } from '../../src/agent-context/index.js';
import { summaryRequest } from '../../src/agent-round/requests.js';
import { classifyFault } from '../../src/agent-runtime/internal/limits.js';
import { apply, descend, policy, setupContext, summary } from './helpers.js';

it('压缩保留未完成任务，详细步骤结果移到封存原文，恢复与重复提交不改变进度', () => {
  const { context, store } = setupContext();
  descend(context, 3);
  apply(context, { type: 'plan', objectives: ['已完成甲', '已完成乙', '正在工作', '等待工作'] });
  for (const name of ['甲', '乙']) {
    apply(context, { type: 'advance' });
    apply(context, { type: 'step_completed', result: {
      ...summary(undefined, `${name}阶段结论`), decisions: [`${name}的详细结果`.repeat(350)],
    } });
  }
  apply(context, { type: 'advance' });
  const before = context.snapshot().level3!;
  apply(context, { type: 'compact' });
  const pending = context.beginSummaryAttempt();
  const request = summaryRequest(context.checkpoint(), 4096);
  const payload = JSON.parse(String(request.messages[1]?.content)) as {
    maxSummaryBytes: number; fixedFrameBytes: number; targetFrameBytes: number; suggestedContentBytes: number;
  };
  expect(payload.maxSummaryBytes + payload.fixedFrameBytes).toBe(payload.targetFrameBytes);
  expect(payload.suggestedContentBytes).toBeLessThan(payload.maxSummaryBytes);
  context.commitSummary('compact', pending.id, summary(pending.sourceRef));
  const after = context.snapshot().level3!;
  expect(after.taskChain.tasks.map((task) => task.state)).toEqual(['COMPLETED', 'COMPLETED', 'RUNNING', 'WAITING']);
  expect(after.taskChain.currentTaskId).toBe(before.taskChain.currentTaskId);
  expect(estimateContextTokens(after)).toBeLessThan(4000);
  const task = after.taskChain.tasks[0]!;
  expect(task.state === 'COMPLETED' && task.result.sourceRefs).toEqual([pending.sourceRef]);
  const archive = context.read(pending.sourceRef);
  expect(archive?.kind === 'frame' && archive.context.level3).toEqual(before);
  const restored = restoreAgentContextManager({ key: 'agent-1', store });
  const checkpoint = restored.checkpoint();
  restored.commitSummary('compact', pending.id, summary(pending.sourceRef));
  expect(restored.checkpoint()).toEqual(checkpoint);
  expect(restored.read(pending.sourceRef)).toEqual(archive);
});

it('摘要过大提供具体容量并允许有限纠正，原文、计划和提交回执保持不变', () => {
  const budget = { maxTokens: 6000, compactAtTokens: 4000, targetTokens: 2000, maxTasks: 5 };
  const { context } = setupContext(undefined, { ...policy, budgets: { 1: budget, 2: budget, 3: budget } });
  apply(context, { type: 'idle' });
  const pending = context.beginSummaryAttempt();
  const checkpoint = context.checkpoint();
  let failure: unknown;
  try { context.commitSummary('large', pending.id, summary(pending.sourceRef, '很长'.repeat(600))); }
  catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'summary_too_large' });
  expect(classifyFault(failure)).toMatchObject({ kind: 'protocol', retry: true });
  expect(String(failure)).toContain('摘要最多');
  expect(context.checkpoint()).toEqual(checkpoint);
  expect(context.roundReceipt('large')).toBeUndefined();
  context.failSummary(pending.id, String(failure));
  expect(JSON.stringify(summaryRequest(context.checkpoint(), 4096))).toContain('摘要最多');
  context.commitSummary('small', pending.id, summary(pending.sourceRef));
  expect(context.needsRun()).toBe(false);
});

it('固定结构过大时在请求模型前拒绝，防止无论如何总结都无法收敛', () => {
  const { context } = setupContext();
  apply(context, { type: 'plan', objectives: ['尚未完成的目标'.repeat(700)] });
  apply(context, { type: 'compact' });
  expect(() => summaryCapacity(context.checkpoint())).toThrow('固定结构');
  expect(() => summaryRequest(context.checkpoint(), 4096)).toThrow('无法容纳摘要');
});
