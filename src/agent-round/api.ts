import type {
  AgentContextManager, ContextCursor, ContextDecision, ContextEntry, ContextView,
} from '../agent-context/index.js';
import type {
  AgentRun, AgentScheduler, AgentWakeEvent, AsyncOperationResult,
} from '../agent-scheduler/index.js';
import type { ModelCompletion, ModelCompletionRequest, ModelRequester } from '../model-requester/index.js';

export type ResolvedContextInput = {
  readonly entries: readonly ContextEntry[];
  /** 操作发起时保存的目标引用，不能在结果到达时改成当前计划。 */
  readonly target?: ContextCursor;
};

export type AgentWorkRound = {
  readonly view: ContextView;
  /** 宿主业务副作用必须用此稳定键派生幂等键，不能使用 runId。 */
  readonly idempotencyKey: string;
  readonly run: AgentRun;
  readonly signal: AbortSignal | undefined;
  /** 每轮最多请求一次；统一检查完整输入、工具和输出预算。 */
  request(request: ModelCompletionRequest): Promise<ModelCompletion>;
};

export type AgentRoundOptions = {
  readonly agentId: number;
  readonly context: AgentContextManager;
  readonly scheduler: AgentScheduler;
  readonly requester: ModelRequester;
  /**
   * 宿主若在请求器内部准入，必须使用此端口：取得准入后、网络发送前同步调用 beforeSend。
   * 准入拒绝或缓存重放不得调用；未注入时默认 requester 已在外部取得准入。
   */
  readonly dispatchRequest?: (input: ModelCompletionRequest, signal: AbortSignal | undefined,
    beforeSend: () => void) => Promise<ModelCompletion>;
  readonly maxRequestTokens: number;
  readonly maxOutputTokens: number;
  /** 宿主按结构化代码生成持久错误，避免供应商原始响应进入语义上下文。 */
  readonly formatError?: (error: unknown) => string;
  readonly resolveEvent: (event: AgentWakeEvent) => Promise<ResolvedContextInput>;
  readonly resolveResult: (result: AsyncOperationResult) => Promise<ResolvedContextInput>;
  /** 普通业务协议由宿主适配；返回值通过 Context Manager 校验。 */
  readonly work: (round: AgentWorkRound) => Promise<{
    decision: ContextDecision;
    entries?: readonly ContextEntry[];
  }>;
  /** 输入已持久进入 Context 后确认来源收件箱，重启时仍可幂等重投。 */
  readonly inputsReceived?: (run: AgentRun) => void;
  /** 异步操作可能在本轮立即完成；结果仍由下一批交付。 */
  readonly waitSatisfied?: (run: AgentRun) => boolean;
  /** 归还失败批次后同步安装暂停条件，必须先于宿主再次领取。 */
  readonly failureReturned?: (run: AgentRun, error: unknown) => void;
};

export interface AgentRoundRunner {
  /**
   * 只处理调用方已从 scheduler 领取的一轮，不自行领取或循环。
   * 失败归还原批次并抛错；宿主决定退避或停止，不能无限吞错重试。
   */
  execute(run: AgentRun, signal?: AbortSignal): Promise<'work' | 'summary' | 'replayed'>;
}
