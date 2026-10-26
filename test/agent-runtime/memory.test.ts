import { readRuntimeRequest } from '../../src/agent-runtime/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createAgentRuntime, type AgentRuntime, type AgentRuntimeOptions, type ConversationRead, type SetContactNote,
} from '../../src/agent-runtime/index.js';
import { estimateContextTokens, SqliteContextStore } from '../../src/agent-context/index.js';
import { ModelRequesterError, type ModelCompletionRequest } from '../../src/model-requester/index.js';
import { ConversationStore } from '../../src/agent-runtime/internal/conversations.js';
import { ConversationMemoryStore } from '../../src/agent-runtime/internal/memory-store.js';
import { composeMemory, defaultMemoryPolicy } from '../../src/agent-runtime/internal/memory-view.js';
import { digestSchema } from '../../src/agent-runtime/internal/memory-schema.js';
import { parseAction } from '../../src/agent-runtime/internal/protocol.js';
import { nativeMessage } from '../fixtures/native-message.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const silent = { kind: 'context', decision: { type: 'finish_turn' } };
const inputSchema = z.object({
  self: z.object({ id: z.number() }), conversation: z.object({ id: z.string(), members: z.array(z.object({ kind: z.string() })) }),
  currentBatch: z.object({ messageIds: z.array(z.string()) }), context: z.unknown(), crossConversationMemory: z.unknown(),
});
function input(request: ModelCompletionRequest) { return inputSchema.parse(readRuntimeRequest(request)); }
const summaryInput = z.object({
  purpose: z.literal('conversation_compaction'), conversationId: z.string(), throughSequence: z.number(),
  previous: digestSchema.passthrough().nullable(), messages: z.array(z.object({ id: z.string(), content: z.string() })),
});
function digest(request: ModelCompletionRequest) {
  const data = summaryInput.parse(readRuntimeRequest(request));
  const first = data.messages[0]!;
  const ref = { conversationId: data.conversationId, messageId: first.id };
  return { overview: first.content.slice(0, 100), unresolved: [],
    quotations: [{ text: first.content.slice(0, 100), sourceRef: ref }], sourceRefs: [ref] };
}
function compact(request: ModelCompletionRequest) {
  return request.tools?.some((tool) => tool.name === 'submit_conversation_summary');
}
async function setup(work: (request: ModelCompletionRequest) => object | Promise<object>,
  extra: Partial<AgentRuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-memory-'));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const options: AgentRuntimeOptions = { database: join(directory, 'runtime.sqlite'), workspaces: { work: directory },
    limits: { requestsPerMinute: 1000, tokensPerMinute: 5_000_000, maxRetries: 0, maxTotalTokens: 5_000_000 },
    conversationPolicy: { quietMs: 8, maxWaitMs: 20, groupQuietMs: 10 },
    requester: { provider: 'minimax', model: 'test', async request(request) {
      return { provider: 'minimax', model: 'test', finishReason: 'stop',
        message: nativeMessage(await work(request)),
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
    } }, ...extra,
  };
  const runtime = createAgentRuntime(options);
  cleanup.push(() => runtime.close());
  await runtime.initialize();
  return { runtime, options };
}
async function agent(runtime: AgentRuntime, ownerId = 'owner') {
  return (await runtime.createAgent({ ownerId, workspaceId: 'work', character: 'coordinator',
    objective: '处理当前消息', capabilities: [], startMode: 'on_message' })).control.agentId;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待记忆验收超时。');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function processed(runtime: AgentRuntime, id: string, agentId?: number) {
  return runtime.conversationMailboxes(id, 'owner', agentId).every((item) => item.state === 'processed');
}
const noteInput = (id: number): SetContactNote => ({ target: { kind: 'agent', id },
  introduction: '长期协作伙伴', body: '偏好中文。'.repeat(200), tags: ['研发'], unresolved: ['核实方案'],
  sourceRefs: [], expectedVersion: 0, idempotencyKey: 'note-first' });

