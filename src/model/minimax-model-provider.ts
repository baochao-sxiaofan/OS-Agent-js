import type { JsonObject, JsonValue } from '../types/json.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelRequestEstimate,
  ModelResponse,
  ModelUsage,
} from './model-provider.js';
import {
  AGENT_RESPONSE_JSON_SCHEMA,
  buildStructuredAgentSystemInstruction,
  parseStructuredAgentResponse,
  serializeContextItemForModel,
} from './structured-agent-response.js';

const DEFAULT_BASE_URL = 'https://api.minimaxi.com/v1';
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const AGENT_RESPONSE_TOOL_NAME = 'submit_agent_response';

export type MiniMaxModelProviderOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  fetchImplementation?: typeof fetch;
};

export class MiniMaxProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MiniMaxProviderError';
  }
}

/**
 * MiniMax reasoning models do not support response_format. Their documented
 * OpenAI-compatible path exposes structured function arguments instead.
 */
export class MiniMaxModelProvider implements ModelProvider {
  readonly id: string;
  readonly contextWindowTokens: number;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #maxOutputTokens: number | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: MiniMaxModelProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new Error('MiniMax API key must not be empty.');
    }
    if (!options.model.trim()) {
      throw new Error('MiniMax model ID must not be empty.');
    }
    if (options.maxOutputTokens !== undefined && options.maxOutputTokens <= 0) {
      throw new Error('MiniMax maxOutputTokens must be greater than zero.');
    }

    this.#apiKey = options.apiKey.trim();
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(
      /\/+$/u,
      '',
    );
    this.#model = options.model.trim();
    this.#maxOutputTokens = options.maxOutputTokens;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
    this.contextWindowTokens =
      options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    this.id = `minimax:${this.#model}`;
  }

  estimate(request: ModelRequest): ModelRequestEstimate {
    return {
      inputTokens: estimateTokens(JSON.stringify(request)),
      maxOutputTokens: this.#maxOutputTokens ?? 0,
      estimatedCostUsd: 0,
    };
  }

  async invoke(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    const response = await this.#fetch(
      `${this.#baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(this.buildRequestBody(request)),
        signal,
      },
    );
    const body = await parseJsonResponse(response);
    if (!response.ok) {
      throw new MiniMaxProviderError(
        formatProviderError(response.status, body),
        response.status,
      );
    }

    const responseObject = requireObject(body, 'response');
    assertBaseResponseSuccess(responseObject);
    const choices = requireArray(responseObject['choices'], 'choices');
    const choice = requireObject(choices[0], 'choices[0]');
    const message = requireObject(choice['message'], 'choices[0].message');
    const usage = parseUsage(responseObject['usage']);
    const diagnostics = formatResponseDiagnostics(choice, message);

    // 通道一：OS 控制动作仍通过 submit_agent_response 提交。
    const toolArguments = extractAgentResponseToolArguments(message);
    if (toolArguments !== undefined) {
      return parseAgentResponse(toolArguments, request, usage, diagnostics);
    }

    // 通道二：模型直接调用真实业务工具（file.create、workspace.search 等）。
    // 把原生 tool_call 翻译成统一的 tool_calls envelope，再走同一套解析与
    // 后续 CapabilityManager 校验，权限判定不受传输格式影响。
    const businessCalls = extractBusinessToolCalls(message, request);
    if (businessCalls.length > 0) {
      return parseAgentResponse(
        JSON.stringify({
          action: 'tool_calls',
          calls: businessCalls,
          turnSummary: synthesizeTurnSummary(request, businessCalls),
        }),
        request,
        usage,
        diagnostics,
      );
    }

    const content = message['content'];
    if (typeof content !== 'string' || !content.trim()) {
      throw new MiniMaxProviderError(
        `MiniMax returned no OS-Agent action (${diagnostics}).`,
      );
    }
    return parseAgentResponse(
      extractStructuredJson(stripThinkingBlock(content)),
      request,
      usage,
      diagnostics,
    );
  }

  private buildRequestBody(request: ModelRequest): JsonObject {
    const body: JsonObject = {
      model: this.#model,
      messages: [
        {
          role: 'system',
          content: [
            buildStructuredAgentSystemInstruction(request),
            'You may act in one of two ways this turn.',
            'To run visible workspace tools, call them directly as native function calls using their exact names and input schemas.',
            `For every other decision (planning a graph, completing a node, requesting capabilities, finishing, etc.), call ${AGENT_RESPONSE_TOOL_NAME} exactly once with the complete OS-Agent action object.`,
            'Do not place the OS-Agent action object in message content.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            goal: request.goal,
            ...(request.character === undefined
              ? {}
              : { character: request.character }),
            capabilities: request.capabilities ?? [],
            attempt: request.attempt,
            context: request.context.map(serializeContextItemForModel),
            tools: request.tools,
            delegation: request.delegation,
            ...(request.graph === undefined
              ? {}
              : { graph: request.graph }),
          }),
        },
      ],
      stream: false,
      reasoning_split: true,
      tools: [
        {
          type: 'function',
          function: {
            name: AGENT_RESPONSE_TOOL_NAME,
            description:
              'Submit exactly one complete OS-Agent control action for this turn (set_graph, complete_node, request_replan, final, request_capabilities, resolve_capability_request, wait_for_async_work, needs_parent_action, spawn_subagents).',
            parameters: structuredClone(
              AGENT_RESPONSE_JSON_SCHEMA,
            ) as unknown as JsonObject,
          },
        },
        ...request.tools.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters:
              tool.inputSchema === undefined
                ? { type: 'object', additionalProperties: true }
                : (structuredClone(tool.inputSchema) as unknown as JsonObject),
          },
        })),
      ],
      tool_choice: 'required',
    };
    if (this.#maxOutputTokens !== undefined) {
      body['max_completion_tokens'] = this.#maxOutputTokens;
    }
    return body;
  }
}

function extractAgentResponseToolArguments(
  message: JsonObject,
): string | undefined {
  const value = message['tool_calls'];
  if (value === undefined) {
    return undefined;
  }
  const toolCalls = requireArray(value, 'choices[0].message.tool_calls');
  const matchingArguments: string[] = [];

  for (const [index, toolCall] of toolCalls.entries()) {
    const call = requireObject(
      toolCall,
      `choices[0].message.tool_calls[${index}]`,
    );
    const fn = requireObject(
      call['function'],
      `choices[0].message.tool_calls[${index}].function`,
    );
    if (fn['name'] !== AGENT_RESPONSE_TOOL_NAME) {
      continue;
    }
    matchingArguments.push(
      requireString(
        fn['arguments'],
        `choices[0].message.tool_calls[${index}].function.arguments`,
      ),
    );
  }

  if (matchingArguments.length > 1) {
    throw new MiniMaxProviderError(
      `MiniMax called ${AGENT_RESPONSE_TOOL_NAME} more than once.`,
    );
  }
  // 未匹配 submit_agent_response 不再直接报错：可能是原生业务工具调用，
  // 由 extractBusinessToolCalls 处理。
  return matchingArguments[0];
}

/**
 * 收集模型对真实业务工具的原生调用，翻译成统一 tool_calls envelope 所需的
 * `{ callId, toolName, input }`。只接受本轮请求里可见的工具名，避免模型伪造
 * 工具绕过 Character 可见性；能否执行仍由 CapabilityManager 最终裁决。
 */
function extractBusinessToolCalls(
  message: JsonObject,
  request: ModelRequest,
): Array<{ callId: string; toolName: string; input: JsonObject }> {
  const value = message['tool_calls'];
  if (value === undefined) {
    return [];
  }
  const toolCalls = requireArray(value, 'choices[0].message.tool_calls');
  const visibleToolNames = new Set(request.tools.map((tool) => tool.name));
  const calls: Array<{
    callId: string;
    toolName: string;
    input: JsonObject;
  }> = [];

  for (const [index, toolCall] of toolCalls.entries()) {
    const call = requireObject(
      toolCall,
      `choices[0].message.tool_calls[${index}]`,
    );
    const fn = requireObject(
      call['function'],
      `choices[0].message.tool_calls[${index}].function`,
    );
    const name = requireString(
      fn['name'],
      `choices[0].message.tool_calls[${index}].function.name`,
    );
    if (name === AGENT_RESPONSE_TOOL_NAME) {
      continue;
    }
    if (!visibleToolNames.has(name)) {
      throw new MiniMaxProviderError(
        `MiniMax called an unavailable tool: ${name}.`,
      );
    }
    const rawArguments =
      typeof fn['arguments'] === 'string' ? fn['arguments'] : '{}';
    let input: JsonValue;
    try {
      input = JSON.parse(rawArguments || '{}') as JsonValue;
    } catch {
      throw new MiniMaxProviderError(
        `MiniMax tool call ${name} had invalid JSON arguments.`,
      );
    }
    const callId =
      typeof call['id'] === 'string' && call['id'].trim()
        ? call['id']
        : `${name}-${index}`;
    calls.push({
      callId,
      toolName: name,
      input: isObject(input) ? input : {},
    });
  }

  return calls;
}

/** 为原生工具调用合成一个最小 turnSummary，满足统一协议的必填字段。 */
function synthesizeTurnSummary(
  request: ModelRequest,
  calls: ReadonlyArray<{ toolName: string }>,
): { request: string; outcome: string } {
  const toolNames = calls.map((call) => call.toolName).join(', ');
  return {
    request: request.goal.slice(0, 200) || 'Execute the assigned work.',
    outcome: `Invoked workspace tools: ${toolNames}.`,
  };
}

function parseAgentResponse(
  text: string,
  request: ModelRequest,
  usage: ModelUsage,
  diagnostics: string,
): ModelResponse {
  try {
    return parseStructuredAgentResponse(
      normalizeControlEnvelope(text, request),
      request,
      usage,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MiniMaxProviderError(
      `MiniMax returned an invalid OS-Agent action (${diagnostics}): ${message}`,
    );
  }
}

/**
 * 对 submit_agent_response 载荷做无歧义的容错归一化：补齐缺失的 turnSummary，
 * 并把误写成字符串的 turnSummary 收敛为对象。只修复格式，不改动 action、graph、
 * capability 等任何影响语义或安全的字段——那些仍由严格校验拒绝。
 */
function normalizeControlEnvelope(
  text: string,
  request: ModelRequest,
): string {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
  if (!isObject(parsed)) {
    return text;
  }
  const summary = parsed['turnSummary'];
  if (typeof summary === 'string') {
    parsed['turnSummary'] = {
      request: request.goal.slice(0, 200) || 'Continue the assigned work.',
      outcome: summary.slice(0, 400),
    };
  } else if (!isObject(summary)) {
    parsed['turnSummary'] = {
      request: request.goal.slice(0, 200) || 'Continue the assigned work.',
      outcome:
        typeof parsed['action'] === 'string'
          ? `Returned ${parsed['action']}.`
          : 'Returned an OS-Agent action.',
    };
  }
  return JSON.stringify(parsed);
}

function stripThinkingBlock(text: string): string {
  let remaining = text.trim();
  while (true) {
    const match = /^<think>[\s\S]*?<\/think>\s*/iu.exec(remaining);
    if (!match) {
      return remaining;
    }
    remaining = remaining.slice(match[0].length).trimStart();
  }
}

/**
 * Recover the OS-Agent action object when the model wrote it into free-form
 * content instead of a clean JSON body. Handles ```json fences and leading or
 * trailing prose by extracting the first balanced top-level JSON object.
 */
function extractStructuredJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/iu.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    return fenced[1].trim();
  }
  if (trimmed.startsWith('{')) {
    return trimmed;
  }
  const balanced = extractFirstJsonObject(trimmed);
  return balanced ?? trimmed;
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

