import type { JsonObject, JsonValue } from '../../types/json.js';
import {
  ModelRequesterError,
  type ModelAssistantMessage,
  type ModelCompletion,
  type ModelCompletionRequest,
  type ModelContentPart,
  type ModelFinishReason,
  type ModelMessage,
  type ModelTokenUsage,
  type ModelToolCall,
} from '../api.js';

/** 传输格式细节仅限此适配器内部使用。 */
export function encodeRequest(request: ModelCompletionRequest, model: string): JsonObject {
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw invalidRequest('messages must contain at least one message.');
  }
  if (request.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)) {
    throw invalidRequest('maxOutputTokens must be a positive integer.');
  }
  if (request.temperature !== undefined &&
      (!Number.isFinite(request.temperature) || request.temperature <= 0 || request.temperature > 1)) {
    throw invalidRequest('MiniMax temperature must be in (0, 1].');
  }
  const tools = request.tools ?? [];
  const names = new Set<string>();
  for (const tool of tools) {
    requireInputString(tool.name, 'tool name', false);
    requireInputString(tool.description, 'tool description');
    if (!isObject(tool.parameters) || !isJson(tool.parameters)) {
      throw invalidRequest('Tool parameters must be a JSON Schema object.');
    }
    if (names.has(tool.name)) throw invalidRequest('Tool names must be unique.');
    names.add(tool.name);
  }
  const choice = request.toolChoice;
  if ((choice === 'required' || typeof choice === 'object') && tools.length === 0) {
    throw invalidRequest('toolChoice requires tool definitions.');
  }
  if (typeof choice === 'object' && (choice === null || !names.has(choice.name))) {
    throw invalidRequest('toolChoice must name a declared tool.');
  }
  if (choice !== undefined && typeof choice !== 'object' &&
      choice !== 'auto' && choice !== 'none' && choice !== 'required') {
    throw invalidRequest('Unsupported toolChoice.');
  }
  const body: JsonObject = {
    model,
    messages: request.messages.map((message) => encodeMessage(message, model)),
    stream: false,
    reasoning_split: true,
  };
  if (tools.length > 0) {
    body['tools'] = tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (choice !== undefined) {
    body['tool_choice'] = typeof choice === 'string' ? choice
      : { type: 'function', function: { name: choice.name } };
  }
  if (request.maxOutputTokens !== undefined) body['max_completion_tokens'] = request.maxOutputTokens;
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  return body;
}

