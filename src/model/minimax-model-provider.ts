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
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
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
  readonly #maxOutputTokens: number;
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
    this.#maxOutputTokens =
      options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
    this.contextWindowTokens =
      options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    this.id = `minimax:${this.#model}`;
  }

  estimate(request: ModelRequest): ModelRequestEstimate {
    return {
      inputTokens: estimateTokens(JSON.stringify(request)),
      maxOutputTokens: this.#maxOutputTokens,
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

    const toolArguments = extractAgentResponseToolArguments(message);
    if (toolArguments !== undefined) {
      return parseAgentResponse(toolArguments, request, usage, diagnostics);
    }

    const content = message['content'];
    if (typeof content !== 'string' || !content.trim()) {
      throw new MiniMaxProviderError(
        `MiniMax returned no OS-Agent action (${diagnostics}).`,
      );
    }
    return parseAgentResponse(
      stripThinkingBlock(content),
      request,
      usage,
      diagnostics,
    );
  }

  private buildRequestBody(request: ModelRequest): JsonObject {
    return {
      model: this.#model,
      messages: [
        {
          role: 'system',
          content: [
            buildStructuredAgentSystemInstruction(request),
            `Call ${AGENT_RESPONSE_TOOL_NAME} exactly once with the complete response object.`,
            'Do not place the response object in message content.',
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
          }),
        },
      ],
      stream: false,
      max_completion_tokens: this.#maxOutputTokens,
      reasoning_split: true,
      tools: [
        {
          type: 'function',
          function: {
            name: AGENT_RESPONSE_TOOL_NAME,
            description:
              'Submit exactly one complete OS-Agent action for this turn.',
            parameters: structuredClone(
              AGENT_RESPONSE_JSON_SCHEMA,
            ) as unknown as JsonObject,
          },
        },
      ],
      tool_choice: 'auto',
    };
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
  if (matchingArguments.length === 0 && toolCalls.length > 0) {
    throw new MiniMaxProviderError(
      `MiniMax returned an unsupported tool call instead of ${AGENT_RESPONSE_TOOL_NAME}.`,
    );
  }
  return matchingArguments[0];
}

function parseAgentResponse(
  text: string,
  request: ModelRequest,
  usage: ModelUsage,
  diagnostics: string,
): ModelResponse {
  try {
    return parseStructuredAgentResponse(text, request, usage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MiniMaxProviderError(
      `MiniMax returned an invalid OS-Agent action (${diagnostics}): ${message}`,
    );
  }
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
