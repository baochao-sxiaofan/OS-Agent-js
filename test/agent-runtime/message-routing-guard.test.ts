import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAgentRuntime } from '../../src/agent-runtime/index.js';
import { nativeMessage } from '../fixtures/native-message.js';

it('协作群缺少点名时先纠正，修正后的消息仅发送一次并唤醒对方', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'message-routing-'));
  let groupId = '';
  let authorCalls = 0;
  let editorCalls = 0;
  const checkedMentions: number[][] = [];
  const runtime = createAgentRuntime({
    database: join(directory, 'runtime.sqlite'), workspaces: { work: directory },
    limits: { retryBaseMs: 1 }, conversationPolicy: { groupQuietMs: 1, maxWaitMs: 1 },
    messageGuard: ({ agentId, conversationId, mentions }) => {
      expect(conversationId).toBe(groupId);
      expect(agentId).toBe(1);
      checkedMentions.push([...mentions]);
      return mentions.includes(2) ? null : '请设置mentions:[2]，正文中写@姓名不能唤醒对方。';
    },
    requester: { provider: 'minimax', model: 'test', async request(request) {
      const payload = JSON.parse(String(request.messages[1]?.content)) as {
        self: { id: number }; previousError: string | null;
      };
      let action: object;
      if (payload.self.id === 1) {
        authorCalls++;
        if (authorCalls > 1) expect(payload.previousError).toContain('请设置mentions:[2]');
        action = { kind: 'send_message', conversationId: groupId, content: '@编辑 请审查第04章',
          finish: true, ...(authorCalls > 1 ? { mentions: [2] } : {}) };
      } else {
        editorCalls++;
        expect(JSON.stringify(request.messages)).toContain('@编辑 请审查第04章');
        action = { kind: 'context', decision: { type: 'finish_turn' } };
      }
      return { provider: 'minimax', model: 'test', finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        message: nativeMessage(action) };
    } },
  });
  try {
    await runtime.initialize();
    for (const name of ['作者', '编辑']) {
      await runtime.createAgent({ ownerId: 'owner', workspaceId: 'work', character: 'coordinator',
        objective: name, displayName: name, capabilities: [], startMode: 'on_message' });
    }
    groupId = runtime.createConversation({ ownerId: 'owner', workspaceId: 'work', kind: 'group',
      participation: 'mentioned', members: [
        { kind: 'user', id: 'owner' }, { kind: 'agent', id: 1 }, { kind: 'agent', id: 2 },
      ] }).id;
    runtime.sendMessage(groupId, 'owner', { content: '写好一章交编辑', mentions: [1], idempotencyKey: 'start' });
    runtime.start();
    const deadline = Date.now() + 2000;
    while (editorCalls !== 1 || runtime.list('owner').some((agent) => agent.control.state !== 'SLEEPING')) {
      if (Date.now() > deadline || runtime.list('owner').some((agent) => agent.status === 'paused')) {
        throw new Error('纠正后的协作消息未完成交付。');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(authorCalls).toBe(2);
    expect(checkedMentions).toEqual([[], [2]]);
    expect(runtime.conversationMessages(groupId, 'owner').filter((message) => message.sender.kind === 'agent'))
      .toHaveLength(1);
    expect(runtime.interrupts(1, 'owner').map(({ kind, action }) => ({ kind, action })))
      .toEqual([{ kind: 'protocol', action: 'retry' }]);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
