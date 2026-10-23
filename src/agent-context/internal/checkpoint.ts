import type { ContextCheckpoint, ContextDelivery, ContextPolicy } from '../management.js';
import { active, assertBudgets, assertCursor, frames, objective } from './frames.js';
import { integer, json, keys, object, requireContext, strings, text, validateBudget, validateEntry, validateSummary } from './validation.js';

export function validatePolicy(value: unknown): asserts value is ContextPolicy {
  object(value);
  keys(value, ['budgets', 'maxSummaryAttempts', 'maxInbox', 'maxDeliveryBytes']);
  object(value.budgets);
  keys(value.budgets, ['1', '2', '3']);
  for (const level of [1, 2, 3]) validateBudget(value.budgets[level]);
  integer(value.maxSummaryAttempts, 1);
  integer(value.maxInbox, 1);
  integer(value.maxDeliveryBytes, 1);
}

function validateCursor(value: unknown): void {
  object(value);
  keys(value, ['frameId', 'planRevision']);
  text(value.frameId);
  integer(value.planRevision);
}

export function validateDelivery(value: unknown): asserts value is ContextDelivery {
  object(value);
  keys(value, ['key', 'target', 'entries']);
  text(value.key);
  if (value.target !== undefined) validateCursor(value.target);
  requireContext(Array.isArray(value.entries) && value.entries.length > 0, '投递必须包含语义记录。');
  value.entries.forEach(validateEntry);
}

