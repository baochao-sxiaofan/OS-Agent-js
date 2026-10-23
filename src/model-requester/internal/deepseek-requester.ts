import { Buffer } from 'node:buffer';
import { ModelRequesterError, type ModelRequester, type ModelRequesterOptions,
  type ModelCompletionRequest, type ModelCompletion } from '../api.js';
import { encodeDeepSeek, decodeDeepSeek } from './deepseek-codec.js';
import { DeepSeekTransport } from './deepseek-transport.js';

export class DeepSeekRequester implements ModelRequester {
  readonly provider = 'deepseek';
  readonly model: string;
  readonly #transport: DeepSeekTransport;
  readonly #thinking: 'enabled' | 'disabled';
  readonly #effort: 'high' | 'max';
  constructor(options: Extract<ModelRequesterOptions, { provider: 'deepseek' }>) {
    this.model = options.model.trim();
    this.#thinking = options.thinking ?? 'enabled';
    this.#effort = options.reasoningEffort ?? 'high';
    if (!this.model || !['enabled', 'disabled'].includes(this.#thinking) || !['high', 'max'].includes(this.#effort)) {
      throw new ModelRequesterError('DeepSeek 型号或思考配置无效。', { provider: 'deepseek', code: 'invalid_request' });
    }
    this.#transport = new DeepSeekTransport(options);
  }
  async request(request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    if (signal?.aborted) throw new ModelRequesterError('DeepSeek 请求已取消。', {
      provider: 'deepseek', code: 'cancelled',
    });
    let encoded: ReturnType<typeof encodeDeepSeek>;
    let body: string;
    try {
      // 固定提交步骤要求原生强制工具；普通工作保留思考并由返回校验守住 required。
      const thinking = typeof request.toolChoice === 'object' ? 'disabled' : this.#thinking;
      encoded = encodeDeepSeek(request, this.model, thinking === 'enabled');
      body = JSON.stringify({ ...encoded.body, thinking: { type: thinking },
        ...(thinking === 'enabled' ? { reasoning_effort: this.#effort } : {}) });
      if (Buffer.byteLength(body) > 50 * 1024 * 1024) throw new Error('请求过大');
    } catch (error) {
      if (error instanceof ModelRequesterError) throw error;
      throw new ModelRequesterError('DeepSeek 请求必须可序列化为 JSON，且不超过 50 MB。', {
        provider: 'deepseek', code: 'invalid_request',
      });
    }
    const completion = decodeDeepSeek(await this.#transport.json('/chat/completions', body, signal), this.model, encoded.originals);
    const choice = request.toolChoice;
    const calls = completion.message.toolCalls;
    if ((choice === 'required' || typeof choice === 'object') && (calls.length === 0 ||
        calls.some((call) => typeof choice === 'object' ? call.name !== choice.name
          : !request.tools?.some((tool) => tool.name === call.name)))) {
      throw new ModelRequesterError('DeepSeek 未返回请求要求的工具调用，响应未被执行。', {
        provider: 'deepseek', code: 'invalid_response', retryable: true,
        protocolReason: calls.length ? 'unexpected_tool' : 'missing_tool_calls',
      });
    }
    return completion;
  }
}
