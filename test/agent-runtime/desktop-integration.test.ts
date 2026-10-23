import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createAgentRuntime } from '../../src/agent-runtime/index.js';
import { createAgentServer } from '../../src/server/index.js';
import { DesktopService } from '../../desktop-next/main/service.js';
import { DemoRequester } from '../../desktop-next/main/demo-requester.js';
import { nativeMessage } from '../fixtures/native-message.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'desktop-next-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待对话状态超时。');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const secrets = { available: () => false, encrypt: () => { throw new Error('不可用'); }, decrypt: () => '' };

it('桌面联系人创建不运行，显式消息唤醒和休眠，重启保留会话未读和幂等历史', async () => {
  const path = await directory();
  let desktop = new DesktopService(path, secrets);
  cleanup.push(() => desktop.close());
  await desktop.initialize();
  const id = await desktop.create({
    name: '代码搭档', objective: '协助理解项目代码', character: 'developer', workspaceId: null, access: 'none',
  });
  expect(desktop.snapshot().contacts[0]).toMatchObject({ id, name: '代码搭档', state: 'SLEEPING', rounds: 0 });
  const conversationId = desktop.snapshot().contacts[0]!.directConversationId;
  const chat = () => desktop.snapshot().conversations.find((item) => item.id === conversationId)!;
  desktop.send(conversationId, '第一条消息', 'same-key');
  expect(() => desktop.saveModel({ mode: 'demo', model: 'demo', apiKey: '' })).toThrow('等待');
  await until(() => chat().mailboxes.every((item) => item.state === 'processed'));
  const first = chat();
  expect(first.messages).toHaveLength(2);
  expect(first.messages[1]?.content).toContain('第一条消息');
  expect(desktop.snapshot().contacts[0]?.rounds).toBe(1);
  expect(first.unread).toBe(1);
  desktop.markRead(conversationId);
  expect(chat().unread).toBe(0);
  await desktop.close();
  desktop = new DesktopService(path, secrets);
  await desktop.initialize();
  expect(desktop.snapshot().contacts[0]).toMatchObject({ name: '代码搭档', state: 'SLEEPING' });
  expect(chat()).toMatchObject({ unread: 0, messages: first.messages });
  desktop.send(conversationId, '第一条消息', 'same-key');
  expect(chat().messages).toHaveLength(2);
  expect(() => desktop.send(conversationId, '篡改消息', 'same-key')).toThrow('幂等键');
  desktop.send(conversationId, '接着讨论', 'second-key');
  await until(() => chat().mailboxes.every((item) => item.state === 'processed'));
  expect(chat().messages).toHaveLength(4);
  expect(chat().messages.at(-1)?.content).toContain('接着讨论');
  expect(desktop.snapshot().contacts).toHaveLength(1);
});

it('桌面只能引用宿主登记的工作区，角色权限不能被渲染进程提升', async () => {
  const path = await directory();
  const desktop = new DesktopService(path, secrets);
  cleanup.push(() => desktop.close());
  await desktop.initialize();
  const base = { name: '审计', objective: '只读分析', character: 'code_auditor', workspaceId: 'forged', access: 'read' };
  await expect(desktop.create(base)).rejects.toThrow('登记');
  const workspace = await desktop.registerWorkspace(path);
  await expect(desktop.create({ ...base, workspaceId: workspace.id, access: 'write' })).rejects.toThrow('只读');
  await desktop.create({ ...base, workspaceId: workspace.id });
  expect(desktop.snapshot().contacts[0]?.capabilities).toEqual(['file.read', 'directory.read']);
  await expect(desktop.create({ ...base, parentId: 1 })).rejects.toThrow();
  expect(() => desktop.saveModel({ mode: 'minimax', model: 'model', apiKey: '' })).toThrow('API Key');
});

it('工作区映射不可变，HTTP 消息历史受用户归属保护', async () => {
  const path = await directory();
  const other = await directory();
  const runtime = createAgentRuntime({ database: join(path, 'runtime.sqlite'),
    requester: new DemoRequester(), workspaces: { home: path } });
  const server = createAgentServer({ runtime, port: 0, profiles: {}, principals: [
    { token: 'owner-token-with-length', ownerId: 'owner', profiles: [] },
    { token: 'other-token-with-length', ownerId: 'other', profiles: [] },
  ] });
  cleanup.push(() => server.close());
  const address = await server.listen();
  await runtime.registerWorkspace('more', other);
  await expect(runtime.registerWorkspace('more', path)).rejects.toThrow('不能更换');
  const agent = await runtime.createAgent({ ownerId: 'owner', workspaceId: 'more', character: 'coordinator',
    objective: '长期协助', capabilities: [], startMode: 'on_message' });
  runtime.submit(agent.control.agentId, 'owner', '你好', 'first');
  await until(() => runtime.conversationMailboxes(runtime.directConversation(agent.control.agentId, 'owner').id, 'owner')
    .every((item) => item.state === 'processed'));
  const url = `http://127.0.0.1:${address.port}/v1/agents/${agent.control.agentId}/messages`;
  const response = await fetch(url, { headers: { authorization: 'Bearer owner-token-with-length' } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ messages: [{ role: 'user', content: '你好' }, { role: 'assistant' }] });
  expect((await fetch(url, { headers: { authorization: 'Bearer other-token-with-length' } })).status).toBe(400);
});