it('中文全文检索、短词和字面引号命中；分页读取长原文且不影响邮箱', async () => {
  const { runtime } = await setup(() => silent);
  const id = await agent(runtime);
  const dm = runtime.directConversation(id, 'owner').id;
  const text = '很长的说明'.repeat(420) + '暗号是蓝鲸739。';
  const message = runtime.sendMessage(dm, 'owner', { content: text, idempotencyKey: 'long' });
  runtime.sendMessage(dm, 'owner', { content: '再次确认蓝鲸739；字面 " OR * 查询', idempotencyKey: 'another' });
  const before = runtime.conversationMailboxes(dm, 'owner');
  expect(runtime.searchConversations('owner', { query: '蓝鲸739' }).hits).toHaveLength(2);
  expect(runtime.searchConversations('owner', { query: '暗号' }).hits[0]?.messageId).toBe(message.id);
  expect(runtime.searchConversations('owner', { query: '" OR *' }).hits).toHaveLength(1);
  const page = runtime.searchConversations('owner', { query: '蓝鲸739', limit: 1 });
  expect(page.nextBeforeSequence).not.toBeNull();
  expect(runtime.searchConversations('owner', { query: '蓝鲸739', beforeSequence: page.nextBeforeSequence! })
    .hits[0]?.messageId).toBe(message.id);
  expect(runtime.searchConversations('owner', { query: '蓝鲸', sender: { kind: 'agent', id } }).hits).toEqual([]);
  let query: ConversationRead | null = { conversationId: dm, messageId: message.id, throughSequence: message.sequence };
  let collected = '';
  while (query) {
    const read = runtime.readConversation('owner', query);
    expect(estimateContextTokens(read)).toBeLessThan(2600);
    collected += read.messages.map((item) => item.content).join('');
    query = read.next;
  }
  expect(collected).toBe(text);
  expect(runtime.conversationMailboxes(dm, 'owner')).toEqual(before);
});

it('JSON 转义膨胀的原文仍能在预算内搜索并完整分页读取', async () => {
  const { runtime } = await setup(() => silent);
  const id = await agent(runtime);
  const dm = runtime.directConversation(id, 'owner').id;
  const content = '预算边界' + '\u0001'.repeat(900);
  const message = runtime.sendMessage(dm, 'owner', { content, idempotencyKey: 'escaped' });
  const search = runtime.searchConversations('owner', { query: '预算边界' });
  expect(search.hits[0]?.messageId).toBe(message.id);
  expect(estimateContextTokens(search)).toBeLessThan(2600);
  let query: ConversationRead | null = { conversationId: dm, messageId: message.id, throughSequence: message.sequence };
  let collected = '';
  while (query) {
    const result = runtime.readConversation('owner', query);
    expect(result.messages[0]!.content.length).toBeGreaterThan(0);
    expect(estimateContextTokens(result)).toBeLessThan(2600);
    collected += result.messages.map((item) => item.content).join('');
    query = result.next;
  }
  expect(collected).toBe(content);
});

