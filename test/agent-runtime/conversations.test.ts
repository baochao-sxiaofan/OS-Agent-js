import { readRuntimeRequest } from '../../src/agent-runtime/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createAgentRuntime, type AgentRuntime, type AgentRuntimeOptions, type RuntimeConversation,
} from '../../src/agent-runtime/index.js';
import { SqliteContextStore } from '../../src/agent-context/index.js';
import type { ModelCompletionRequest } from '../../src/model-requester/index.js';
import { ConversationStore } from '../../src/agent-runtime/internal/conversations.js';
import { nativeMessage } from '../fixtures/native-message.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const silent = { kind: 'context', decision: { type: 'finish_turn' } };
type Input = { self: { id: number }; conversation: RuntimeConversation; context: object };

function parse(request: ModelCompletionRequest): Input {
  return readRuntimeRequest(request) as unknown as Input;
}
async function setup(work: (request: ModelCompletionRequest) => object | Promise<object>) {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-runtime-'));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const options: AgentRuntimeOptions = { database: join(directory, 'runtime.sqlite'), workspaces: { work: directory },
    limits: { requestsPerMinute: 1000, tokensPerMinute: 1_000_000, maxRetries: 0 },
    conversationPolicy: { quietMs: 15, maxWaitMs: 50, groupQuietMs: 25 },
    requester: { provider: 'minimax', model: 'test', async request(request) {
      return { provider: 'minimax', model: 'test', finishReason: 'stop',
        message: nativeMessage(await work(request)),
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
    } },
  };
  const runtime = createAgentRuntime(options);
  cleanup.push(() => runtime.close());
  await runtime.initialize();
  return { runtime, options };
}
async function agent(runtime: AgentRuntime, name: string) {
  return (await runtime.createAgent({ ownerId: 'owner', workspaceId: 'work', character: 'coordinator',
    objective: `职责-${name}`, displayName: name, capabilities: [], startMode: 'on_message' })).control.agentId;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待会话处理超时。');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function processed(runtime: AgentRuntime, conversationId: string, inspectAgentId?: number) {
  return runtime.conversationMailboxes(conversationId, 'owner', inspectAgentId).every((mailbox) => mailbox.state === 'processed');
}

