import type { ContextItem } from '../kernel/context.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelRequestEstimate,
  ModelResponse,
  ModelUsage,
} from './model-provider.js';
import {
  STRUCTURED_AGENT_INSTRUCTION,
  parseStructuredAgentResponse,
} from './structured-agent-response.js';

export type OpenAiCompatibleModelProviderOptions = {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  apiKeyHeader?: 'api-key' | 'authorization';
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';
  fetchImplementation?: typeof fetch;
};

export class OpenAiCompatibleProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenAiCompatibleProviderError';
  }
}

export class OpenAiCompatibleModelProvider implements ModelProvider {
  readonly id: string;
  readonly contextWindowTokens: number;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #maxOutputTokens: number;
  readonly #apiKeyHeader: 'api-key' | 'authorization';
  readonly #maxTokensField: 'max_completion_tokens' | 'max_tokens';
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiCompatibleModelProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new Error('API key must not be empty.');
    }
    if (!options.model.trim()) {
      throw new Error('Model ID must not be empty.');
    }
    this.#apiKey = options.apiKey.trim();
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.#model = options.model.trim();
    this.#maxOutputTokens = options.maxOutputTokens ?? 640;
    this.#apiKeyHeader = options.apiKeyHeader ?? 'authorization';
    this.#maxTokensField = options.maxTokensField ?? 'max_tokens';
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
    this.contextWindowTokens = options.contextWindowTokens ?? 128_000;
    this.id = `${options.providerId}:${this.#model}`;
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
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.#apiKeyHeader === 'api-key') {
      headers['api-key'] = this.#apiKey;
    } else {
      headers['authorization'] = `Bearer ${this.#apiKey}`;
    }

    const response = await this.#fetch(
      `${this.#baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(this.buildRequestBody(request)),
        signal,
      },
    );
    const body = await parseJsonResponse(response);
    if (!response.ok) {
      throw new OpenAiCompatibleProviderError(
        formatProviderError(response.status, body),
        response.status,
      );
    }

    const responseObject = requireObject(body, 'response');
    const choices = requireArray(responseObject['choices'], 'choices');
    const choice = requireObject(choices[0], 'choices[0]');
    const message = requireObject(choice['message'], 'choices[0].message');
    const content = requireString(
      message['content'],
      'choices[0].message.content',
    );
    const usage = parseUsage(responseObject['usage']);
    return parseStructuredAgentResponse(content, request, usage);
  }

  private buildRequestBody(request: ModelRequest): JsonObject {
    const payload: JsonObject = {
      model: this.#model,
      messages: [
        {
          role: 'system',
          content: [
            STRUCTURED_AGENT_INSTRUCTION,
            request.summaryProtocol.instruction,
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            taskId: request.taskId,
            goal: request.goal,
            attempt: request.attempt,
            context: request.context.map(serializeContextItem),
            tools: request.tools,
            delegation: request.delegation,
          }),
        },
      ],
      stream: false,
      response_format: {
        type: 'json_object',
      },
    };
    payload[this.#maxTokensField] = this.#maxOutputTokens;
    return payload;
  }
}

function serializeContextItem(item: ContextItem): JsonObject {
  return structuredClone(item) as JsonObject;
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
    throw new OpenAiCompatibleProviderError(
      `Provider returned non-JSON HTTP content (status ${response.status}).`,
      response.status,
    );
  }
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
      return `Model request failed (${status}): ${message}`;
    }
  }
  return `Model request failed with HTTP status ${status}.`;
}

function requireObject(
  value: JsonValue | undefined,
  path: string,
): JsonObject {
  if (!isObject(value)) {
    throw new OpenAiCompatibleProviderError(
      `${path} must be a JSON object.`,
    );
  }
  return value;
}

function requireArray(
  value: JsonValue | undefined,
  path: string,
): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new OpenAiCompatibleProviderError(`${path} must be an array.`);
  }
  return value;
}

function requireString(
  value: JsonValue | undefined,
  path: string,
): string {
  if (typeof value !== 'string') {
    throw new OpenAiCompatibleProviderError(`${path} must be a string.`);
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
