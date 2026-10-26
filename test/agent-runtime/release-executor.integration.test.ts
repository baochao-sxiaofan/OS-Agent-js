import { readRuntimeRequest } from '../../src/agent-runtime/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createAgentRuntime, type AgentRuntimeOptions } from '../../src/agent-runtime/index.js';
import { CharacterRegistry } from '../../src/character/character-registry.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolExecutionError } from '../../src/tools/tool.js';
import { RuntimeStore } from '../../src/agent-runtime/internal/store.js';
import { restoreAgentContextManager, SqliteContextStore } from '../../src/agent-context/index.js';
import { AgentState, createAgentControlBlock } from '../../src/agent-control-block/index.js';
import { createAgentScheduler } from '../../src/agent-scheduler/index.js';
import { nativeMessage } from '../fixtures/native-message.js';
import { summary } from '../agent-context/helpers.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待执行集成结果超时。');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function options(directory: string, effect: 'read_only' | 'side_effect',
  execute: (argument: string) => Promise<import('../../src/types/json.js').JsonValue>): AgentRuntimeOptions {
  const tools = new ToolRegistry();
  tools.register({ name: 'test.operation', effect, description: '执行集成验证',
    requiredCapability: 'test.operation', validateInput: () => ({ valid: true }),
    execute: (input) => execute(String(input.value)) });
  const calls = new Map<number, number>();
  return {
    database: join(directory, 'runtime.sqlite'), workspaces: { work: directory }, tools,
    characters: new CharacterRegistry([{ id: 'test', displayName: '测试', promptFragment: '测试',
      visibleToolIds: ['test.operation'], capabilityCeiling: ['test.operation'],
      requestableCapabilities: [], allowedChildCharacters: [] }]),
    limits: { toolTimeoutMs: 300, requestsPerMinute: 100, tokensPerMinute: 5_000_000 },
    requester: { provider: 'deepseek', model: 'fixture', async request(request) {
      const payload = readRuntimeRequest(request) as { self?: { id: number }; sourceRef?: string };
      const id = payload.self?.id ?? 1;
      const count = (calls.get(id) ?? 0) + 1;
      if (!payload.sourceRef) calls.set(id, count);
      const action = payload.sourceRef ? summary(payload.sourceRef)
        : count === 1 ? { kind: 'tools', calls: [{ name: 'test.operation', arguments: { value: String(id) } }] }
        : { kind: 'context', decision: { type: 'finish_turn' } };
      return { provider: 'deepseek', model: 'fixture', finishReason: 'tool_calls', message: nativeMessage(action),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    } },
  };
}
const create = {
  ownerId: 'owner', workspaceId: 'work', character: 'test', objective: '实际执行',
  capabilities: [{ capability: 'test.operation', scope: { kind: 'all' as const } }],
};

it('超时等待结束后仍保持实际写锁，未确认副作用阻断其他 Agent 写入', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-write-lock-'));
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  const runtime = createAgentRuntime(options(directory, 'side_effect', async (value) => {
    started.push(value);
    if (value === '1') await gate;
    return { written: value };
  }));
  try {
    await runtime.initialize(); await runtime.createAgent(create); runtime.start();
    await until(() => runtime.inspect(1, 'owner').status === 'paused');
    const unknown = runtime.approvals(1, 'owner')[0]!;
    expect(() => runtime.reconcile(1, 'owner', unknown.operationId, { outcome: 'failed', result: {} }))
      .toThrow('仍在执行');
    await runtime.createAgent(create);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(started).toEqual(['1']);
    release();
    await until(() => runtime.inspect(2, 'owner').control.state === 'SLEEPING');
    expect(started).toEqual(['1']);
    runtime.reconcile(1, 'owner', unknown.operationId, { outcome: 'succeeded', result: { checked: true } });
    await runtime.createAgent(create);
    await until(() => started.includes('3'));
  } finally { release(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

it('明确远端读取错误持久为 failed，错误详情保留且不产生成功回执', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-remote-error-'));
  const configuration = options(directory, 'read_only', async () => {
    throw new ToolExecutionError('mcp_tool_failed', '远端工具失败。', { isError: true, detail: 'missing' });
  });
  const runtime = createAgentRuntime(configuration);
  try {
    await runtime.initialize(); await runtime.createAgent(create); runtime.start();
    await until(() => runtime.inspect(1, 'owner').control.state === 'SLEEPING');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(configuration.database, { readOnly: true });
    try {
      const row = db.prepare('SELECT body FROM runtime_operations').get()!;
      expect(JSON.parse(String(row.body))).toMatchObject({
        state: 'failed', result: { error: 'mcp_tool_failed', detail: { isError: true } },
      });
    } finally { db.close(); }
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

it('对账终态与待投递标记同事务保存，重启后补投确认事实至上下文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-reconciliation-'));
  const configuration = options(directory, 'side_effect', async () => { throw new Error('远端响应丢失'); });
  let runtime = createAgentRuntime(configuration);
  try {
    await runtime.initialize(); await runtime.createAgent(create); runtime.start();
    await until(() => runtime.inspect(1, 'owner').status === 'paused');
    const operationId = runtime.approvals(1, 'owner')[0]!.operationId;
    await runtime.close();
    const store = new RuntimeStore(configuration.database);
    const operation = store.operation(operationId)!;
    store.putReconciliation({ ...operation, state: 'succeeded', result: { recoveredEvidence: '确认原写入成功' } });
    store.close();
    const requests: string[] = [];
    const requester = configuration.requester;
    runtime = createAgentRuntime({ ...configuration, requester: { ...requester,
      async request(request, signal) { requests.push(JSON.stringify(request)); return requester.request(request, signal); },
    } });
    await runtime.initialize();
    expect(runtime.approvals(1, 'owner')).toEqual([]);
    runtime.resume(1, 'owner'); runtime.start();
    await until(() => runtime.inspect(1, 'owner').control.state === 'SLEEPING');
    expect(requests.join('\n')).toContain('recoveredEvidence');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(configuration.database, { readOnly: true });
    try {
      const row = db.prepare('SELECT body FROM runtime_metadata WHERE id=?').get(`reconciliation:${operationId}`);
      expect(z.boolean().parse(JSON.parse(String(row?.body)))).toBe(false);
    } finally { db.close(); }
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

it('满收件箱的对账保留可靠事件，重启仍就绪并在排空后确认', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-reconcile-backpressure-'));
  const budget = { maxTokens: 20_000, compactAtTokens: 15_000, targetTokens: 8000, maxTasks: 10 };
  const configuration: AgentRuntimeOptions = {
    ...options(directory, 'side_effect', async () => { throw new Error('响应丢失'); }),
    contextPolicy: { budgets: { 1: budget, 2: budget, 3: budget }, maxInbox: 1,
      maxDeliveryBytes: 30_000, maxSummaryAttempts: 3 },
  };
  let runtime = createAgentRuntime(configuration);
  try {
    await runtime.initialize(); await runtime.createAgent(create); runtime.start();
    await until(() => runtime.inspect(1, 'owner').status === 'paused');
    const id = runtime.approvals(1, 'owner')[0]!.operationId;
    runtime.provideFeedback(1, 'owner', '暂停期间的新资料', 'backpressure');
    expect(() => runtime.reconcile(1, 'owner', id, { outcome: 'failed', result: { confirmed: true } })).not.toThrow();
    await runtime.close();
    runtime = createAgentRuntime(configuration);
    await runtime.initialize();
    expect(runtime.isReady()).toBe(true);
    runtime.resume(1, 'owner'); runtime.start();
    await until(() => runtime.inspect(1, 'owner').control.state === 'SLEEPING');
    const db = new DatabaseSync(configuration.database, { readOnly: true });
    try {
      const row = db.prepare('SELECT body FROM runtime_metadata WHERE id=?').get(`reconciliation:${id}`);
      expect(JSON.parse(String(row?.body))).toBe(false);
    } finally { db.close(); }
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

it('恢复开始先隔离所有 Agent 的旧写入，早编号新写不能抢先执行', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-global-write-barrier-'));
  const started: string[] = [];
  const configuration = options(directory, 'side_effect', async (value) => { started.push(value); return {}; });
  let runtime = createAgentRuntime(configuration);
  try {
    await runtime.initialize();
    for (let index = 0; index < 8; index++) await runtime.createAgent({ ...create, startMode: 'on_message' });
    await runtime.close();
    const store = new RuntimeStore(configuration.database);
    const contexts = new SqliteContextStore(configuration.database);
    const scheduler = createAgentScheduler({}, store);
    try {
      for (const agentId of [1, 8]) {
        const agent = store.agent(agentId)!;
        const context = restoreAgentContextManager({ key: agent.contextKey, store: contexts });
        scheduler.register(createAgentControlBlock({ ...agent.control, state: AgentState.READY }, context));
        const run = scheduler.takeNextRun()!;
        const handle = scheduler.registerOperations(run, [{ operationId: `barrier:${agentId}`, timeoutMs: 30_000 }])[0]!;
        store.putOperation({
          id: `barrier:${agentId}`, agentId, batchId: run.batch.batchId, target: context.cursor(),
          toolName: 'test.operation', arguments: { value: String(agentId) },
          state: agentId === 1 ? 'registered' : 'running', effect: 'side_effect', result: null,
          schedulerOperation: handle.operation,
        });
        scheduler.finishRun(run, 'idle');
      }
    } finally { scheduler.close(); contexts.close(); store.close(); }
    runtime = createAgentRuntime(configuration);
    await runtime.initialize();
    expect(runtime.approvals(8, 'owner')[0]!.state).toBe('unknown');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual([]);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
