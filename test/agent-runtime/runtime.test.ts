import { readRuntimeRequest } from '../../src/agent-runtime/index.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentRuntime, type AgentRuntime } from '../../src/agent-runtime/index.js';
import type { ModelCompletionRequest, ModelRequester } from '../../src/model-requester/index.js';
import { ModelRequesterError } from '../../src/model-requester/index.js';
import { summary } from '../agent-context/helpers.js';
import { nativeMessage } from '../fixtures/native-message.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function requester(actions: object[], onRequest?: (request: ModelCompletionRequest) => void): ModelRequester {
  return {
    provider: 'minimax', model: 'test',
    async request(request) {
      onRequest?.(request);
      const system = request.messages[0];
      const summarizing = typeof system?.content === 'string' && system.content.includes('独立总结轮');
      const source = summarizing ? readRuntimeRequest(request) as { sourceRef: string } : null;
      const content = JSON.stringify(source ? summary(source.sourceRef) : actions.shift());
      if (!content) throw new Error('测试动作耗尽。');
      return { provider: 'minimax', model: 'test', finishReason: 'stop',
        message: nativeMessage(JSON.parse(content) as object),
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 } };
    },
  };
}
async function setup(model: ModelRequester) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-runtime-'));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const runtime = createAgentRuntime({ database: join(directory, 'runtime.sqlite'), requester: model,
    workspaces: { workspace: directory }, limits: { retryBaseMs: 10, requestsPerMinute: 100, tokensPerMinute: 1_000_000 } });
  cleanup.push(() => runtime.close());
  await runtime.initialize();
  return { runtime, directory };
}
async function waitUntil(runtime: AgentRuntime, id: number, check: () => boolean, timeout = 4000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (check()) return;
    if (runtime.inspect(id, 'owner').status === 'paused') throw new Error(JSON.stringify(runtime.interrupts(id, 'owner')));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('等待任务超时。');
}
const context = (type: string, extra = {}) => ({ kind: 'context', decision: { type, ...extra } });