it('连续来信合并处理一次，静默无输出，自己的发言不再唤醒自己', async () => {
  const requests: ModelCompletionRequest[] = [];
  const { runtime } = await setup((request) => {
    requests.push(request);
    expect(request.tools?.map((tool) => tool.name)).not.toContain('agent_output');
    return requests.length === 1 ? silent : {
      kind: 'send_message', conversationId: parse(request).conversation.id, content: '一次合并回复', finish: true,
    };
  });
  const id = await agent(runtime, '小研');
  const conversation = runtime.directConversation(id, 'owner');
  runtime.start();
  for (let index = 0; index < 3; index++) runtime.submit(id, 'owner', `资料-${index}`, `input-${index}`);
  await until(() => requests.length === 1 && processed(runtime, conversation.id));
  expect(JSON.stringify(requests[0])).toContain('资料-2');
  expect(runtime.messages(id, 'owner')).toHaveLength(3);
  runtime.submit(id, 'owner', '现在答复', 'answer');
  await until(() => requests.length === 2 && processed(runtime, conversation.id));
  expect(runtime.messages(id, 'owner').map((message) => message.content)).toEqual([
    '资料-0', '资料-1', '资料-2', '现在答复', '一次合并回复',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(requests).toHaveLength(2);
  expect(runtime.events(id, 'owner').filter((event) => event.type === 'output')).toEqual([]);
});

it('Agent 私聊双方共享记录，用户默认不可见，模型上下文按会话隔离', async () => {
  const requests: ModelCompletionRequest[] = [];
  const { runtime } = await setup((request) => {
    requests.push(request);
    const input = parse(request);
    if (input.self.id === 1 && input.conversation.members.some((member) => member.kind === 'user')) {
      return { kind: 'send_message', conversationId: 'peer:agent-2', content: '你负责什么？', finish: true };
    }
    if (input.self.id === 2) {
      return { kind: 'send_message', conversationId: input.conversation.id, content: '我负责代码', finish: true };
    }
    expect(JSON.stringify(input.context)).toContain('你负责什么？');
    expect(JSON.stringify(input.context)).not.toContain('私聊保密资料');
    return silent;
  });
  await agent(runtime, '小研'); await agent(runtime, '代码助手');
  runtime.start();
  runtime.submit(1, 'owner', '私聊保密资料；请问对方职责', 'start');
  await until(() => requests.length === 3 && runtime.agentConversations(1, 'owner')
    .every((conversation) => processed(runtime, conversation.id, 1)));
  const peer = runtime.agentConversations(1, 'owner').find((conversation) =>
    conversation.members.every((member) => member.kind === 'agent'))!;
  expect(runtime.conversations('owner')).toHaveLength(2);
  expect(runtime.messages(1, 'owner')).toHaveLength(1);
  expect(runtime.messages(2, 'owner')).toHaveLength(0);
  expect(runtime.conversationMessages(peer.id, 'owner', 1)).toEqual(runtime.conversationMessages(peer.id, 'owner', 2));
  expect(runtime.conversationMessages(peer.id, 'owner', 1).map((message) => message.content)).toEqual(['你负责什么？', '我负责代码']);
  expect(() => runtime.conversationMessages(peer.id, 'owner')).toThrow('无权');
  expect(() => runtime.sendMessage(peer.id, 'owner', { content: '冒充成员', idempotencyKey: 'no' })).toThrow();
  expect(() => runtime.conversationMessages(peer.id, 'other', 1)).toThrow();
});

it('同一个 Agent 顺序处理会话，新到来消息不能被旧批次提前消费', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requests: ModelCompletionRequest[] = [];
  let concurrent = 0;
  const { runtime } = await setup(async (request) => {
    concurrent++; expect(concurrent).toBe(1);
    requests.push(request);
    if (requests.length === 1) await gate;
    concurrent--;
    return silent;
  });
  const id = await agent(runtime, '小研');
  const direct = runtime.directConversation(id, 'owner');
  const group = runtime.createConversation({ ownerId: 'owner', workspaceId: 'work', kind: 'group',
    title: '项目群', members: [{ kind: 'user', id: 'owner' }, { kind: 'agent', id }] });
  runtime.start();
  runtime.submit(id, 'owner', '私聊第一条', 'first');
  await until(() => requests.length === 1);
  runtime.sendMessage(group.id, 'owner', { content: '群里的资料', idempotencyKey: 'group' });
  runtime.submit(id, 'owner', '运行中到达', 'second');
  release!();
  await until(() => requests.length === 3 && processed(runtime, direct.id) && processed(runtime, group.id));
  expect(JSON.stringify(requests[0])).not.toContain('运行中到达');
  const groupRequest = requests.find((request) => parse(request).conversation.id === group.id)!;
  expect(JSON.stringify(parse(groupRequest).context)).not.toContain('私聊第一条');
  expect(JSON.stringify(parse(groupRequest).context)).not.toContain('运行中到达');
  expect(requests.filter((request) => parse(request).conversation.id === direct.id)).toHaveLength(2);
});

it('群聊只被点名时参与，不相关 Agent 保持休眠，回复引用也能点名原发送者', async () => {
  const requests: ModelCompletionRequest[] = [];
  const { runtime } = await setup((request) => {
    requests.push(request);
    const input = parse(request);
    return { kind: 'send_message', conversationId: input.conversation.id, content: '我补充一次', finish: true };
  });
  await agent(runtime, '甲'); await agent(runtime, '乙');
  const group = runtime.createConversation({ ownerId: 'owner', workspaceId: 'work', kind: 'group',
    participation: 'mentioned', members: [{ kind: 'user', id: 'owner' }, { kind: 'agent', id: 1 }, { kind: 'agent', id: 2 }] });
  runtime.start();
  runtime.sendMessage(group.id, 'owner', { content: '普通通知', idempotencyKey: 'notice' });
  runtime.sendMessage(group.id, 'owner', { content: '请甲回答', mentions: [1], idempotencyKey: 'mention' });
  await until(() => requests.length === 1 && processed(runtime, group.id));
  expect(parse(requests[0]!).self.id).toBe(1);
  const replyTo = runtime.conversationMessages(group.id, 'owner').at(-1)!.id;
  runtime.sendMessage(group.id, 'owner', { content: '再补充', replyTo, idempotencyKey: 'reply' });
  await until(() => requests.length === 2 && processed(runtime, group.id));
  expect(requests.map((request) => parse(request).self.id)).toEqual([1, 1]);
  expect(runtime.inspect(2, 'owner').control.state).toBe('SLEEPING');
  expect(() => runtime.sendMessage(group.id, 'owner', { content: '越界', mentions: [99], idempotencyKey: 'bad' })).toThrow();
  expect(() => runtime.sendMessage(runtime.directConversation(2, 'owner').id, 'owner',
    { content: '越界引用', replyTo, idempotencyKey: 'bad-reference' })).toThrow();
});

it('发件后 Context 提交失败，重启重放原批次不重复发言，继续保留其他未处理消息', async () => {
  let calls = 0;
  const { runtime, options } = await setup((request) => {
    calls++;
    return { kind: 'send_message', conversationId: parse(request).conversation.id, content: '已收到', finish: true };
  });
  const id = await agent(runtime, '恢复测试');
  const conversation = runtime.directConversation(id, 'owner');
  const original = SqliteContextStore.prototype.commit;
  const spy = vi.spyOn(SqliteContextStore.prototype, 'commit').mockImplementation(function (this: SqliteContextStore, ...args) {
    if (args[4].some((receipt) => receipt.key.startsWith('round:'))) throw new Error('模拟发件后断电');
    return original.apply(this, args);
  });
  runtime.start();
  runtime.submit(id, 'owner', '第一条', 'first');
  await until(() => !runtime.isReady());
  spy.mockRestore();
  await runtime.close();
  const restored = createAgentRuntime(options);
  cleanup.push(() => restored.close());
  await restored.initialize();
  restored.start();
  await until(() => processed(restored, conversation.id));
  expect(calls).toBe(1);
  expect(restored.messages(id, 'owner').map((message) => message.content)).toEqual(['第一条', '已收到']);
  restored.submit(id, 'owner', '重启后第二条', 'second');
  await until(() => calls === 2 && processed(restored, conversation.id));
  expect(restored.messages(id, 'owner')).toHaveLength(4);
});

it('持久窗口恢复、发送幂等和跨会话共享自动预算由宿主约束', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-store-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'chat.sqlite');
  let store = new ConversationStore(database, { quietMs: 5, maxWaitMs: 15, maxAutomaticMessages: 2 });
  const dm = store.create({ ownerId: 'owner', workspaceId: 'work', kind: 'direct',
    members: [{ kind: 'user', id: 'owner' }, { kind: 'agent', id: 1 }] });
  const peers = store.create({ ownerId: 'owner', workspaceId: 'work', kind: 'direct',
    members: [{ kind: 'agent', id: 1 }, { kind: 'agent', id: 2 }] });
  const input = { content: '用户推动', idempotencyKey: 'input' };
  const user = store.send(dm.id, { kind: 'user', id: 'owner' }, input);
  expect(store.send(dm.id, { kind: 'user', id: 'owner' }, input)).toEqual(user);
  expect(() => store.send(dm.id, { kind: 'user', id: 'owner' }, { ...input, content: '不同正文' })).toThrow('幂等');
  store.close();
  store = new ConversationStore(database, { quietMs: 5, maxWaitMs: 15, maxAutomaticMessages: 2 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const batch = store.seal(1, 20000)!;
    expect(batch.messages).toEqual([user]);
    const first = { content: '请求', idempotencyKey: 'send1' };
    expect(() => store.send(peers.id, { kind: 'agent', id: 1 }, first, batch.phaseId, 100)).toThrow('投递容量');
    expect(store.messages(peers.id)).toEqual([]);
    const sent = store.send(peers.id, { kind: 'agent', id: 1 }, first, batch.phaseId);
    expect(store.send(peers.id, { kind: 'agent', id: 1 }, first, batch.phaseId)).toEqual(sent);
    store.send(peers.id, { kind: 'agent', id: 2 }, { content: '答复', idempotencyKey: 'send2' }, sent.phaseId);
    expect(() => store.send(dm.id, { kind: 'agent', id: 1 },
      { content: '不能重置额度', idempotencyKey: 'send3' }, sent.phaseId)).toThrow('预算');
    expect(store.messages(dm.id)).toHaveLength(1);
    expect(store.messages(peers.id)).toHaveLength(2);
    store.delivered(batch.id); store.acknowledge(batch.id);
    expect(store.mailboxes(dm.id)[0]?.processedSequence).toBe(user.sequence);
  } finally { store.close(); }
});

