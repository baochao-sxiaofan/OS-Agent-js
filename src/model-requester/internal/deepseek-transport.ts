import { ModelRequesterError, type ModelRequestReason } from '../api.js';

type Connection = {
  apiKey: string; baseUrl?: string; timeoutMs?: number; fetchImplementation?: typeof fetch;
};

/** 列出型号与推理共用传输边界，不把供应商原始错误或凭据带到日志和界面。 */
export class DeepSeekTransport {
  readonly #key: string;
  readonly #base: string;
  readonly #timeout: number;
  readonly #fetch: typeof fetch;
  constructor(options: Connection) {
    this.#key = options.apiKey.trim();
    this.#base = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/u, '');
    this.#timeout = options.timeoutMs ?? 180_000;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
    if (!this.#key || !Number.isSafeInteger(this.#timeout) || this.#timeout <= 0) {
      throw new ModelRequesterError('请填写 DeepSeek API Key，并使用有效的超时时间。', {
        provider: 'deepseek', code: 'invalid_request',
      });
    }
  }
  async json(path: '/models' | '/chat/completions', body?: string, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw aborted('cancelled');
    const timeout = AbortSignal.timeout(this.#timeout);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.#fetch(`${this.#base}${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: combined,
        headers: { authorization: `Bearer ${this.#key}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body }),
      });
      if (!response.ok) {
        const status = response.status;
        const requestReason = status === 400 || status === 422 ? await rejectedRequestReason(response) : undefined;
        if (status !== 400 && status !== 422) await response.body?.cancel();
        const hint = status === 401 ? 'API Key 无效，请检查凭据。'
          : status === 402 ? '账户余额不足，请在 DeepSeek 平台充值。'
            : status === 403 ? '当前账户没有访问权限。'
              : status === 429 ? '请求过于频繁，请稍后重试。'
                : status >= 500 ? '服务暂时不可用，请稍后重试。' : '请检查所选模型及请求配置。';
        const retry = response.headers.get('retry-after');
        const delay = retry?.trim() ? (Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : NaN;
        throw new ModelRequesterError(`DeepSeek 请求失败（HTTP ${status}）：${hint}`, {
          provider: 'deepseek', code: 'http_error', status,
          retryable: [408, 409, 425, 429].includes(status) || status >= 500,
          ...(requestReason ? { requestReason } : {}),
          ...(Number.isFinite(delay) ? { retryAfterMs: Math.max(0, delay) } : status === 429 ? { retryAfterMs: 30_000 } : {}),
        });
      }
      let value: unknown;
      try { value = await response.json(); }
      catch { throw new ModelRequesterError('DeepSeek 返回的内容不是有效 JSON。', {
        provider: 'deepseek', code: 'invalid_response',
      }); }
      combined.throwIfAborted();
      if (value && typeof value === 'object' && 'error' in value && value.error != null) {
        throw new ModelRequesterError('DeepSeek 返回了接口错误，请检查账户和模型配置。', {
          provider: 'deepseek', code: 'provider_error',
        });
      }
      return value;
    } catch (error) {
      if (signal?.aborted) throw aborted('cancelled');
      if (timeout.aborted) throw aborted('timeout');
      if (error instanceof ModelRequesterError) throw error;
      throw new ModelRequesterError('无法连接 DeepSeek，请检查网络后重试。', {
        provider: 'deepseek', code: 'network_error', retryable: true,
      });
    }
  }
}

/** 只输出有限枚举；错误原文可能回显提示词或凭据，不能持久化或直接展示。 */
async function rejectedRequestReason(response: Response): Promise<ModelRequestReason | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= 16_384) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16_384) return undefined;
      chunks.push(chunk.value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || !('error' in data) || !data.error ||
        typeof data.error !== 'object' || !('message' in data.error) || typeof data.error.message !== 'string') return undefined;
    const message = data.error.message;
    if (/invalid schema for function|invalid (?:json )?schema/iu.test(message)) return 'invalid_tool_schema';
    if (/tool_call_id|tool calls? (?:must|should)|reasoning_content.*(?:missing|required)|missing.*reasoning_content/iu.test(message)) {
      return 'invalid_tool_history';
    }
    if (/context length|context_length_exceeded|maximum context/iu.test(message)) return 'context_length_exceeded';
    return undefined;
  } catch { return undefined; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function aborted(code: 'cancelled' | 'timeout'): ModelRequesterError {
  return new ModelRequesterError(code === 'cancelled' ? 'DeepSeek 请求已取消。' : 'DeepSeek 请求超时，请重试。', {
    provider: 'deepseek', code, retryable: code === 'timeout',
  });
}
