import { readRuntimeRequest } from '../../src/agent-runtime/index.js';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { createAgentRuntime, type AgentRuntimeOptions } from '../../src/agent-runtime/index.js';
import type { ModelCompletionRequest } from '../../src/model-requester/index.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { fileCreateTool, fileWriteTool } from '../../src/tools/builtin/file-tools.js';
import { fileApplyPatchTool } from '../../src/tools/builtin/apply-patch-tool.js';
import { CharacterRegistry } from '../../src/character/character-registry.js';
import { summary } from '../agent-context/helpers.js';
import { nativeMessage } from '../fixtures/native-message.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'execution-recovery-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function until(check: () => boolean) {
  const end = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > end) throw new Error('等待超时。');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function response(action: object) {
  return { provider: 'minimax' as const, model: 'test', finishReason: 'stop' as const,
    message: nativeMessage(action),
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
}
function configuration(path: string, execute: () => Promise<import('../../src/types/json.js').JsonValue>,
  actions: object[] = [], toolName = 'test.write'): AgentRuntimeOptions {
  const tools = new ToolRegistry();
  tools.register({ name: toolName, description: '测试', effect: 'side_effect', requiredCapability: toolName,
    validateInput: () => ({ valid: true }), execute });
  return { database: join(path, 'runtime.sqlite'), workspaces: { work: path }, tools,
    characters: new CharacterRegistry([{
      id: 'test', displayName: '测试', promptFragment: '测试', visibleToolIds: [toolName],
      capabilityCeiling: [toolName], requestableCapabilities: [toolName], allowedChildCharacters: [],
    }]),
    requester: { provider: 'minimax', model: 'test', async request(request) {
      const ref = String(request.messages[0]?.content).includes('独立总结轮')
        ? (readRuntimeRequest(request) as { sourceRef: string }).sourceRef : null;
      return response(ref ? summary(ref) : actions.shift() ?? { kind: 'context', decision: { type: 'idle' } });
    } },
  };
}
const create = (toolName = 'test.write') => ({
  ownerId: 'owner', workspaceId: 'work', character: 'test', objective: '测试',
  capabilities: [{ capability: toolName, scope: { kind: 'all' as const } }],
});
const call = (name = 'test.write') => ({ kind: 'tools', calls: [{ name, arguments: {} }] });

it('副作用异常立即暂停；未知结果和对账结果分别留存，恢复后不再执行工具', async () => {
  const path = await directory();
  let effects = 0;
  const options = configuration(path, async () => { effects++; throw new Error('响应丢失'); }, [call()]);
  const requests: ModelCompletionRequest[] = [];
  const original = options.requester.request.bind(options.requester);
  const runtime = createAgentRuntime({ ...options, requester: { ...options.requester,
    async request(request, signal) { requests.push(request); return original(request, signal); },
  } });
  cleanup.push(() => runtime.close());
  await runtime.initialize(); const agent = await runtime.createAgent(create()); const id = agent.control.agentId;
  runtime.start();
  await until(() => runtime.inspect(id, 'owner').status === 'paused');
  const operation = runtime.approvals(id, 'owner')[0]!;
  expect(operation.state).toBe('unknown');
  expect(() => runtime.resume(id, 'owner')).toThrow('对账');
  runtime.reconcile(id, 'owner', operation.operationId, { outcome: 'succeeded', result: { confirmed: true } });
  runtime.resume(id, 'owner');
  await until(() => runtime.inspect(id, 'owner').control.state === 'SLEEPING');
  expect(effects).toBe(1);
  expect(JSON.stringify(requests)).toContain('confirmed');
});

it('文件不存在时反馈创建方式并继续，未执行写入的失败不要求对账', async () => {
  const path = await directory();
  const arguments_ = { path: 'workspace://current/chapter.md', content: '模型生成的章节' };
  const options = configuration(path, async () => ({}), [
    { kind: 'tools', calls: [{ name: 'file.write', arguments: arguments_ }] },
    { kind: 'tools', calls: [{ name: 'file.create', arguments: arguments_ }] },
  ]);
  const tools = new ToolRegistry();
  tools.register(fileCreateTool);
  tools.register(fileWriteTool);
  const requests: ModelCompletionRequest[] = [];
  const original = options.requester.request.bind(options.requester);
  const runtime = createAgentRuntime({ ...options, tools,
    characters: new CharacterRegistry([{
      id: 'test', displayName: '测试', promptFragment: '测试',
      visibleToolIds: ['file.write', 'file.create'], capabilityCeiling: ['file.write', 'file.create'],
      requestableCapabilities: [], allowedChildCharacters: [],
    }]),
    requester: { ...options.requester, async request(request, signal) {
      requests.push(request);
      return original(request, signal);
    } },
  });
  cleanup.push(() => runtime.close());
  await runtime.initialize();
  await runtime.createAgent({ ...create(), capabilities: ['file.write', 'file.create'].map((capability) => ({
    capability, scope: { kind: 'subtree' as const, resource: 'workspace://current/' },
  })) });
  runtime.start();
  await until(() => runtime.inspect(1, 'owner').control.state === 'SLEEPING');
  expect(runtime.inspect(1, 'owner').status).toBe('active');
  expect(runtime.approvals(1, 'owner')).toEqual([]);
  expect(await readFile(join(path, 'chapter.md'), 'utf8')).toBe(arguments_.content);
  expect(JSON.stringify(requests)).toContain('file_not_found');
  expect(JSON.stringify(requests)).toContain('inputArtifactRef');
  const db = new DatabaseSync(options.database);
  try {
    const rows = db.prepare('SELECT body FROM runtime_operations').all().map((row) =>
      JSON.parse(String(row.body)) as { toolName: string; state: string });
    expect(rows.find((row) => row.toolName === 'file.write')?.state).toBe('failed');
    expect(rows.find((row) => row.toolName === 'file.create')?.state).toBe('succeeded');
    const input = db.prepare("SELECT body FROM runtime_artifacts WHERE id LIKE '%/input'").get();
    expect(JSON.parse(String(input?.body))).toEqual(arguments_);
  } finally { db.close(); }
});

it.each([
  { find: '不存在的原句', code: 'patch_no_match' },
  { find: '重复', code: 'patch_ambiguous' },
])('补丁前置失败 $code 自动反馈，保留原稿且允许修正后继续', async ({ find, code }) => {
  const path = await directory();
  await writeFile(join(path, 'chapter.md'), '原标题\n重复\n重复\n', 'utf8');
  const failedArguments = { path: 'workspace://current/chapter.md', find, replace: '不应写入' };
  const options = configuration(path, async () => ({}), [
    { kind: 'tools', calls: [{ name: 'file.apply_patch', arguments: failedArguments }] },
    { kind: 'tools', calls: [{ name: 'file.apply_patch', arguments: {
      path: failedArguments.path, find: '原标题', replace: '作者修改后的标题',
    } }] },
  ]);
  const tools = new ToolRegistry();
  tools.register(fileApplyPatchTool);
  const requests: ModelCompletionRequest[] = [];
  const original = options.requester.request.bind(options.requester);
  const runtime = createAgentRuntime({ ...options, tools,
    characters: new CharacterRegistry([{
      id: 'test', displayName: '测试', promptFragment: '测试',
      visibleToolIds: ['file.apply_patch'], capabilityCeiling: ['file.write'],
      requestableCapabilities: [], allowedChildCharacters: [],
    }]),
    requester: { ...options.requester, async request(request, signal) {
      requests.push(request);
      return original(request, signal);
    } },
  });
  cleanup.push(() => runtime.close());
  await runtime.initialize();
  await runtime.createAgent({ ...create(), capabilities: [{
    capability: 'file.write', scope: { kind: 'subtree', resource: 'workspace://current/' },
  }] });
  runtime.start();
  await until(() => runtime.inspect(1, 'owner').control.state === 'SLEEPING');
  expect(runtime.inspect(1, 'owner').status).toBe('active');
  expect(runtime.approvals(1, 'owner')).toEqual([]);
  expect(await readFile(join(path, 'chapter.md'), 'utf8')).toBe('作者修改后的标题\n重复\n重复\n');
  expect(JSON.stringify(requests)).toContain(code);
  expect(JSON.stringify(requests)).toContain('inputArtifactRef');
  const db = new DatabaseSync(options.database);
  try {
    const rows = db.prepare('SELECT body FROM runtime_operations').all().map((row) =>
      JSON.parse(String(row.body)) as { state: string });
    expect(rows.map((row) => row.state)).toEqual(['failed', 'succeeded']);
    const input = db.prepare("SELECT body FROM runtime_artifacts WHERE id LIKE '%/input'").get();
    expect(JSON.parse(String(input?.body))).toEqual(failedArguments);
  } finally { db.close(); }
});

it('SIGKILL 后保留工具幂等键和原批次，未知副作用不自动重放', async () => {
  const path = await directory();
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/runtime-crash.ts', path],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
  try {
    await until(() => output.includes('EFFECT_WRITTEN'));
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
  } finally { child.kill('SIGKILL'); }
  const key = (await readFile(join(path, 'effects.txt'), 'utf8')).trim();
  let effects = 0;
  const runtime = createAgentRuntime(configuration(path, async () => { effects++; return {}; }));
  cleanup.push(() => runtime.close());
  await runtime.initialize();
  expect(runtime.inspect(1, 'owner').status).toBe('paused');
  const operation = runtime.approvals(1, 'owner')[0]!;
  expect(operation.operationId).toBe(key);
  runtime.start();
  runtime.reconcile(1, 'owner', key, { outcome: 'succeeded', result: { recovered: true } });
  runtime.resume(1, 'owner');
  await until(() => runtime.inspect(1, 'owner').control.state === 'SLEEPING');
  expect(effects).toBe(0);
  expect((await readFile(join(path, 'effects.txt'), 'utf8')).trim()).toBe(key);
});

it('审批超时后拒绝执行，取消不会签发授权', async () => {
  const path = await directory();
  let effects = 0;
  const runtime = createAgentRuntime({ ...configuration(path, async () => { effects++; return {}; },
    [call('git.push')], 'git.push'), limits: { toolTimeoutMs: 30 } });
  cleanup.push(() => runtime.close());
  await runtime.initialize(); const agent = await runtime.createAgent(create('git.push')); const id = agent.control.agentId;
  runtime.start();
  await until(() => runtime.approvals(id, 'owner').length > 0);
  const operationId = runtime.approvals(id, 'owner')[0]!.operationId;
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(() => runtime.approve(id, 'owner', operationId, true)).toThrow();
  await until(() => runtime.inspect(id, 'owner').control.state === 'SLEEPING');
  expect(effects).toBe(0);
  expect(runtime.inspect(id, 'owner').grants.every((grant) => grant.source.type !== 'human')).toBe(true);
});

it('工具忽略 signal 时仍可停机；排队写操作不在停机后启动', async () => {
  const path = await directory();
  let effects = 0;
  const runtime = createAgentRuntime(configuration(path, async () => { effects++; return new Promise(() => {}); },
    [{ kind: 'tools', calls: [{ name: 'test.write', arguments: {} }, { name: 'test.write', arguments: {} }] }]));
  cleanup.push(() => runtime.close());
  await runtime.initialize(); await runtime.createAgent(create()); runtime.start();
  await until(() => effects === 1);
  await runtime.close();
  expect(effects).toBe(1);
  expect(runtime.isReady()).toBe(false);
});

it('同一个数据库只允许一个 Runtime 进程占用，关闭后可以重新打开', async () => {
  const path = await directory();
  const options = configuration(path, async () => ({}));
  const first = createAgentRuntime(options);
  cleanup.push(() => first.close());
  expect(() => createAgentRuntime(options)).toThrow('占用');
  await first.close();
  const second = createAgentRuntime(options);
  cleanup.push(() => second.close());
  await second.initialize();
});

it('被协议拒绝的请求和回复保存在追加历史，修复不销毁原始证据', async () => {
  const path = await directory();
  const options = configuration(path, async () => ({}), [{ kind: 'invalid', evidence: 'original-reply' }]);
  const runtime = createAgentRuntime({ ...options, limits: { retryBaseMs: 5 } });
  cleanup.push(() => runtime.close());
  await runtime.initialize(); await runtime.createAgent(create()); runtime.start();
  await until(() => runtime.inspect(1, 'owner').control.state === 'SLEEPING');
  const db = new DatabaseSync(options.database);
  try {
    const rows = db.prepare('SELECT request,completion FROM runtime_request_history').all();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.completion)).toContain('original-reply');
    expect(String(rows[0]!.request)).toContain('messages');
  } finally { db.close(); }
});

