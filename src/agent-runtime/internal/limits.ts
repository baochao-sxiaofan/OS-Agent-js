import { ModelRequesterError, type ModelCompletion, type ModelCompletionRequest, type ModelRequester } from '../../model-requester/index.js';
import { AgentContextError, estimateContextTokens } from '../../agent-context/index.js';
import type { RuntimeAgent, RuntimeLimits } from '../api.js';
import type { RuntimeStore } from './store.js';
import { abortable } from './abortable.js';
import { defaultTokenSettings } from '../tokens.js';
import { consumeWorkRound, workBudget } from './work-budget.js';
import { migrateSavedCompletion } from './legacy-completion.js';

export const defaultLimits: RuntimeLimits = {
  maxConcurrentRequests: 4, requestsPerMinute: 30, tokensPerMinute: defaultTokenSettings.tokensPerMinute,
  maxRequestTokens: defaultTokenSettings.maxRequestTokens, maxOutputTokens: defaultTokenSettings.maxOutputTokens,
  maxRounds: 128, maxTotalTokens: defaultTokenSettings.maxTotalTokens,
  maxCostUsd: 5, inputUsdPerMillion: 0, outputUsdPerMillion: 0,
  maxRetries: 3, retryBaseMs: 1000, repeatedActionLimit: 8,
  maxAgents: 32, toolTimeoutMs: 120_000,
};

export class RuntimeFault extends Error {
  constructor(readonly kind: 'budget' | 'loop' | 'protocol' | 'tool' | 'permission',
    message: string, readonly retryable = false) {
    super(message);
  }
}

export class AdmissionWait extends Error {
  constructor(readonly resumeAt: number) { super('等待模型请求准入额度。'); }
}

/** 请求前预留 Token，使用实际用量更新 Agent；未返回用量时保留估算值。 */
export class RequestAdmission {
  #active = 0;
  constructor(public limits: RuntimeLimits, readonly store: RuntimeStore) {}