it('长备注按作者隔离、版本冲突、来源越权和幂等重放保留后来的修改', async () => {
  const { runtime } = await setup((request) => {
    if (JSON.stringify(input(request).context).includes('contact_note_set')) return silent;
    return { kind: 'contact_note_set', target: { kind: 'agent', id: 2 }, introduction: 'AI 自己的判断',
      body: '这是 Agent 1 的笔记', tags: ['协作'], unresolved: [], sourceRefs: [], expectedVersion: 0 };
  });
  await agent(runtime); await agent(runtime);
  const other = await agent(runtime, 'other');
  const initial = noteInput(2);
  const first = runtime.setContactNote('owner', initial);
  expect(first.body.length).toBe(1000);
  const second = runtime.setContactNote('owner', { ...initial, body: '用户新版本', expectedVersion: 1, idempotencyKey: 'second' });
  expect(runtime.setContactNote('owner', initial)).toEqual(first);
  expect(runtime.contactNote('owner', { kind: 'agent', id: 2 })).toEqual(second);
  expect(() => runtime.setContactNote('owner', { ...initial, idempotencyKey: 'stale' })).toThrow('版本冲突');
  expect(() => runtime.setContactNote('owner', { ...initial, body: '重复键换内容' })).toThrow('幂等');
  expect(() => runtime.setContactNote('owner', noteInput(other))).toThrow();
  expect(() => runtime.setContactNote('owner', { ...initial, target: { kind: 'user', id: 'invented' } })).toThrow();
  const privateDm = runtime.directConversation(other, 'other').id;
  const message = runtime.sendMessage(privateDm, 'other', { content: '别人的资料', idempotencyKey: 'private' });
  expect(() => runtime.setContactNote('owner', { ...initial, expectedVersion: 2, idempotencyKey: 'bad-source',
    sourceRefs: [{ conversationId: privateDm, messageId: message.id }] })).toThrow();
  expect(() => runtime.readConversation('owner', { conversationId: privateDm })).toThrow();
  expect(runtime.searchConversations('owner', { query: '别人的' }).hits).toEqual([]);
  runtime.start(); runtime.submit(1, 'owner', '请记笔记', 'start');
  await until(() => runtime.contactNote('owner', { kind: 'agent', id: 2 }, 1) !== null &&
    processed(runtime, runtime.directConversation(1, 'owner').id));
  expect(runtime.contactNote('owner', { kind: 'agent', id: 2 }, 1)?.body).toBe('这是 Agent 1 的笔记');
  expect(runtime.contactNote('owner', { kind: 'agent', id: 2 })?.body).toBe('用户新版本');
});

it('暗号可跨会话读取，B 的访问也能在 A 的用户会话查证，B 看不到 A 的用户私聊', async () => {
  let visited = false;
  const { runtime } = await setup((request) => {
    const view = input(request);
    if (view.self.id === 1 && view.conversation.members.every((member) => member.kind === 'agent')) {
      expect(JSON.stringify(view.context)).not.toContain('蓝鲸739');
      expect(JSON.stringify(view.crossConversationMemory)).toContain('蓝鲸739');
      return { kind: 'send_message', conversationId: view.conversation.id, content: '暗号蓝鲸739', finish: true };
    }
    if (view.self.id === 2 && view.conversation.members.some((member) => member.kind === 'user')) {
      expect(JSON.stringify(view.crossConversationMemory)).not.toContain('蓝鲸739');
      return { kind: 'send_message', conversationId: 'peer:agent-1', content: '请告诉我暗号？', finish: true };
    }
    if (view.self.id === 1 && JSON.stringify(view.context).includes('来找你了吗')) {
      expect(JSON.stringify(view.crossConversationMemory)).toContain('请告诉我暗号');
      visited = true;
    }
    return silent;
  });
  await agent(runtime); await agent(runtime);
  runtime.start();
  runtime.submit(1, 'owner', '如果 B 来问你，告诉他暗号蓝鲸739', 'secret');
  await until(() => processed(runtime, runtime.directConversation(1, 'owner').id));
  runtime.submit(2, 'owner', '去找 A 要暗号', 'ask');
  await until(() => runtime.agentConversations(1, 'owner').some((item) => item.members.every((member) => member.kind === 'agent') &&
    runtime.conversationMessages(item.id, 'owner', 1).some((message) => message.content === '暗号蓝鲸739')));
  const peer = runtime.agentConversations(1, 'owner').find((item) => item.members.every((member) => member.kind === 'agent'))!;
  expect(runtime.searchConversations('owner', { query: '请告诉我暗号' }).hits).toEqual([]);
  expect(runtime.searchConversations('owner', { query: '请告诉我暗号' }, 1).hits).toHaveLength(1);
  expect(() => runtime.readConversation('owner', { conversationId: runtime.directConversation(1, 'owner').id }, 2)).toThrow();
  expect(() => runtime.contactNotes('other', 1)).toThrow();
  runtime.submit(1, 'owner', 'B 来找你了吗', 'verify');
  await until(() => visited && processed(runtime, peer.id, 1));
  expect(runtime.messages(1, 'owner')).toHaveLength(2);
});

