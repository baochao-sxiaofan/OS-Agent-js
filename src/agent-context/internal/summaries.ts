import type { ContextFrame, ContextSummary } from '../api.js';
import type { ContextCheckpoint, ContextSummaryPurpose } from '../management.js';
import { active, archive, assertBudgets, assertCursor, emptyChain, replaceFrame, setChain, type Mutation } from './frames.js';
import { estimateContextTokens, requireContext, validateSummary } from './validation.js';

export function sourceRefs(frame: ContextFrame): string[] {
  const refs = new Set<string>();
  if (frame.memory.historyRef) refs.add(frame.memory.historyRef);
  const addSummary = (summary: ContextSummary): void => {
    summary.sourceRefs.forEach((ref) => refs.add(ref));
    summary.artifactRefs.forEach((ref) => refs.add(ref));
    summary.observations.forEach((item) => item.sourceRefs.forEach((ref) => refs.add(ref)));
    summary.lessonCandidates.forEach((item) => item.sourceRefs.forEach((ref) => refs.add(ref)));
  };
  if (frame.memory.summary) addSummary(frame.memory.summary);
  frame.memory.lessons.forEach((lesson) => lesson.sourceRefs.forEach((ref) => refs.add(ref)));
  for (const task of frame.taskChain.tasks) {
    if (task.state === 'COMPLETED') addSummary(task.result);
    if (task.state === 'INTERRUPTED' && task.partialResult) addSummary(task.partialResult);
  }
  for (const entry of frame.memory.recentEntries) {
    if (entry.kind === 'message') entry.attachmentRefs?.forEach((ref) => refs.add(ref));
    if (entry.kind === 'observation') entry.observation.sourceRefs.forEach((ref) => refs.add(ref));
    // 已投递消息是本层实际收到的证据，其宿主消息 ID 可用于总结引用。
    if (entry.kind === 'event' && entry.name === 'conversation_message') refs.add(entry.id);
    if (entry.kind === 'event' && entry.name === 'artifact_page' && entry.data !== null &&
      typeof entry.data === 'object' && 'ref' in entry.data && typeof entry.data.ref === 'string') refs.add(entry.data.ref);
    if (entry.kind === 'event' && entry.name === 'conversation_read' && entry.data !== null &&
      typeof entry.data === 'object' && 'messages' in entry.data && Array.isArray(entry.data.messages)) {
      for (const message of entry.data.messages) {
        if (message !== null && typeof message === 'object' && !Array.isArray(message) &&
            typeof message.messageId === 'string') refs.add(message.messageId);
      }
    }
  }
  return [...refs];
}

export function scheduleSummary(mutation: Mutation, purpose: ContextSummaryPurpose, reason = ''): void {
  const frame = active(mutation.state.context);
  requireContext(!mutation.state.pendingSummary, '已有待总结工作。', 'invalid_state');
  const unfinished = frame.taskChain.tasks.some((task) => task.state === 'WAITING' || task.state === 'RUNNING');
  if (purpose === 'complete' || purpose === 'idle') {
    requireContext(!unfinished, '任务链仍有未完成工作，不能完成或休眠。', 'invalid_state');
  }
  requireContext(purpose !== 'complete' || frame.level !== 1, '根层长期职责不能完成。', 'invalid_state');
  requireContext(purpose !== 'interrupt' || frame.level !== 1, '根层长期职责不能中断。', 'invalid_state');
  requireContext(purpose !== 'idle' || frame.level === 1, '子层必须先向父层总结。', 'invalid_state');
  const sourceRef = archive(mutation);
  mutation.state.pendingSummary = {
    id: mutation.id(), frameId: frame.id, planRevision: frame.taskChain.revision,
    purpose, reason, sourceRef, allowedRefs: [sourceRef, ...sourceRefs(frame)],
    attempts: 0, lastError: null,
  };
  mutation.state.runnable = true;
}

export function compactedFrame(frame: ContextFrame, summary: ContextSummary, historyRef: string,
  sealedSourceRef = historyRef): ContextFrame {
  const completed = frame.taskChain.tasks.every((task) =>
    task.state !== 'WAITING' && task.state !== 'RUNNING');
  // 封存帧已保留每个步骤的完整结果；活跃计划只保留短结论和可读取的原文引用。
  const compactResult = (result: ContextSummary): ContextSummary => {
    if (estimateContextTokens(result) <= 1024) return result;
    const characters = Array.from(result.outcome);
    return {
      outcome: characters.slice(0, 160).join('') + (characters.length > 160 ? '…（完整结果见来源）' : ''),
      observations: [], decisions: [], artifactRefs: [], unresolved: [], nextResponsibilities: [],
      lessonCandidates: [], sourceRefs: [sealedSourceRef],
    };
  };
  const updated = completed
    ? setChain(frame, emptyChain(frame.level, frame.taskChain.revision))
    : setChain(frame, { ...frame.taskChain, tasks: frame.taskChain.tasks.map((task) =>
      task.state === 'COMPLETED' ? { ...task, result: compactResult(task.result) }
        : task.state === 'INTERRUPTED' && task.partialResult
          ? { ...task, partialResult: compactResult(task.partialResult) } : task) });
  return { ...updated, memory: { ...updated.memory, summary, recentEntries: [], historyRef } };
}

