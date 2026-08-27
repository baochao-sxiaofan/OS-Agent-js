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
  serializeContextItemForModel,
} from './structured-agent-response.js';

export type AnthropicModelProviderOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  fetchImplementation?: typeof fetch;
};

export class AnthropicProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AnthropicProviderError';
  }
}

export class AnthropicModelProvider implements ModelProvider {
  readonly id: string;
  readonly contextWindowTokens: number;

  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #maxOutputTokens: number;
  readonly #fetch: typeof fetch;

  constructor(options: AnthropicModelProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new Error('Anthropic API key must not be empty.');
    }
    if (!options.model.trim()) {
      throw new Error('Anthropic model ID must not be empty.');
    }
    this.#apiKey = options.apiKey.trim();
    this.#model = options.model.trim();
    this.#baseUrl = (
      options.baseUrl ?? 'https://api.anthropic.com'
    ).replace(/\/+$/u, '');
    this.#maxOutputTokens = options.maxOutputTokens ?? 640;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
    this.contextWindowTokens = options.contextWindowTokens ?? 200_000;
    this.id = `anthropic:${this.#model}`;
  }

  estimate(request: ModelRequest): ModelRequestEstimate {
    return {
      inputTokens: Math.max(
        1,
        Math.ceil(JSON.stringify(request).length / 4),
      ),
      maxOutputTokens: this.#maxOutputTokens,
      estimatedCostUsd: 0,
    };
  }

  async invoke(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'x-api-key': this.#apiKey,
      },
      body: JSON.stringify({
        model: this.#model,
        max_tokens: this.#maxOutputTokens,
        system: [
          STRUCTURED_AGENT_INSTRUCTION,
          request.summaryProtocol.instruction,
        ].join(' '),
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              goal: request.goal,
              attempt: request.attempt,
              context: request.context.map(serializeContextItemForModel),
              tools: request.tools,
              delegation: request.delegation,
            }),
          },
        ],
      }),
      signal,
    });
    const body = await parseJsonResponse(response);
    if (!response.ok) {
      throw new AnthropicProviderError(
        formatProviderError(response.status, body),
        response.status,
      );
    }

    const object = requireObject(body, 'response');
    const content = requireArray(object['content'], 'content');
    const text = content
      .map((block, index) => {
        const blockObject = requireObject(
          block,
          `content[${index}]`,
        );
        return blockObject['type'] === 'text' &&
          typeof blockObject['text'] === 'string'
          ? blockObject['text']
          : '';
      })
      .join('');
    if (!text.trim()) {
      throw new AnthropicProviderError(
        'Anthropic returned no text content.',
      );
    }
    return parseStructuredAgentResponse(
      text,
      request,
      parseUsage(object['usage']),
    );
  }
}

async function parseJsonResponse(response: Response): Promise<JsonValue> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new AnthropicProviderError(
      `Anthropic returned non-JSON HTTP content (status ${response.status}).`,
      response.status,
    );
  }
}

function parseUsage(value: JsonValue | undefined): ModelUsage {
  if (!isObject(value)) {
    return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
  return {
    inputTokens: nonNegativeNumber(value['input_tokens']),
    outputTokens: nonNegativeNumber(value['output_tokens']),
    costUsd: 0,
  };
}

function formatProviderError(status: number, body: JsonValue): string {
  if (isObject(body) && isObject(body['error'])) {
    const message = body['error']['message'];
    if (typeof message === 'string') {
      return `Anthropic request failed (${status}): ${message}`;
    }
  }
  return `Anthropic request failed with HTTP status ${status}.`;
}

function requireObject(
  value: JsonValue | undefined,
  path: string,
): JsonObject {
  if (!isObject(value)) {
    throw new AnthropicProviderError(`${path} must be a JSON object.`);
  }
  return value;
}

function requireArray(
  value: JsonValue | undefined,
  path: string,
): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new AnthropicProviderError(`${path} must be an array.`);
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