it('近期视图遵守总预算，截断可见；历史过多时仍可检索，任务现场不复制', async () => {
  const { runtime, options } = await setup(() => silent);
  const id = await agent(runtime);
  const primary = runtime.directConversation(id, 'owner').id;
  for (let i = 0; i < 14; i++) {
    const group = runtime.createConversation({ ownerId: 'owner', workspaceId: 'work', kind: 'group',
      members: [{ kind: 'user', id: 'owner' }, { kind: 'agent', id }], title: `历史群${i}` });
    runtime.sendMessage(group.id, 'owner', { content: `第${i}个记录` + '很长的历史'.repeat(300), idempotencyKey: `m${i}` });
  }
  const chats = new ConversationStore(options.database);
  const store = new ConversationMemoryStore(options.database, chats);
  try {
    store.setNote({ ownerId: 'owner', member: { kind: 'agent', id } }, noteInput(id));
    const identity = { ownerId: 'owner', member: { kind: 'agent' as const, id } };
    for (const budget of [200, 1000, 4000]) {
      const view = composeMemory(store, identity, primary, defaultMemoryPolicy, budget);
      expect(estimateContextTokens(view)).toBeLessThanOrEqual(budget);
      expect(view?.omittedConversations).toBeGreaterThan(0);
    }
    const view = composeMemory(store, identity, primary, defaultMemoryPolicy, 4000)!;
    expect(view.conversations.length).toBeLessThanOrEqual(10);
    expect(view.conversations.some((item) => item.deltaOmitted)).toBe(true);
    expect(store.search(identity, { query: '第0个记录' }).hits).toHaveLength(1);
  } finally { store.close(); chats.close(); }
});

it('压缩固定上界、保留运行中增量，重启后沿已提交版本继续且不重复压缩', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let compactCalls = 0;
  let workCalls = 0;
  const { runtime, options } = await setup(async (request) => {
    if (compact(request)) { compactCalls++; if (compactCalls === 1) await gate; return digest(request); }
    workCalls++; return silent;
  }, { memoryPolicy: { compactAfterMessages: 2, compactAfterTokens: 100_000 } });
  const id = await agent(runtime);
  const dm = runtime.directConversation(id, 'owner').id;
  runtime.submit(id, 'owner', '原始约定蓝鲸739', 'one');
  runtime.submit(id, 'owner', '原始第二条', 'two');
  runtime.start();
  await until(() => compactCalls === 1);
  const fixed = runtime.conversationMessages(dm, 'owner').at(-1)!.sequence;
  runtime.submit(id, 'owner', '压缩期间新到达', 'three');
  release!();
  await until(() => workCalls === 2 && processed(runtime, dm));
  expect(runtime.conversationSummary(dm, 'owner')?.coveredSequence).toBe(fixed);
  expect(runtime.conversationSummary(dm, 'owner')?.version).toBe(1);
  expect(runtime.conversationMessages(dm, 'owner')).toHaveLength(3);
  await runtime.close();
  const restored = createAgentRuntime(options);
  cleanup.push(() => restored.close());
  await restored.initialize(); restored.start();
  restored.submit(id, 'owner', '继续新消息', 'four');
  await until(() => compactCalls === 2 && processed(restored, dm));
  expect(restored.conversationSummary(dm, 'owner')?.version).toBe(2);
});

