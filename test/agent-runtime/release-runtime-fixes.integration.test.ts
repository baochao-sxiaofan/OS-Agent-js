import { readRuntimeRequest } from '../../src/agent-runtime/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import {
  createAgentRuntime, defaultTokenSettings, type AgentRuntime, type AgentRuntimeOptions,
} from '../../src/agent-runtime/index.js';
import { estimateContextTokens, SqliteContextStore } from '../../src/agent-context/index.js';
import {
  ModelRequesterError, type ModelCompletion, type ModelCompletionRequest,
} from '../../src/model-requester/index.js';
import { defaultLimits, RequestAdmission, trackedRequester } from '../../src/agent-runtime/internal/limits.js';
import { RuntimeStore } from '../../src/agent-runtime/internal/store.js';
import { nativeMessage } from '../fixtures/native-message.js';
import { summary } from '../agent-context/helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'release-runtime-fixes-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

function open(options: AgentRuntimeOptions): AgentRuntime {
  const runtime = createAgentRuntime(options);
  cleanup.push(() => runtime.close());
  return runtime;
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 6000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('等待运行时修复验证超时。');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const agent = {
  ownerId: 'owner', workspaceId: 'work', character: 'coordinator', objective: '长期工作',
  capabilities: [], startMode: 'on_message' as const,
};
const finish = { kind: 'context', decision: { type: 'finish_turn' } };
const continued = { kind: 'context', decision: { type: 'continue' } };

function complete(action: object): ModelCompletion {
  return { provider: 'deepseek', model: 'fixture', finishReason: 'tool_calls',
    message: nativeMessage(action), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
}

function payload(request: ModelCompletionRequest): { currentBatch: { id: string }; previousError: string | null } {
  return readRuntimeRequest(request) as {
    currentBatch: { id: string }; previousError: string | null;
  };
}

type Budget = { key: string; used: number; allocation: number; closed: boolean };
function budget(database: string): Budget {
  const db = new DatabaseSync(database);
  try {
    const row = db.prepare("SELECT body FROM runtime_metadata WHERE id='work-budget:1'").get();
    return JSON.parse(String(row?.body)) as Budget;
  } finally { db.close(); }
}

function history(database: string): { id: string; request: ModelCompletionRequest; completion: ModelCompletion | null }[] {
  const db = new DatabaseSync(database);
  try {
    return db.prepare('SELECT id,request,completion FROM runtime_request_history ORDER BY sequence').all().map((row) => ({
      id: String(row.id), request: JSON.parse(String(row.request)) as ModelCompletionRequest,
      completion: JSON.parse(String(row.completion)) as ModelCompletion | null,
    }));
  } finally { db.close(); }
}

it.each(['permission', 'input'])('同步%s拒绝的结果轮累计原额度，重启和继续不扩大权限或清零累计用量', async (denial) => {
  const path = await directory();
  const requests: ModelCompletionRequest[] = [];
  const options: AgentRuntimeOptions = {
    database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    limits: { maxRounds: 1, inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
    conversationPolicy: { quietMs: 1, maxWaitMs: 1 },
    requester: { provider: 'deepseek', model: 'fixture', async request(request) {
      requests.push(request);
      return complete(requests.length <= 2 ? { kind: 'tools', calls: [{
        name: 'file.read', arguments: { path: denial === 'input' ? 42 : `workspace://current/denied-${requests.length}` },
      }] } : finish);
    } },
  };
  let runtime = open(options);
  await runtime.initialize();
  await runtime.createAgent({ ...agent, capabilities: denial === 'input'
    ? [{ capability: 'file.read', scope: { kind: 'subtree', resource: 'workspace://current/' } }] : [] });
  runtime.start();
  runtime.submit(1, 'owner', '处理同一工作', 'one-work');
  await until(() => runtime.inspect(1, 'owner').status === 'paused');
  await runtime.pause(1, 'owner');
  expect(requests).toHaveLength(1);
  expect(runtime.interrupts(1, 'owner').at(-1)?.kind).toBe('budget');
  expect(budget(options.database)).toMatchObject({ key: payload(requests[0]!).currentBatch.id, used: 1, closed: false });
  const grants = runtime.inspect(1, 'owner').grants;
  await runtime.close();
  runtime = open(options);
  await runtime.initialize();
  runtime.start();
  runtime.resume(1, 'owner');
  await until(() => runtime.inspect(1, 'owner').status === 'paused');
  await runtime.pause(1, 'owner');
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1])).toContain('permission_or_input_denied');
  expect(new Set(requests.map((request) => payload(request).currentBatch.id)).size).toBe(1);
  expect(runtime.inspect(1, 'owner')).toMatchObject({ totalTokens: 4, grants });
  expect(runtime.inspect(1, 'owner').costUsd).toBeCloseTo(0.000004, 12);
  expect(runtime.approvals(1, 'owner')).toEqual([]);
  runtime.resume(1, 'owner');
  await until(() => runtime.inspect(1, 'owner').control.state === 'SLEEPING');
  expect(requests).toHaveLength(3);
  expect(runtime.inspect(1, 'owner')).toMatchObject({ rounds: 3, totalTokens: 6, grants });
  expect(runtime.inspect(1, 'owner').costUsd).toBeCloseTo(0.000006, 12);
  expect(runtime.events(1, 'owner').filter((event) => event.type === 'work_budget_renewed')).toHaveLength(2);
  expect(budget(options.database)).toMatchObject({ used: 1, allocation: 3, closed: true });
});

