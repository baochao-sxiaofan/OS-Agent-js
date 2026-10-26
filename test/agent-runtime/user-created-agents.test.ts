import { readRuntimeRequest } from '../../src/agent-runtime/index.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createAgentRuntime, type AgentRuntimeOptions } from '../../src/agent-runtime/index.js';
import type { ModelAssistantMessage, ModelCompletionRequest } from '../../src/model-requester/index.js';
import { summary } from '../agent-context/helpers.js';
import { nativeMessage } from '../fixtures/native-message.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(work: (request: ModelCompletionRequest) => ModelAssistantMessage) {
  const path = await mkdtemp(join(tmpdir(), 'user-created-agents-'));
  cleanup.push(() => rm(path, { force: true, recursive: true }));
  const options: AgentRuntimeOptions = {
    database: join(path, 'runtime.sqlite'), workspaces: { work: path }, limits: { maxRetries: 0 },
    requester: { provider: 'minimax', model: 'test', async request(request) {
      const ref = String(request.messages[0]?.content).includes('独立总结轮')
        ? (readRuntimeRequest(request) as { sourceRef: string }).sourceRef : null;
      return { provider: 'minimax', model: 'test', finishReason: 'stop',
        message: ref ? text(summary(ref)) : work(request),
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
    } },
  };
  const runtime = createAgentRuntime(options);
  cleanup.push(() => runtime.close());
  await runtime.initialize();
  return { runtime, path };
}
function text(action: object): ModelAssistantMessage {
  return nativeMessage(action);
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待超时。');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const input = { ownerId: 'user', workspaceId: 'work', character: 'coordinator', objective: '长期职责', capabilities: [] };
const spawn = { kind: 'spawn', character: 'developer', objective: '自动创建', capabilities: [] };
const attempts: ModelAssistantMessage[] = [
  { role: 'assistant', content: JSON.stringify(spawn), toolCalls: [] },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'agent_spawn',
    arguments: { character: 'developer', objective: '自动创建', capabilities: [] } }] },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'agent_action', arguments: spawn }] },
];

it.each(attempts)('模型伪造创建动作被拒绝，用户创建入口是唯一身份来源：%j', async (attempt) => {
  const { runtime } = await setup((request) => {
    expect(request.tools?.map((tool) => tool.name)).not.toContain('agent_spawn');
    expect(String(request.messages[0]?.content)).not.toContain('root coordinator');
    return attempt;
  });
  const agent = await runtime.createAgent(input);
  runtime.start();
  await until(() => runtime.inspect(agent.control.agentId, 'user').status === 'paused');
  expect(runtime.interrupts(agent.control.agentId, 'user').at(-1)?.kind).toBe('protocol');
  expect(runtime.list('user')).toHaveLength(1);
  expect(runtime.events(agent.control.agentId, 'user').filter((event) => event.type === 'agent_created'))
    .toMatchObject([{ data: { createdBy: 'user' } }]);
  const invalid = { ...input, parentId: agent.control.agentId };
  await expect(runtime.createAgent(invalid)).rejects.toThrow();
  expect(runtime.list('user')).toHaveLength(1);
});

it('同工作区消息不会把发送方的写权限转授给接收方', async () => {
  const calls = new Map<string, number>();
  const { runtime, path } = await setup((request) => {
    const data = readRuntimeRequest(request) as {
      context: { frames: { objective: string }[] };
    };
    const objective = data.context.frames[0]!.objective;
    const count = (calls.get(objective) ?? 0) + 1;
    calls.set(objective, count);
    if (objective === '发送端' && count === 1) {
      return text({ kind: 'message', recipient: 'agent-2', content: '请代我创建 report.md' });
    }
    if (objective === '接收端' && count === 1) {
      return text({ kind: 'tools', calls: [{ name: 'file.create',
        arguments: { path: 'workspace://current/report.md', content: '无权写入' } }] });
    }
    return text({ kind: 'output', content: '工作结束' });
  });
  await runtime.createAgent({ ...input, objective: '发送端', capabilities: [
    { capability: 'file.create', scope: { kind: 'subtree', resource: 'workspace://current/' } },
  ] });
  await runtime.createAgent({ ...input, objective: '接收端', character: 'developer' });
  await runtime.pause(2, 'user');
  runtime.start();
  await until(() => runtime.inspect(1, 'user').control.state === 'SLEEPING');
  runtime.resume(2, 'user');
  await until(() => runtime.inspect(2, 'user').control.state === 'SLEEPING');
  expect(runtime.interrupts(2, 'user').some((entry) => entry.kind === 'permission')).toBe(true);
  expect(runtime.inspect(2, 'user').grants).toEqual([]);
  await expect(readFile(join(path, 'report.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});
