import { Buffer } from 'node:buffer';

import {
  ModelRequesterError,
  type ModelCompletion,
  type ModelCompletionRequest,
  type ModelRequester,
  type ModelRequesterOptions,
} from '../api.js';
import { decodeResponse, encodeRequest, isObject } from './minimax-codec.js';

const MAX_REQUEST_BYTES = 50 * 1024 * 1024;
const RETRYABLE_API_CODES = new Set([1000, 1001, 1002, 1024, 1033, 2045]);

export class MiniMaxRequester implements ModelRequester {
  readonly provider = 'minimax';
  readonly model: string;
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: Extract<ModelRequesterOptions, { provider: 'minimax' }>) {
    if (!options.apiKey?.trim() || !options.model?.trim()) {
      throw new ModelRequesterError('MiniMax API key and model must not be empty.', {
        provider: 'minimax', code: 'invalid_request',
      });
    }
    this.model = options.model.trim();
    this.#apiKey = options.apiKey.trim();
    this.#endpoint = `${(options.baseUrl ?? 'https://api.minimaxi.com/v1').replace(/\/+$/u, '')}/chat/completions`;
    this.#timeoutMs = options.timeoutMs ?? 180_000;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new ModelRequesterError('timeoutMs must be a positive integer.', {
        provider: 'minimax', code: 'invalid_request',
      });
    }
  }

  async request(request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    if (signal?.aborted) throw aborted('cancelled');
    let body: string;
    try {
      body = JSON.stringify(encodeRequest(request, this.model));
    } catch (error) {
      if (error instanceof ModelRequesterError) throw error;
      throw new ModelRequesterError('Request must contain valid, JSON-serializable model messages.', {
        provider: 'minimax', code: 'invalid_request',
      });
    }
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      throw new ModelRequesterError('MiniMax request exceeds the 50 MB transport limit.', {
        provider: 'minimax', code: 'invalid_request',
      });
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json' },
        body,
        signal: combined,
        redirect: 'error',
      });
      const text = await response.text();
      combined.throwIfAborted();
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        if (!response.ok) throw this.httpError(response);
        throw new ModelRequesterError(`MiniMax returned non-JSON HTTP content (status ${response.status}).`, {
          provider: 'minimax', code: 'invalid_response', status: response.status,
        });
      }
      if (!response.ok) throw this.httpError(response, value);
      this.assertSuccess(value, response);
      return decodeResponse(value, this.model);
    } catch (error) {
      if (signal?.aborted) throw aborted('cancelled');
      if (timeout.aborted) throw aborted('timeout');
      if (error instanceof ModelRequesterError) throw error;
      // 原生 fetch 错误可能包含请求头、URL 或凭据。
      throw new ModelRequesterError('MiniMax network request failed.', {
        provider: 'minimax', code: 'network_error', retryable: true,
      });
    }
  }

  private httpError(response: Response, body?: unknown): ModelRequesterError {
    const retryAfterMs = retryAfterMilliseconds(response.headers.get('retry-after'));
    const message = errorMessage(body);
    return new ModelRequesterError(
      `MiniMax request failed with HTTP status ${response.status}.${message ? ` ${this.redact(message)}` : ''}`,
      {
        provider: 'minimax', code: 'http_error', status: response.status,
        retryable: [408, 409, 425, 429].includes(response.status) || response.status >= 500,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    );
  }

  private assertSuccess(body: unknown, response: Response): void {
    if (!isObject(body)) return;
    const base = body['base_resp'];
    if (isObject(base) && typeof base['status_code'] === 'number' && base['status_code'] !== 0) {
      const code = base['status_code'];
      const retryAfterMs = retryAfterMilliseconds(response.headers.get('retry-after'));
      throw new ModelRequesterError(
        `MiniMax request failed (${code}): ${this.redact(errorMessage(body) ?? 'Unknown API error.')}`,
        {
          provider: 'minimax', code: 'provider_error', apiCode: code,
          status: response.status, retryable: RETRYABLE_API_CODES.has(code),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      );
    }
    if (body['error'] !== undefined && body['error'] !== null) {
      throw new ModelRequesterError(this.redact(errorMessage(body) ?? 'MiniMax returned an API error.'), {
        provider: 'minimax', code: 'provider_error', status: response.status,
      });
    }
  }

  private redact(message: string): string {
    return message.replaceAll(this.#apiKey, '[redacted]');
  }
}

function errorMessage(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const error = value['error'];
  if (isObject(error) && typeof error['message'] === 'string') return error['message'];
  const base = value['base_resp'];
  return isObject(base) && typeof base['status_msg'] === 'string' ? base['status_msg'] : undefined;
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}

function aborted(code: 'cancelled' | 'timeout'): ModelRequesterError {
  return new ModelRequesterError(
    code === 'cancelled' ? 'Model request was cancelled.' : 'Model request timed out.',
    { provider: 'minimax', code, retryable: code === 'timeout' },
  );
}
