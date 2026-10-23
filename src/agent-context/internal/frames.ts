import type {
  AgentContext, ContextFrame, ContextLevel, ContextMemory, ContextTaskChain,
} from '../api.js';
import type { ContextCheckpoint, ContextCursor, ContextStoreWrite } from '../management.js';
import { estimateContextTokens, requireContext } from './validation.js';

export type Draft = {
  -readonly [Key in keyof ContextCheckpoint]: ContextCheckpoint[Key];
};

export type Mutation = {
  state: Draft;
  writes: ContextStoreWrite[];
  id: () => string;
};

export function active(context: AgentContext): ContextFrame {
  return context.level3 ?? context.level2 ?? context.level1;
}

export function frames(context: AgentContext): ContextFrame[] {
  return [context.level1, ...(context.level2 ? [context.level2] : []),
    ...(context.level3 ? [context.level3] : [])];
}

export function replaceFrame(context: AgentContext, frame: ContextFrame): AgentContext {
  switch (frame.level) {
    case 1: return { ...context, level1: frame };
    case 2: return { ...context, level2: frame };
    case 3:
      requireContext(context.level2, '第三层不能脱离第二层。', 'invalid_state');
      return { ...context, level2: context.level2, level3: frame };
  }
}

export function setChain(frame: ContextFrame, chain: ContextTaskChain): ContextFrame {
  requireContext(chain.target === frame.taskChain.target, '任务链派发层级不匹配。', 'invalid_state');
  // 已在运行时验证联合类型之间的对应关系。
  return { ...frame, taskChain: chain } as ContextFrame;
}

export function emptyChain(level: ContextLevel, revision = 0): ContextTaskChain {
  return { target: level === 1 ? 2 : level === 2 ? 3 : 'local',
    revision, phase: 'PLANNING', currentTaskId: null, tasks: [] };
}

export function emptyMemory(): ContextMemory {
  return { summary: null, lessons: [], recentEntries: [], historyRef: null };
}

export function assertCursor(frame: ContextFrame, cursor: ContextCursor): void {
  requireContext(frame.id === cursor.frameId && frame.taskChain.revision === cursor.planRevision,
    '上下文或计划版本已变化。', 'stale_context');
}

export function assertBudgets(context: AgentContext): void {
  for (const frame of frames(context)) {
    requireContext(estimateContextTokens(frame) <= frame.budget.maxTokens,
      `第 ${frame.level} 层超过硬容量上限；请缩短内容或使用存储引用。`, 'budget_exceeded');
    requireContext(frame.taskChain.tasks.length <= frame.budget.maxTasks, '任务数量超过层级上限。', 'budget_exceeded');
  }
}

export function archive(mutation: Mutation): string {
  const ref = `context-history://${mutation.id()}`;
  mutation.writes.push({ ref, record: { kind: 'frame', context: structuredClone(mutation.state.context) } });
  return ref;
}

export function objective(context: AgentContext, frame: ContextFrame): string {
  if (frame.level === 1) return frame.currentTask.objective;
  const parent = frame.level === 2 ? context.level1 : context.level2;
  requireContext(parent && parent.id === frame.currentTask.frameId &&
    parent.taskChain.revision === frame.currentTask.planRevision, '父任务引用已失效。', 'stale_context');
  const task = parent.taskChain.tasks.find((task) => task.id === frame.currentTask.taskId);
  requireContext(task?.state === 'RUNNING' && parent.taskChain.currentTaskId === task.id,
    '子层必须指向父层当前运行的任务。', 'stale_context');
  return task.objective;
}