it('旧版本误关闭的同一收件批次预算恢复时保留已用轮数', async () => {
  const path = await directory();
  let calls = 0;
  const options: AgentRuntimeOptions = {
    database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    limits: { maxRounds: 1 }, conversationPolicy: { quietMs: 1, maxWaitMs: 1 },
    requester: { provider: 'deepseek', model: 'fixture', async request() {
      calls++;
      return complete({ kind: 'tools', calls: [{ name: 'file.read', arguments: { path: 'workspace://current/no-grant' } }] });
    } },
  };
  let runtime = open(options);
  await runtime.initialize(); await runtime.createAgent(agent); runtime.start();
  runtime.submit(1, 'owner', '处理', 'legacy-work');
  await until(() => runtime.inspect(1, 'owner').status === 'paused');
  await runtime.close();
  const db = new DatabaseSync(options.database);
  try {
    const saved = budget(options.database);
    db.prepare("UPDATE runtime_metadata SET body=? WHERE id='work-budget:1'").run(JSON.stringify({ ...saved, closed: true }));
  } finally { db.close(); }
  runtime = open(options);
  await runtime.initialize(); runtime.start(); runtime.resume(1, 'owner');
  await until(() => runtime.inspect(1, 'owner').status === 'paused');
  expect(calls).toBe(1);
  expect(budget(options.database)).toMatchObject({ used: 1, closed: false });
  expect(runtime.interrupts(1, 'owner').at(-1)?.kind).toBe('budget');
});

it('循环中断重启后显式继续归档未执行动作，使用新回复并处理下一批来信', async () => {
  const path = await directory();
  const requests: ModelCompletionRequest[] = [];
  const replies: ModelCompletion[] = [];
  const options: AgentRuntimeOptions = {
    database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    limits: { repeatedActionLimit: 2 }, conversationPolicy: { quietMs: 1, maxWaitMs: 1 },
    requester: { provider: 'deepseek', model: 'fixture', async request(request) {
      requests.push(request);
      const response = complete(requests.length <= 2 ? continued : finish);
      replies.push(response);
      return response;
    } },
  };
  let runtime = open(options);
  await runtime.initialize(); await runtime.createAgent(agent); runtime.start();
  runtime.submit(1, 'owner', '原工作', 'loop-work');
  await until(() => runtime.inspect(1, 'owner').status === 'paused');
  expect(requests).toHaveLength(2);
  expect(runtime.interrupts(1, 'owner').at(-1)?.kind).toBe('loop');
  await runtime.close();
  runtime = open(options);
  await runtime.initialize(); runtime.start();
  expect(requests).toHaveLength(2);
  runtime.resume(1, 'owner');
  await until(() => runtime.inspect(1, 'owner').control.state === 'SLEEPING');
  expect(requests).toHaveLength(3);
  expect(payload(requests[2]!).previousError).toContain('重复动作');
  expect(new Set(requests.map((request) => payload(request).currentBatch.id)).size).toBe(1);
  expect(history(options.database)).toMatchObject([{ request: requests[1], completion: replies[1] }]);
  expect(runtime.inspect(1, 'owner').totalTokens).toBe(6);
  expect(runtime.events(1, 'owner').filter((event) => event.type === 'loop_retry_requested')).toHaveLength(1);
  runtime.submit(1, 'owner', '下一工作', 'after-loop');
  await until(() => requests.length === 4 && runtime.inspect(1, 'owner').control.state === 'SLEEPING');
  expect(payload(requests[3]!).currentBatch.id).not.toBe(payload(requests[0]!).currentBatch.id);
  expect(runtime.inspect(1, 'owner').status).toBe('active');
});

