import type { ContextEntry } from '../api.js';
import type { ContextDecision } from '../management.js';
import { active, archive, emptyMemory, replaceFrame, setChain, type Mutation } from './frames.js';
import { scheduleSummary, sourceRefs } from './summaries.js';
import { keys, requireContext, strings, text, validateEntry, validateSummary } from './validation.js';

export function applyDecision(mutation: Mutation, decision: ContextDecision, entries: readonly ContextEntry[]): void {
  const { state } = mutation;
  let frame = active(state.context);
  entries.forEach(validateEntry);
  frame = { ...frame, memory: { ...frame.memory, recentEntries: [...frame.memory.recentEntries, ...entries] } };
  state.context = replaceFrame(state.context, frame);
  // 新建子层也必须能看见分派任务所依赖的近期资料和来源。
  state.runnable = true;
  const chain = frame.taskChain;
  switch (decision.type) {
    case 'plan':
    case 'replan': {
      keys(decision, decision.type === 'plan' ? ['type', 'objectives'] : ['type', 'objectives', 'reason']);
      strings(decision.objectives);
      requireContext(decision.objectives.length > 0 && decision.objectives.length <= frame.budget.maxTasks,
        '任务链不能为空或超过任务数量上限。');
      if (decision.type === 'plan') {
        requireContext(chain.tasks.every((task) => task.state !== 'WAITING' && task.state !== 'RUNNING'),
          '替换未完成计划需要显式 replan。', 'invalid_state');
      } else {
        text(decision.reason);
        state.context = replaceFrame(state.context, setChain(frame, {
          target: chain.target, revision: chain.revision, phase: 'PLANNING', currentTaskId: null,
          tasks: chain.tasks.map((task) => task.state === 'RUNNING'
            ? { ...task, state: 'INTERRUPTED', reason: decision.reason }
            : task.state === 'WAITING' ? { ...task, state: 'SUPERSEDED' } : task),
        }));
      }
      const previousPlanRef = archive(mutation);
      frame = { ...frame, memory: { ...frame.memory, historyRef: previousPlanRef } };
      state.context = replaceFrame(state.context, setChain(frame, {
        target: chain.target, revision: chain.revision + 1, phase: 'PLANNING', currentTaskId: null,
        tasks: decision.objectives.map((objective) => ({ id: mutation.id(), objective, state: 'WAITING' })),
        ...(decision.type === 'replan' ? { replan: { reason: decision.reason, previousPlanRef } } : {}),
      }));
      return;
    }
    case 'advance': {
      keys(decision, ['type']);
      requireContext(chain.phase === 'PLANNING', '已经有运行中的任务。', 'invalid_state');
      const next = chain.tasks.find((task) => task.state === 'WAITING');
      requireContext(next, '没有待运行任务。', 'invalid_state');
      state.context = replaceFrame(state.context, setChain(frame, {
        target: chain.target, revision: chain.revision, phase: 'EXECUTING', currentTaskId: next.id,
        tasks: chain.tasks.map((task) => task === next ? { ...task, state: 'RUNNING' } : task),
      }));
      const child = {
        id: mutation.id(),
        currentTask: { frameId: frame.id, planRevision: chain.revision, taskId: next.id },
        memory: { ...emptyMemory(), summary: frame.memory.summary,
          recentEntries: frame.memory.recentEntries, historyRef: frame.memory.historyRef },
      };
      if (frame.level === 1) {
        state.context = { ...state.context, level2: { ...child, level: 2,
          budget: state.policy.budgets[2],
          taskChain: { target: 3, revision: 0, phase: 'PLANNING', currentTaskId: null, tasks: [] } },
        level3: null };
      } else if (frame.level === 2) {
        state.context = { ...state.context, level2: state.context.level2!,
          level3: { ...child, level: 3, budget: state.policy.budgets[3],
            taskChain: { target: 'local', revision: 0, phase: 'PLANNING', currentTaskId: null, tasks: [] } } };
      }
      return;
    }
    case 'step_completed': {
      keys(decision, ['type', 'result']);
      requireContext(frame.level === 3 && chain.phase === 'EXECUTING', '只能完成正在执行的第三层步骤。', 'invalid_state');
      validateSummary(decision.result, sourceRefs(frame));
      state.context = replaceFrame(state.context, setChain(frame, {
        target: chain.target, revision: chain.revision, phase: 'PLANNING', currentTaskId: null,
        tasks: chain.tasks.map((task) => task.id === chain.currentTaskId
          ? { ...task, state: 'COMPLETED', result: decision.result } : task),
      }));
      return;
    }
    case 'interrupt':
      keys(decision, ['type', 'reason']);
      text(decision.reason);
      scheduleSummary(mutation, 'interrupt', decision.reason);
      return;
    case 'complete':
    case 'compact':
    case 'idle':
      keys(decision, ['type']);
      scheduleSummary(mutation, decision.type);
      return;
    case 'finish_turn':
      keys(decision, ['type']);
      requireContext(frame.level === 1 && !state.context.level2 && !state.context.level3 &&
        chain.tasks.every((task) => task.state !== 'WAITING' && task.state !== 'RUNNING'),
      '静默结束只允许根层且无未完成任务。', 'invalid_state');
      state.runnable = false;
      return;
    case 'continue':
    case 'wait':
      keys(decision, ['type']);
      state.runnable = decision.type === 'continue';
      return;
    default:
      requireContext(false, '未知的上下文动作。');
  }
}
