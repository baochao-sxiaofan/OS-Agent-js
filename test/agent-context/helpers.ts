import {
  createAgentContextManager, InMemoryContextStore,
  type AgentContextManager, type ContextDecision, type ContextPolicy, type ContextStore, type ContextSummary,
} from '../../src/agent-context/index.js';

export const policy: ContextPolicy = {
  budgets: {
    1: { maxTokens: 20_000, compactAtTokens: 15_000, targetTokens: 8_000, maxTasks: 10 },
    2: { maxTokens: 20_000, compactAtTokens: 15_000, targetTokens: 8_000, maxTasks: 10 },
    3: { maxTokens: 20_000, compactAtTokens: 15_000, targetTokens: 8_000, maxTasks: 10 },
  },
  maxSummaryAttempts: 3, maxInbox: 16, maxDeliveryBytes: 30_000,
};

export function setupContext(store: ContextStore = new InMemoryContextStore(), customPolicy = policy) {
  let next = 0;
  const context = createAgentContextManager({
    key: 'agent-1', store, instructions: ['遵守宿主规则'], objective: '持续协助用户',
    policy: customPolicy, createId: () => `kernel-${++next}`,
  });
  return { context, store };
}

export function apply(context: AgentContextManager, decision: ContextDecision) {
  context.apply(`round-${context.checkpoint().revision}`, context.cursor(), decision);
}

export function descend(context: AgentContextManager, level: 2 | 3 = 2) {
  apply(context, { type: 'plan', objectives: ['完成阶段工作'] });
  apply(context, { type: 'advance' });
  if (level === 3) {
    apply(context, { type: 'plan', objectives: ['完成具体工作'] });
    apply(context, { type: 'advance' });
  }
}

export function summary(sourceRef?: string, outcome = '工作已完成'): ContextSummary {
  return { outcome, observations: [], decisions: [], artifactRefs: [], unresolved: [],
    nextResponsibilities: [], lessonCandidates: [], sourceRefs: sourceRef ? [sourceRef] : [] };
}

export function finishSummary(context: AgentContextManager) {
  const pending = context.beginSummaryAttempt();
  context.commitSummary(`summary-${context.checkpoint().revision}`, pending.id, summary(pending.sourceRef));
  return pending;
}