it.each([3, 4])('循环继续窗口仍有限，同一工作保留原轮数上限：%s', async (maxRounds) => {
  const path = await directory();
  let calls = 0;
  const runtime = open({
    database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    limits: { repeatedActionLimit: 2, maxRounds }, conversationPolicy: { quietMs: 1, maxWaitMs: 1 },
    requester: { provider: 'deepseek', model: 'fixture', async request() {
      calls++;
      return complete(continued);
    } },
  });
  await runtime.initialize(); await runtime.createAgent(agent); runtime.start();
  runtime.submit(1, 'owner', '不能空转', 'bounded-loop');
  await until(() => runtime.inspect(1, 'owner').status === 'paused');
  await runtime.pause(1, 'owner');
  expect(calls).toBe(2);
  runtime.resume(1, 'owner');
  runtime.resume(1, 'owner');
  await until(() => runtime.inspect(1, 'owner').status === 'paused');
  await runtime.pause(1, 'owner');
  expect(calls).toBe(maxRounds);
  expect(runtime.interrupts(1, 'owner').at(-1)?.kind).toBe(maxRounds === 3 ? 'budget' : 'loop');
  expect(runtime.events(1, 'owner').filter((event) => event.type === 'loop_retry_requested')).toHaveLength(1);
  expect(runtime.events(1, 'owner').filter((event) => event.type === 'work_budget_renewed')).toHaveLength(0);
  expect(runtime.inspect(1, 'owner').totalTokens).toBe(maxRounds * 2);
});

it('结束动作期间缓冲的宿主事件和排队批次仍属于原工作预算', async () => {
  const path = await directory();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const database = join(path, 'runtime.sqlite');
  const runtime = open({
    database, workspaces: { work: path }, limits: { maxRounds: 1 },
    conversationPolicy: { quietMs: 1, maxWaitMs: 1 },
    requester: { provider: 'deepseek', model: 'fixture', async request() {
      calls++;
      await gate;
      return complete(finish);
    } },
  });
  await runtime.initialize(); await runtime.createAgent(agent); runtime.start();
  runtime.submit(1, 'owner', '原工作', 'event-work');
  await until(() => calls === 1);
  runtime.provideFeedback(1, 'owner', '结束前仍有反馈需要处理', 'buffered');
  release();
  await until(() => runtime.inspect(1, 'owner').status === 'paused');
  expect(calls).toBe(1);
  expect(runtime.interrupts(1, 'owner').at(-1)?.kind).toBe('budget');
  expect(budget(database)).toMatchObject({ used: 1, closed: false });
  expect(runtime.conversationMailboxes(runtime.directConversation(1, 'owner').id, 'owner'))
    .toMatchObject([{ state: 'processing', processedSequence: 0 }]);
});

