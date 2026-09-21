import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { MediaGenerationPort, MediaGenerationContext, GeneratedMedia } from '../tools/builtin/media-tools.js';
import type { JsonObject, JsonValue } from '../types/json.js';

export type MiniMaxMediaProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

/** 图片和视频生成独立于 M3 文本与视觉接口。 */
export class MiniMaxMediaProvider implements MediaGenerationPort {
  readonly #key: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #pollIntervalMs: number;
  readonly #timeoutMs: number;
  constructor(options: MiniMaxMediaProviderOptions) {
    this.#key = options.apiKey.trim();
    if (!this.#key) throw new Error('MiniMax media API key is missing.');
    this.#baseUrl = (options.baseUrl ?? 'https://api.minimaxi.com/v1').replace(/\/+$/u, '');
    const url = new URL(this.#baseUrl);
    if (url.protocol !== 'https:' || !['api.minimaxi.com', 'api.minimax.cn', 'api.minimax.io'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('MiniMax media endpoint must be an official HTTPS API.');
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.#timeoutMs = options.timeoutMs ?? 600_000;
  }

  async generate(kind: 'image' | 'video', input: JsonObject, context: MediaGenerationContext): Promise<GeneratedMedia> {
    const key = `minimax-media:${context.idempotencyKey}`;
    const fingerprint = createHash('sha256').update(JSON.stringify({ kind, input, endpoint: this.#baseUrl })).digest('hex');
    let state = context.operationStore.get(key);
    if (state && state['fingerprint'] !== fingerprint) throw new Error('Generation idempotency key was reused with different parameters.');
    if (state?.['state'] === 'completed') return parseGeneratedMedia(state['result']);
    if (state?.['state'] === 'submitting') throw new Error('The previous media submission has an uncertain outcome. Check MiniMax task history before starting another generation; automatic resubmission was prevented.');
    if (state?.['state'] === 'failed') throw new Error(String(state['error']));
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(this.#timeoutMs)]);
    signal.throwIfAborted();
    if (!state) {
      state = { fingerprint, state: 'submitting', kind };
      context.operationStore.set(key, state);
      let response: JsonObject;
      try {
        response = await this.request(kind === 'image' ? 'image_generation' : 'video_generation', signal,
          kind === 'image'
            ? { model: 'image-01', prompt: input['prompt'] ?? '', aspect_ratio: input['aspectRatio'] ?? '1:1', response_format: 'base64', n: 1 }
            : { model: 'MiniMax-Hailuo-2.3', prompt: input['prompt'] ?? '', duration: 6, resolution: '768P' });
      } catch (error) {
        // 网络中断不能证明已提交的计费请求被服务端拒绝。
        if (error instanceof MiniMaxMediaApiError) context.operationStore.set(key, { ...state, state: 'failed', error: error.message });
        throw error;
      }
      if (kind === 'image') {
        const data = object(response['data'], 'image data');
        const images = data['image_base64'];
        if (!Array.isArray(images) || typeof images[0] !== 'string' || !images[0]) throw new Error('MiniMax returned no generated image (the request may have been filtered).');
        const encoded = images[0].replace(/^data:image\/[a-z]+;base64,/u, '');
        const bytes = Buffer.from(encoded, 'base64');
        const mimeType = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png'
          : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
          : bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : undefined;
        if (!mimeType || bytes.length > 10 * 1024 * 1024) throw new Error('MiniMax returned an unsupported or oversized image.');
        const result = { mimeType, dataBase64: encoded };
        context.operationStore.set(key, { ...state, state: 'completed', result });
        return result;
      }
      const remoteTaskId = string(response['task_id'], 'video task ID');
      state = { ...state, state: 'polling', remoteTaskId };
      context.operationStore.set(key, state);
    }
    const remoteTaskId = string(state['remoteTaskId'], 'persisted video task ID');
    for (;;) {
      signal.throwIfAborted();
      const response = await this.request(`query/video_generation?task_id=${encodeURIComponent(remoteTaskId)}`, signal);
      const status = string(response['status'], 'video status').toLowerCase();
      if (status === 'success') {
        const fileId = string(response['file_id'], 'video file ID');
        const metadata = await this.request(`files/retrieve?file_id=${encodeURIComponent(fileId)}`, signal);
        const file = object(metadata['file'], 'video file');
        const url = string(file['download_url'], 'video download URL');
        assertPublicHttpsUrl(url);
        const result = { mimeType: 'video/mp4', url, fileId, remoteTaskId };
        context.operationStore.set(key, { ...state, state: 'completed', result });
        return result;
      }
      if (status === 'fail' || status === 'failed') {
        const error = 'MiniMax video generation failed. Check the prompt and the video entitlement of your plan.';
        context.operationStore.set(key, { ...state, state: 'failed', error });
        throw new Error(error);
      }
      if (!['preparing', 'queueing', 'queued', 'processing', 'pending'].includes(status)) throw new Error(`Unknown MiniMax video status: ${status}`);
      await delay(this.#pollIntervalMs, undefined, { signal });
    }
  }

  private async request(path: string, signal: AbortSignal, payload?: JsonObject): Promise<JsonObject> {
    const response = await this.#fetch(`${this.#baseUrl}/${path}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.#key}`, 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]), redirect: 'error',
    });
    if (response.headers.get('content-length') && Number(response.headers.get('content-length')) > 16 * 1024 * 1024) throw new Error('MiniMax media response exceeds the size limit.');
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.length;
          if (length > 16 * 1024 * 1024) { await reader.cancel(); throw new Error('MiniMax media response exceeds the size limit.'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
    }
    let body: JsonObject;
    try { body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonValue, 'response'); }
    catch { throw new Error(`MiniMax returned invalid JSON (HTTP ${response.status}).`); }
    const base = body['base_resp'];
    const code = base && typeof base === 'object' && !Array.isArray(base) ? base['status_code'] : 0;
    if (!response.ok || (typeof code === 'number' && code !== 0)) {
      const message = base && typeof base === 'object' && !Array.isArray(base) ? base['status_msg'] : undefined;
      throw new MiniMaxMediaApiError(`MiniMax media API rejected the request (HTTP ${response.status}, code ${String(code)}): ${typeof message === 'string' ? message.replaceAll(this.#key, '[redacted]') : 'Check credentials, plan entitlement, and remaining quota.'}`);
    }
    return body;
  }
}

class MiniMaxMediaApiError extends Error {}
function object(value: JsonValue | undefined, name: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}.`);
  return value;
}
function string(value: JsonValue | undefined, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${name}.`);
  return value;
}
function parseGeneratedMedia(value: JsonValue | undefined): GeneratedMedia {
  const record = object(value, 'stored media result');
  const mimeType = string(record['mimeType'], 'media type');
  if (typeof record['dataBase64'] === 'string') return { mimeType, dataBase64: record['dataBase64'] };
  const url = string(record['url'], 'media URL');
  assertPublicHttpsUrl(url);
  return { mimeType, url,
    ...(typeof record['remoteTaskId'] === 'string' ? { remoteTaskId: record['remoteTaskId'] } : {}),
    ...(typeof record['fileId'] === 'string' ? { fileId: record['fileId'] } : {}),
  };
}
function assertPublicHttpsUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password ||
      !['minimax.chat', 'minimax.io', 'minimaxi.com', 'minimax.cn'].some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) throw new Error('MiniMax returned an untrusted media URL.');
}