it('内部层交付不进入用户聊天，L1 完成计划后可显式发言或静默', async () => {
  const path = await directory();
  const demo = new DemoRequester();
  let step = 0;
  const runtime = createAgentRuntime({
    database: join(path, 'runtime.sqlite'), workspaces: { home: path },
    requester: { provider: 'minimax', model: 'layered-demo', async request(request, signal) {
      if (request.tools?.some((tool) => tool.name === 'submit_summary')) return demo.request(request, signal);
      const actions = [
        { kind: 'context', decision: { type: 'plan', objectives: ['内部阶段'] } },
        { kind: 'context', decision: { type: 'advance' } },
        { kind: 'output', content: '内部层的交付' },
        { kind: 'send_message', conversationId: (JSON.parse(String(request.messages[1]?.content)) as {
          conversation: { id: string };
        }).conversation.id, content: '面向用户的最终结果', finish: true },
      ];
      if (step === 3) {
        expect(request.toolChoice).toBe('required');
        expect(request.tools?.some((tool) => tool.name === 'context_finish_turn')).toBe(true);
      }
      return { provider: 'minimax', model: 'layered-demo', finishReason: 'stop',
        message: nativeMessage(actions[step++]!),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    } },
  });
  cleanup.push(() => runtime.close());
  await runtime.initialize();
  await runtime.createAgent({ ownerId: 'user', workspaceId: 'home', objective: '长期工作',
    character: 'coordinator', capabilities: [], startMode: 'on_message' });
  runtime.start();
  runtime.submit(1, 'user', '请分层处理', 'task');
  await until(() => runtime.conversationMailboxes(runtime.directConversation(1, 'user').id, 'user')
    .every((item) => item.state === 'processed'));
  expect(runtime.messages(1, 'user').map((message) => message.content)).toEqual(['请分层处理', '面向用户的最终结果']);
});

it('桌面 Agent 视角只读且不清未读，私聊双向记录不进入用户会话', async () => {
  const desktop = new DesktopService(await directory(), secrets);
  cleanup.push(() => desktop.close());
  await desktop.initialize();
  const input = { objective: '长期协作', character: 'coordinator', workspaceId: null, access: 'none' };
  const first = await desktop.create({ ...input, name: '小研' });
  const second = await desktop.create({ ...input, name: '代码助手' });
  const own = desktop.snapshot().contacts[0]!.directConversationId;
  desktop.send(own, '和代码助手聊聊', 'collaborate');
  await until(() => desktop.snapshot(first).inspector?.conversations.some((item) =>
    !item.includesUser && item.messages.length === 2 && item.mailboxes.every((mailbox) => mailbox.state === 'processed')) === true);
  const peer = desktop.snapshot(first).inspector!.conversations.find((item) => !item.includesUser)!;
  expect(desktop.snapshot().conversations).toHaveLength(2);
  expect(desktop.snapshot().conversations.flatMap((item) => item.messages)).toHaveLength(1);
  expect(desktop.snapshot(second).inspector?.conversations.find((item) => item.id === peer.id)?.messages).toEqual(peer.messages);
  expect(() => desktop.send(peer.id, '不能冒充', 'forbidden')).toThrow();
  expect(() => desktop.markRead(peer.id)).toThrow();
  desktop.send(own, '正常回复', 'reply');
  await until(() => desktop.snapshot().conversations.find((item) => item.id === own)?.unread === 1);
  desktop.snapshot(first);
  expect(desktop.snapshot().conversations.find((item) => item.id === own)?.unread).toBe(1);
});

it('桌面群聊可聚合点名、无关成员沉默，工作区和伪造成员受宿主约束', async () => {
  const path = await directory();
  const desktop = new DesktopService(path, secrets);
  cleanup.push(() => desktop.close());
  await desktop.initialize();
  const input = { objective: '长期协作', character: 'coordinator', workspaceId: null, access: 'none' };
  const first = await desktop.create({ ...input, name: '甲' });
  const second = await desktop.create({ ...input, name: '乙' });
  const id = desktop.createGroup({ title: '项目群', agentIds: [first, second], participation: 'all' });
  const chat = () => desktop.snapshot().conversations.find((item) => item.id === id)!;
  desktop.send(id, '第一条资料', 'group-first', [first]);
  desktop.send(id, '第二条资料', 'group-second', [first]);
  await until(() => chat().mailboxes.every((item) => item.state === 'processed'));
  expect(chat().messages).toHaveLength(3);
  expect(chat().messages[2]).toMatchObject({ sender: { kind: 'agent', id: first } });
  expect(chat().messages[2]?.content).toContain('这 2 条消息');
  expect(chat().unread).toBe(1);
  expect(desktop.snapshot().conversations.filter((item) => item.kind === 'direct').every((item) => !item.messages.length)).toBe(true);
  desktop.send(id, '通知，无需回复', 'notice');
  await until(() => chat().mailboxes.every((item) => item.state === 'processed'));
  expect(chat().messages).toHaveLength(4);
  expect(() => desktop.send(id, '点名越界', 'bad-mention', [999])).toThrow();
  const workspace = await desktop.registerWorkspace(path);
  const third = await desktop.create({ ...input, workspaceId: workspace.id, name: '另一工作区' });
  expect(() => desktop.createGroup({ title: '越界', agentIds: [first, third], participation: 'all' })).toThrow('工作区');
});
