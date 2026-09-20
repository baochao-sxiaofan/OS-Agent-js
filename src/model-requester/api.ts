import type { JsonObject, JsonValue } from '../types/json.js';

export type ModelVendor = 'minimax' | 'anthropic' | 'openai' | 'gemini';

export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'video'; url: string; fps?: number };

export type ModelToolCall = {
  id: string;
  name: string;
  arguments: JsonObject;
};

/**
 * Opaque, JSON-persistable vendor state for replaying an assistant turn.
 * Callers must preserve it unchanged, and must not interpret or edit data.
 * This is continuation data, not an authorization token.
 */
export type ModelContinuation = {
  provider: ModelVendor;
  model: string;
  data: JsonObject;
};

export type ModelAssistantMessage = {
  role: 'assistant';
  content: string;
  toolCalls: readonly ModelToolCall[];
  continuation?: ModelContinuation;
};

export type ModelMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | readonly ModelContentPart[] }
  | ModelAssistantMessage
  | { role: 'tool'; callId: string; content: JsonValue };

export type ModelToolDefinition = {
  name: string;
  description: string;
  parameters: JsonObject;
};

export type ModelCompletionRequest = {
  messages: readonly ModelMessage[];
  tools?: readonly ModelToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  maxOutputTokens?: number;
  temperature?: number;
};

export type ModelFinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter'
  | 'unknown';

export type ModelTokenUsage = {
  /** Missing usage fields are normalized to zero. No cost is inferred. */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type ModelCompletion = {
  id?: string;
  provider: ModelVendor;
  model: string;
  message: ModelAssistantMessage;
  finishReason: ModelFinishReason;
  usage: ModelTokenUsage;
};

export interface ModelRequester {
  readonly provider: ModelVendor;
  readonly model: string;
  /** One non-streaming request. No scheduling, retries or tool execution. */
  request(
    request: ModelCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ModelCompletion>;
}

type RequesterConnectionOptions = {
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
};

export type ModelRequesterOptions = RequesterConnectionOptions & (
  | { provider: 'minimax'; apiKey: string }
  | { provider: Exclude<ModelVendor, 'minimax'>; apiKey?: string }
);

export type ModelRequesterErrorCode =
  | 'invalid_request'
  | 'invalid_response'
  | 'http_error'
  | 'provider_error'
  | 'network_error'
  | 'cancelled'
  | 'timeout'
  | 'not_implemented';

export class ModelRequesterError extends Error {
  readonly code: ModelRequesterErrorCode;
  readonly provider: ModelVendor;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly apiCode: number | undefined;

  constructor(
    message: string,
    options: {
      code: ModelRequesterErrorCode;
      provider: ModelVendor;
      retryable?: boolean;
      status?: number;
      retryAfterMs?: number;
      apiCode?: number;
    },
  ) {
    super(message);
    this.name = 'ModelRequesterError';
    this.code = options.code;
    this.provider = options.provider;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.apiCode = options.apiCode;
  }
}