/** 以实际保存结构估算剩余摘要空间，不能把整个层容量都许给模型。 */
export function summaryCapacity(checkpoint: ContextCheckpoint): {
  targetFrameBytes: number; fixedFrameBytes: number; maxSummaryBytes: number; suggestedContentBytes: number;
} {
  const pending = checkpoint.pendingSummary;
  requireContext(pending, '缺少待总结状态。', 'invalid_state');
  const frame = active(checkpoint.context);
  const empty: ContextSummary = { outcome: '', observations: [], decisions: [], artifactRefs: [],
    unresolved: [], nextResponsibilities: [], lessonCandidates: [], sourceRefs: [] };
  const projected = compactedFrame(frame, empty,
    'context-summary://00000000-0000-0000-0000-000000000000', pending.sourceRef);
  const fixedFrameBytes = estimateContextTokens(projected) - estimateContextTokens(empty);
  const maxSummaryBytes = frame.budget.targetTokens - fixedFrameBytes;
  const minimumBytes = estimateContextTokens({ ...empty, outcome: '摘要', sourceRefs: [pending.sourceRef] });
  requireContext(maxSummaryBytes >= minimumBytes,
    `第 ${frame.level} 层固定结构占 ${fixedFrameBytes} 字节，目标 ${frame.budget.targetTokens} 字节，无法容纳摘要；请提高压缩目标容量。`,
    'budget_exceeded');
  // 短编号还原和 JSON 转义会增长；此值是生成建议，提交时仍按还原后的真实大小校验。
  const referenceReserve = Math.min(Math.floor(maxSummaryBytes / 2),
    Math.max(...pending.allowedRefs.map((ref) => Buffer.byteLength(JSON.stringify(ref)))) * 32);
  return { targetFrameBytes: frame.budget.targetTokens, fixedFrameBytes, maxSummaryBytes,
    suggestedContentBytes: Math.max(1, maxSummaryBytes - minimumBytes - referenceReserve) };
}

export function integrateSummary(mutation: Mutation, id: string, summary: ContextSummary): void {
  const { state } = mutation;
  const pending = state.pendingSummary;
  requireContext(pending?.id === id, '总结凭据已失效。', 'stale_context');
  const frame = active(state.context);
  assertCursor(frame, pending);
  validateSummary(summary, pending.allowedRefs);
  requireContext(summary.sourceRefs.includes(pending.sourceRef), '总结必须引用本次封存历史。');
  const summaryRef = `context-summary://${mutation.id()}`;
  const compacted = compactedFrame(frame, summary, summaryRef, pending.sourceRef);
  const capacity = summaryCapacity(state);
  const actualBytes = estimateContextTokens(compacted);
  requireContext(actualBytes <= frame.budget.targetTokens,
    `第 ${frame.level} 层压缩后 ${actualBytes} 字节，目标容量 ${capacity.targetFrameBytes}；固定结构 ${capacity.fixedFrameBytes}，`
      + `本次摘要 ${estimateContextTokens(summary)}，摘要最多 ${capacity.maxSummaryBytes} 字节。请减少观察和经验条目、合并重复引用后重新提交。`,
    'summary_too_large');
  mutation.writes.push({ ref: summaryRef, record: { kind: 'summary', sourceRef: pending.sourceRef, summary } });
  if (pending.purpose === 'compact' || pending.purpose === 'idle') {
    state.context = replaceFrame(state.context, compacted);
  } else {
    requireContext(frame.level !== 1, '根层不能被释放。', 'invalid_state');
    const parent = frame.level === 2 ? state.context.level1 : state.context.level2;
    requireContext(parent && parent.id === frame.currentTask.frameId &&
      parent.taskChain.revision === frame.currentTask.planRevision, '父任务版本已变化。', 'stale_context');
    const tasks = parent.taskChain.tasks.map((task) => {
      if (task.id !== frame.currentTask.taskId) return task;
      requireContext(task.state === 'RUNNING', '父任务不再运行。', 'stale_context');
      return pending.purpose === 'complete'
        ? { ...task, state: 'COMPLETED' as const, result: summary }
        : { ...task, state: 'INTERRUPTED' as const, reason: pending.reason, partialResult: summary };
    });
    state.context = replaceFrame(state.context, setChain(parent, {
      ...parent.taskChain, tasks, phase: 'PLANNING', currentTaskId: null,
    }));
    state.context = frame.level === 2
      ? { ...state.context, level2: null, level3: null }
      : { ...state.context, level2: state.context.level2!, level3: null };
  }
  // 先验证父层容量，整个事务成功后才能释放子层和消费总结。
  assertBudgets(state.context);
  state.pendingSummary = null;
  state.runnable = pending.purpose !== 'idle' || state.inbox.length > 0;
}