/** 恢复数据逐字段验证后才允许成为运行时权威状态。 */
export function validateCheckpoint(value: unknown): asserts value is ContextCheckpoint {
  json(value);
  object(value);
  keys(value, ['schemaVersion', 'revision', 'context', 'policy', 'runnable', 'pendingSummary', 'inbox']);
  requireContext(value.schemaVersion === 1, '不支持的检查点版本。');
  integer(value.revision);
  validatePolicy(value.policy);
  requireContext(typeof value.runnable === 'boolean', 'runnable 必须为布尔值。');
  requireContext(Array.isArray(value.inbox), 'inbox 必须为数组。');
  value.inbox.forEach(validateDelivery);
  requireContext(value.inbox.length <= value.policy.maxInbox, '收件箱超过上限。');
  for (const delivery of value.inbox) requireContext(
    Buffer.byteLength(JSON.stringify(delivery)) <= value.policy.maxDeliveryBytes, '恢复输入超过单次容量上限。');
  requireContext(new Set(value.inbox.map((item) => item.key)).size === value.inbox.length, '收件箱包含重复投递。');
  object(value.context);
  keys(value.context, ['schemaVersion', 'level1', 'level2', 'level3']);
  requireContext(value.context.schemaVersion === 1, '不支持的上下文版本。');
  const ids = new Set<string>();
  for (const level of [1, 2, 3] as const) {
    const frame = value.context[`level${level}`];
    if (level !== 1 && frame === null) continue;
    object(frame);
    keys(frame, ['id', 'level', 'currentTask', 'taskChain', 'memory', 'budget', ...(level === 1 ? ['instructions'] : [])]);
    text(frame.id);
    requireContext(!ids.has(frame.id), '内部身份发生冲突。');
    ids.add(frame.id);
    requireContext(frame.level === level, '层级不匹配。');
    validateBudget(frame.budget);
    requireContext(JSON.stringify(frame.budget) === JSON.stringify(value.policy.budgets[level]), '层级预算与宿主策略不一致。');
    object(frame.currentTask);
    if (level === 1) {
      keys(frame.currentTask, ['id', 'objective']);
      text(frame.currentTask.id);
      text(frame.currentTask.objective);
      requireContext(!ids.has(frame.currentTask.id), '根任务身份冲突。');
      ids.add(frame.currentTask.id);
      strings(frame.instructions);
    } else {
      keys(frame.currentTask, ['frameId', 'planRevision', 'taskId']);
      text(frame.currentTask.frameId);
      text(frame.currentTask.taskId);
      integer(frame.currentTask.planRevision, 1);
    }
    object(frame.memory);
    keys(frame.memory, ['summary', 'lessons', 'recentEntries', 'historyRef']);
    if (frame.memory.summary !== null) validateSummary(frame.memory.summary);
    requireContext(Array.isArray(frame.memory.lessons), '经验必须为数组。');
    validateSummary({ outcome: '经验校验', observations: [], decisions: [], artifactRefs: [],
      unresolved: [], nextResponsibilities: [], sourceRefs: [], lessonCandidates: frame.memory.lessons });
    requireContext(Array.isArray(frame.memory.recentEntries), '近期记录必须为数组。');
    frame.memory.recentEntries.forEach(validateEntry);
    if (frame.memory.historyRef !== null) text(frame.memory.historyRef);
    object(frame.taskChain);
    const chain = frame.taskChain;
    keys(chain, ['target', 'revision', 'tasks', 'phase', 'currentTaskId', 'replan']);
    requireContext(chain.target === (level === 1 ? 2 : level === 2 ? 3 : 'local'), '任务链目标错误。');
    integer(chain.revision);
    requireContext(Array.isArray(chain.tasks), '任务必须为数组。');
    const running: string[] = [];
    for (const task of chain.tasks) {
      object(task);
      text(task.id);
      requireContext(!ids.has(task.id), '任务身份发生冲突。');
      ids.add(task.id);
      text(task.objective);
      const base = ['id', 'objective', 'state'];
      switch (task.state) {
        case 'RUNNING': running.push(task.id); keys(task, base); break;
        case 'WAITING':
        case 'SUPERSEDED': keys(task, base); break;
        case 'COMPLETED': keys(task, [...base, 'result']); validateSummary(task.result); break;
        case 'INTERRUPTED':
          keys(task, [...base, 'reason', 'partialResult']);
          text(task.reason);
          if (task.partialResult !== undefined) validateSummary(task.partialResult);
          break;
        default: requireContext(false, '非法任务状态。');
      }
    }
    requireContext(chain.revision > 0 || chain.tasks.length === 0, '未安装计划不能带任务。');
    requireContext(chain.phase === 'PLANNING' || chain.phase === 'EXECUTING', '非法规划阶段。');
    requireContext(chain.phase === 'EXECUTING'
      ? running.length === 1 && chain.currentTaskId === running[0]
      : running.length === 0 && chain.currentTaskId === null, '任务选择与运行状态不一致。');
    if (chain.replan !== undefined) {
      requireContext(chain.phase === 'PLANNING', '执行阶段不能携带重规划请求。');
      object(chain.replan);
      keys(chain.replan, ['reason', 'previousPlanRef', 'partialResult']);
      text(chain.replan.reason);
      text(chain.replan.previousPlanRef);
      if (chain.replan.partialResult !== undefined) validateSummary(chain.replan.partialResult);
    }
  }
  // 字段形状验证完成后，再验证跨层引用和状态不变量。
  const context = value.context as ContextCheckpoint['context'];
  requireContext(context.level2 !== null || context.level3 === null, '第三层不能脱离第二层。');
  for (const frame of frames(context)) objective(context, frame);
  requireContext(context.level1.taskChain.phase !== 'EXECUTING' || context.level2, '运行任务缺少第二层。');
  requireContext(context.level2?.taskChain.phase !== 'EXECUTING' || context.level3, '运行任务缺少第三层。');
  assertBudgets(context);
  if (value.pendingSummary !== null) {
    object(value.pendingSummary);
    const pending = value.pendingSummary;
    keys(pending, ['id', 'frameId', 'planRevision', 'purpose', 'reason', 'sourceRef', 'allowedRefs', 'attempts', 'lastError']);
    text(pending.id);
    text(pending.frameId);
    integer(pending.planRevision);
    text(pending.sourceRef);
    strings(pending.allowedRefs);
    requireContext(pending.allowedRefs.includes(pending.sourceRef), '总结缺少封存引用。');
    integer(pending.attempts);
    requireContext(pending.attempts <= value.policy.maxSummaryAttempts, '总结尝试次数越界。');
    requireContext(typeof pending.reason === 'string', '总结原因必须是字符串。');
    if (pending.lastError !== null) text(pending.lastError);
    requireContext(['complete', 'interrupt', 'compact', 'idle'].includes(String(pending.purpose)), '非法总结目的。');
    assertCursor(active(context), { frameId: pending.frameId, planRevision: pending.planRevision });
    requireContext(value.runnable, '待总结状态必须仍可调度。');
    const frame = active(context);
    requireContext(pending.purpose !== 'idle' || frame.level === 1, '空闲总结只能位于根层。');
    requireContext(!['complete', 'interrupt'].includes(String(pending.purpose)) || frame.level !== 1,
      '根层职责不能完成或中断。');
    if (pending.purpose === 'complete' || pending.purpose === 'idle') {
      requireContext(frame.taskChain.tasks.every((task) => task.state !== 'RUNNING' && task.state !== 'WAITING'),
        '未完成任务不能处于结束总结阶段。');
    }
  }
}