function encodeMessage(message: ModelMessage, model: string): JsonObject {
  switch (message.role) {
    case 'system':
      requireInputString(message.content, 'system content');
      return { role: 'system', content: message.content };
    case 'user':
      if (typeof message.content === 'string') return { role: 'user', content: message.content };
      if (!Array.isArray(message.content) || message.content.length === 0) {
        throw invalidRequest('User content must be text or a nonempty list of content parts.');
      }
      return { role: 'user', content: message.content.map((part: ModelContentPart) => encodePart(part, model)) };
    case 'tool':
      requireInputString(message.callId, 'tool result callId', false);
      if (!isJson(message.content)) throw invalidRequest('Tool result must be JSON serializable.');
      return {
        role: 'tool', tool_call_id: message.callId,
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      };
    case 'assistant': {
      requireInputString(message.content, 'assistant content');
      if (!Array.isArray(message.toolCalls)) throw invalidRequest('assistant toolCalls must be an array.');
      const body: JsonObject = { role: 'assistant', content: message.content };
      const ids = new Set<string>();
      if (message.toolCalls.length > 0) {
        body['tool_calls'] = message.toolCalls.map((call: ModelToolCall) => {
          requireInputString(call.id, 'tool call id', false);
          requireInputString(call.name, 'tool call name', false);
          if (ids.has(call.id)) throw invalidRequest('Tool call IDs must be unique within a message.');
          ids.add(call.id);
          if (!isObject(call.arguments) || !isJson(call.arguments)) {
            throw invalidRequest('Tool call arguments must be a JSON object.');
          }
          return { id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
        });
      }
      const continuation = message.continuation;
      if (continuation !== undefined) {
        if (continuation.provider !== 'minimax' || continuation.model !== model) {
          throw invalidRequest('Assistant continuation belongs to a different provider or model.');
        }
        if (!isObject(continuation.data) || !isJson(continuation.data)) {
          throw invalidRequest('Invalid assistant continuation.');
        }
        // 不透明状态不能通过对象展开覆盖角色、内容或工具调用字段。
        for (const key of ['reasoning_details', 'reasoning_content'] as const) {
          if (continuation.data[key] !== undefined) body[key] = continuation.data[key];
        }
      }
      return body;
    }
    default:
      throw invalidRequest('Unsupported message role.');
  }
}

function encodePart(part: ModelContentPart, model: string): JsonObject {
  if (part.type === 'text') {
    requireInputString(part.text, 'text part');
    return { type: 'text', text: part.text };
  }
  if (part.type !== 'image' && part.type !== 'video') throw invalidRequest('Unsupported content part.');
  if (!/^MiniMax-M3(?:$|-)/iu.test(model)) {
    throw invalidRequest('MiniMax media input requires MiniMax-M3.');
  }
  requireInputString(part.url, 'media URL', false);
  if (part.type === 'image') return { type: 'image_url', image_url: { url: part.url } };
  if (part.fps !== undefined && (!Number.isFinite(part.fps) || part.fps <= 0)) {
    throw invalidRequest('Video fps must be greater than zero.');
  }
  return {
    type: 'video_url',
    video_url: { url: part.url.replace(/^data:video\/quicktime;/u, 'data:video/mov;'), fps: part.fps ?? 1 },
  };
}

export function decodeResponse(value: unknown, model: string): ModelCompletion {
  const response = requireObject(value, 'response');
  const choices = response['choices'];
  if (!Array.isArray(choices) || choices.length !== 1) {
    throw invalidResponse('MiniMax response must contain exactly one choice.');
  }
  const choice = requireObject(choices[0], 'choices[0]');
  const native = requireObject(choice['message'], 'choices[0].message');
  if (native['role'] !== undefined && native['role'] !== 'assistant') {
    throw invalidResponse('Expected an assistant response.');
  }
  const content = native['content'];
  if (content !== null && content !== undefined && typeof content !== 'string') {
    throw invalidResponse('Assistant content must be text or null.');
  }
  const finishReason = decodeFinishReason(choice['finish_reason']);
  const toolCalls: ModelToolCall[] = [];
  const ids = new Set<string>();
  const calls = native['tool_calls'];
  if (calls !== undefined && calls !== null) {
    if (!Array.isArray(calls)) throw invalidResponse('tool_calls must be an array.');
    for (const value of calls) {
      const call = requireObject(value, 'tool_call');
      if (call['type'] !== undefined && call['type'] !== 'function') {
        throw invalidResponse('Unsupported tool call type.');
      }
      const fn = requireObject(call['function'], 'tool_call.function');
      const id = requireString(call['id'], 'tool_call.id');
      const name = requireString(fn['name'], 'tool_call.function.name');
      const raw = requireString(fn['arguments'], 'tool_call.function.arguments');
      if (ids.has(id)) throw invalidResponse('Duplicate tool call ID.');
      ids.add(id);
      let args: unknown;
      try {
        args = JSON.parse(raw);
      } catch {
        throw invalidResponse(`Tool call has invalid JSON arguments (finishReason=${finishReason}).`);
      }
      if (!isObject(args) || !isJson(args)) {
        throw invalidResponse('Tool call arguments must be a JSON object.');
      }
      toolCalls.push({ id, name, arguments: args });
    }
  }
  const data: JsonObject = {};
  for (const key of ['reasoning_details', 'reasoning_content'] as const) {
    const state = native[key];
    if (state !== undefined && state !== null) {
      if (!isJson(state)) throw invalidResponse('Invalid reasoning continuation.');
      data[key] = structuredClone(state);
    }
  }
  const message: ModelAssistantMessage = {
    role: 'assistant',
    content: content ?? '',
    toolCalls,
    ...(Object.keys(data).length === 0 ? {} : { continuation: { provider: 'minimax' as const, model, data } }),
  };
  return {
    ...(typeof response['id'] === 'string' ? { id: response['id'] } : {}),
    provider: 'minimax',
    model,
    message,
    finishReason,
    usage: decodeUsage(response['usage']),
  };
}

function decodeFinishReason(value: unknown): ModelFinishReason {
  switch (value) {
    case 'stop':
    case 'tool_calls':
    case 'length':
    case 'content_filter':
      return value;
    default:
      return 'unknown';
  }
}

function decodeUsage(value: unknown): ModelTokenUsage {
  const usage = isObject(value) ? value : {};
  const count = (n: unknown): number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
  const inputTokens = count(usage['prompt_tokens']);
  const outputTokens = count(usage['completion_tokens']);
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage['total_tokens'] === undefined ? inputTokens + outputTokens : count(usage['total_tokens']),
  };
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) throw invalidResponse(`${path} must be a JSON object.`);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalidResponse(`${path} must be a nonempty string.`);
  return value;
}

function requireInputString(value: unknown, path: string, allowEmpty = true): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw invalidRequest(`${path} must be ${allowEmpty ? 'a' : 'a nonempty'} string.`);
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJson(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((child: unknown) => isJson(child, ancestors));
  ancestors.delete(value);
  return valid;
}

function invalidRequest(message: string): ModelRequesterError {
  return new ModelRequesterError(message, { provider: 'minimax', code: 'invalid_request' });
}

function invalidResponse(message: string): ModelRequesterError {
  return new ModelRequesterError(message, { provider: 'minimax', code: 'invalid_response' });
}
