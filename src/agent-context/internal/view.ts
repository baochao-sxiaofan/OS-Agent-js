import type { AgentContext } from '../api.js';
import { frames, objective } from './frames.js';
import { sourceRefs } from './summaries.js';

/** 只输出语义数据；内部帧、任务和计划版本身份不进入模型消息。 */
export function createContextView(context: AgentContext) {
  return {
    instructions: [...context.level1.instructions],
    frames: frames(context).map((frame) => ({
      level: frame.level,
      objective: objective(context, frame),
      phase: frame.taskChain.phase,
      allowedSourceRefs: sourceRefs(frame),
      tasks: frame.taskChain.tasks.map((task) => ({
        objective: task.objective, state: task.state,
        ...(task.state === 'COMPLETED' ? { result: task.result } : {}),
        ...(task.state === 'INTERRUPTED' ? { reason: task.reason, partialResult: task.partialResult } : {}),
      })),
      memory: structuredClone(frame.memory),
    })),
  };
}

export type ContextView = ReturnType<typeof createContextView>;