describe('服务器 Runtime 真实协议闭环', () => {
  it('根层旧计划完成后，新来信仍可执行文件交付，子层完成仍须收尾', async () => {
    let newBatch = false;
    let checked = false;
    const { runtime, directory } = await setup(requester([
      context('plan', { objectives: ['完成旧阶段'] }), context('advance'),
      context('plan', { objectives: ['旧阶段步骤'] }), context('advance'),
      context('complete'), context('complete'), context('finish_turn'),
      { kind: 'tools', calls: [{ name: 'file.create', arguments: {
        path: 'workspace://current/next.txt', content: '新来信要求的实际交付',
      } }] },
      context('finish_turn'),
    ], (request) => {
      if (!request.tools?.some((tool) => tool.name === 'context_finish_turn' || tool.name === 'context_complete')) return;
      const payload = readRuntimeRequest(request) as {
        completedPlan: boolean; completedPlanNextAction: string | null;
        context: { frames: { level: number }[] };
      };
      if (payload.completedPlan && payload.context.frames.at(-1)?.level !== 1) {
        expect(payload.completedPlanNextAction).toBe('complete');
        expect(request.toolChoice).toBe('required');
      }
      if (newBatch) {
        expect(payload.completedPlan).toBe(true);
        expect(payload.completedPlanNextAction).toBe('process_current_batch');
        expect(request.toolChoice).toBe('required');
        checked = true;
      }
    }));
    const agent = await runtime.createAgent({
      ownerId: 'owner', workspaceId: 'workspace', character: 'developer', objective: '持续工作',
      startMode: 'on_message',
      capabilities: [{ capability: 'file.create', scope: { kind: 'subtree', resource: 'workspace://current/' } }],
    });
    runtime.submit(agent.control.agentId, 'owner', '执行旧阶段', 'old-delivery');
    const conversation = runtime.directConversation(agent.control.agentId, 'owner');
    runtime.start();
    await waitUntil(runtime, agent.control.agentId, () => runtime.inspect(agent.control.agentId, 'owner').control.state === 'SLEEPING' &&
      runtime.conversationMailboxes(conversation.id, 'owner').every((mailbox) => mailbox.state === 'processed'));
    expect(runtime.inspect(agent.control.agentId, 'owner').control.context.level1.taskChain.tasks[0]?.state).toBe('COMPLETED');
    newBatch = true;
    runtime.submit(agent.control.agentId, 'owner', '旧阶段已验收，请生成下一份文件', 'next-delivery');
    await waitUntil(runtime, agent.control.agentId, () => runtime.inspect(agent.control.agentId, 'owner').control.state === 'SLEEPING' &&
      runtime.conversationMailboxes(conversation.id, 'owner').every((mailbox) => mailbox.state === 'processed'));
    expect(checked).toBe(true);
    expect(await readFile(join(directory, 'next.txt'), 'utf8')).toBe('新来信要求的实际交付');
  });

  it('模型自主规划、读写工具、三层总结、输出并再次唤醒', async () => {
    const requests: ModelCompletionRequest[] = [];
    const actions = [
      context('plan', { objectives: ['报告'] }), context('advance'),
      context('plan', { objectives: ['读写'] }), context('advance'),
      { kind: 'tools', calls: [{ name: 'file.read', arguments: { path: 'workspace://current/input.txt' } }] },
      { kind: 'tools', calls: [{ name: 'file.create', arguments: { path: 'workspace://current/report.txt', content: '报告内容' } }] },
      { kind: 'output', content: '报告已完成' }, context('complete'), context('idle'),
      { kind: 'output', content: '第二次任务完成' },
    ];
    const { runtime, directory } = await setup(requester(actions, (request) => requests.push(request)));
    await writeFile(join(directory, 'input.txt'), '资料内容');
    const agent = await runtime.createAgent({
      ownerId: 'owner', workspaceId: 'workspace', character: 'developer', objective: '读取 input.txt 并生成报告',
      capabilities: [
        { capability: 'file.read', scope: { kind: 'subtree', resource: 'workspace://current/' } },
        { capability: 'file.create', scope: { kind: 'subtree', resource: 'workspace://current/' } },
      ],
    });
    runtime.start();
    await waitUntil(runtime, agent.control.agentId, () => runtime.inspect(agent.control.agentId, 'owner').control.state === 'SLEEPING');
    expect(await readFile(join(directory, 'report.txt'), 'utf8')).toBe('报告内容');
    expect(runtime.events(agent.control.agentId, 'owner').filter((event) => event.type === 'output')).toHaveLength(1);
    expect(requests.some((request) => JSON.stringify(request).includes('资料内容'))).toBe(true);
    runtime.submit(agent.control.agentId, 'owner', '新的任务', 'second');
    runtime.submit(agent.control.agentId, 'owner', '新的任务', 'second');
    const conversation = runtime.directConversation(agent.control.agentId, 'owner');
    await waitUntil(runtime, agent.control.agentId, () => runtime.inspect(agent.control.agentId, 'owner').control.state === 'SLEEPING' &&
      runtime.conversationMailboxes(conversation.id, 'owner').every((mailbox) => mailbox.state === 'processed'));
    expect(runtime.events(agent.control.agentId, 'owner').filter((event) => event.type === 'output')).toHaveLength(2);
    expect(() => runtime.inspect(agent.control.agentId, 'other')).toThrow('宿主');
  });

  it('网络错误退避重试，不能忙循环；超过限制暂停', async () => {
    let attempts = 0;
    const model = requester([context('idle')]);
    const original = model.request.bind(model);
    model.request = async (...args) => {
      attempts++;
      if (attempts <= 2) throw new ModelRequesterError('test', { provider: 'minimax', code: 'network_error', retryable: true });
      return original(...args);
    };
    const { runtime } = await setup(model);
    const agent = await runtime.createAgent({ ownerId: 'owner', workspaceId: 'workspace',
      character: 'code_auditor', objective: '完成任务', capabilities: [] });
    runtime.start();
    await waitUntil(runtime, agent.control.agentId, () => runtime.inspect(agent.control.agentId, 'owner').control.state === 'SLEEPING');
    expect(runtime.interrupts(agent.control.agentId, 'owner').filter((item) => item.action === 'retry')).toHaveLength(2);
    expect(attempts).toBe(4);
  });

  it('目录越权执行前拒绝，结果反馈模型且不会读文件', async () => {
    const actions = [
      { kind: 'tools', calls: [{ name: 'file.read', arguments: { path: 'workspace://current/../secret.txt' } }] },
      { kind: 'output', content: '收到拒绝' },
    ];
    const { runtime } = await setup(requester(actions));
    const agent = await runtime.createAgent({
      ownerId: 'owner', workspaceId: 'workspace', character: 'code_auditor', objective: '读取资料',
      capabilities: [{ capability: 'file.read', scope: { kind: 'subtree', resource: 'workspace://current/' } }],
    });
    runtime.start();
    await waitUntil(runtime, agent.control.agentId, () => runtime.inspect(agent.control.agentId, 'owner').control.state === 'SLEEPING');
    expect(runtime.interrupts(agent.control.agentId, 'owner').some((item) => item.kind === 'tool' || item.kind === 'permission')).toBe(true);
  });
});
