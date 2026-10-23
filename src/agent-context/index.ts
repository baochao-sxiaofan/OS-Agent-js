// 唯一公共入口；管理实现不依赖调度器、模型厂商或旧 TCB。
export { createAgentContextManager, restoreAgentContextManager } from './internal/manager.js';
export { createContextView, type ContextView } from './internal/view.js';
export { estimateContextTokens, validateSummary } from './internal/validation.js';
export { summaryCapacity } from './internal/summaries.js';
export { InMemoryContextStore } from './storage/memory.js';
export { SqliteContextStore } from './storage/sqlite.js';
export { AgentContextError } from './management.js';
export { contextSummarySchema, contextSummaryJsonSchema } from './summary-schema.js';
export type {
  AgentContextManager, ContextCheckpoint, ContextCursor, ContextDecision, ContextDelivery,
  ContextManagerOptions, ContextPolicy, ContextReceipt, ContextRecord, ContextStore,
  ContextStoreWrite, ContextSummaryPurpose, PendingContextSummary,
} from './management.js';
export type {
  AgentContext,
  ContextBudget,
  ContextEntry,
  ContextFrame,
  ContextFrameId,
  ContextLesson,
  ContextLevel,
  ContextMemory,
  ContextObservation,
  ContextPhase,
  ContextReference,
  ContextReplan,
  ContextSummary,
  ContextTask,
  ContextTaskChain,
  ContextTaskDefinition,
  ContextTaskId,
  ContextTaskRef,
  ContextTaskState,
  ContextValue,
  LevelOneContext,
  LevelThreeContext,
  LevelTwoContext,
} from './api.js';
