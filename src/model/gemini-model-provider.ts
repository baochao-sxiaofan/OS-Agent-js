import type { ContextItem, TurnSummary } from '../kernel/context.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelRequestEstimate,
  ModelResponse,
  SubagentSpawnRequest,
} from './model-provider.js';

const DEFAULT_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 128;

const AGENT_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: [
        'final',
        'needs_parent_action',
        'spawn_subagents',
        'wait_for_async_work',
      ],
      description: 'The next runtime action.',
    },
    output: {
      type: 'string',
      description: 'The concise final answer when action is final.',
    },
    children: {
      type: 'array',
      description:
        'Child tasks to create when action is spawn_subagents.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: {
            type: 'string',
          },
          goal: {
            type: 'string',
          },
          capabilities: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          maxModelAttempts: {
            type: 'integer',
            minimum: 1,
          },
          maxCostUsd: {
            type: 'number',
            minimum: 0,
          },
        },
        required: ['goal'],
      },
    },
    requiredWork: {
      type: 'string',
      description:
        'Work required from the parent when action is needs_parent_action.',
    },
    partialOutput: {
      type: 'string',
      description:
        'Optional partial result when action is needs_parent_action.',
    },
    turnSummary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        request: {
          type: 'string',
          description: 'One concise sentence describing the request.',
        },
        outcome: {
          type: 'string',
          description: 'One concise sentence describing the outcome.',
        },
      },
      required: ['request', 'outcome'],
    },
  },
  required: ['action', 'turnSummary'],
} as const;

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
    parts: Array<{
      text: string;
    }>;
  }>;
  generationConfig: {
    temperature: number;
    maxOutputTokens: number;
    responseMimeType: 'application/json';
    responseJsonSchema: typeof AGENT_RESPONSE_JSON_SCHEMA;
  };
};