it.each([false, true])('HTTP402后缩减输出限额最终发送新额度，归档旧请求且保留累计预留，重启=%s', async (restart) => {
  const path = await directory();
  const requests: ModelCompletionRequest[] = [];
  const options: AgentRuntimeOptions = {
    database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    conversationPolicy: { quietMs: 1, maxWaitMs: 1 },
    requester: { provider: 'deepseek', model: 'fixture', async request(request) {
      requests.push(request);
      if (requests.length === 1) throw new ModelRequesterError('账户额度不足', {
        provider: 'deepseek', code: 'http_error', status: 402, retryable: false,
      });
      return complete(finish);
    } },
  };
  let runtime = open(options);
  await runtime.initialize(); await runtime.createAgent(agent); runtime.start();
  runtime.submit(1, 'owner', '保留工作', 'capacity-work');
  await until(() => runtime.inspect(1, 'owner').status === 'paused');
  await runtime.pause(1, 'owner');
  const previousTokens = runtime.inspect(1, 'owner').totalTokens;
  runtime.configureTokens({ ...defaultTokenSettings, maxOutputTokens: 4000 });
  if (restart) {
    await runtime.close(); runtime = open(options); await runtime.initialize(); runtime.start();
  }
  runtime.resume(1, 'owner');
  await until(() => runtime.inspect(1, 'owner').control.state === 'SLEEPING');
  expect(requests.map((request) => request.maxOutputTokens)).toEqual([32_768, 4000]);
  expect(runtime.tokenSettings().maxOutputTokens).toBe(4000);
  expect(history(options.database)).toMatchObject([{ request: requests[0], completion: null }]);
  expect(runtime.inspect(1, 'owner')).toMatchObject({ rounds: 2, totalTokens: previousTokens + 2 });
});

it.each(['output', 'request'])('最终prepare结果的%s超限在准入、扣额度和网络请求前拒绝', async (excess) => {
  const store = new RuntimeStore(':memory:');
  let calls = 0;
  const request: ModelCompletionRequest = { messages: [{ role: 'user', content: '本轮现场' }], maxOutputTokens: 10 };
  const limits = { ...defaultLimits, maxOutputTokens: 10, maxRequestTokens: estimateContextTokens(request) + 10 };
  const requester = trackedRequester({
    store, limits: () => limits, admission: new RequestAdmission(limits, store), batch: () => 'prepared',
    prepare: (input) => excess === 'output' ? { ...input, maxOutputTokens: 11 }
      : { ...input, messages: [...input.messages, { role: 'user', content: 'x'.repeat(1000) }] },
    agent: () => { throw new Error('超限请求不应读取或扣除Agent额度。'); },
    update: () => { throw new Error('超限请求不应更新累计额度。'); },
    requester: { provider: 'deepseek', model: 'fixture', async request() {
      calls++;
      return complete(finish);
    } },
  });
  try {
    await expect(requester.request(request)).rejects.toMatchObject({ kind: 'budget' });
    expect(calls).toBe(0);
    expect(store.metadata('admission')).toBeUndefined();
    expect(store.request('prepared')).toBeUndefined();
  } finally { store.close(); }
});

it('最终旧请求缺少输出限额时归档并显式发送当前宿主上限', async () => {
  const path = await directory();
  const runtime = open({
    database: join(path, 'identity.sqlite'), workspaces: { work: path },
    requester: { provider: 'deepseek', model: 'fixture', async request() { return complete(finish); } },
  });
  await runtime.initialize();
  let current = await runtime.createAgent(agent);
  const database = join(path, 'requests.sqlite');
  const store = new RuntimeStore(database);
  const saved: ModelCompletionRequest = { messages: [{ role: 'user', content: '旧请求' }] };
  const input: ModelCompletionRequest = { messages: [{ role: 'user', content: '当前请求' }] };
  const sent: ModelCompletionRequest[] = [];
  const limits = { ...defaultLimits, maxOutputTokens: 10 };
  const requester = trackedRequester({
    store, limits: () => limits, admission: new RequestAdmission(limits, store), batch: () => 'missing-output',
    agent: () => current, update: (value) => { current = value; },
    requester: { provider: 'deepseek', model: 'fixture', async request(request) {
      sent.push(request);
      return complete(finish);
    } },
  });
  try {
    store.putRequest('missing-output', saved);
    store.putMetadata('protocol-version:missing-output', 3);
    await requester.request(input);
    expect(sent).toEqual([{ ...input, maxOutputTokens: 10 }]);
    expect(store.request('missing-output')).toEqual(sent[0]);
    expect(history(database)).toMatchObject([{ request: saved, completion: null }]);
    expect(current.totalTokens).toBe(2);
  } finally { store.close(); }
});