function formatResponseDiagnostics(
  choice: JsonObject,
  message: JsonObject,
): string {
  const finishReason =
    typeof choice['finish_reason'] === 'string'
      ? choice['finish_reason']
      : 'unknown';
  const contentLength =
    typeof message['content'] === 'string'
      ? message['content'].length
      : 0;
  const reasoningPresent =
    message['reasoning_details'] !== undefined ||
    (typeof message['reasoning_content'] === 'string' &&
      message['reasoning_content'].length > 0);
  const toolCallCount = Array.isArray(message['tool_calls'])
    ? message['tool_calls'].length
    : 0;
  return [
    `finishReason=${finishReason}`,
    `contentLength=${contentLength}`,
    `reasoningPresent=${String(reasoningPresent)}`,
    `toolCallCount=${toolCallCount}`,
  ].join(', ');
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function parseJsonResponse(response: Response): Promise<JsonValue> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new MiniMaxProviderError(
      `MiniMax returned non-JSON HTTP content (status ${response.status}).`,
      response.status,
    );
  }
}

function assertBaseResponseSuccess(response: JsonObject): void {
  const baseResponse = response['base_resp'];
  if (!isObject(baseResponse)) {
    return;
  }
  const statusCode = baseResponse['status_code'];
  if (typeof statusCode !== 'number' || statusCode === 0) {
    return;
  }
  const statusMessage =
    typeof baseResponse['status_msg'] === 'string'
      ? baseResponse['status_msg']
      : 'Unknown MiniMax API error.';
  throw new MiniMaxProviderError(
    `MiniMax request failed (${statusCode}): ${statusMessage}`,
  );
}

