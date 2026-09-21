// 唯一公共入口，内部状态实现不作为独立路径导出。
export { AgentState, InvalidAgentTransitionError } from './api.js';
export { canAgentTransition, createAgentControlBlock } from './internal/control-block.js';
export type {
  AgentControlBlock,
  AgentFilePermission,
  AgentId,
  AgentSchedulingHandle,
  ManagedAgentControlBlock,
} from './api.js';
export type { AgentContext } from '../agent-context/index.js';
