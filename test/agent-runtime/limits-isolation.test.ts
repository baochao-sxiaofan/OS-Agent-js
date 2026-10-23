import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { createAgentRuntime, type AgentRuntimeOptions } from '../../src/agent-runtime/index.js';
import { createAgentServer } from '../../src/server/index.js';
import { createModelRequester, type ModelCompletionRequest } from '../../src/model-requester/index.js';
import { summary } from '../agent-context/helpers.js';
import { nativeMessage } from '../fixtures/native-message.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function options(work: (request: ModelCompletionRequest) => object): Promise<AgentRuntimeOptions> {
  const path = await mkdtemp(join(tmpdir(), 'limits-isolation-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return { database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    requester: { provider: 'minimax', model: 'test', async request(request) {
      const ref = String(request.messages[0]?.content).includes('独立总结轮')
        ? (JSON.parse(String(request.messages[1]?.content)) as { sourceRef: string }).sourceRef : null;
      return { provider: 'minimax', model: 'test', finishReason: 'stop',
        message: nativeMessage(ref ? summary(ref) : work(request)),
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
    } },
  };
}
async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error('等待超时。');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const agent = { ownerId: 'owner', workspaceId: 'work', character: 'coordinator', objective: '任务', capabilities: [] };
const idle = { kind: 'context', decision: { type: 'idle' } };

it.each([
  { maxRounds: 1 }, { maxTotalTokens: 1 }, { maxCostUsd: 0, inputUsdPerMillion: 1 },
])('累计资源上限在请求前阻断，包括总结轮：%j', async (limits) => {
  let calls = 0;
  const config = await options(() => { calls++; return idle; });
  const runtime = createAgentRuntime({ ...config, limits });
  cleanup.push(() => runtime.close());
  await runtime.initialize(); const created = await runtime.createAgent(agent); const id = created.control.agentId;
  runtime.start();
  await until(() => runtime.inspect(id, 'owner').status === 'paused');
  expect(runtime.interrupts(id, 'owner').at(-1)?.kind).toBe('budget');
  expect(calls).toBe('maxRounds' in limits ? 1 : 0);
});

it('MiniMax HTTP429业务码2056只请求一次，暂停并明确提示额度耗尽', async () => {
  let calls = 0;
  const config = await options(() => idle);
  const requester = createModelRequester({ provider: 'minimax', model: 'test', apiKey: 'fake-quota-test-key',
    fetchImplementation: async () => {
      calls++;
      return new Response(JSON.stringify({
        error: { message: '已达到 Token Plan 用量上限：请升级或补充积分。 (2056)' },
      }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '4' } });
    } });
  const runtime = createAgentRuntime({ ...config, requester });
  cleanup.push(() => runtime.close());
  await runtime.initialize(); await runtime.createAgent(agent);
  runtime.start();
  await until(() => runtime.inspect(1, 'owner').status === 'paused');
  expect(calls).toBe(1);
  expect(runtime.inspect(1, 'owner').lastError).toContain('API 2056');
  expect(runtime.inspect(1, 'owner').lastError).toContain('额度已用尽');
  expect(runtime.interrupts(1, 'owner').every((interrupt) => interrupt.action !== 'retry')).toBe(true);
});

it('普通业务和总结共享 RPM，耗尽后持久退避而不再请求', async () => {
  let calls = 0;
  const config = await options(() => { calls++; return idle; });
  const runtime = createAgentRuntime({ ...config, limits: { requestsPerMinute: 1 } });
  cleanup.push(() => runtime.close());
  await runtime.initialize(); const created = await runtime.createAgent(agent); const id = created.control.agentId;
  runtime.start();
  await until(() => runtime.interrupts(id, 'owner').length > 0);
  expect(calls).toBe(1);
  expect(runtime.inspect(id, 'owner').control.state).toBe('BLOCKED');
  expect(runtime.interrupts(id, 'owner')[0]!.resumeAt).toBeGreaterThan(Date.now() + 50_000);
});

it('用户创建数量受全局上限限制，休眠和重启不重置长期身份数量', async () => {
  const config = { ...await options(() => idle), limits: { maxAgents: 1 } };
  const first = createAgentRuntime(config);
  cleanup.push(() => first.close());
  await first.initialize(); await first.createAgent(agent); first.start();
  await until(() => first.inspect(1, 'owner').control.state === 'SLEEPING');
  await expect(first.createAgent(agent)).rejects.toThrow('数量');
  await first.close();
  const runtime = createAgentRuntime(config);
  cleanup.push(() => runtime.close());
  await runtime.initialize();
  await expect(runtime.createAgent(agent)).rejects.toThrow('数量');
  expect(runtime.list('owner')).toHaveLength(1);
});

it.each(['other-owner', 'other-workspace', 'self', 'cancelled'])('平等 Agent 通信拒绝越界或无效收件人：%s', async (boundary) => {
  let receiverCalls = 0;
  const config = await options((request) => {
    const data = JSON.parse(String(request.messages[1]?.content)) as {
      context: { frames: { objective: string }[] }; peers: string[];
    };
    if (data.context.frames[0]!.objective === '发送端') {
      expect(data.peers).toEqual([]);
      return { kind: 'message', recipient: boundary === 'self' ? 'agent-1' : 'agent-2', content: '越界消息' };
    }
    receiverCalls++;
    expect(JSON.stringify(request)).not.toContain('越界消息');
    return idle;
  });
  const runtime = createAgentRuntime({ ...config, workspaces: { ...config.workspaces, other: config.workspaces.work! } });
  cleanup.push(() => runtime.close());
  await runtime.initialize();
  await runtime.createAgent({ ...agent, objective: '发送端' });
  const ownerId = boundary === 'other-owner' ? 'other' : 'owner';
  if (boundary !== 'self') {
    await runtime.createAgent({ ...agent, objective: '接收端', ownerId,
      workspaceId: boundary === 'other-workspace' ? 'other' : 'work' });
    if (boundary === 'cancelled') await runtime.cancel(2, 'owner');
  }
  runtime.start();
  await until(() => runtime.inspect(1, 'owner').status === 'paused');
  expect(runtime.interrupts(1, 'owner').at(-1)?.kind).toBe('permission');
  if (boundary === 'other-owner' || boundary === 'other-workspace') {
    await until(() => runtime.inspect(2, ownerId).control.state === 'SLEEPING');
    expect(receiverCalls).toBe(1);
  } else expect(receiverCalls).toBe(0);
});

it('运行存储失败时阻断调度，HTTP readyz 返回 503，关闭后保留现场', async () => {
  let db: DatabaseSync;
  const config = await options(() => {
    db.exec('DROP TABLE runtime_events');
    return idle;
  });
  db = new DatabaseSync(config.database);
  const runtime = createAgentRuntime(config);
  const server = createAgentServer({ runtime, port: 0, profiles: {}, principals: [
    { ownerId: 'owner', token: 'test-runtime-failure-token', profiles: [] },
  ] });
  cleanup.push(async () => { await server.close(); db.close(); });
  const address = await server.listen();
  await runtime.createAgent(agent);
  await until(() => !runtime.isReady());
  expect((await fetch(`http://127.0.0.1:${address.port}/readyz`)).status).toBe(503);
});