it('总结多次准入等待不消耗总结尝试、工作轮数或累计额度，放行后仍完成原总结', async () => {
  const path = await directory();
  let calls = 0;
  const database = join(path, 'runtime.sqlite');
  const runtime = open({
    database, workspaces: { work: path },
    limits: { requestsPerMinute: 1, retryBaseMs: 1 },
    conversationPolicy: { quietMs: 1, maxWaitMs: 1 },
    requester: { provider: 'deepseek', model: 'fixture', async request(request) {
      calls++;
      const view = readRuntimeRequest(request) as { sourceRef?: string };
      return complete(view.sourceRef ? summary(view.sourceRef) : { kind: 'context', decision: { type: 'idle' } });
    } },
  });
  await runtime.initialize(); await runtime.createAgent(agent); runtime.start();
  runtime.submit(1, 'owner', '需要总结', 'admission-summary');
  await until(() => runtime.interrupts(1, 'owner').length > 0);
  const contexts = new SqliteContextStore(database);
  const db = new DatabaseSync(database);
  try {
    for (let index = 1; index <= 4; index++) {
      await runtime.pause(1, 'owner');
      const pending = contexts.load(runtime.inspect(1, 'owner').contextKey)?.pendingSummary;
      expect(pending).toMatchObject({ attempts: 0, lastError: null });
      expect(runtime.inspect(1, 'owner')).toMatchObject({ rounds: 1, totalTokens: 2 });
      expect(calls).toBe(1);
      if (index < 4) {
        const count = runtime.interrupts(1, 'owner').length;
        runtime.resume(1, 'owner');
        await until(() => runtime.interrupts(1, 'owner').length > count);
      }
    }
    db.prepare("UPDATE runtime_metadata SET body='[]' WHERE id='admission'").run();
    runtime.resume(1, 'owner');
    await until(() => runtime.inspect(1, 'owner').control.state === 'SLEEPING');
    expect(calls).toBe(2);
    expect(runtime.inspect(1, 'owner')).toMatchObject({ rounds: 2, totalTokens: 4 });
    expect(contexts.load(runtime.inspect(1, 'owner').contextKey)?.pendingSummary).toBeNull();
  } finally { db.close(); contexts.close(); }
});

it('发送钩子只在真实请求前调用，缓存重放不重复计数，钩子失败不扣工作额度', async () => {
  const path = await directory();
  const runtime = open({
    database: join(path, 'identity.sqlite'), workspaces: { work: path },
    requester: { provider: 'deepseek', model: 'fixture', async request() { return complete(finish); } },
  });
  await runtime.initialize();
  let current = await runtime.createAgent(agent);
  const store = new RuntimeStore(':memory:');
  const input: ModelCompletionRequest = { messages: [{ role: 'user', content: '当前请求' }], maxOutputTokens: 10 };
  let key = 'one';
  let hooks = 0;
  let calls = 0;
  const requester = trackedRequester({
    store, limits: () => defaultLimits, admission: new RequestAdmission(defaultLimits, store), batch: () => key,
    agent: () => current, update: (value) => { current = value; },
    requester: { provider: 'deepseek', model: 'fixture', async request() {
      calls++;
      expect(hooks).toBe(1);
      return complete(finish);
    } },
  });
  try {
    await requester.dispatchRequest(input, undefined, () => { hooks++; });
    await requester.dispatchRequest(input, undefined, () => { hooks++; });
    expect({ calls, hooks }).toEqual({ calls: 1, hooks: 1 });
    expect(current).toMatchObject({ rounds: 1, totalTokens: 2 });
    key = 'failed-hook';
    await expect(requester.dispatchRequest(input, undefined, () => {
      throw new Error('总结计数存储失败');
    })).rejects.toThrow('总结计数存储失败');
    expect(calls).toBe(1);
    expect(current).toMatchObject({ rounds: 1, totalTokens: 2 });
    expect(store.metadata('work-budget:1')).toMatchObject({ used: 1 });
  } finally { store.close(); }
});

it('内存Runtime在打开资源前明确拒绝，底层RuntimeStore内存用途不受影响', () => {
  let calls = 0;
  expect(() => createAgentRuntime({
    database: ':memory:', workspaces: { work: tmpdir() },
    requester: { provider: 'deepseek', model: 'fixture', async request() {
      calls++;
      return complete(finish);
    } },
  })).toThrow('Runtime 不支持 :memory: 数据库');
  expect(calls).toBe(0);
  const store = new RuntimeStore(':memory:');
  try {
    store.putMetadata('test', 1);
    expect(store.metadata('test')).toBe(1);
  } finally { store.close(); }
});