function parseUsage(value: JsonValue | undefined): ModelUsage {
  if (!isObject(value)) {
    return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
  return {
    inputTokens: nonNegativeNumber(value['prompt_tokens']),
    outputTokens: nonNegativeNumber(value['completion_tokens']),
    costUsd: 0,
  };
}

function formatProviderError(status: number, body: JsonValue): string {
  if (isObject(body) && isObject(body['error'])) {
    const message = body['error']['message'];
    if (typeof message === 'string') {
      return `MiniMax request failed (${status}): ${message}`;
    }
  }
  if (isObject(body) && isObject(body['base_resp'])) {
    const message = body['base_resp']['status_msg'];
    if (typeof message === 'string' && message) {
      return `MiniMax request failed (${status}): ${message}`;
    }
  }
  return `MiniMax request failed with HTTP status ${status}.`;
}

function requireObject(
  value: JsonValue | undefined,
  path: string,
): JsonObject {
  if (!isObject(value)) {
    throw new MiniMaxProviderError(`${path} must be a JSON object.`);
  }
  return value;
}

function requireArray(
  value: JsonValue | undefined,
  path: string,
): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new MiniMaxProviderError(`${path} must be an array.`);
  }
  return value;
}

function requireString(
  value: JsonValue | undefined,
  path: string,
): string {
  if (typeof value !== 'string') {
    throw new MiniMaxProviderError(`${path} must be a string.`);
  }
  return value;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function nonNegativeNumber(value: JsonValue | undefined): number {
  return typeof value === 'number' && value >= 0 ? value : 0;
}
