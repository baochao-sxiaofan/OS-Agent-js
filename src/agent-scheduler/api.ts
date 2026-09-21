import type { AgentId, AgentSchedulingHandle, AgentState } from '../agent-control-block/index.js';

/** 已实际发起的外部操作；与 agent-context 中的工作目标无关。 */
export type AsyncOperation = {
  readonly agentId: AgentId;
  readonly operationId: string;
  readonly originRunId: string;
  readonly startedAt: number;
  readonly deadline: number;
  readonly state: 'RUNNING';
};

/** 超时只结束本地等待，不保证远端副作用已经撤销。 */
export type AsyncOperationOutcome =
  | { readonly type: 'succeeded'; readonly resultRef: string }
  | { readonly type: 'failed'; readonly error: string; readonly resultRef?: string }
  | { readonly type: 'cancelled'; readonly reason: string }
  | { readonly type: 'timed_out' };

/** 结果正文保存在执行模块中；调度器只收集引用和终态信息。 */
export type AsyncOperationResult = {
  readonly operation: AsyncOperation;
  readonly completedAt: number;
  readonly outcome: AsyncOperationOutcome;
};

export type AsyncOperationOptions = {
  /** 等待期限由执行模块提供；省略时使用调度器默认值。 */
  readonly timeoutMs?: number;
};

/** 先登记整组操作，再发起副作用；超时信号交给执行模块尝试取消。 */
export type AsyncOperationHandle = {
  readonly operation: AsyncOperation;
  readonly signal: AbortSignal;
};

/** 消息应先持久登记，再按事件 ID 唤醒；调度器不解析消息正文。 */
export type AgentWakeEvent = {
  readonly eventId: string;
  readonly eventRef: string;
};

/** 入队时固定结果与事件集合，之后收到的回调只能进入下一批。 */
export type AgentDispatchBatch = {
  readonly agentId: AgentId;
  readonly batchId: string;
  readonly sealedAt: number;
  readonly results: readonly AsyncOperationResult[];
  readonly events: readonly AgentWakeEvent[];
  /** 封存时仍在途的操作快照；输入构造方无需读取实时 Map1。 */
  readonly pendingOperations: readonly AsyncOperation[];
  /** Context 请求继续推进；即使没有异步结果也可以运行。 */
  readonly continuation: boolean;
};

/** 同一 Agent 最多有一张有效运行凭据；旧凭据不能结束新一轮。 */
export type AgentRun = {
  readonly agentId: AgentId;
  readonly runId: string;
  readonly batch: AgentDispatchBatch;
};

export type AgentRunIntent = 'continue' | 'idle';

/** 只读观测快照，不暴露 Map、Promise、模型配置或 Context。 */
export type AgentScheduleSnapshot = {
  readonly agentId: AgentId;
  readonly state: AgentState;
  readonly pendingOperations: readonly AsyncOperation[];
  readonly completedResults: readonly AsyncOperationResult[];
  readonly pendingEvents: readonly AgentWakeEvent[];
  readonly queuedBatch: AgentDispatchBatch | null;
  readonly running: AgentRun | null;
  readonly batchDueAt: number | null;
};

export type AgentSchedulerOptions = {
  /** 从首个未交付结果到达起计算，默认 30 秒；后续结果不重置计时。 */
  readonly batchWindowMs?: number;
  /** 操作默认截止时间，默认 120 秒。 */
  readonly operationTimeoutMs?: number;
  /** 仅限制领取中的运行数，不选择模型或处理请求级重试，默认 4。 */
  readonly maxConcurrentRuns?: number;
  /** 包括在途、待交付及已封存结果，默认每个 Agent 256 项。 */
  readonly maxBufferedOperations?: number;
  /** 待处理与已封存外部事件的总上限，默认每个 Agent 256 项。 */
  readonly maxBufferedEvents?: number;
  /** 已消费唤醒事件的去重缓存上限，默认每个 Agent 1024 项。 */
  readonly recentEventLimit?: number;
};

export interface AgentScheduler {
  /** 只接收 READY 或 SLEEPING 的新实例；不隐式恢复丢失的运行记录。 */
  register(agent: AgentSchedulingHandle): void;
  /** 仅当已经休眠且没有任何待交付工作时才能移除。 */
  unregister(agentId: AgentId): void;
  /** 返回是否接收了新事件；重复事件不会追加到已经封存的批次。 */
  notify(agentId: AgentId, event: AgentWakeEvent): boolean;
  /** 公平地领取下一批；由发送方在获得模型准入后调用，满额时返回 null。 */
  takeNextRun(): AgentRun | null;
  /** 等到有批次且有运行额度，不主动发模型请求；支持调用方取消等待。 */
  waitForReady(signal?: AbortSignal): Promise<void>;
  /** 必须持有有效运行凭据；登记操作后，调用方才能真正启动它们。 */
  registerOperations(run: AgentRun, operations: readonly AsyncOperationOptions[]): readonly AsyncOperationHandle[];
  /** 重复、迟到或不存在的操作返回 false，不能覆盖已经封存的结果。 */
  completeOperation(operation: AsyncOperation, outcome: AsyncOperationOutcome): boolean;
  /** 调用方先吸收批次结果并更新 Context，再确认运行结束。 */
  finishRun(run: AgentRun, intent: AgentRunIntent): void;
  /**
   * 由发送方显式归还未处理成功的批次，保留原始输入并释放运行额度。
   * 不自动调用模型、不决定是否重试；再次领取会获得新的 runId。
   */
  returnRun(run: AgentRun): void;
  inspect(agentId: AgentId): AgentScheduleSnapshot;
}

export type AgentSchedulerErrorCode =
  | 'invalid_input'
  | 'duplicate_agent'
  | 'unknown_agent'
  | 'invalid_state'
  | 'stale_run'
  | 'capacity_exceeded';

export class AgentSchedulerError extends Error {
  constructor(readonly code: AgentSchedulerErrorCode, message: string) {
    super(message);
    this.name = 'AgentSchedulerError';
  }
}