  acquire(tokens: number): () => void {
    const now = Date.now();
    const reservations = (this.store.metadata<{ at: number; tokens: number }[]>('admission') ?? [])
      .filter((item) => item.at > now - 60_000);
    if (tokens > this.limits.tokensPerMinute) throw new RuntimeFault('budget', '单次请求超过每分钟 Token 配额。');
    if (this.#active >= this.limits.maxConcurrentRequests) throw new AdmissionWait(now + 100);
    if (reservations.length >= this.limits.requestsPerMinute ||
        reservations.reduce((sum, item) => sum + item.tokens, 0) + tokens > this.limits.tokensPerMinute) {
      throw new AdmissionWait((reservations[0]?.at ?? now) + 60_001);
    }
    this.store.putMetadata('admission', [...reservations, { at: now, tokens }]);
    this.#active++;
    return () => { this.#active--; };
  }
}

export function trackedRequester(options: {
  requester: ModelRequester; admission: RequestAdmission; store: RuntimeStore; limits: () => RuntimeLimits;
  agent: () => RuntimeAgent; update: (agent: RuntimeAgent) => void; batch: () => string;
  workBatch?: () => string | undefined;
  prepare?: (input: ModelCompletionRequest) => ModelCompletionRequest;
}): ModelRequester & {
  dispatchRequest(input: ModelCompletionRequest, signal: AbortSignal | undefined,
    beforeSend: () => void): Promise<ModelCompletion>;
} {
  return {
    provider: options.requester.provider, model: options.requester.model,
    request(input: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
      return this.dispatchRequest(input, signal, () => {});
    },
    async dispatchRequest(input: ModelCompletionRequest, signal: AbortSignal | undefined,
      beforeSend: () => void): Promise<ModelCompletion> {
      const key = options.batch();
      const completed = options.store.completion(key);
      const version = options.store.metadata<number>(`protocol-version:${key}`) ?? 1;
      const native = version >= 2;
      if (completed) return native ? completed : migrateSavedCompletion(completed, options.store.request(key));
      // 已完成回复继续幂等恢复；未完成旧请求归档后按固定工具和增量布局重建。
      if (version < 4 && options.store.request(key)) options.store.repairRequest(key);
      const limits = options.limits();
      let saved = options.store.request(key);
      if (saved && (saved.maxOutputTokens === undefined || !requestFitsLimits(saved, limits))) {
        // 容量调整不覆盖原始请求；归档后用当前现场和限额重建。
        options.store.repairRequest(key);
        saved = undefined;
      }
      const selected = saved ?? options.prepare?.(input) ?? input;
      const request = { ...selected, maxOutputTokens: selected.maxOutputTokens ?? limits.maxOutputTokens };
      if (!requestFitsLimits(request, limits)) {
        throw new RuntimeFault('budget', '完整模型请求或输出预留超过当前宿主 Token 限制。');
      }
      const agent = options.agent();
      const budget = workBudget(options.store, agent.control.agentId, options.workBatch?.());
      const tokens = estimateContextTokens(request) + (request.maxOutputTokens ?? limits.maxOutputTokens);
      const estimatedCost = (estimateContextTokens(request) * limits.inputUsdPerMillion +
        (request.maxOutputTokens ?? limits.maxOutputTokens) * limits.outputUsdPerMillion) / 1_000_000;
      if (budget.used >= limits.maxRounds) throw new RuntimeFault('budget',
        `本次工作已用完 ${limits.maxRounds} 轮模型请求。现场已保存；点击“继续”可追加 ${limits.maxRounds} 轮，累计 Token 和费用上限仍有效。`);
      if (agent.totalTokens + tokens > limits.maxTotalTokens) throw new RuntimeFault('budget',
        `累计 Token 额度不足：已使用 ${agent.totalTokens}，本次需预留 ${tokens}，上限 ${limits.maxTotalTokens}。`);
      if (agent.costUsd + estimatedCost > limits.maxCostUsd) throw new RuntimeFault('budget',
        `累计费用额度不足：已使用 $${agent.costUsd.toFixed(4)}，上限 $${limits.maxCostUsd}。`);
      const release = options.admission.acquire(tokens);
      try {
        options.store.putRequest(key, request);
        options.store.putMetadata(`protocol-version:${key}`, 4);
        const result = await abortable(() => {
          // 准入和取消检查通过后通知轮次计数；缓存重放与未发送请求不消耗总结尝试。
          beforeSend();
          consumeWorkRound(options.store, agent.control.agentId, budget);
          // 尝试次数与最坏用量先落盘，进程中断也不会绕过资源上限。
          options.update({ ...agent, rounds: agent.rounds + 1, totalTokens: agent.totalTokens + tokens,
            costUsd: agent.costUsd + estimatedCost });
          return options.requester.request(request, signal);
        }, signal);
        options.store.putCompletion(key, result);
        const current = options.agent();
        const actualTokens = result.usage.totalTokens || tokens;
        const actualCost = result.usage.totalTokens > 0
          ? (result.usage.inputTokens * limits.inputUsdPerMillion +
            result.usage.outputTokens * limits.outputUsdPerMillion) / 1_000_000 : estimatedCost;
        options.update({ ...current, totalTokens: current.totalTokens - tokens + actualTokens,
          costUsd: current.costUsd - estimatedCost + actualCost });
        options.store.event(agent.control.agentId, 'model_completed', {
          roundKey: key, provider: result.provider, model: result.model,
          inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
          ...(result.usage.cacheHitTokens === undefined ? {} : { cacheHitTokens: result.usage.cacheHitTokens }),
          ...(result.usage.cacheMissTokens === undefined ? {} : { cacheMissTokens: result.usage.cacheMissTokens }),
        });
        return result;
      } finally { release(); }
    },
  };
}

function requestFitsLimits(request: ModelCompletionRequest, limits: RuntimeLimits): boolean {
  const output = request.maxOutputTokens ?? limits.maxOutputTokens;
  return Number.isSafeInteger(output) && output > 0 && output <= limits.maxOutputTokens &&
    estimateContextTokens(request) + output <= limits.maxRequestTokens;
}

export function classifyFault(error: unknown) {
  if (error instanceof AdmissionWait) return { kind: 'network' as const, retry: true, delayUntil: error.resumeAt, message: error.message };
  if (error instanceof ModelRequesterError) return { kind: error.code === 'invalid_response' ? 'protocol' as const : 'network' as const,
    retry: error.code === 'invalid_response' || error.retryable,
    delayUntil: error.retryAfterMs === undefined ? undefined : Date.now() + error.retryAfterMs,
    message: modelFaultMessage(error) };
  if (error instanceof RuntimeFault) return { kind: error.kind, retry: error.retryable,
    delayUntil: undefined, message: error.message };
  if (error instanceof AgentContextError) return {
    kind: error.code === 'budget_exceeded' ? 'budget' as const : 'protocol' as const,
    retry: error.code === 'invalid_input' || error.code === 'invalid_state' || error.code === 'summary_too_large',
    delayUntil: undefined, message: `上下文协议错误：${error.code} ${error.message}`,
  };
  return { kind: 'internal' as const, retry: false, delayUntil: undefined,
    message: '运行时内部故障，保留现场等待宿主检查。' };
}

/** 使用结构化错误生成可操作提示，不把供应商原始响应或凭据写入持久记录。 */
function modelFaultMessage(error: ModelRequesterError): string {
  const code = `${error.provider}:${error.code}${error.status ? ` HTTP ${error.status}` : ''}${
    error.apiCode === undefined ? '' : ` API ${error.apiCode}`}`;
  let hint: string;
  if (error.provider === 'minimax' && error.apiCode === 2056) {
    hint = 'MiniMax Token Plan 或账户额度已用尽，请补充额度后点击“继续”；当前任务现场已保留。';
  } else if (error.status === 529) hint = '模型服务暂时繁忙。若自动重试后仍暂停，请稍后点击“继续”，无需重发消息。';
  else if (error.status === 401) hint = '模型鉴权失败，请检查 API Key 是否正确或已失效。';
  else if (error.status === 402) hint = '模型服务报告账户余额或可用额度不足，请充值或检查账户额度后点击“继续”；当前任务现场已保留。';
  else if (error.status === 403) hint = '当前凭据没有访问该模型的权限，请检查账号和模型配置。';
  else if (error.status === 429) hint = '模型请求受限，请等待限流窗口恢复并检查账号额度。';
  else if (error.code === 'timeout') hint = '模型请求超时，请检查连接或稍后继续。';
  else if (error.code === 'network_error') hint = '无法连接模型服务，请检查网络后继续。';
  else if (error.requestReason === 'invalid_tool_schema') hint = '工具定义的 JSON Schema 无效，请更新或修复工具结构后继续；重复发送相同请求不会恢复。';
  else if (error.requestReason === 'invalid_tool_history') hint = '工具调用历史不符合模型接口要求，请检查调用与回执配对以及思考续接字段。';
  else if (error.requestReason === 'context_length_exceeded') hint = '实际请求超过模型上下文容量，请降低请求容量或压缩上下文后继续。';
  else if (error.code === 'invalid_request') hint = '模型请求配置无效，请检查模型名称和本次会话的 API Key。';
  else if (error.code === 'invalid_response') {
    const reasons = {
      missing_tool_calls: '缺少原生 tool_calls；请调用本轮声明的函数，正文 JSON 不会被执行。',
      unexpected_tool: '返回了本轮未允许的函数；必须逐字使用当前 tools 声明的函数名。message_send 不带任何后缀；不能把业务工具的哈希后缀拼到其他函数名上。',
      duplicate_call_id: '工具调用 ID 重复；请为每个调用提供唯一 ID。',
      invalid_arguments: '工具参数不完整或不是 JSON 对象；请按函数 schema 重新提交完整参数。',
      invalid_envelope: '模型响应结构无效；请正常结束并提交原生工具调用。',
    };
    hint = error.protocolReason ? reasons[error.protocolReason] : '模型响应不符合协议，请按本轮 tools 提交原生工具调用。';
  }
  else hint = '模型服务拒绝或未完成请求，请根据错误码检查配置并稍后继续。';
  return `${code}：${hint}`;
}