it('普通协议重试耗尽后显式继续会归档错误响应并重开有限尝试', async () => {
  const path = await directory();
  let corrected = false;
  let requests = 0;
  const options = configuration(path, async () => ({}));
  const runtime = createAgentRuntime({ ...options, limits: { maxRetries: 1, retryBaseMs: 1 },
    requester: { provider: 'minimax', model: 'test', async request() {
      requests++;
      return response(corrected ? { kind: 'context', decision: { type: 'finish_turn' } }
        : { kind: 'context', decision: { type: 'complete', reason: '不允许的字段', summary: {} } });
    } },
  });
  cleanup.push(() => runtime.close());
  await runtime.initialize();
  const agent = await runtime.createAgent(create());
  const task = agent.control.context.level1.currentTask;
  runtime.start();
  await until(() => runtime.inspect(1, 'owner').status === 'paused');
  expect(requests).toBe(2);
  expect(runtime.inspect(1, 'owner').lastError).toContain('unrecognized_keys');
  corrected = true;
  runtime.resume(1, 'owner');
  await until(() => runtime.inspect(1, 'owner').control.state === 'SLEEPING');
  expect(requests).toBe(3);
  expect(runtime.inspect(1, 'owner').control.context.level1.currentTask).toEqual(task);
  const db = new DatabaseSync(options.database);
  try {
    const rejected = db.prepare('SELECT completion FROM runtime_request_history').all();
    expect(rejected).toHaveLength(2);
    expect(rejected.every((row) => String(row.completion).includes('不允许的字段'))).toBe(true);
  } finally { db.close(); }
});

it('恢复时拒绝旧父子 Agent 快照，不自动采用模型创建的身份且保留原数据', async () => {
  const path = await directory();
  const options = configuration(path, async () => ({}));
  const first = createAgentRuntime(options);
  await first.initialize(); await first.createAgent(create()); await first.close();
  const db = new DatabaseSync(options.database);
  const row = db.prepare('SELECT body FROM runtime_agents WHERE id=1').get()!;
  const saved = JSON.parse(String(row.body)) as { parentId: number | null };
  saved.parentId = 1;
  db.prepare('UPDATE runtime_agents SET body=? WHERE id=1').run(JSON.stringify(saved));
  db.close();
  const restored = createAgentRuntime(options);
  cleanup.push(() => restored.close());
  await expect(restored.initialize()).rejects.toThrow('旧版父子 Agent 快照');
  expect(restored.isReady()).toBe(false);
  const preserved = new DatabaseSync(options.database);
  try {
    expect(String(preserved.prepare('SELECT body FROM runtime_agents WHERE id=1').get()!.body))
      .toBe(JSON.stringify(saved));
  } finally { preserved.close(); }
});