it('伪造摘要引用和原文不能推进覆盖，失败次数跨重启保留而正常工作继续', async () => {
  let attempts = 0;
  let works = 0;
  const { runtime, options } = await setup((request) => {
    if (compact(request)) {
      attempts++;
      const valid = digest(request);
      return attempts === 1 ? { ...valid, sourceRefs: [{ conversationId: valid.sourceRefs[0]!.conversationId, messageId: 'fake' }] }
        : { ...valid, quotations: [{ text: '原文中不存在的暗号', sourceRef: valid.sourceRefs[0]! }] };
    }
    works++; return silent;
  }, { memoryPolicy: { compactAfterMessages: 1, failureCooldownMs: 1, maxSummaryAttempts: 2 } });
  const id = await agent(runtime);
  const dm = runtime.directConversation(id, 'owner').id;
  runtime.start(); runtime.submit(id, 'owner', '真实原文', 'one');
  await until(() => works === 1 && processed(runtime, dm));
  expect(runtime.conversationSummary(dm, 'owner')).toBeNull();
  await runtime.close();
  const restored = createAgentRuntime(options);
  cleanup.push(() => restored.close());
  await restored.initialize(); restored.start();
  restored.submit(id, 'owner', '第二轮', 'two');
  await until(() => works === 2 && processed(restored, dm));
  restored.submit(id, 'owner', '第三轮', 'three');
  await until(() => works === 3 && processed(restored, dm));
  expect(attempts).toBe(2);
  expect(restored.conversationSummary(dm, 'owner')).toBeNull();
  expect(restored.searchConversations('owner', { query: '真实原文' }, id).hits).toHaveLength(1);
  expect(restored.inspect(id, 'owner').status).toBe('active');
});

it('摘要落盘后 Context 提交断电，重放保持压缩用途且只发一次正常答复', async () => {
  let compactCalls = 0;
  let works = 0;
  const { runtime, options } = await setup((request) => {
    if (compact(request)) { compactCalls++; return digest(request); }
    works++; return { kind: 'send_message', conversationId: input(request).conversation.id, content: '已收到', finish: true };
  }, { memoryPolicy: { compactAfterMessages: 1 } });
  const id = await agent(runtime);
  const dm = runtime.directConversation(id, 'owner').id;
  const original = SqliteContextStore.prototype.commit;
  const spy = vi.spyOn(SqliteContextStore.prototype, 'commit').mockImplementation(function (this: SqliteContextStore, ...args) {
    if (args[4].some((receipt) => receipt.key.startsWith('round:'))) throw new Error('模拟压缩后断电');
    return original.apply(this, args);
  });
  runtime.start(); runtime.submit(id, 'owner', '保存暗号', 'one');
  await until(() => !runtime.isReady());
  spy.mockRestore();
  await runtime.close();
  const restored = createAgentRuntime(options);
  cleanup.push(() => restored.close());
  await restored.initialize(); restored.start();
  await until(() => processed(restored, dm));
  expect(compactCalls).toBe(1);
  expect(works).toBe(1);
  expect(restored.conversationSummary(dm, 'owner')?.version).toBe(1);
  expect(restored.messages(id, 'owner').map((message) => message.content)).toEqual(['保存暗号', '已收到']);
});

it('压缩网络重试继续使用固定原文和统一计量', async () => {
  const requests: ModelCompletionRequest[] = [];
  const { runtime } = await setup((request) => {
    if (compact(request)) {
      requests.push(request);
      if (requests.length === 1) throw new ModelRequesterError('服务繁忙', {
        provider: 'minimax', code: 'http_error', retryable: true, status: 429, retryAfterMs: 40,
      });
      return digest(request);
    }
    return silent;
  }, { memoryPolicy: { compactAfterMessages: 1 },
    limits: { maxRetries: 2, retryBaseMs: 5, requestsPerMinute: 1000, tokensPerMinute: 5_000_000 } });
  const id = await agent(runtime);
  const dm = runtime.directConversation(id, 'owner').id;
  runtime.start(); runtime.submit(id, 'owner', '网络重试资料', 'one');
  await until(() => requests.length === 2 && processed(runtime, dm));
  expect(requests[1]).toEqual(requests[0]);
  expect(runtime.inspect(id, 'owner').rounds).toBe(3);
  expect(runtime.interrupts(id, 'owner')[0]?.kind).toBe('network');
});

it('原生记忆控制函数不能伪造作者，也不能和发言混用', () => {
  const completion = (name: string, args: object) => ({
    provider: 'minimax' as const, model: 'test', finishReason: 'tool_calls' as const,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    message: { role: 'assistant' as const, content: '', toolCalls: [{ id: 'call', name,
      arguments: JSON.parse(JSON.stringify(args)) as Record<string, string> }] },
  });
  expect(parseAction(completion('conversation_search', { query: '暗号' })).kind).toBe('conversation_search');
  expect(() => parseAction(completion('contact_note_set', { ...noteInput(2), author: { kind: 'user', id: 'owner' } }))).toThrow();
  const mixed = completion('conversation_search', { query: '暗号' });
  mixed.message.toolCalls.push({ id: 'second', name: 'message_send', arguments: { content: 'no' } });
  expect(() => parseAction(mixed)).toThrow('混合');
});

