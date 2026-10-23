import { randomUUID } from 'node:crypto';
import type { RuntimeStore } from './store.js';

type WorkBudget = { key: string; used: number; allocation: number; closed: boolean };

/** 工作额度跨重试和重启保留；收件批次与长期统计使用不同的生命周期。 */
export function workBudget(store: RuntimeStore, agentId: number, batchId?: string): WorkBudget {
  const saved = store.metadata<WorkBudget>(`work-budget:${agentId}`);
  // 同一收件批次不能因旧版本过早关闭而重新获得额度。
  if (saved && batchId === saved.key && saved.closed) {
    const reopened = { ...saved, closed: false };
    store.putMetadata(`work-budget:${agentId}`, reopened);
    return reopened;
  }
  if (saved && !saved.closed && (!batchId || saved.key === batchId)) return saved;
  const budget = { key: batchId ?? `work:${randomUUID()}`, used: 0, allocation: 1, closed: false };
  store.putMetadata(`work-budget:${agentId}`, budget);
  return budget;
}

export function consumeWorkRound(store: RuntimeStore, agentId: number, budget: WorkBudget): void {
  store.putMetadata(`work-budget:${agentId}`, { ...budget, used: budget.used + 1 });
}

export function finishWorkBudget(store: RuntimeStore, agentId: number): void {
  const saved = store.metadata<WorkBudget>(`work-budget:${agentId}`);
  if (saved && !saved.closed) store.putMetadata(`work-budget:${agentId}`, { ...saved, closed: true });
}

export function renewWorkBudget(store: RuntimeStore, agentId: number, maximum: number): boolean {
  const saved = store.metadata<WorkBudget>(`work-budget:${agentId}`);
  if (!saved || saved.closed || saved.used < maximum) return false;
  store.putMetadata(`work-budget:${agentId}`, { ...saved, used: 0, allocation: saved.allocation + 1 });
  store.event(agentId, 'work_budget_renewed', { workKey: saved.key, previousRounds: saved.used,
    allocation: saved.allocation + 1, maxRounds: maximum });
  return true;
}
