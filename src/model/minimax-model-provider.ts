import {
  createModelRequester,
  ModelRequesterError,
  type ModelCompletion,
  type ModelCompletionRequest,
  type ModelRequester,
} from '../model-requester/index.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelRequestEstimate,
  ModelResponse,
  ModelUsage,
} from './model-provider.js';
import {
  buildAgentResponseJsonSchema,
  buildStructuredAgentSystemInstruction,
  estimateModelInputTokens,
  parseStructuredAgentResponse,
  serializeContextItemForModel,
} from './structured-agent-response.js';
import { extractModelMedia, isVideo } from './media.js';
import { miniMaxModelHistory, storeModelMessage } from './minimax-history.js';

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
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'MiniMaxProviderError';
  }
}

/**
 * Compatibility facade for the existing Agent runtime. It owns OS-Agent
 * prompts and action interpretation, and calls only the requester's public API.
 */
export class MiniMaxModelProvider implements ModelProvider {
  readonly id: string;
  readonly contextWindowTokens: number;
  readonly #requester: ModelRequester;
  readonly #maxOutputTokens: number | undefined;

  constructor(options: MiniMaxModelProviderOptions) {
    this.#requester = createModelRequester({ ...options, provider: 'minimax' });
    if (options.maxOutputTokens !== undefined &&
        (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0)) {
      throw new Error('MiniMax maxOutputTokens must be a positive integer.');
    }
    this.#maxOutputTokens = options.maxOutputTokens;
    this.contextWindowTokens = options.contextWindowTokens ??
      (/^MiniMax-M3(?:$|-)/iu.test(this.#requester.model) ? 1_048_576 : 204_800);
    this.id = `minimax:${this.#requester.model}`;
  }

  estimate(request: ModelRequest): ModelRequestEstimate {
    return {
      inputTokens: estimateModelInputTokens(request),
      maxOutputTokens: this.#maxOutputTokens ?? 0,
      estimatedCostUsd: 0,
    };
  }

  async invoke(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    let completion: ModelCompletion;
    try {
      completion = await this.#requester.request(this.buildRequest(request), signal);
    } catch (error) {
      if (!(error instanceof ModelRequesterError)) throw error;
      throw Object.assign(new MiniMaxProviderError(error.message, error.status, error.retryAfterMs), {
        code: error.code, retryable: error.retryable, apiCode: error.apiCode,
      });
    }
    const { message } = completion;
    const usage: ModelUsage = {
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
      costUsd: 0,
    };
    const diagnostics = [
      `finishReason=${completion.finishReason}`,
      `contentLength=${message.content.length}`,
      `reasoningPresent=${String(message.continuation !== undefined)}`,
      `toolCallCount=${message.toolCalls.length}`,
    ].join(', ');
    if (completion.finishReason === 'length') {
      throw Object.assign(new MiniMaxProviderError(
        `MiniMax output reached the token limit; no action was executed. (${diagnostics})`,
      ), { retryable: false });
    }
    if (completion.finishReason === 'content_filter') {
      throw Object.assign(new MiniMaxProviderError('MiniMax output was filtered; no action was executed.'), { retryable: false });
    }
    const withHistory = (response: ModelResponse): ModelResponse => ({
      ...response,
      providerMessage: { providerId: this.id, message: storeModelMessage(message) },
    });
    const controlCalls = message.toolCalls.filter((call) => call.name === AGENT_RESPONSE_TOOL_NAME);
    if (controlCalls.length > 1) {
      throw new MiniMaxProviderError(`MiniMax called ${AGENT_RESPONSE_TOOL_NAME} more than once.`);
    }
    const control = controlCalls[0];
    if (control !== undefined) {
      if (message.toolCalls.length !== 1) {
        throw new MiniMaxProviderError('MiniMax mixed a control action with business tools; no action was executed.');
      }
      return withHistory(parseAgentResponse(JSON.stringify(control.arguments), request, usage, diagnostics));
    }
    if (message.toolCalls.length > 0) {
      const visibleNames = new Set(request.tools.map((tool) => tool.name));
      const calls = message.toolCalls.map((call) => {
        if (!visibleNames.has(call.name)) {
          throw new MiniMaxProviderError(`MiniMax called an unavailable tool: ${call.name}.`);
        }
        return { callId: call.id, toolName: call.name, input: call.arguments };
      });
      return withHistory(parseAgentResponse(JSON.stringify({
        action: 'tool_calls',
        calls,
        turnSummary: {
          request: request.goal.slice(0, 200) || 'Execute the assigned work.',
          outcome: `Invoked workspace tools: ${calls.map((call) => call.toolName).join(', ')}.`,
        },
      }), request, usage, diagnostics));
    }
    if (!message.content.trim()) {
      throw new MiniMaxProviderError(`MiniMax returned no OS-Agent action (${diagnostics}).`);
    }
    return withHistory(parseAgentResponse(
      extractStructuredJson(stripThinkingBlock(message.content)), request, usage, diagnostics,
    ));
  }

  private buildRequest(request: ModelRequest): ModelCompletionRequest {
    const textPayload = JSON.stringify({
      goal: request.goal,
      ...(request.character === undefined ? {} : { character: request.character }),
      capabilities: request.capabilities ?? [],
      attempt: request.attempt,
      context: request.context.map(serializeContextItemForModel),
      tools: request.tools,
      delegation: request.delegation,
      ...(request.graph === undefined ? {} : { graph: request.graph }),
    });
    const media = extractModelMedia(request.context);
    const history = miniMaxModelHistory(request.context, this.id, this.#requester.model);
    return {
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
        ...(history.length === 0 ? [] : [{ role: 'user' as const, content: request.goal }, ...history]),
        {
          role: 'user',
          content: media.length === 0 ? textPayload : [
            { type: 'text', text: textPayload },
            ...media.map((item) => ({
              type: isVideo(item) ? 'video' as const : 'image' as const,
              url: `data:${item.mimeType};base64,${item.dataBase64}`,
            })),
          ],
        },
      ],
      tools: [
        {
          name: AGENT_RESPONSE_TOOL_NAME,
          description: 'Submit exactly one complete OS-Agent control action allowed by this turn schema.',
          parameters: buildAgentResponseJsonSchema(request),
        },
        ...request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema ?? { type: 'object', additionalProperties: true },
        })),
      ],
      toolChoice: 'required',
      ...(this.#maxOutputTokens === undefined ? {} : { maxOutputTokens: this.#maxOutputTokens }),
      ...(request.preferences?.temperature === undefined ? {} : { temperature: request.preferences.temperature }),
    };
  }
}

