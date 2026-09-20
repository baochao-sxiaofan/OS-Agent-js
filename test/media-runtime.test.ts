import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AdmissionController, InMemoryArtifactStore, InMemoryOperationStore, InMemoryTaskStore, SqliteOperationStore,
  MiniMaxMediaProvider, MiniMaxModelProvider, TaskScheduler, ToolRegistry, TURN_SUMMARY_PROTOCOL,
  createMediaGenerationTools, createArtifactTools, directoryDeleteTool, fileApplyPatchTool, mediaReadTool,
  type ModelRequest,
} from '../src/index.js';
import { extractModelMedia, validateMediaAttachments } from '../src/model/media.js';
import { serializeContextItemForModel } from '../src/model/structured-agent-response.js';
import { miniMaxHistory } from '../src/model/minimax-history.js';
import { ResourceLockManager } from '../src/locks/resource-lock-manager.js';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=';
const request: ModelRequest = { taskId: 'private-task-id', goal: 'Inspect media.', context: [], tools: [], attempt: 1,
  summaryProtocol: TURN_SUMMARY_PROTOCOL, delegation: { canSpawnSubagents: false } };
const envelope = { action: 'final', output: 'done', turnSummary: { request: 'Inspect.', outcome: 'Done.' } };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('multimodal runtime', () => {
  it('attaches media arriving through the completion mailbox and removes binary bytes from text', () => {
    const context = [{ type: 'async_work_update' as const, generationId: 'generation', allFinished: true, pending: [], results: [{
      kind: 'tool' as const, workId: 'capture', label: 'capture', status: 'completed' as const, completedAt: 1,
      output: { marker: 'os-agent.image.v1', mimeType: 'image/png', dataBase64: pixel },
    }] }];
    expect(extractModelMedia(context)).toHaveLength(1);
    expect(JSON.stringify(serializeContextItemForModel(context[0]!))).not.toContain(pixel);
  });

  it('maps MOV to MiniMax video/mov and keeps base64 out of the text prompt', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(json({ choices: [{ message: { content: JSON.stringify(envelope) } }] }));
    const provider = new MiniMaxModelProvider({ apiKey: 'test-key', model: 'MiniMax-M3', fetchImplementation });
    await provider.invoke({ ...request, context: [{ type: 'user', content: 'Watch.', attachments: [{ id: 'movie', name: 'movie.mov', mimeType: 'video/quicktime', dataBase64: 'dmlkZW8=' }] }] }, new AbortController().signal);
    const body = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body));
    expect(body.messages[1].content[1]).toEqual({ type: 'video_url', video_url: { url: 'data:video/mov;base64,dmlkZW8=', fps: 1 } });
    expect(body.messages[1].content[0].text).not.toContain('dmlkZW8=');
    expect(JSON.stringify(body)).not.toContain(request.taskId);
    expect(provider.contextWindowTokens).toBe(1_048_576);
  });

  it('rejects non-vision MiniMax input without making an API call', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const provider = new MiniMaxModelProvider({ apiKey: 'test-key', model: 'MiniMax-M2.7', fetchImplementation });
    await expect(provider.invoke({ ...request, context: [{ type: 'user', content: 'Read.', attachments: [{ id: 'img', name: 'image.png', mimeType: 'image/png', dataBase64: pixel }] }] }, new AbortController().signal)).rejects.toThrow('MiniMax-M3');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('preserves native reasoning and exact tool-result IDs after a snapshot-style clone', () => {
    const message = { role: 'assistant', content: '', reasoning_details: [{ type: 'reasoning.text', text: 'provider-private-continuation' }],
      tool_calls: [{ id: 'native-7', type: 'function', function: { name: 'file.read', arguments: '{"path":"workspace://current/a"}' } }] };
    const context = structuredClone([{ type: 'provider_message' as const, providerId: 'minimax:MiniMax-M3', message },
      { type: 'async_work_update' as const, generationId: 'g', pending: [], allFinished: true, results: [{ kind: 'tool' as const, workId: 'native-7', label: 'read', status: 'completed' as const, completedAt: 1, output: { content: 'actual result' } }] }]);
    const messages = miniMaxHistory(context, 'minimax:MiniMax-M3');
    expect(messages[0]).toEqual(message);
    expect(messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'native-7', content: '{"content":"actual result"}' });
    expect(miniMaxHistory(context, 'another-provider')).toEqual([]);
    expect(JSON.stringify(serializeContextItemForModel(context[0]!))).not.toContain('provider-private-continuation');
  });

  it('rejects mixed control and business calls without executing either', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(json({ choices: [{ message: { tool_calls: [
      { id: 'control', function: { name: 'submit_agent_response', arguments: JSON.stringify(envelope) } },
      { id: 'write', function: { name: 'file.write', arguments: '{}' } },
    ] } }] }));
    const provider = new MiniMaxModelProvider({ apiKey: 'test-key', model: 'MiniMax-M3', fetchImplementation });
    await expect(provider.invoke(request, new AbortController().signal)).rejects.toThrow('mixed');
  });

  it('validates binary encoding and aggregate attachment limits', () => {
    const attachment = { id: 'one', name: 'image.png', mimeType: 'image/png', dataBase64: pixel };
    expect(validateMediaAttachments([attachment])).toHaveLength(1);
    expect(() => validateMediaAttachments([{ ...attachment, dataBase64: 'not base64!' }])).toThrow();
    expect(() => validateMediaAttachments(Array.from({ length: 5 }, () => attachment))).toThrow();
    for (const dataBase64 of ['=AAA', 'AA=A', 'AAAA=', 'A===']) {
      expect(() => validateMediaAttachments([{ ...attachment, dataBase64 }])).toThrow();
    }
    const large = Buffer.alloc(2 * 1024 * 1024).toString('base64');
    expect(validateMediaAttachments([{ ...attachment, mimeType: 'video/mp4', dataBase64: large }])[0]?.dataBase64).toBe(large);
  });

  it('reads workspace image bytes through media.read', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'os-agent-media-'));
    await writeFile(join(workspace, 'image.png'), Buffer.from(pixel, 'base64'));
    const result = await mediaReadTool.execute({ path: 'workspace://current/image.png' }, { workspaceRoot: workspace, taskId: 'task', idempotencyKey: 'read', signal: new AbortController().signal });
    expect(result).toMatchObject({ marker: 'os-agent.image.v1', dataBase64: pixel });
  });

  it('reconciles a patch when the file changed before completion was persisted', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'os-agent-replay-'));
    const path = join(workspace, 'value.txt');
    await writeFile(path, 'value=1');
    const store = new InMemoryOperationStore();
    const context = { workspaceRoot: workspace, taskId: 'task', idempotencyKey: 'patch', signal: new AbortController().signal, operationStore: store };
    const set = store.set.bind(store);
    vi.spyOn(store, 'set').mockImplementation((key, record) => { if (record['state'] === 'completed') throw new Error('simulated crash'); set(key, record); });
    const input = { path: 'workspace://current/value.txt', find: 'value=1', replace: 'value=10' };
    await expect(fileApplyPatchTool.execute(input, context)).rejects.toThrow('simulated crash');
    vi.mocked(store.set).mockImplementation(set);
    await fileApplyPatchTool.execute(input, context);
    await fileApplyPatchTool.execute(input, context);
    expect(await readFile(path, 'utf8')).toBe('value=10');
  });

  it('rejects normalized workspace-root deletion and locks the full deleted subtree', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'os-agent-root-'));
    await expect(directoryDeleteTool.execute({ path: 'workspace://current/.' }, { workspaceRoot: workspace, taskId: 't', idempotencyKey: 'd', signal: new AbortController().signal })).rejects.toThrow('root');
    const requirements = directoryDeleteTool.requiredCapabilities!({ path: 'workspace://current/src' });
    expect(requirements).toEqual([{ capability: 'directory.delete', scope: { kind: 'subtree', resource: 'workspace://current/src' } }]);
    const locks = new ResourceLockManager();
    const lease = await locks.acquire('a', [{ mode: 'exclusive', scope: { kind: 'subtree', resource: 'workspace://current/src' } }]);
    const abort = new AbortController();
    const waiting = locks.acquire('b', [{ mode: 'exclusive', scope: { kind: 'exact', resource: 'workspace://current/src/app.ts' } }], abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow('aborted');
    lease.close();
  });

  it('terminates a permanent authentication failure after one request', async () => {
    const invoke = vi.fn().mockRejectedValue(Object.assign(new Error('Invalid API key'), { status: 401 }));
    const scheduler = new TaskScheduler({ provider: { id: 'test', contextWindowTokens: 100_000, estimate: () => ({ inputTokens: 1, maxOutputTokens: 1, estimatedCostUsd: 0 }), invoke },
      tools: new ToolRegistry(), store: new InMemoryTaskStore(), admission: new AdmissionController({ maxConcurrentRequests: 1, requestsPerMinute: 10, tokensPerMinute: 1000 }) });
    const task = await scheduler.submit({ goal: 'fail', maxModelAttempts: 4096 });
    await scheduler.runUntilIdle();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(task.state.status).toBe('TERMINATED');
  });

  it('stores generated image artifacts without adding base64 to the tool result', async () => {
    const generate = vi.fn().mockResolvedValue({ mimeType: 'image/png', dataBase64: pixel });
    const store = new InMemoryArtifactStore();
    const tool = createMediaGenerationTools({ generate }, store)[0]!;
    const context = { taskId: 'root', idempotencyKey: 'image', signal: new AbortController().signal, operationStore: new InMemoryOperationStore() };
    const result = await tool.execute({ prompt: 'red square' }, context);
    expect(JSON.stringify(result)).not.toContain(pixel);
    await tool.execute({ prompt: 'red square' }, context);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(store.list({ rootTaskId: 'root' })[0]?.content).toMatchObject({ dataBase64: pixel });
    await expect(tool.execute({ prompt: 'different' }, context)).rejects.toThrow('different parameters');
    const read = createArtifactTools(store).find((entry) => entry.name === 'artifact.read')!;
    const output = await read.execute({ artifact: store.list({ rootTaskId: 'root' })[0]!.uri }, context);
    expect(extractModelMedia([{ type: 'tool_result', callId: 'read', toolName: read.name, output }])[0]?.dataBase64).toBe(pixel);
  });

  it('recovers an artifact persisted just before its operation result was lost', async () => {
    const generate = vi.fn().mockResolvedValue({ mimeType: 'image/png', dataBase64: pixel });
    const artifacts = new InMemoryArtifactStore();
    const operations = new InMemoryOperationStore();
    const tool = createMediaGenerationTools({ generate }, artifacts)[0]!;
    const context = { taskId: 'root', idempotencyKey: 'crash', signal: new AbortController().signal, operationStore: operations };
    const set = vi.spyOn(operations, 'set').mockImplementationOnce(() => { throw new Error('simulated crash'); });
    await expect(tool.execute({ prompt: 'red square' }, context)).rejects.toThrow('simulated crash');
    set.mockRestore();
    await tool.execute({ prompt: 'red square' }, context);
    expect(artifacts.list({ rootTaskId: 'root' })).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('persists operation intents across SQLite connections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'os-agent-ledger-'));
    const location = join(directory, 'operations.sqlite');
    const first = new SqliteOperationStore(location);
    first.set('video', { state: 'polling', remoteTaskId: 'remote-1' });
    first.close();
    const restored = new SqliteOperationStore(location);
    try { expect(restored.get('video')).toEqual({ state: 'polling', remoteTaskId: 'remote-1' }); }
    finally { restored.close(); }
  });

  it('caps transient failures and honors Retry-After without holding a provider lease', async () => {
    const invoke = vi.fn().mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 4000 }));
    const admission = new AdmissionController({ maxConcurrentRequests: 1, requestsPerMinute: 10, tokensPerMinute: 1000 });
    const wait = vi.fn(async () => undefined);
    const scheduler = new TaskScheduler({ provider: { id: 'test', contextWindowTokens: 100_000, estimate: () => ({ inputTokens: 1, maxOutputTokens: 1, estimatedCostUsd: 0 }), invoke },
      tools: new ToolRegistry(), store: new InMemoryTaskStore(), admission, wait });
    const task = await scheduler.submit({ goal: 'retry', maxModelAttempts: 4096 });
    await scheduler.runUntilIdle();
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toHaveLength(2);
    expect(wait).toHaveBeenNthCalledWith(1, 4000, expect.any(AbortSignal));
    expect(task.state.status).toBe('TERMINATED');
  });

  it('classifies HTTP 200 business errors and redacts echoed credentials', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(json({ base_resp: { status_code: 2056, status_msg: 'Quota test-key' } }));
    const provider = new MiniMaxModelProvider({ apiKey: 'test-key', model: 'MiniMax-M3', fetchImplementation });
    await expect(provider.invoke(request, new AbortController().signal)).rejects.toMatchObject({ retryable: false, apiCode: 2056, message: expect.not.stringContaining('test-key') });
  });

  it('resumes an existing remote video task and never submits it twice', async () => {
    const store = new InMemoryOperationStore();
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ task_id: 'remote-1' }))
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(json({ status: 'Success', file_id: 'file-1' }))
      .mockResolvedValueOnce(json({ file: { download_url: 'https://filecdn.minimax.chat/video.mp4' } }));
    const provider = new MiniMaxMediaProvider({ apiKey: 'test-key', fetchImplementation, pollIntervalMs: 1 });
    const context = { idempotencyKey: 'video-1', signal: new AbortController().signal, operationStore: store };
    await expect(provider.generate('video', { prompt: 'red cube' }, context)).rejects.toThrow('connection lost');
    const restoredProvider = new MiniMaxMediaProvider({ apiKey: 'test-key', fetchImplementation, pollIntervalMs: 1 });
    await expect(restoredProvider.generate('video', { prompt: 'red cube' }, context)).resolves.toMatchObject({ mimeType: 'video/mp4', remoteTaskId: 'remote-1' });
    expect(fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('does not resubmit an image request with an unknown billing outcome', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection lost'));
    const provider = new MiniMaxMediaProvider({ apiKey: 'test-key', fetchImplementation });
    const context = { idempotencyKey: 'image-1', signal: new AbortController().signal, operationStore: new InMemoryOperationStore() };
    await expect(provider.generate('image', { prompt: 'red square' }, context)).rejects.toThrow('connection lost');
    await expect(provider.generate('image', { prompt: 'red square' }, context)).rejects.toThrow('uncertain');
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});
