import type {
  AgentContext, ContextBudget, ContextEntry, ContextFrameId, ContextLevel,
  ContextReference, ContextSummary,
} from './api.js';

/** 仅供宿主保存和回传，不能放入模型提示词。 */
export type ContextCursor = {
  readonly frameId: ContextFrameId;
  readonly planRevision: number;
};

export type ContextSummaryPurpose = 'complete' | 'interrupt' | 'compact' | 'idle';

export type PendingContextSummary = ContextCursor & {
  readonly id: string;
  readonly purpose: ContextSummaryPurpose;
  readonly reason: string;
  readonly sourceRef: ContextReference;
  readonly allowedRefs: readonly ContextReference[];
  readonly attempts: number;
  readonly lastError: string | null;
};

/** 来源系统提供稳定的投递键；未指定目标的消息属于根层。 */
export type ContextDelivery = {
  readonly key: string;
  readonly entries: readonly ContextEntry[];
  readonly target?: ContextCursor;
};

export type ContextPolicy = {
  readonly budgets: Readonly<Record<ContextLevel, ContextBudget>>;
  readonly maxSummaryAttempts: number;
  readonly maxInbox: number;
  readonly maxDeliveryBytes: number;
};

/** 调度状态不在此处保存；恢复后由宿主重新登记 READY 的 Agent。 */
export type ContextCheckpoint = {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly context: AgentContext;
  readonly policy: ContextPolicy;
  readonly runnable: boolean;
  readonly pendingSummary: PendingContextSummary | null;
  readonly inbox: readonly ContextDelivery[];
};

/** 模型只能提议动作，不能指定内部身份、权限、预算或根层指令。 */
export type ContextDecision =
  | { readonly type: 'plan'; readonly objectives: readonly string[] }
  | { readonly type: 'replan'; readonly objectives: readonly string[]; readonly reason: string }
  | { readonly type: 'advance' }
  | { readonly type: 'step_completed'; readonly result: ContextSummary }
  | { readonly type: 'complete' }
  | { readonly type: 'interrupt'; readonly reason: string }
  | { readonly type: 'compact' }
  | { readonly type: 'idle' }
  | { readonly type: 'finish_turn' }
  | { readonly type: 'continue' }
  | { readonly type: 'wait' };

/** 所有写入与检查点在同一事务中提交；引用一旦发布不可覆盖。 */
export type ContextRecord =
  | { readonly kind: 'history'; readonly delivery: ContextDelivery }
  | { readonly kind: 'frame'; readonly context: AgentContext }
  | { readonly kind: 'summary'; readonly sourceRef: string; readonly summary: ContextSummary };

export type ContextStoreWrite = {
  readonly ref: string;
  readonly record: ContextRecord;
};

export type ContextReceipt = {
  readonly key: string;
  readonly intent: 'continue' | 'idle';
};

/**
 * 存储按单个 Agent 命名空间隔离。commit 必须同步原子完成或抛错，
 * 比较 revision 后同时写入快照、追加记录和幂等回执。
 */
export interface ContextStore {
  load(key: string): ContextCheckpoint | undefined;
  read(key: string, ref: string): ContextRecord | undefined;
  receipt(key: string, id: string): ContextReceipt | undefined;
  commit(key: string, expectedRevision: number | null, checkpoint: ContextCheckpoint,
    writes: readonly ContextStoreWrite[], receipts: readonly ContextReceipt[]): void;
}

export type ContextManagerOptions = {
  readonly key: string;
  readonly store: ContextStore;
  readonly instructions: readonly string[];
  readonly objective: string;
  readonly policy: ContextPolicy;
  /** 长期联系人创建时可先休眠，等第一条消息再运行。 */
  readonly initiallyIdle?: boolean;
  /** 只供内核和确定性测试注入，不接受模型传入。 */
  readonly createId?: () => string;
};

export interface AgentContextManager {
  snapshot(): AgentContext;
  checkpoint(): ContextCheckpoint;
  cursor(): ContextCursor;
  needsRun(): boolean;
  receive(deliveries: readonly ContextDelivery[]): void;
  /** 持久接收容量内的输入；返回 false 时未接收部分仍归来源系统保管。 */
  receiveAvailable(deliveries: readonly ContextDelivery[]): boolean;
  /** 吸收收件箱并按容量决定普通轮或总结轮；总结源封存后不可改变。 */
  prepare(): ContextCheckpoint;
  apply(roundKey: string, cursor: ContextCursor, decision: ContextDecision,
    entries?: readonly ContextEntry[]): void;
  /** 取得准入后、发出请求前持久化次数，崩溃后也不会无限重试。 */
  beginSummaryAttempt(): PendingContextSummary;
  /** 仅可信宿主调整所有层的容量；保留任务、原文与版本，待总结来源另行封存。 */
  configureBudget(budget: ContextBudget): void;
  /** 宿主显式恢复时重开有限总结尝试，自动重试不得调用。 */
  retrySummary(): void;
  failSummary(id: string, message: string): void;
  /** 仅提交总结阶段，不代表该调度批次的输入已全部接收。 */
  commitSummaryPhase(roundKey: string, id: string, summary: ContextSummary): void;
  summaryReceipt(roundKey: string): ContextReceipt | undefined;
  /** 编排层确认全部输入已持久接收后，单独确认已完成总结的批次。 */
  acknowledgeRound(roundKey: string): void;
  /** 兼容直接调用方：原子提交总结并确认已接收的批次。 */
  commitSummary(roundKey: string, id: string, summary: ContextSummary): void;
  roundReceipt(roundKey: string): ContextReceipt | undefined;
  read(ref: string): ContextRecord | undefined;
}

export class AgentContextError extends Error {
  constructor(readonly code: 'invalid_input' | 'invalid_state' | 'stale_context' |
    'budget_exceeded' | 'summary_too_large' | 'retry_exhausted' | 'storage_conflict', message: string) {
    super(message);
    this.name = 'AgentContextError';
  }
}