function parseAgentResponse(text: string, request: ModelRequest, usage: ModelUsage, diagnostics: string): ModelResponse {
  try {
    return parseStructuredAgentResponse(normalizeControlEnvelope(text, request), request, usage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MiniMaxProviderError(`MiniMax returned an invalid OS-Agent action (${diagnostics}): ${message}`);
  }
}

/** Repair summary formatting only; action/graph/capability semantics stay strict. */
function normalizeControlEnvelope(text: string, request: ModelRequest): string {
  let parsed: JsonValue;
  try { parsed = JSON.parse(text) as JsonValue; } catch { return text; }
  if (!isObject(parsed)) return text;
  const summary = parsed['turnSummary'];
  if (typeof summary === 'string') {
    parsed['turnSummary'] = {
      request: request.goal.slice(0, 200) || 'Continue the assigned work.',
      outcome: summary.slice(0, 400),
    };
  } else if (!isObject(summary)) {
    parsed['turnSummary'] = {
      request: request.goal.slice(0, 200) || 'Continue the assigned work.',
      outcome: typeof parsed['action'] === 'string' ? `Returned ${parsed['action']}.` : 'Returned an OS-Agent action.',
    };
  }
  return JSON.stringify(parsed);
}

function stripThinkingBlock(text: string): string {
  let remaining = text.trim();
  while (true) {
    const match = /^<think>[\s\S]*?<\/think>\s*/iu.exec(remaining);
    if (!match) return remaining;
    remaining = remaining.slice(match[0].length).trimStart();
  }
}

/** Recover a structured action from fenced JSON or surrounding prose. */
function extractStructuredJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/iu.exec(trimmed);
  if (fenced?.[1] !== undefined) return fenced[1].trim();
  if (trimmed.startsWith('{')) return trimmed;
  return extractFirstJsonObject(trimmed) ?? trimmed;
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