type ParsedGeminiEnvelope =
  | {
      action: 'final';
      output: string;
      turnSummary: TurnSummary;
    }
  | {
      action: 'needs_parent_action';
      requiredWork: string;
      partialOutput?: string;
      turnSummary: TurnSummary;
    }
  | {
      action: 'spawn_subagents';
      children: SubagentSpawnRequest[];
      turnSummary: TurnSummary;
    }
  | {
      action: 'wait_for_async_work';
      turnSummary: TurnSummary;
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
  readonly #maxOutputTokens: number;
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
    this.#maxOutputTokens =
      options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.#pricing = options.pricing ?? {
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    };
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
    this.id = `gemini:${this.#model}`;
  }

  estimate(request: ModelRequest): ModelRequestEstimate {
    const inputTokens = estimateTextTokens(this.buildPrompt(request));
    return {
      inputTokens,
      maxOutputTokens: this.#maxOutputTokens,
      estimatedCostUsd: calculateCost(
        inputTokens,
        this.#maxOutputTokens,
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
    const envelope = parseAgentEnvelope(text, request);
    const usage = parseUsage(responseObject, this.#pricing);

    switch (envelope.action) {
      case 'final':
        return {
          type: 'final',
          output: envelope.output,
          turnSummary: envelope.turnSummary,
          usage,
        };
      case 'needs_parent_action':
        return {
          type: 'needs_parent_action',
          requiredWork: envelope.requiredWork,
          ...(envelope.partialOutput === undefined
            ? {}
            : { partialOutput: envelope.partialOutput }),
          turnSummary: envelope.turnSummary,
          usage,
        };
      case 'spawn_subagents':
        return {
          type: 'spawn_subagents',
          children: envelope.children,
          turnSummary: envelope.turnSummary,
          usage,
        };
      case 'wait_for_async_work':
        return {
          type: 'wait_for_async_work',
          turnSummary: envelope.turnSummary,
          usage,
        };
      default: {
        const exhaustiveAction: never = envelope;
        throw new GeminiProviderError(
          `Unhandled Gemini action: ${String(exhaustiveAction)}`,
        );
      }
    }
  }

  private endpoint(): string {
    return `${this.#baseUrl}/models/${encodeURIComponent(this.#model)}:generateContent`;
  }

  private buildRequestBody(request: ModelRequest): GeminiRequestBody {
    return {
      systemInstruction: {
        parts: [
          {
            text: [
              'You are the model worker for OS-Agent-js.',
              'Select exactly one action allowed by the response schema.',
              'Use final when the task is complete.',
              'Use spawn_subagents only when delegation.canSpawnSubagents is true and the goal explicitly requires delegation.',
              'Use wait_for_async_work only when an async_work_update has unfinished pending work.',
              'When async_work_update.allFinished is true, synthesize its results and normally return final.',
              'Use needs_parent_action only when a child cannot proceed without parent work.',
              'Keep outputs, child goals, and summaries concise.',
              request.summaryProtocol.instruction,
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
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: this.#maxOutputTokens,
        responseMimeType: 'application/json',
        responseJsonSchema: AGENT_RESPONSE_JSON_SCHEMA,
      },
    };
  }

  private buildPrompt(request: ModelRequest): string {
    const prompt = {
      taskId: request.taskId,
      goal: request.goal,
      attempt: request.attempt,
      context: request.context.map(serializeContextItem),
      tools: request.tools,
      delegation: request.delegation,
    };
    return JSON.stringify(prompt);
  }
}

function serializeContextItem(item: ContextItem): JsonObject {
  return structuredClone(item) as JsonObject;
}

function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
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

function parseAgentEnvelope(
  text: string,
  request: ModelRequest,
): ParsedGeminiEnvelope {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    throw new GeminiProviderError(
      'Gemini structured output was not valid JSON.',
    );
  }

  const envelope = requireJsonObject(parsed, 'structured output');
  const action = requireString(
    envelope['action'],
    'structured output.action',
  );
  const summary = requireJsonObject(
    envelope['turnSummary'],
    'structured output.turnSummary',
  );
  const turnSummary = {
    request: requireString(
      summary['request'],
      'structured output.turnSummary.request',
    ),
    outcome: requireString(
      summary['outcome'],
      'structured output.turnSummary.outcome',
    ),
  };

  switch (action) {
    case 'final':
      return {
        action,
        output: requireString(
          envelope['output'],
          'structured output.output',
        ),
        turnSummary,
      };
    case 'needs_parent_action': {
      const partialOutput = optionalString(
        envelope['partialOutput'],
        'structured output.partialOutput',
      );
      return {
        action,
        requiredWork: requireString(
          envelope['requiredWork'],
          'structured output.requiredWork',
        ),
        ...(partialOutput === undefined ? {} : { partialOutput }),
        turnSummary,
      };
    }
    case 'spawn_subagents':
      if (!request.delegation.canSpawnSubagents) {
        throw new GeminiProviderError(
          'Gemini requested subagents when delegation is disabled.',
        );
      }
      return {
        action,
        children: parseChildren(envelope['children']),
        turnSummary,
      };
    case 'wait_for_async_work':
      if (!hasPendingAsyncWork(request.context)) {
        throw new GeminiProviderError(
          'Gemini requested async waiting without pending work.',
        );
      }
      return {
        action,
        turnSummary,
      };
    default:
      throw new GeminiProviderError(
        `Gemini returned unsupported action: ${action}`,
      );
  }
}

function parseChildren(
  value: JsonValue | undefined,
): SubagentSpawnRequest[] {
  const children = requireJsonArray(value, 'structured output.children');
  if (children.length === 0) {
    throw new GeminiProviderError(
      'structured output.children must not be empty.',
    );
  }
  return children.map((child, index) => {
    const path = `structured output.children[${index}]`;
    const childObject = requireJsonObject(child, path);
    const taskId = optionalString(childObject['taskId'], `${path}.taskId`);
    const capabilities = optionalStringArray(
      childObject['capabilities'],
      `${path}.capabilities`,
    );
    const maxModelAttempts = optionalPositiveInteger(
      childObject['maxModelAttempts'],
      `${path}.maxModelAttempts`,
    );
    const maxCostUsd = optionalNonNegativeNumberValue(
      childObject['maxCostUsd'],
      `${path}.maxCostUsd`,
    );
    return {
      goal: requireString(childObject['goal'], `${path}.goal`),
      ...(taskId === undefined ? {} : { taskId }),
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(maxModelAttempts === undefined ? {} : { maxModelAttempts }),
      ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    };
  });
}

function hasPendingAsyncWork(context: readonly ContextItem[]): boolean {
  return context.some(
    (item) =>
      item.type === 'async_work_update' &&
      !item.allFinished &&
      item.pending.length > 0,
  );
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

function optionalString(
  value: JsonValue | undefined,
  path: string,
): string | undefined {
  return value === undefined ? undefined : requireString(value, path);
}

function optionalInteger(
  value: JsonValue | undefined,
  path: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new GeminiProviderError(`${path} must be an integer.`);
  }
  return value;
}

function optionalPositiveInteger(
  value: JsonValue | undefined,
  path: string,
): number | undefined {
  const integer = optionalInteger(value, path);
  if (integer !== undefined && integer <= 0) {
    throw new GeminiProviderError(`${path} must be greater than zero.`);
  }
  return integer;
}

function optionalNonNegativeNumberValue(
  value: JsonValue | undefined,
  path: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new GeminiProviderError(
      `${path} must be a non-negative finite number.`,
    );
  }
  return value;
}

function optionalStringArray(
  value: JsonValue | undefined,
  path: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireJsonArray(value, path).map((item, index) =>
    requireString(item, `${path}[${index}]`),
  );
}

function optionalNonNegativeNumber(value: JsonValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
