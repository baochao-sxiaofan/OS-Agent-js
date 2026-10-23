import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime, type AgentRuntime, type AgentRuntimeOptions, type ConversationRead } from '../../src/agent-runtime/index.js';
import { SqliteContextStore } from '../../src/agent-context/index.js';
import { createModelRequester } from '../../src/model-requester/index.js';
import { ConversationStore } from '../../src/agent-runtime/internal/conversations.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

const wireSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string().nullable() })),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
});
type WireRequest = z.infer<typeof wireSchema>;
const wire = (init?: RequestInit) => wireSchema.parse(JSON.parse(String(init?.body)));
const isCompact = (request: WireRequest) => request.tools.some((tool) => tool.function.name === 'submit_conversation_summary');
function response(name?: string, args = '{}') {
  return Response.json({
    choices: [{ finish_reason: name ? 'tool_calls' : 'stop', message: {
      role: 'assistant', content: '',
      ...(name ? { tool_calls: [{ id: 'fixture-call', type: 'function', function: { name, arguments: args } }] } : {}),
    } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
}
function validSummary(request: WireRequest) {
  const data = z.object({ conversationId: z.string(), messages: z.array(z.object({ id: z.string() })).min(1) })
    .parse(JSON.parse(String(request.messages[1]?.content)));
  return response('submit_conversation_summary', JSON.stringify({
    overview: '已记录当前约定', unresolved: [], quotations: [],
    sourceRefs: [{ conversationId: data.conversationId, messageId: data.messages[0]!.id }],
  }));
}

async function setup(fetchImplementation: typeof fetch, extra: Partial<AgentRuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'memory-release-integration-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const options: AgentRuntimeOptions = {
    database: join(directory, 'runtime.sqlite'), workspaces: { work: directory },
    requester: createModelRequester({ provider: 'deepseek', model: 'fixture-only', apiKey: 'fixture-only-key', fetchImplementation }),
    conversationPolicy: { quietMs: 5, groupQuietMs: 10, maxWaitMs: 20 },
    memoryPolicy: { compactAfterMessages: 1, compactAfterTokens: 100_000, maxSummaryAttempts: 1, failureCooldownMs: 1 },
    limits: { maxRetries: 1, retryBaseMs: 1, requestsPerMinute: 1000, tokensPerMinute: 5_000_000, maxTotalTokens: 5_000_000 },
    ...extra,
  };
  const runtime = createAgentRuntime(options);
  cleanup.push(() => runtime.close());
  await runtime.initialize();
  const id = (await runtime.createAgent({ ownerId: 'owner', workspaceId: 'work', character: 'coordinator',
    objective: '处理当前消息', capabilities: [], startMode: 'on_message' })).control.agentId;
  return { runtime, options, id, conversationId: runtime.directConversation(id, 'owner').id };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待发布记忆回归超时。');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const processed = (runtime: AgentRuntime, conversationId: string) =>
  runtime.conversationMailboxes(conversationId, 'owner').every((mailbox) => mailbox.state === 'processed');
function memoryState(database: string, conversationId: string) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return {
      failures: db.prepare('SELECT covered,attempts,retry_at FROM memory_failures WHERE conversation_id=?').all(conversationId),
      rounds: db.prepare("SELECT body,outcome FROM memory_rounds WHERE json_extract(body,'$.kind')='compact'").all(),
    };
  } finally { db.close(); }
}

it.each(['缺少调用', '错误工具', '无效参数'] as const)('真实 requester 的%s记入摘要失败后继续工作，重启仍受失败上限约束', async (mode) => {
  let compactions = 0;
  let works = 0;
  const { runtime, options, id, conversationId } = await setup(async (_url, init) => {
    if (isCompact(wire(init))) {
      compactions++;
      if (mode === '缺少调用') return response();
      if (mode === '错误工具') return response('context_finish_turn');
      return response('submit_conversation_summary', '{');
    }
    works++;
    return response('context_finish_turn');
  });
  runtime.submit(id, 'owner', '必须保留的原文', 'first');
  runtime.start();
  await until(() => works === 1 && processed(runtime, conversationId));
  expect(compactions).toBe(1);
  expect(runtime.inspect(id, 'owner')).toMatchObject({ status: 'active', rounds: 2 });
  expect(runtime.interrupts(id, 'owner')).toEqual([]);
  expect(runtime.conversationSummary(conversationId, 'owner')).toBeNull();
  const state = memoryState(options.database, conversationId);
  expect(state.failures).toEqual([{ covered: 0, attempts: 1, retry_at: expect.any(Number) }]);
  expect(state.rounds).toHaveLength(1);
  expect(state.rounds[0]?.outcome).toBe('invalid_summary');
  await runtime.close();
  const restored = createAgentRuntime(options);
  cleanup.push(() => restored.close());
  await restored.initialize();
  restored.submit(id, 'owner', '重启后的普通工作', 'second');
  restored.start();
  await until(() => works === 2 && processed(restored, conversationId));
  expect(compactions).toBe(1);
  expect(memoryState(options.database, conversationId).failures).toEqual(state.failures);
  expect(restored.conversationMessages(conversationId, 'owner').map((message) => message.content))
    .toEqual(['必须保留的原文', '重启后的普通工作']);
});

it('失败结果已落盘但轮次回执提交中断，恢复不重复摘要请求或累计失败', async () => {
  let compactions = 0;
  let works = 0;
  const { runtime, options, id, conversationId } = await setup(async (_url, init) => {
    if (isCompact(wire(init))) { compactions++; return response(); }
    works++; return response('context_finish_turn');
  });
  const original = SqliteContextStore.prototype.commit;
  const spy = vi.spyOn(SqliteContextStore.prototype, 'commit').mockImplementation(function (this: SqliteContextStore, ...args) {
    if (args[4].some((receipt) => receipt.key.startsWith('round:'))) throw new Error('模拟轮次回执提交中断');
    return original.apply(this, args);
  });
  runtime.submit(id, 'owner', '重放仍是辅助摘要', 'first');
  runtime.start();
  await until(() => !runtime.isReady());
  expect(memoryState(options.database, conversationId).rounds[0]?.outcome).toBe('invalid_summary');
  spy.mockRestore();
  await runtime.close();
  const restored = createAgentRuntime(options);
  cleanup.push(() => restored.close());
  await restored.initialize(); restored.start();
  await until(() => works === 1 && processed(restored, conversationId));
  expect(compactions).toBe(1);
  expect(memoryState(options.database, conversationId).failures[0]?.attempts).toBe(1);
});

it('摘要 429 仍走 Runtime 网络退避并重放固定请求，不写格式失败', async () => {
  const requests: WireRequest[] = [];
  let works = 0;
  const { runtime, options, id, conversationId } = await setup(async (_url, init) => {
    const request = wire(init);
    if (isCompact(request)) {
      requests.push(request);
      if (requests.length === 1) return Response.json({ error: { message: 'fixture-rate-limit' } },
        { status: 429, headers: { 'retry-after': '0' } });
      return validSummary(request);
    }
    works++; return response('context_finish_turn');
  });
  runtime.submit(id, 'owner', '网络重试的固定原文', 'first'); runtime.start();
  await until(() => works === 1 && processed(runtime, conversationId));
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(runtime.interrupts(id, 'owner')).toMatchObject([{ kind: 'network', action: 'retry' }]);
  expect(runtime.inspect(id, 'owner').rounds).toBe(3);
  expect(runtime.conversationSummary(conversationId, 'owner')?.version).toBe(1);
  expect(memoryState(options.database, conversationId).failures).toEqual([]);
});

it('摘要请求前预算不足仍暂停，不能计成格式失败或发出模型请求', async () => {
  let calls = 0;
  const { runtime, options, id, conversationId } = await setup(async () => {
    calls++; return response();
  }, { limits: { maxTotalTokens: 1 } });
  runtime.submit(id, 'owner', '预算不足', 'first'); runtime.start();
  await until(() => runtime.inspect(id, 'owner').status === 'paused');
  expect(calls).toBe(0);
  expect(runtime.interrupts(id, 'owner')).toMatchObject([{ kind: 'budget', action: 'pause' }]);
  expect(memoryState(options.database, conversationId).failures).toEqual([]);
  expect(memoryState(options.database, conversationId).rounds[0]?.outcome).toBeNull();
});

it('格式失败仍消耗共享工作轮预算，普通工作不能绕过额度', async () => {
  let compactions = 0;
  let works = 0;
  const { runtime, options, id, conversationId } = await setup(async (_url, init) => {
    if (isCompact(wire(init))) { compactions++; return response(); }
    works++; return response('context_finish_turn');
  }, { limits: { maxRounds: 1 } });
  runtime.submit(id, 'owner', '只有一轮额度', 'first'); runtime.start();
  await until(() => runtime.inspect(id, 'owner').status === 'paused');
  expect(compactions).toBe(1);
  expect(works).toBe(0);
  expect(runtime.inspect(id, 'owner').rounds).toBe(1);
  expect(runtime.interrupts(id, 'owner')).toMatchObject([{ kind: 'budget', action: 'pause' }]);
  expect(memoryState(options.database, conversationId).failures[0]?.attempts).toBe(1);
});

it('取消在途摘要仍取消 Agent，不记录格式失败或进入普通工作', async () => {
  let compactions = 0;
  let works = 0;
  const { runtime, options, id, conversationId } = await setup(async (_url, init) => {
    if (!isCompact(wire(init))) { works++; return response('context_finish_turn'); }
    compactions++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  });
  runtime.submit(id, 'owner', '取消中的摘要', 'first'); runtime.start();
  await until(() => compactions === 1);
  await runtime.cancel(id, 'owner');
  expect(runtime.inspect(id, 'owner').status).toBe('cancelled');
  expect(works).toBe(0);
  expect(memoryState(options.database, conversationId).failures).toEqual([]);
  expect(memoryState(options.database, conversationId).rounds[0]?.outcome).toBeNull();
});

it('失败记录事务落盘异常仍 fail-stop，失败次数和轮次结果原子回滚', async () => {
  let compactions = 0;
  let works = 0;
  const { runtime, options, id, conversationId } = await setup(async (_url, init) => {
    if (isCompact(wire(init))) { compactions++; return response(); }
    works++; return response('context_finish_turn');
  });
  const db = new DatabaseSync(options.database);
  try {
    db.exec(`CREATE TRIGGER reject_memory_outcome BEFORE UPDATE OF outcome ON memory_rounds
      BEGIN SELECT RAISE(ABORT,'模拟记忆结果存储故障'); END;`);
    runtime.submit(id, 'owner', '存储故障保留现场', 'first'); runtime.start();
    await until(() => !runtime.isReady());
    expect(compactions).toBe(1);
    expect(works).toBe(0);
    const state = memoryState(options.database, conversationId);
    expect(state.failures).toEqual([]);
    expect(state.rounds[0]?.outcome).toBeNull();
    db.exec('DROP TRIGGER reject_memory_outcome');
  } finally { db.close(); }
  await runtime.close();
  const restored = createAgentRuntime(options);
  cleanup.push(() => restored.close());
  await restored.initialize(); restored.start();
  await until(() => works === 1 && processed(restored, conversationId));
  expect(compactions).toBe(2);
  expect(memoryState(options.database, conversationId).failures[0]?.attempts).toBe(1);
});

it.each(['点名', '定向回复'] as const)('%s的群邮箱截止不被普通消息延后，封存后恢复普通聚合窗口', async (mode) => {
  const directory = await mkdtemp(join(tmpdir(), 'mailbox-release-integration-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new ConversationStore(join(directory, 'chat.sqlite'));
  cleanup.push(() => store.close());
  const clock = vi.spyOn(Date, 'now').mockReturnValue(500);
  const conversation = store.create({ ownerId: 'owner', workspaceId: 'work', kind: 'group', participation: 'all',
    members: [{ kind: 'user', id: 'owner' }, { kind: 'agent', id: 1 }] });
  const earlier = store.send(conversation.id, { kind: 'agent', id: 1 },
    { content: '可定向回复的 Agent 原文', idempotencyKey: 'earlier' }, 'fixture-phase');
  clock.mockReturnValue(1000);
  store.send(conversation.id, { kind: 'user', id: 'owner' }, { content: '立即处理', idempotencyKey: 'addressed',
    ...(mode === '点名' ? { mentions: [1] } : { replyTo: earlier.id }) });
  expect(store.due(1)).toBe(1500);
  for (const at of [1100, 1400]) {
    clock.mockReturnValue(at);
    store.send(conversation.id, { kind: 'user', id: 'owner' }, { content: '普通群消息', idempotencyKey: `ordinary-${at}` });
    expect(store.due(1)).toBe(1500);
  }
  clock.mockReturnValue(1500);
  const batch = store.seal(1, 20_000)!;
  expect(batch.messages).toHaveLength(4);
  store.acknowledge(batch.id);
  clock.mockReturnValue(1600);
  store.send(conversation.id, { kind: 'user', id: 'owner' }, { content: '新聚合窗口', idempotencyKey: 'new-window' });
  expect(store.due(1)).toBe(2800);
});

it('普通群流量仍使用长静默窗口，后续点名可以提前，重复点名仍受首次最大等待上限约束', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mailbox-cap-integration-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new ConversationStore(join(directory, 'chat.sqlite'));
  cleanup.push(() => store.close());
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const conversation = store.create({ ownerId: 'owner', workspaceId: 'work', kind: 'group',
    members: [{ kind: 'user', id: 'owner' }, { kind: 'agent', id: 1 }] });
  const send = (at: number, mentions: number[] = []) => {
    clock.mockReturnValue(at);
    store.send(conversation.id, { kind: 'user', id: 'owner' }, { content: '聚合消息', idempotencyKey: `at-${at}`, mentions });
  };
  send(1000); expect(store.due(1)).toBe(2200);
  send(1100); expect(store.due(1)).toBe(2300);
  send(1200, [1]); expect(store.due(1)).toBe(1700);
  send(1500, [1]); expect(store.due(1)).toBe(2000);
  send(2800, [1]); expect(store.due(1)).toBe(3000);
  send(2900); expect(store.due(1)).toBe(3000);
});

it('公开 ID 读取统一应用序号上下界，分页保留范围且不返回后续原文或修改邮箱', async () => {
  const { runtime, conversationId } = await setup(async () => response('context_finish_turn'));
  const first = runtime.sendMessage(conversationId, 'owner', { content: '第一条长原文'.repeat(150), idempotencyKey: 'first' });
  const second = runtime.sendMessage(conversationId, 'owner', { content: '固定范围内第二条', idempotencyKey: 'second' });
  const third = runtime.sendMessage(conversationId, 'owner', { content: '范围外新原文', idempotencyKey: 'third' });
  const before = runtime.conversationMailboxes(conversationId, 'owner');
  expect(runtime.readConversation('owner', { conversationId, messageId: third.id, throughSequence: second.sequence }))
    .toEqual({ messages: [], next: null, truncated: false });
  expect(runtime.readConversation('owner', { conversationId, messageId: first.id, afterSequence: first.sequence }))
    .toEqual({ messages: [], next: null, truncated: false });
  expect(() => runtime.readConversation('owner', { conversationId, messageId: 'missing', throughSequence: first.sequence })).toThrow();
  let query: ConversationRead | null = { conversationId, messageId: first.id, afterSequence: 0, throughSequence: second.sequence };
  let content = '';
  let pages = 0;
  while (query) {
    if (++pages > 20) throw new Error('序号范围分页未前进。');
    const result = runtime.readConversation('owner', query);
    expect(result.messages.every((message) => message.sequence <= second.sequence)).toBe(true);
    content += result.messages.map((message) => message.content).join('');
    if (result.next) expect(result.next.throughSequence).toBe(second.sequence);
    query = result.next;
  }
  expect(pages).toBeGreaterThan(2);
  expect(content).toBe(first.content + second.content);
  expect(runtime.readConversation('owner', { conversationId, messageId: second.id, afterSequence: first.sequence,
    throughSequence: second.sequence }).messages[0]?.messageId).toBe(second.id);
  expect(runtime.conversationMailboxes(conversationId, 'owner')).toEqual(before);
});
