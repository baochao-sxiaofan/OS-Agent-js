// 唯一公共入口；队列、Map 和定时器实现不对外导出。
export { createAgentScheduler } from './internal/scheduler.js';
export { AgentSchedulerError } from './api.js';
export type {
  AgentDispatchBatch,
  AgentRun,
  AgentRunIntent,
  AgentScheduleSnapshot,
  AgentScheduler,
  AgentSchedulerErrorCode,
  AgentSchedulerOptions,
  AgentWakeEvent,
  AsyncOperation,
  AsyncOperationHandle,
  AsyncOperationOptions,
  AsyncOperationOutcome,
  AsyncOperationResult,
} from './api.js';