it('两个 Agent 即使持续互相回复也由共享预算暂停，不污染用户私聊', async () => {
  const { runtime } = await setup((request) => {
    const input = parse(request);
    return { kind: 'send_message', conversationId: input.conversation.members.some((member) => member.kind === 'user')
      ? 'peer:agent-2' : input.conversation.id, content: '无止境互相确认', finish: true };
  });
  await agent(runtime, '甲'); await agent(runtime, '乙');
  runtime.start(); runtime.submit(1, 'owner', '开始协作', 'start');
  await until(() => runtime.list('owner').some((item) => item.status === 'paused'));
  const peer = runtime.agentConversations(1, 'owner').find((item) => item.members.every((member) => member.kind === 'agent'))!;
  expect(runtime.conversationMessages(peer.id, 'owner', 1)).toHaveLength(12);
  expect(runtime.messages(1, 'owner').map((message) => message.content)).toEqual(['开始协作']);
  expect(runtime.messages(2, 'owner')).toEqual([]);
  expect(runtime.interrupts(1, 'owner').some((interrupt) => interrupt.message.includes('预算'))).toBe(true);
  expect(runtime.isReady()).toBe(true);
});

it('已封存但尚未通知调度器的批次可恢复，静默之后重启不重复处理', async () => {
  let requests = 0;
  const { runtime, options } = await setup(() => { requests++; return silent; });
  const id = await agent(runtime, '排队恢复');
  const conversation = runtime.directConversation(id, 'owner');
  runtime.submit(id, 'owner', '持久排队', 'queued');
  await runtime.close();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const mailbox = new ConversationStore(options.database);
  const batch = mailbox.seal(id, 20000);
  expect(batch?.status).toBe('queued');
  mailbox.close();
  let restored = createAgentRuntime(options);
  try {
    await restored.initialize(); restored.start();
    await until(() => requests === 1 && processed(restored, conversation.id));
    await restored.close();
    restored = createAgentRuntime(options);
    await restored.initialize(); restored.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(requests).toBe(1);
    expect(processed(restored, conversation.id)).toBe(true);
  } finally { await restored.close(); }
});

