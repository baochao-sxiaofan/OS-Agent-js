import type { JsonObject, JsonValue } from '../types/json.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelRequestEstimate,
  ModelResponse,
} from './model-provider.js';
import {
  buildAgentResponseJsonSchema,
  buildStructuredAgentSystemInstruction,
  estimateModelInputTokens,
  extractModelImages,
  parseStructuredAgentResponse,
  serializeContextItemForModel,
} from './structured-agent-response.js';

const DEFAULT_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;

export type GeminiPricing = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

export type GeminiModelProviderOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  pricing?: GeminiPricing;
  fetchImplementation?: typeof fetch;
};

type GeminiRequestBody = {
  systemInstruction: {
    parts: Array<{
      text: string;
    }>;
  };
  contents: Array<{
    role: 'user';
    parts: Array<
      | { text: string }
      | {
          inlineData: {
            mimeType: string;
            data: string;
          };
        }
    >;
  }>;
  generationConfig: {
    temperature: number;
    maxOutputTokens?: number;
    responseMimeType: 'application/json';
    responseJsonSchema: JsonObject;
    thinkingConfig?: {
      thinkingLevel: 'HIGH' | 'LOW' | 'MEDIUM';
    };
  };
};

export class GeminiProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GeminiProviderError';
  }
}

export class GeminiModelProvider implements ModelProvider {
  readonly id: string;
  readonly contextWindowTokens: number;

  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #maxOutputTokens: number | undefined;
  readonly #pricing: GeminiPricing;
  readonly #fetch: typeof fetch;

  constructor(options: GeminiModelProviderOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error('Gemini API key must not be empty.');
    }
    if (options.maxOutputTokens !== undefined && options.maxOutputTokens <= 0) {
      throw new Error('Gemini maxOutputTokens must be greater than zero.');
    }

    this.#apiKey = options.apiKey;
    this.#model = options.model ?? 'gemini-3.5-flash-lite';
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, '');
    this.contextWindowTokens =
      options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    this.#maxOutputTokens = options.maxOutputTokens;
    this.#pricing = options.pricing ?? {
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    };
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
    this.id = `gemini:${this.#model}`;
  }

  estimate(request: ModelRequest): ModelRequestEstimate {
    const inputTokens = estimateModelInputTokens(request);
    return {
      inputTokens,
      maxOutputTokens: this.#maxOutputTokens ?? 0,
      estimatedCostUsd: calculateCost(
        inputTokens,
        this.#maxOutputTokens ?? 0,
        this.#pricing,
      ),
    };
  }

  async invoke(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    const response = await this.#fetch(this.endpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.#apiKey,
      },
      body: JSON.stringify(this.buildRequestBody(request)),
      signal,
    });

    const responseBody: JsonValue = await parseResponseBody(response);
    if (!response.ok) {
      throw new GeminiProviderError(
        formatGeminiError(response.status, responseBody),
        response.status,
      );
    }

    const responseObject = requireJsonObject(
      responseBody,
      'Gemini response body',
    );
    const text = extractCandidateText(responseObject);
    const usage = parseUsage(responseObject, this.#pricing);
    try {
      return parseStructuredAgentResponse(text, request, usage);
    } catch (error) {
      throw new GeminiProviderError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private endpoint(): string {
    return `${this.#baseUrl}/models/${encodeURIComponent(this.#model)}:generateContent`;
  }

  private buildRequestBody(request: ModelRequest): GeminiRequestBody {
    const images = extractModelImages(request.context);
    const body: GeminiRequestBody = {
      systemInstruction: {
        parts: [
          {
            text: [
              buildStructuredAgentSystemInstruction(request),
              'The response must follow the supplied JSON schema.',
            ].join(' '),
          },
        ],
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: this.buildPrompt(request),
            },
            ...images.map((image) => ({
              inlineData: {
                mimeType: image.mimeType,
                data: image.dataBase64,
              },
            })),
          ],
        },
      ],
      generationConfig: {
        temperature: request.preferences?.temperature ?? 0,
        responseMimeType: 'application/json',
        responseJsonSchema: buildAgentResponseJsonSchema(request),
      },
    };
    if (this.#maxOutputTokens !== undefined) {
      body.generationConfig.maxOutputTokens = this.#maxOutputTokens;
    }
    if (
      this.#model.startsWith('gemini-3') &&
      request.preferences?.reasoningEffort !== undefined &&
      request.preferences.reasoningEffort !== 'auto'
    ) {
      body.generationConfig.thinkingConfig = {
        thinkingLevel:
          request.preferences.reasoningEffort.toUpperCase() as
            | 'HIGH'
            | 'LOW'
            | 'MEDIUM',
      };
    }
    return body;
  }

  private buildPrompt(request: ModelRequest): string {
    const prompt = {
      goal: request.goal,
      ...(request.character === undefined
        ? {}
        : { character: request.character }),
      capabilities: request.capabilities ?? [],
      attempt: request.attempt,
      context: request.context.map(serializeContextItemForModel),
      tools: request.tools,
      delegation: request.delegation,
      ...(request.graph === undefined ? {} : { graph: request.graph }),
    };
    return JSON.stringify(prompt);
  }
}

