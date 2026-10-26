import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../types/json.js';
import { ModelRequesterError, type ModelCompletion, type ModelCompletionRequest, type ModelProtocolReason } from '../api.js';

const json: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(json), z.record(json),
]));
const object = z.record(json);
const nonempty = z.string().min(1).refine((value) => !!value.trim());
const call = z.object({ id: nonempty, name: nonempty, arguments: object });
const requestSchema = z.object({
  messages: z.array(z.discriminatedUnion('role', [
    z.object({ role: z.literal('system'), content: z.string() }),
    z.object({ role: z.literal('user'), content: z.union([
      z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1),
    ]) }),
    z.object({ role: z.literal('tool'), callId: nonempty, content: json }),
    z.object({ role: z.literal('assistant'), content: z.string(), toolCalls: z.array(call),
      continuation: z.object({ provider: z.string(), model: z.string(), data: object }).optional() }),
  ])).min(1),
  tools: z.array(z.object({ name: nonempty, description: z.string(), parameters: object })).default([]),
  toolChoice: z.union([z.enum(['auto', 'none', 'required']), z.object({ name: nonempty })]).optional(),
  parallelToolCalls: z.boolean().optional(),
  maxOutputTokens: z.number().int().positive().safe().optional(),
  temperature: z.number().min(0).max(2).optional(),
});
const responseSchema = z.object({
  id: z.string().optional(),
  choices: z.array(z.object({
    finish_reason: z.string().nullish(),
    message: z.object({
      role: z.literal('assistant').optional(), content: z.string().nullish(),
      reasoning_content: z.string().nullish(),
      tool_calls: z.array(z.object({
        id: nonempty, type: z.literal('function').optional(),
        function: z.object({ name: nonempty, arguments: nonempty }),
      })).nullish(),
    }),
  })).length(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().safe().optional(),
    completion_tokens: z.number().int().nonnegative().safe().optional(),
    total_tokens: z.number().int().nonnegative().safe().optional(),
    prompt_cache_hit_tokens: z.number().int().nonnegative().safe().optional(),
    prompt_cache_miss_tokens: z.number().int().nonnegative().safe().optional(),
  }).nullish(),
});

/** 工具名称的协议限制留在边界内，运行时始终使用原始名称。 */
export function encodeDeepSeek(request: ModelCompletionRequest, model: string, thinking: boolean): {
  body: JsonObject; originals: ReadonlyMap<string, string>;
} {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) throw invalid('invalid_request', 'DeepSeek 请求格式无效；当前接入仅支持文本输入。');
  const input = parsed.data;
  const aliases = new Map<string, string>();
  const originals = new Map<string, string>();
  function alias(name: string): string {
    const previous = aliases.get(name);
    if (previous) return previous;
    const encoded = /^[a-zA-Z0-9_-]{1,64}$/u.test(name) ? name
      : `${name.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 40)}__${createHash('sha256').update(name).digest('hex').slice(0, 20)}`;
    if (originals.has(encoded) && originals.get(encoded) !== name) {
      throw invalid('invalid_request', '工具名称映射冲突。');
    }
    aliases.set(name, encoded); originals.set(encoded, name);
    return encoded;
  }
  const names = new Set(input.tools.map((tool) => tool.name));
  if (names.size !== input.tools.length) throw invalid('invalid_request', '工具名称不能重复。');
  input.tools.forEach((tool) => alias(tool.name));
  const choice = input.toolChoice;
  if ((choice === 'required' || typeof choice === 'object') && !names.size ||
      typeof choice === 'object' && !names.has(choice.name)) {
    throw invalid('invalid_request', 'toolChoice 必须引用已声明的工具。');
  }
  const messages: JsonObject[] = input.messages.map((message) => {
    if (message.role === 'system') return { role: 'system', content: message.content };
    if (message.role === 'user') return { role: 'user', content: typeof message.content === 'string'
      ? message.content : message.content.map((part) => part.text).join('\n') };
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.callId,
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) };
    const result: JsonObject = { role: 'assistant', content: message.content };
    if (new Set(message.toolCalls.map((tool) => tool.id)).size !== message.toolCalls.length) {
      throw invalid('invalid_request', '同一回复的工具调用 ID 不能重复。');
    }
    if (message.toolCalls.length) result['tool_calls'] = message.toolCalls.map((tool) => ({
      id: tool.id, type: 'function', function: { name: alias(tool.name), arguments: JSON.stringify(tool.arguments) },
    }));
    if (message.continuation) {
      const continuation = message.continuation;
      if (continuation.provider !== 'deepseek' || continuation.model !== model) {
        throw invalid('invalid_request', '模型续接状态属于其他供应商或型号。');
      }
      const reasoning = continuation.data['reasoning_content'];
      if (reasoning !== undefined) {
        if (typeof reasoning !== 'string') throw invalid('invalid_request', '模型续接状态无效。');
        // 只重放协议字段，不允许不透明数据覆盖角色或工具调用。
        result['reasoning_content'] = reasoning;
      }
    }
    return result;
  });
  const body: JsonObject = { model, messages, stream: false };
  // 工具接口不随本轮选择变化，返回结果仍由 requester 校验原契约。
  const tools = input.tools;
  if (tools.length) body['tools'] = tools.map((tool) => ({
    type: 'function', function: { ...tool, name: alias(tool.name) },
  }));
  if (choice !== undefined) body['tool_choice'] = thinking && choice === 'required'
    ? 'auto' : typeof choice === 'string' ? choice : { type: 'function', function: { name: alias(choice.name) } };
  if (input.parallelToolCalls !== undefined) body['parallel_tool_calls'] = input.parallelToolCalls;
  if (input.maxOutputTokens !== undefined) body['max_tokens'] = input.maxOutputTokens;
  if (input.temperature !== undefined) body['temperature'] = input.temperature;
  return { body, originals };
}

