import { createHash } from 'node:crypto';
import type { ContextDelivery } from '../management.js';
import { active, frames, replaceFrame, type Mutation } from './frames.js';
import { scheduleSummary } from './summaries.js';
import { estimateContextTokens, requireContext } from './validation.js';

export function deliveryRef(key: string): string {
  return `context-input://${createHash('sha256').update(key).digest('hex')}`;
}

export function drainInbox(mutation: Mutation): void {
  const { state } = mutation;
  if (state.pendingSummary) return;
  for (const delivery of state.inbox) {
    const target = delivery.target
      ? frames(state.context).find((frame) => frame.id === delivery.target?.frameId &&
        frame.taskChain.revision === delivery.target.planRevision)
      : state.context.level1;
    // 旧计划的结果只向根层报告存储引用，不能作为新计划的直接输入。
    const frame = target ?? state.context.level1;
    // 不向暂未取得执行权的祖先层塞入正文，避免其预算阻塞子层收尾。
    if (frame.id !== active(state.context).id) continue;
    const entries = target ? delivery.entries : [{
      id: mutation.id(), createdAt: 0, kind: 'event' as const, name: 'stale_context_input',
      data: { sourceRef: deliveryRef(delivery.key) },
    }];
    const updated = { ...frame, memory: { ...frame.memory,
      recentEntries: [...frame.memory.recentEntries, ...entries] } };
    if (estimateContextTokens(updated) > frame.budget.maxTokens) {
      requireContext(active(state.context).id === frame.id && frame.memory.recentEntries.length > 0,
        '输入超过可用容量；请将大内容存为引用或先缩减活跃任务。', 'budget_exceeded');
      scheduleSummary(mutation, 'compact');
      return;
    }
    state.context = replaceFrame(state.context, updated);
    state.inbox = state.inbox.filter((item) => item.key !== delivery.key);
    state.runnable = true;
    if (active(state.context).id === frame.id &&
        estimateContextTokens(updated) >= frame.budget.compactAtTokens) {
      scheduleSummary(mutation, 'compact');
      return;
    }
  }
  const frame = active(state.context);
  if (estimateContextTokens(frame) >= frame.budget.compactAtTokens) scheduleSummary(mutation, 'compact');
}

export function sameDelivery(left: ContextDelivery, right: ContextDelivery): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
