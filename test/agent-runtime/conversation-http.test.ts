import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAgentRuntime } from '../../src/agent-runtime/index.js';
import { createAgentServer } from '../../src/server/index.js';
import { nativeMessage } from '../fixtures/native-message.js';

it('HTTP 会话按成员读取，管理查看只读，用户与模型不能伪造其他发送者', async () => {
  const path = await mkdtemp(join(tmpdir(), 'conversation-http-'));
  const runtime = createAgentRuntime({
    database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    conversationPolicy: { quietMs: 5, maxWaitMs: 15 },
    requester: { provider: 'minimax', model: 'test', async request(request) {
      const input = JSON.parse(String(request.messages[1]?.content)) as {
        self: { id: number }; conversation: { members: { kind: string }[] };
      };
      const action = input.self.id === 1 && input.conversation.members.some((member) => member.kind === 'user')
        ? { kind: 'send_message', conversationId: 'peer:agent-2', content: '只发给另一个 Agent', finish: true }
        : { kind: 'context', decision: { type: 'finish_turn' } };
      return { provider: 'minimax', model: 'test', finishReason: 'stop',
        message: nativeMessage(action),
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
    } },
  });
  const server = createAgentServer({ runtime, port: 0,
    profiles: { helper: { workspaceId: 'work', character: 'coordinator', capabilities: [], startMode: 'on_message' } },
    principals: [{ ownerId: 'one', token: 'test-token-owner-one', profiles: ['helper'] },
      { ownerId: 'two', token: 'test-token-owner-two', profiles: ['helper'] }],
  });
  try {
    const { port } = await server.listen();
    const base = `http://127.0.0.1:${port}`;
    const auth = { authorization: 'Bearer test-token-owner-one', 'content-type': 'application/json' };
    const post = (url: string, value: object) => fetch(`${base}${url}`, { method: 'POST', headers: auth, body: JSON.stringify(value) });
    for (const objective of ['甲', '乙']) expect((await post('/v1/agents', { profile: 'helper', objective })).status).toBe(201);
    const response = await post('/v1/conversations', { kind: 'group', workspaceId: 'work',
      title: '项目群', agentIds: [1, 2], participation: 'mentioned' });
    expect(response.status).toBe(201);
    const { conversation } = await response.json() as { conversation: { id: string } };
    const route = `/v1/conversations/${conversation.id}/messages`;
    expect((await post(route, { content: '普通通知', idempotencyKey: 'notice' })).status).toBe(201);
    expect((await post(route, { content: '冒充', idempotencyKey: 'forged', sender: { kind: 'agent', id: 1 } })).status).toBe(400);
    expect((await fetch(`${base}${route}`, { headers: { authorization: 'Bearer test-token-owner-two' } })).status).toBe(400);
    expect((await fetch(`${base}${route}`, { headers: auth })).status).toBe(200);
    expect((await post('/v1/agents/1/messages', { content: '联系另一个 Agent', idempotencyKey: 'start' })).status).toBe(202);
    const deadline = Date.now() + 2000;
    while (runtime.agentConversations(1, 'one').length < 3) {
      if (Date.now() > deadline) throw new Error('未创建 Agent 私聊。');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const peer = runtime.agentConversations(1, 'one').find((item) => item.members.every((member) => member.kind === 'agent'))!;
    const peerRoute = `/v1/conversations/${peer.id}/messages`;
    expect((await fetch(`${base}${peerRoute}`, { headers: auth })).status).toBe(400);
    const inspected = await fetch(`${base}${peerRoute}?inspectAgentId=1`, { headers: auth });
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({ messages: [{ content: '只发给另一个 Agent', sender: { kind: 'agent', id: 1 } }] });
    expect((await post(`${peerRoute}?inspectAgentId=1`, { content: '只读界面不能代发', idempotencyKey: 'no' })).status).toBe(400);
    const listed = await fetch(`${base}/v1/conversations`, { headers: auth });
    expect(await listed.json()).toMatchObject({ conversations: expect.not.arrayContaining([expect.objectContaining({ id: peer.id })]) });
    expect((await fetch(`${base}/v1/agents/1/legacy`, { headers: auth })).status).toBe(200);
  } finally { await server.close(); await rm(path, { recursive: true, force: true }); }
});