function calculateCost(
  inputTokens: number,
  outputTokens: number,
  pricing: GeminiPricing,
): number {
  return (
    (inputTokens * pricing.inputUsdPerMillionTokens +
      outputTokens * pricing.outputUsdPerMillionTokens) /
    1_000_000
  );
}

async function parseResponseBody(response: Response): Promise<JsonValue> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new GeminiProviderError(
      `Gemini returned non-JSON HTTP content (status ${response.status}).`,
      response.status,
    );
  }
}

function extractCandidateText(response: JsonObject): string {
  const candidates = requireJsonArray(response['candidates'], 'candidates');
  const firstCandidate = requireJsonObject(candidates[0], 'candidates[0]');
  const content = requireJsonObject(
    firstCandidate['content'],
    'candidates[0].content',
  );
  const parts = requireJsonArray(content['parts'], 'candidates[0].content.parts');
  const textParts = parts.map((part, index) => {
    const partObject = requireJsonObject(
      part,
      `candidates[0].content.parts[${index}]`,
    );
    return requireString(
      partObject['text'],
      `candidates[0].content.parts[${index}].text`,
    );
  });
  const text = textParts.join('');
  if (text.trim().length === 0) {
    throw new GeminiProviderError('Gemini returned an empty candidate.');
  }
  return text;
}

function parseUsage(
  response: JsonObject,
  pricing: GeminiPricing,
): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
} {
  const usageValue = response['usageMetadata'];
  if (usageValue === undefined) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  }
  const usage = requireJsonObject(usageValue, 'usageMetadata');
  const inputTokens = optionalNonNegativeNumber(usage['promptTokenCount']);
  const outputTokens = optionalNonNegativeNumber(
    usage['candidatesTokenCount'],
  );
  return {
    inputTokens,
    outputTokens,
    costUsd: calculateCost(inputTokens, outputTokens, pricing),
  };
}

function formatGeminiError(status: number, body: JsonValue): string {
  if (isJsonObject(body) && isJsonObject(body['error'])) {
    const message = body['error']['message'];
    if (typeof message === 'string') {
      return `Gemini request failed (${status}): ${message}`;
    }
  }
  return `Gemini request failed with HTTP status ${status}.`;
}

function requireJsonObject(
  value: JsonValue | undefined,
  path: string,
): JsonObject {
  if (!isJsonObject(value)) {
    throw new GeminiProviderError(`${path} must be a JSON object.`);
  }
  return value;
}

function requireJsonArray(
  value: JsonValue | undefined,
  path: string,
): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new GeminiProviderError(`${path} must be a JSON array.`);
  }
  return value;
}

function requireString(value: JsonValue | undefined, path: string): string {
  if (typeof value !== 'string') {
    throw new GeminiProviderError(`${path} must be a string.`);
  }
  return value;
}

function optionalNonNegativeNumber(value: JsonValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