export function decodeDeepSeek(value: unknown, model: string, originals: ReadonlyMap<string, string>): ModelCompletion {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw invalid('invalid_response', 'DeepSeek 返回了无效的模型响应。', 'invalid_envelope');
  const response = parsed.data;
  const choice = response.choices[0]!;
  const native = choice.message;
  const ids = new Set<string>();
  const toolCalls = (native.tool_calls ?? []).map((tool) => {
    if (ids.has(tool.id)) throw invalid('invalid_response', 'DeepSeek 返回了重复的工具调用 ID。', 'duplicate_call_id');
    ids.add(tool.id);
    let args: unknown;
    try { args = JSON.parse(tool.function.arguments); }
    catch { throw invalid('invalid_response', 'DeepSeek 工具参数不是完整的 JSON。', 'invalid_arguments'); }
    const parameters = object.safeParse(args);
    if (!parameters.success) throw invalid('invalid_response', 'DeepSeek 工具参数必须是 JSON 对象。', 'invalid_arguments');
    return { id: tool.id, name: originals.get(tool.function.name) ?? tool.function.name, arguments: parameters.data };
  });
  const reason = choice.finish_reason;
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  return {
    ...(response.id ? { id: response.id } : {}), provider: 'deepseek', model,
    finishReason: reason === 'stop' || reason === 'tool_calls' || reason === 'length' || reason === 'content_filter'
      ? reason : 'unknown',
    message: {
      role: 'assistant', content: native.content ?? '', toolCalls,
      ...(native.reasoning_content == null ? {} : {
        continuation: { provider: 'deepseek', model, data: { reasoning_content: native.reasoning_content } },
      }),
    },
    usage: { inputTokens, outputTokens, totalTokens: response.usage?.total_tokens ?? inputTokens + outputTokens,
      ...(response.usage?.prompt_cache_hit_tokens === undefined ? {} : { cacheHitTokens: response.usage.prompt_cache_hit_tokens }),
      ...(response.usage?.prompt_cache_miss_tokens === undefined ? {} : { cacheMissTokens: response.usage.prompt_cache_miss_tokens }),
    },
  };
}

function invalid(code: 'invalid_request' | 'invalid_response', message: string, protocolReason?: ModelProtocolReason): ModelRequesterError {
  return new ModelRequesterError(message, { provider: 'deepseek', code,
    retryable: code === 'invalid_response', ...(protocolReason ? { protocolReason } : {}) });
}
