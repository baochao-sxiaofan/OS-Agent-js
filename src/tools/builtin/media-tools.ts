import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ArtifactStore } from '../../artifacts/artifact-store.js';
import { MODEL_IMAGE_MARKER, MODEL_VIDEO_MARKER } from '../../kernel/context.js';
import { MAX_IMAGE_BYTES, MAX_INLINE_MEDIA_BYTES, isVideo } from '../../model/media.js';
import type { OperationStore } from '../../persistence/operation-store.js';
import type { JsonObject, JsonValue } from '../../types/json.js';
import type { Tool, ToolExecutionContext } from '../tool.js';
import { WorkspaceResolver } from '../workspace-fs.js';

export const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
};

export type GeneratedMedia = { mimeType: string; dataBase64?: string; url?: string; fileId?: string; remoteTaskId?: string };
export type MediaGenerationContext = { signal: AbortSignal; idempotencyKey: string; operationStore: OperationStore };
export interface MediaGenerationPort {
  generate(kind: 'image' | 'video', input: JsonObject, context: MediaGenerationContext): Promise<GeneratedMedia>;
}

export const mediaReadTool: Tool = {
  name: 'media.read',
  description: 'Read an image or video from the workspace and attach its actual visual content to the next model request. Use this instead of file.read for binary media. Input: { path }.',
  effect: 'read_only',
  inputSchema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] },
  validateInput: (input) => typeof input['path'] === 'string' && input['path'].startsWith('workspace://current/') && MEDIA_EXTENSIONS[extname(input['path']).toLowerCase()] !== undefined
    ? { valid: true } : { valid: false, error: 'path must be a workspace image or video (PNG/JPEG/WebP/MP4/MOV/AVI/MKV).' },
  requiredCapabilities: (input) => [{ capability: 'file.read', scope: { kind: 'exact', resource: String(input['path']) } }],
  async execute(input, context): Promise<JsonValue> {
    if (!context.workspaceRoot) throw new Error('media.read requires a mounted workspace.');
    const resolver = await WorkspaceResolver.create(context.workspaceRoot);
    const path = await resolver.assertResolvedInsideRoot(resolver.toHostPath(String(input['path'])));
    const mimeType = MEDIA_EXTENSIONS[extname(String(input['path'])).toLowerCase()];
    if (!mimeType) throw new Error('Unsupported media format.');
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > (isVideo({ mimeType }) ? MAX_INLINE_MEDIA_BYTES : MAX_IMAGE_BYTES)) throw new Error('Media file exceeds the inline input limit.');
      context.signal.throwIfAborted();
      const bytes = await handle.readFile({ signal: context.signal });
      return { marker: isVideo({ mimeType }) ? MODEL_VIDEO_MARKER : MODEL_IMAGE_MARKER, mimeType, sourceName: String(input['path']), dataBase64: bytes.toString('base64') };
    } finally { await handle.close(); }
  },
};

export function createMediaGenerationTools(port: MediaGenerationPort, artifacts: ArtifactStore): Tool[] {
  return (['image', 'video'] as const).map((kind): Tool => ({
    name: `${kind}.generate`,
    description: kind === 'image'
      ? 'Generate one image with MiniMax image-01. Returns a persistent artifact displayed in the conversation. Uses the configured media subscription quota. Input: { prompt, aspectRatio? }.'
      : 'Generate a 6-second 768P video with MiniMax-Hailuo-2.3. Waits for the remote job, resumes it after restart, and returns a video artifact. Requires video entitlement in the configured plan. Input: { prompt }.',
    effect: 'side_effect',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      prompt: { type: 'string', minLength: 1, maxLength: kind === 'image' ? 1500 : 2000 },
      ...(kind === 'image' ? { aspectRatio: { type: 'string', enum: ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'] } } : {}),
    }, required: ['prompt'] },
    validateInput(input) {
      if (typeof input['prompt'] !== 'string' || !input['prompt'].trim() || input['prompt'].length > (kind === 'image' ? 1500 : 2000)) return { valid: false, error: 'prompt is empty or too long.' };
      if (input['aspectRatio'] !== undefined && (kind !== 'image' || !['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'].includes(String(input['aspectRatio'])))) return { valid: false, error: 'Unsupported aspect ratio.' };
      if (Object.keys(input).some((key) => !['prompt', ...(kind === 'image' ? ['aspectRatio'] : [])].includes(key))) return { valid: false, error: 'Unknown generation parameter.' };
      return { valid: true };
    },
    requiredCapabilities: () => [
      { capability: `media.${kind}.generate`, scope: { kind: 'all' } },
      { capability: 'artifact.write', scope: { kind: 'subtree', resource: 'artifact://task/' } },
    ],
    async execute(input, context: ToolExecutionContext): Promise<JsonValue> {
      if (!context.operationStore) throw new Error('Media generation requires an operation store for safe recovery.');
      const artifactKey = `media-artifact:${context.idempotencyKey}`;
      const fingerprint = createHash('sha256').update(JSON.stringify({ kind, input, taskId: context.taskId })).digest('hex');
      const previous = context.operationStore.get(artifactKey);
      if (previous) {
        if (previous['fingerprint'] !== fingerprint) throw new Error('Media artifact key was reused with different parameters.');
        return previous['result'] ?? null;
      }
      // 产物持久化和操作账本使用不同事务。
      // 再次调用 API 前，先对账并补齐产物已创建但账本尚未更新的状态。
      const existing = artifacts.list({ rootTaskId: context.rootTaskId ?? context.taskId, taskId: context.taskId, logicalName: artifactKey, limit: 1 })[0];
      if (existing) {
        if (existing.metadata['generationFingerprint'] !== fingerprint) throw new Error('Persisted media artifact parameters do not match.');
        const result = { artifactUri: existing.uri, mediaType: existing.mediaType, title: existing.title, status: 'completed' };
        context.operationStore.set(artifactKey, { fingerprint, result });
        return result;
      }
      const generated = await port.generate(kind, input, { signal: context.signal, idempotencyKey: context.idempotencyKey, operationStore: context.operationStore });
      const artifact = artifacts.create({
        taskId: context.taskId, rootTaskId: context.rootTaskId ?? context.taskId,
        ...(context.graphNodeAlias === undefined ? {} : { graphNodeAlias: context.graphNodeAlias }),
        kind: 'document', title: String(input['prompt']).slice(0, 100), mediaType: generated.mimeType,
        content: { ...generated }, metadata: { generatedBy: 'minimax', operationKey: context.idempotencyKey, generationFingerprint: fingerprint },
        logicalName: artifactKey,
      });
      const result: JsonObject = { artifactUri: artifact.uri, mediaType: artifact.mediaType, title: artifact.title, status: 'completed' };
      context.operationStore.set(artifactKey, { fingerprint, result });
      return result;
    },
  }));
}
