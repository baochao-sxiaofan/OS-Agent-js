/** 显式启用的真实服务验证，仅通过进程环境变量接收凭据。 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  AdmissionController, InMemoryOperationStore, InMemoryTaskStore, MiniMaxMediaProvider,
  MiniMaxModelProvider, TaskScheduler, ToolRegistry, TURN_SUMMARY_PROTOCOL,
  createWorkspaceCapabilityRequests, registerBuiltinTools, validateMediaAttachments,
  type MediaAttachment, type ModelRequest,
} from '../src/index.js';
import { MEDIA_EXTENSIONS } from '../src/tools/builtin/media-tools.js';

const key = process.env['MINIMAX_API_KEY']?.trim();
if (!key) throw new Error('Set MINIMAX_API_KEY in the environment; do not pass it as a command-line argument.');
const workspace = await mkdtemp(join(tmpdir(), 'os-agent-minimax-live-'));
const provider = new MiniMaxModelProvider({ apiKey: key, model: 'MiniMax-M3', maxOutputTokens: 8192 });
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15 * 60_000);
const report: Array<Record<string, string | number | boolean>> = [];
const log = (value: Record<string, string | number | boolean>) => {
  const sanitized = JSON.stringify(value).replaceAll(key, '[redacted]');
  report.push(JSON.parse(sanitized) as Record<string, string | number | boolean>);
  console.log(sanitized);
};
const request: ModelRequest = { taskId: 'host-only-smoke', goal: 'Return final output exactly pong.', context: [], tools: [],
  attempt: 1, summaryProtocol: TURN_SUMMARY_PROTOCOL, delegation: { canSpawnSubagents: false } };

try {
  if (!process.argv.includes('--media-only') && !process.argv.includes('--video-input-only')) {
  const ping = await provider.invoke(request, controller.signal);
  log({ check: 'M3 structured response', passed: ping.type === 'final', output: ping.type === 'final' ? String(ping.output) : ping.type });

  const tools = new ToolRegistry();
  registerBuiltinTools(tools);
  const scheduler = new TaskScheduler({ provider, tools, store: new InMemoryTaskStore(), operationStore: new InMemoryOperationStore(),
    coordinationMode: 'ai_graph', asyncWorkPolicy: { batchWindowMs: 50 }, workspaceRootResolver: () => workspace,
    admission: new AdmissionController({ maxConcurrentRequests: 1, requestsPerMinute: 25, tokensPerMinute: 200_000 }) });
  const task = await scheduler.submit({ goal: 'Use one self-assigned implement node, no subagents. Create workspace://current/result.txt with exactly hello-m3, then read it with file.read to verify. Finish with the read content.',
    characterId: 'coordinator', capabilities: createWorkspaceCapabilityRequests(), maxModelAttempts: 12 });
  log({ check: 'M3 graph and file tools', status: 'running' });
  await scheduler.run({ signal: controller.signal });
  const file = await readFile(join(workspace, 'result.txt'), 'utf8').catch(() => 'missing');
  log({ check: 'M3 graph and file tools', passed: task.state.status === 'TERMINATED' && task.state.termination.kind === 'completed' && file.trim() === 'hello-m3', attempts: task.modelAttempts, fileContent: file.slice(0, 100) });
  }

  // 传输验证使用固定的小型 PNG 即可；真实生成的媒体会在下方检查。
  const chunk = (type: string, data: Buffer) => {
    const name = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(pngCrc32(Buffer.concat([name, data])));
    return Buffer.concat([size, name, data, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(64 * (64 * 3 + 1));
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3] = 255;
  const pixel = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
  const describe = async (name: string, attachment: MediaAttachment) => {
    const response = await provider.invoke({ ...request, goal: 'Describe the visible colors or motion in one short sentence. Return final.',
      context: [{ type: 'user', content: 'Inspect this media.', attachments: [attachment] }] }, controller.signal);
    log({ check: name, passed: response.type === 'final', output: response.type === 'final' ? String(response.output).slice(0, 500) : response.type });
  };
  if (process.argv.includes('--video-input-only')) {
    const path = process.env['MINIMAX_VIDEO_FIXTURE'];
    if (!path) throw new Error('Set MINIMAX_VIDEO_FIXTURE to a local MP4/MOV/AVI/MKV test video.');
    const bytes = await readFile(path);
    const attachments = validateMediaAttachments([{ id: 'video', name: basename(path),
      mimeType: MEDIA_EXTENSIONS[extname(path).toLowerCase()], dataBase64: bytes.toString('base64') }]);
    await describe('M3 video input', attachments[0]!);
  } else {
    await describe('M3 image input', { id: 'fixture', name: 'fixture.png', mimeType: 'image/png', dataBase64: pixel });
  }

  if (process.argv.includes('--generate') && !process.argv.includes('--video-input-only')) {
    const media = new MiniMaxMediaProvider({ apiKey: key });
    const operationStore = new InMemoryOperationStore();
    for (const kind of ['image', 'video'] as const) {
      log({ check: `${kind} generation`, status: 'running' });
      try {
        const generated = await media.generate(kind, { prompt: kind === 'image'
          ? 'A single large red square centered on a plain white background, flat geometric illustration.'
          : 'A bright red cube slowly rotates on a plain white background. Static camera, simple geometry.' },
        { signal: controller.signal, idempotencyKey: `live-${kind}`, operationStore });
        log({ check: `${kind} generation`, passed: true, mimeType: generated.mimeType });
        if (generated.dataBase64) {
          await writeFile(join(workspace, 'generated-image.bin'), Buffer.from(generated.dataBase64, 'base64'));
          await describe('M3 generated image understanding', { id: 'generated', name: 'image', mimeType: generated.mimeType as 'image/png', dataBase64: generated.dataBase64 });
        }
        if (generated.url) {
          // 只获取服务生成的测试样本，不携带 Authorization 请求头。
          const response = await fetch(generated.url, { signal: controller.signal, redirect: 'error' });
          if (!response.ok) throw new Error(`Video fixture retrieval returned HTTP ${response.status}.`);
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > 36 * 1024 * 1024) throw new Error('Generated video exceeds the smoke fixture size limit.');
          await writeFile(join(workspace, 'generated-video.mp4'), bytes);
          await describe('M3 video input', { id: 'video', name: 'video.mp4', mimeType: 'video/mp4', dataBase64: bytes.toString('base64') });
        }
      } catch (error) {
        log({ check: `${kind} generation`, passed: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }
  }
} catch (error) {
  log({ check: 'live smoke', passed: false, error: error instanceof Error ? error.message : 'Unknown error' });
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await writeFile(join(workspace, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${join(workspace, 'report.json')}`);
  if (report.some((result) => result['passed'] === false)) process.exitCode = 1;
}

// 确保此可选冒烟验证兼容所有受支持的 Node 22 版本。
function pngCrc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
