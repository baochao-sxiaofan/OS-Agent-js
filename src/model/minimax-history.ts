import type { ContextItem } from '../kernel/context.js';
import type { ModelAssistantMessage, ModelMessage, ModelToolCall } from '../model-requester/index.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import { redactMediaOutput } from './media.js';

/** 保留给现有调用方使用的旧版原生历史读取器。 */
export function miniMaxHistory(context: readonly ContextItem[], providerId: string): JsonObject[] {
  const messages: JsonObject[] = [];
  for (const [index, item] of context.entries()) {
    if (item.type !== 'provider_message' || item.providerId !== providerId) continue;
    messages.push(structuredClone(item.message));
    const calls = item.message['tool_calls'];
    if (!Array.isArray(calls)) continue;
    const nextTurn = context.findIndex((entry, i) => i > index && entry.type === 'provider_message');
    const following = context.slice(index + 1, nextTurn < 0 ? undefined : nextTurn);
    for (const call of calls) {
      if (!call || typeof call !== 'object' || Array.isArray(call) || typeof call['id'] !== 'string') continue;
      let output: JsonValue = { status: 'accepted', note: 'Consult the runtime update for execution status. Acceptance does not mean completion.' };
      for (const entry of following) {
        if (entry.type === 'tool_result' && entry.callId === call['id']) output = entry.output;
        if (entry.type === 'async_work_update') {
          const result = entry.results.find((candidate) => candidate.kind === 'tool' && candidate.workId === call['id']);
          if (result) output = result.output ?? { status: result.status, error: result.error ?? 'No output.' };
        }
        if (entry.type === 'tool_call_rejected' || entry.type === 'graph_action_rejected') output = { ...entry };
      }
      messages.push({ role: 'tool', tool_call_id: call['id'], content: JSON.stringify(redactMediaOutput(output)) });
    }
  }
  return messages;
}

/** 新快照只保存公共消息协议，不包含传输层类型。 */
export function storeModelMessage(message: ModelAssistantMessage): JsonObject {
  return {
    format: 'model-message.v1',
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls.map((call) => ({ ...call })),
    ...(message.continuation === undefined ? {} : { continuation: { ...message.continuation } }),
  };
}

export function miniMaxModelHistory(
  context: readonly ContextItem[],
  providerId: string,
  model: string,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const [index, item] of context.entries()) {
    if (item.type !== 'provider_message' || item.providerId !== providerId) continue;
    const assistant = restoreAssistant(item.message, model);
    messages.push(assistant);
    const nextTurn = context.findIndex((entry, i) => i > index && entry.type === 'provider_message');
    const following = context.slice(index + 1, nextTurn < 0 ? undefined : nextTurn);
    for (const call of assistant.toolCalls) {
      let output: JsonValue = { status: 'accepted', note: 'Consult the runtime update for execution status. Acceptance does not mean completion.' };
      for (const entry of following) {
        if (entry.type === 'tool_result' && entry.callId === call.id) output = entry.output;
        if (entry.type === 'async_work_update') {
          const result = entry.results.find((candidate) => candidate.kind === 'tool' && candidate.workId === call.id);
          if (result) output = result.output ?? { status: result.status, error: result.error ?? 'No output.' };
        }
        if (entry.type === 'tool_call_rejected' || entry.type === 'graph_action_rejected') output = { ...entry };
      }
      messages.push({ role: 'tool', callId: call.id, content: redactMediaOutput(output) });
    }
  }
  return messages;
}

/**
 * 兼容模块化之前的旧快照。新代码不再写入此厂商专用结构，
 * 传输编解码统一保留在请求器模块内。
 */
function restoreAssistant(stored: JsonObject, model: string): ModelAssistantMessage {
  const canonical = stored['format'] === 'model-message.v1';
  const rawCalls = stored[canonical ? 'toolCalls' : 'tool_calls'] ?? [];
  if (!Array.isArray(rawCalls)) throw invalidHistory();
  const toolCalls: ModelToolCall[] = rawCalls.map((value) => {
    if (!isObject(value)) throw invalidHistory();
    const fn = canonical ? value : value['function'];
    if (!isObject(fn) || typeof value['id'] !== 'string' || typeof fn['name'] !== 'string') throw invalidHistory();
    let args = fn['arguments'];
    if (!canonical && typeof args === 'string') {
      try { args = JSON.parse(args) as JsonValue; } catch { throw invalidHistory(); }
    }
    if (!isObject(args)) throw invalidHistory();
    return { id: value['id'], name: fn['name'], arguments: structuredClone(args) };
  });
  const content = stored['content'] ?? '';
  if (typeof content !== 'string') throw invalidHistory();
  const message: ModelAssistantMessage = { role: 'assistant', content, toolCalls };
  if (canonical) {
    const continuation = stored['continuation'];
    if (continuation !== undefined) {
      if (!isObject(continuation) || continuation['provider'] !== 'minimax' ||
          typeof continuation['model'] !== 'string' || !isObject(continuation['data'])) throw invalidHistory();
      message.continuation = { provider: 'minimax', model: continuation['model'], data: structuredClone(continuation['data']) };
    }
  } else {
    const data: JsonObject = {};
    for (const key of ['reasoning_details', 'reasoning_content'] as const) {
      if (stored[key] !== undefined && stored[key] !== null) data[key] = structuredClone(stored[key]);
    }
    if (Object.keys(data).length > 0) message.continuation = { provider: 'minimax', model, data };
  }
  return message;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidHistory(): Error {
  return Object.assign(new Error('Invalid persisted MiniMax assistant message.'), { retryable: false });
}
