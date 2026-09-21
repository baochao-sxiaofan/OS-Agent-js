import { Buffer } from 'node:buffer';

import {
  MODEL_IMAGE_MARKER, MODEL_VIDEO_MARKER,
  type ContextItem, type MediaAttachment,
} from '../kernel/context.js';
import type { JsonObject, JsonValue } from '../types/json.js';

export const MEDIA_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp',
  'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
] as const;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
// 计入 base64 编码膨胀后，内联请求仍须低于文档规定的传输上限。
export const MAX_INLINE_MEDIA_BYTES = 36 * 1024 * 1024;

export type ModelMediaInput = Pick<MediaAttachment, 'name' | 'mimeType' | 'dataBase64'>;

export function isVideo(media: { mimeType: string }): boolean {
  return media.mimeType.startsWith('video/');
}

export function validateMediaAttachments(value: unknown): MediaAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new Error('最多添加 4 个图片或视频附件。');
  let bytes = 0;
  const result = value.map((item: unknown): MediaAttachment => {
    if (!item || typeof item !== 'object') throw new Error('无效的媒体附件。');
    const candidate = item as Record<string, unknown>;
    if (typeof candidate['id'] !== 'string' || typeof candidate['name'] !== 'string' ||
        !MEDIA_MIME_TYPES.includes(candidate['mimeType'] as MediaAttachment['mimeType']) ||
        typeof candidate['dataBase64'] !== 'string') throw new Error('不支持的媒体附件格式。');
    const encoded = candidate['dataBase64'];
    const mimeType = candidate['mimeType'] as MediaAttachment['mimeType'];
    const maxBytes = isVideo({ mimeType }) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    // 对数兆字节的 base64 使用重复捕获组可能使 V8 正则栈溢出。
    // 因此无回溯地扫描字符集，再单独检查填充。
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    if (!encoded || encoded.length > Math.ceil(maxBytes / 3) * 4 || encoded.length % 4 !== 0 ||
        /[^A-Za-z0-9+/]/u.test(encoded.slice(0, encoded.length - padding))) {
      throw new Error('媒体内容为空、编码无效或文件过大。');
    }
    const length = Buffer.byteLength(encoded, 'base64');
    if (length > maxBytes) throw new Error('图片不能超过 10 MB，视频不能超过 50 MB。');
    bytes += length;
    return { id: candidate['id'], name: candidate['name'], mimeType, dataBase64: encoded };
  });
  if (bytes > MAX_INLINE_MEDIA_BYTES) throw new Error('本轮媒体附件合计不能超过 36 MB，请缩短或压缩视频。');
  return result;
}

export function mediaFromOutput(value: JsonValue | undefined): ModelMediaInput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if ((value['marker'] !== MODEL_IMAGE_MARKER && value['marker'] !== MODEL_VIDEO_MARKER) ||
      !MEDIA_MIME_TYPES.includes(value['mimeType'] as MediaAttachment['mimeType']) ||
      typeof value['dataBase64'] !== 'string') return undefined;
  return {
    mimeType: value['mimeType'] as MediaAttachment['mimeType'],
    dataBase64: value['dataBase64'],
    name: typeof value['sourceName'] === 'string' ? value['sourceName'] : 'tool-media',
  };
}

/** 同时检查完成邮箱中的结果：当前工具通过 async_work_update 返回完成信息。 */
export function extractModelMedia(context: readonly ContextItem[]): ModelMediaInput[] {
  const media: ModelMediaInput[] = [];
  for (const item of context) {
    if (item.type === 'user') media.push(...(item.attachments ?? []).map(({ name, mimeType, dataBase64 }) => ({ name, mimeType, dataBase64 })));
    const outputs = item.type === 'tool_result' ? [item.output]
      : item.type === 'async_work_update' ? item.results.map((result) => result.output) : [];
    for (const output of outputs) {
      const entry = mediaFromOutput(output);
      if (entry) media.push(entry);
    }
  }
  return media;
}

export function redactMediaOutput(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactMediaOutput);
  if (!value || typeof value !== 'object') return value;
  const output: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'dataBase64') output[key] = redactMediaOutput(child);
  }
  if ('dataBase64' in value) output['mediaAttachedSeparately'] = true;
  return output;
}

export function rejectUnsupportedVideo(context: readonly ContextItem[], provider: string): void {
  if (extractModelMedia(context).some(isVideo)) {
    throw Object.assign(new Error(`${provider} 的当前适配器不支持视频输入，请选择 MiniMax M3 或 Gemini。`), { retryable: false });
  }
}