it('Agent 写备注后断电，原动作重放不会增加版本或覆盖后续笔记', async () => {
  let calls = 0;
  const { runtime, options } = await setup(() => {
    calls++;
    return calls === 1 ? { kind: 'contact_note_set', target: { kind: 'user', id: 'owner' },
      introduction: '用户习惯', body: '喜欢中文', tags: [], unresolved: [], sourceRefs: [], expectedVersion: 0 } : silent;
  });
  const id = await agent(runtime);
  const dm = runtime.directConversation(id, 'owner').id;
  const original = SqliteContextStore.prototype.commit;
  const spy = vi.spyOn(SqliteContextStore.prototype, 'commit').mockImplementation(function (this: SqliteContextStore, ...args) {
    if (args[4].some((receipt) => receipt.key.startsWith('round:'))) throw new Error('备注写入后断电');
    return original.apply(this, args);
  });
  runtime.start(); runtime.submit(id, 'owner', '请记住偏好', 'one');
  await until(() => !runtime.isReady());
  spy.mockRestore();
  await runtime.close();
  const chats = new ConversationStore(options.database);
  const memory = new ConversationMemoryStore(options.database, chats);
  try {
    const identity = { ownerId: 'owner', member: { kind: 'agent' as const, id } };
    const previous = memory.note(identity, { kind: 'user', id: 'owner' })!;
    memory.setNote(identity, { target: previous.target, introduction: previous.introduction, body: '稍后的新笔记',
      tags: [], unresolved: [], sourceRefs: [], expectedVersion: previous.version, idempotencyKey: 'later' });
  } finally { memory.close(); chats.close(); }
  const restored = createAgentRuntime(options);
  cleanup.push(() => restored.close());
  await restored.initialize(); restored.start();
  await until(() => processed(restored, dm));
  expect(calls).toBe(2);
  expect(restored.contactNote('owner', { kind: 'user', id: 'owner' }, id)?.body).toBe('稍后的新笔记');
  expect(restored.contactNote('owner', { kind: 'user', id: 'owner' }, id)?.version).toBe(2);
});

it('普通轮已缓存回复后新消息达到压缩阈值，恢复仍按普通用途重放', async () => {
  let calls = 0;
  let compressions = 0;
  const { runtime, options } = await setup((request) => {
    if (compact(request)) { compressions++; return digest(request); }
    calls++; return { kind: 'send_message', conversationId: input(request).conversation.id, content: '明确答复', finish: true };
  }, { memoryPolicy: { compactAfterMessages: 2 } });
  const id = await agent(runtime);
  const dm = runtime.directConversation(id, 'owner').id;
  const original = SqliteContextStore.prototype.commit;
  const spy = vi.spyOn(SqliteContextStore.prototype, 'commit').mockImplementation(function (this: SqliteContextStore, ...args) {
    if (args[4].some((receipt) => receipt.key.startsWith('round:'))) throw new Error('普通轮发言后断电');
    return original.apply(this, args);
  });
  runtime.start(); runtime.submit(id, 'owner', '第一次', 'one');
  await until(() => !runtime.isReady());
  spy.mockRestore(); await runtime.close();
  const restored = createAgentRuntime(options);
  cleanup.push(() => restored.close());
  await restored.initialize(); restored.start();
  await until(() => processed(restored, dm));
  expect(compressions).toBe(0);
  expect(calls).toBe(1);
  expect(restored.messages(id, 'owner')).toHaveLength(2);
  restored.submit(id, 'owner', '第二次', 'two');
  await until(() => calls === 2 && processed(restored, dm));
  expect(compressions).toBe(1);
});
