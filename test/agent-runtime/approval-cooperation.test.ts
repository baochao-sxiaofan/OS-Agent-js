import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAgentRuntime } from '../../src/agent-runtime/index.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { CharacterRegistry } from '../../src/character/character-registry.js';
import type { ModelCompletionRequest, ModelRequester } from '../../src/model-requester/index.js';
import { summary } from '../agent-context/helpers.js';
import { nativeMessage } from '../fixtures/native-message.js';

function completion(action: object) {
  return { provider: 'minimax' as const, model: 'test', finishReason: 'stop' as const,
    message: nativeMessage(action),
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
}
function source(request: ModelCompletionRequest): string | null {
  return String(request.messages[0]?.content).includes('独立总结轮')
    ? (JSON.parse(String(request.messages[1]?.content)) as { sourceRef: string }).sourceRef : null;
}
async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it('敏感工具在人工批准前不执行，批准只用于该操作', async () => {
  const path = await mkdtemp(join(tmpdir(), 'runtime-approval-'));
  let executions = 0;
  const tools = new ToolRegistry();
  tools.register({
    name: 'git.push', description: '测试敏感操作', effect: 'privileged', requiredCapability: 'git.push',
    validateInput: () => ({ valid: true }), async execute() { executions++; return { pushed: true }; },
  });
  const characters = new CharacterRegistry([{
    id: 'test', displayName: '测试角色', promptFragment: '测试角色',
    visibleToolIds: ['git.push'], capabilityCeiling: ['git.push'],
    requestableCapabilities: ['git.push'], allowedChildCharacters: [],
  }]);
  let work = 0;
  const requester: ModelRequester = { provider: 'minimax', model: 'test', async request(request) {
    const ref = source(request);
    if (ref) return completion(summary(ref));
    work++;
    return completion(work === 1 ? { kind: 'tools', calls: [{ name: 'git.push', arguments: {} }] }
      : { kind: 'context', decision: { type: 'idle' } });
  } };
  const runtime = createAgentRuntime({ database: join(path, 'runtime.sqlite'), requester,
    tools, characters, workspaces: { work: path } });
  try {
    await runtime.initialize();
    const agent = await runtime.createAgent({
      ownerId: 'owner', workspaceId: 'work', character: 'test', objective: '测试审批',
      capabilities: [{ capability: 'git.push', scope: { kind: 'all' } }],
    });
    const id = agent.control.agentId;
    runtime.start();
    await until(() => runtime.approvals(id, 'owner').length === 1);
    expect(executions).toBe(0);
    runtime.approve(id, 'owner', runtime.approvals(id, 'owner')[0]!.operationId, true);
    await until(() => runtime.inspect(id, 'owner').control.state === 'SLEEPING');
    expect(executions).toBe(1);
    expect(runtime.inspect(id, 'owner').grants.some((grant) => grant.remainingUses === 0 && grant.consumedBy)).toBe(true);
    expect(runtime.inspect(id, 'owner').grants.every((grant) => !grant.delegable)).toBe(true);
  } finally { await runtime.close(); await rm(path, { recursive: true, force: true }); }
});

it('用户创建的长期 Agent 通过持久消息协作，重启后回复仍唤醒原身份', async () => {
  const path = await mkdtemp(join(tmpdir(), 'runtime-cooperation-'));
  const calls = new Map<string, number>();
  const received: string[] = [];
  const requester: ModelRequester = { provider: 'minimax', model: 'test', async request(request) {
    const ref = source(request);
    if (ref) return completion(summary(ref));
    const input = JSON.parse(String(request.messages[1]?.content)) as {
      context: { frames: { objective: string }[] }; peers: string[];
    };
    const objective = input.context.frames[0]!.objective;
    const count = (calls.get(objective) ?? 0) + 1;
    calls.set(objective, count);
    received.push(JSON.stringify(request));
    expect(request.tools?.some((tool) => tool.name === 'agent_spawn')).toBe(false);
    if (objective === '长期协调') {
      expect(input.peers).toEqual(['agent-2']);
      return completion(count === 1
        ? { kind: 'message', recipient: 'agent-2', content: '请检查资料' }
        : { kind: 'output', content: '协调工作已处理' });
    }
    expect(input.peers).toEqual(runtime.inspect(1, 'owner').status === 'cancelled' ? [] : ['agent-1']);
    return completion(count === 1
      ? { kind: 'message', recipient: 'agent-1', content: '检查完成' }
      : { kind: 'output', content: '检查工作已处理' });
  } };
  // 本用例验证协作恢复，输入协议增大后仍避免触发独立的分钟配额等待。
  const options = { database: join(path, 'runtime.sqlite'), requester, workspaces: { work: path },
    limits: { tokensPerMinute: 1_000_000 } };
  let runtime = createAgentRuntime(options);
  try {
    await runtime.initialize();
    const coordinator = await runtime.createAgent({
      ownerId: 'owner', workspaceId: 'work', character: 'coordinator', objective: '长期协调',
      capabilities: [{ capability: 'file.read', scope: { kind: 'subtree', resource: 'workspace://current/' } }],
    });
    const auditor = await runtime.createAgent({
      ownerId: 'owner', workspaceId: 'work', character: 'code_auditor', objective: '长期审计', capabilities: [],
    });
    await runtime.pause(auditor.control.agentId, 'owner');
    runtime.start();
    await until(() => runtime.inspect(coordinator.control.agentId, 'owner').control.state === 'SLEEPING');
    expect(calls.get('长期审计')).toBeUndefined();
    await runtime.close();
    runtime = createAgentRuntime(options);
    await runtime.initialize();
    expect(runtime.inspect(auditor.control.agentId, 'owner').status).toBe('paused');
    runtime.resume(auditor.control.agentId, 'owner');
    runtime.start();
    await until(() => (calls.get('长期审计') ?? 0) >= 3 && (calls.get('长期协调') ?? 0) >= 3 &&
      runtime.list('owner').every((item) => item.control.state === 'SLEEPING') &&
      runtime.agentConversations(1, 'owner').every((conversation) =>
        runtime.conversationMailboxes(conversation.id, 'owner', 1).every((mailbox) => mailbox.state === 'processed')));
    const agents = runtime.list('owner');
    expect(agents.map((item) => item.control.agentId)).toEqual([coordinator.control.agentId, auditor.control.agentId]);
    expect(received.join('\n')).toContain('请检查资料');
    expect(received.join('\n')).toContain('检查完成');
    const peer = runtime.agentConversations(1, 'owner').find((conversation) =>
      conversation.members.every((member) => member.kind === 'agent'))!;
    expect(runtime.conversationMessages(peer.id, 'owner', 1).map((message) => message.sender))
      .toEqual([{ kind: 'agent', id: 1 }, { kind: 'agent', id: 2 }]);
    expect(agents[1]!.grants).toEqual([]);
    expect(agents[0]!.grants.every((grant) => !grant.delegable)).toBe(true);
    for (const item of agents) {
      expect(item).not.toHaveProperty('parentId');
      expect(item).not.toHaveProperty('depth');
      expect(item.control.context.level1.memory.summary).not.toBeNull();
    }
    await runtime.cancel(coordinator.control.agentId, 'owner');
    expect(runtime.inspect(auditor.control.agentId, 'owner').status).toBe('active');
    runtime.submit(auditor.control.agentId, 'owner', '独立继续工作', 'next-task');
    const direct = runtime.directConversation(auditor.control.agentId, 'owner');
    await until(() => (calls.get('长期审计') ?? 0) >= 4 &&
      runtime.inspect(auditor.control.agentId, 'owner').control.state === 'SLEEPING' &&
      runtime.conversationMailboxes(direct.id, 'owner').every((mailbox) => mailbox.state === 'processed'));
  } finally { await runtime.close(); await rm(path, { recursive: true, force: true }); }
});