it('发言并结束不能越过未完成任务，模型猜测会话不能冒充成员', async () => {
  let calls = 0;
  const { runtime } = await setup((request) => {
    calls++;
    return calls === 1 ? { kind: 'context', decision: { type: 'plan', objectives: ['尚未执行'] } }
      : { kind: 'send_message', conversationId: parse(request).conversation.id, content: '虚假完成', finish: true };
  });
  const id = await agent(runtime, '未完成');
  runtime.start(); runtime.submit(id, 'owner', '任务', 'task');
  await until(() => runtime.inspect(id, 'owner').status === 'paused');
  expect(runtime.messages(id, 'owner')).toHaveLength(1);
  expect(runtime.interrupts(id, 'owner').at(-1)?.kind).toBe('protocol');
  expect(runtime.inspect(id, 'owner').control.context.level1.taskChain.tasks[0]?.state).toBe('WAITING');

  const other = await setup(() => ({ kind: 'send_message', conversationId: 'guessed-conversation',
    content: '不应发送', finish: true }));
  const otherId = await agent(other.runtime, '权限测试');
  other.runtime.start(); other.runtime.submit(otherId, 'owner', '任务', 'task');
  await until(() => other.runtime.inspect(otherId, 'owner').status === 'paused');
  expect(other.runtime.isReady()).toBe(true);
  expect(other.runtime.interrupts(otherId, 'owner').at(-1)?.kind).toBe('permission');
});
