import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  createAgentRuntime, defaultTokenSettings, type AgentRuntimeOptions, type RuntimeTokenSettings,
} from '../../src/agent-runtime/index.js';
import { SqliteContextStore, estimateContextTokens } from '../../src/agent-context/index.js';
import type { ModelCompletionRequest } from '../../src/model-requester/index.js';
import { DesktopService } from '../../desktop-next/main/service.js';
import { tokenPresets } from '../../desktop-next/shared/tokens.js';
import { nativeMessage } from '../fixtures/native-message.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'runtime-tokens-'));
  cleanup.push(() => rm(path, { force: true, recursive: true }));
  return path;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待容量配置验证超时。');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const silent = { kind: 'context', decision: { type: 'finish_turn' } };
const enlarged: RuntimeTokenSettings = { ...tokenPresets['1M'], maxOutputTokens: 65_536 };

it('默认大容量请求超过旧60K上限，输出上限传给模型；自定义设置保存并在重启后生效', async () => {
  const path = await directory();
  const requests: ModelCompletionRequest[] = [];
  const options: AgentRuntimeOptions = {
    database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    requester: { provider: 'minimax', model: 'fake', async request(request) {
      requests.push(request);
      return { provider: 'minimax', model: 'fake', finishReason: 'stop',
        message: nativeMessage(silent),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    } },
    conversationPolicy: { quietMs: 1, maxWaitMs: 2 },
  };
  let runtime = createAgentRuntime(options);
  cleanup.push(() => runtime.close());
  await runtime.initialize();
  const agent = await runtime.createAgent({ ownerId: 'owner', workspaceId: 'work', character: 'coordinator',
    objective: '长期协作', instructions: ['详细项目背景'.repeat(3500)], capabilities: [], startMode: 'on_message' });
  expect(runtime.tokenSettings()).toEqual(defaultTokenSettings);
  const id = agent.control.agentId;
  runtime.start();
  runtime.submit(id, 'owner', '理解背景', 'first');
  expect(() => runtime.configureTokens(enlarged)).toThrow('暂停');
  await until(() => runtime.inspect(id, 'owner').control.state === 'SLEEPING' && requests.length === 1);
  expect(estimateContextTokens(requests[0])).toBeGreaterThan(60_000);
  expect(requests[0]?.maxOutputTokens).toBe(32_768);
  runtime.configureTokens(enlarged);
  expect(runtime.tokenSettings()).toEqual(enlarged);
  const contexts = new SqliteContextStore(options.database);
  for (const key of contexts.keys()) expect(contexts.load(key)?.context.level1.budget.maxTokens).toBe(300_000);
  contexts.close();
  expect(() => runtime.configureTokens({ ...enlarged, tokensPerMinute: 100 })).toThrow();
  expect(() => runtime.configureTokens({ ...enlarged,
    contextMaxTokens: 9000, contextCompactAtTokens: 7000, contextTargetTokens: 3000 })).toThrow('已有现场');
  expect(runtime.isReady()).toBe(true);
  expect(runtime.tokenSettings()).toEqual(enlarged);
  await runtime.close();
  runtime = createAgentRuntime(options);
  await runtime.initialize();
  expect(runtime.tokenSettings()).toEqual(enlarged);
  runtime.start();
  runtime.submit(id, 'owner', '继续', 'second');
  await until(() => requests.length === 2 && runtime.inspect(id, 'owner').control.state === 'SLEEPING');
  expect(requests[1]?.maxOutputTokens).toBe(65_536);
});

it('总结耗尽后提高容量、重启、显式继续可完成原总结，不重做业务且仍保留有限重试', async () => {
  const path = await directory();
  let success = false;
  let businessCalls = 0;
  const summaryRequests: ModelCompletionRequest[] = [];
  const options: AgentRuntimeOptions = {
    database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    tokenSettings: { ...defaultTokenSettings, maxOutputTokens: 4000 },
    limits: { retryBaseMs: 1, requestsPerMinute: 1000 },
    conversationPolicy: { quietMs: 1, maxWaitMs: 2 },
    requester: { provider: 'minimax', model: 'fake', async request(request) {
      const summary = request.tools?.some((tool) => tool.name === 'submit_summary');
      const view = JSON.parse(String(request.messages[1]?.content)) as {
        sourceRef?: string; context?: { frames: object[] };
      };
      if (summary) {
        summaryRequests.push(request);
        if (!success) return { provider: 'minimax', model: 'fake', finishReason: 'length',
          message: { role: 'assistant', content: '{"outcome":', toolCalls: [] },
          usage: { inputTokens: 1, outputTokens: 4000, totalTokens: 4001 } };
        return { provider: 'minimax', model: 'fake', finishReason: 'tool_calls',
          message: { role: 'assistant', content: '', toolCalls: [{ id: 'summary', name: 'submit_summary',
            arguments: { outcome: '已保留关键信息', observations: [], decisions: [], artifactRefs: [],
              unresolved: [], nextResponsibilities: [], lessonCandidates: [], sourceRefs: [view.sourceRef!] } }] },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      }
      const decisions = [{ type: 'plan', objectives: ['原工作阶段'] }, { type: 'advance' }, { type: 'compact' },
        { type: 'complete' }, { type: 'finish_turn' }];
      const decision = decisions[businessCalls++];
      if (!decision) throw new Error('不应重做业务或额外运行。');
      return { provider: 'minimax', model: 'fake', finishReason: 'stop',
        message: nativeMessage({ kind: 'context', decision }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    } },
  };
  let runtime = createAgentRuntime(options);
  cleanup.push(() => runtime.close());
  await runtime.initialize();
  const id = (await runtime.createAgent({ ownerId: 'owner', workspaceId: 'work', character: 'coordinator',
    objective: '长期协作', capabilities: [], startMode: 'on_message' })).control.agentId;
  runtime.start();
  runtime.submit(id, 'owner', '请处理', 'work');
  await until(() => runtime.inspect(id, 'owner').status === 'paused');
  expect(businessCalls).toBe(3);
  expect(summaryRequests).toHaveLength(4);
  expect(runtime.inspect(id, 'owner').lastError).toContain('被截断');
  const store = new SqliteContextStore(options.database);
  const key = runtime.inspect(id, 'owner').contextKey;
  const previous = store.load(key)!;
  const previousSource = store.read(key, previous.pendingSummary!.sourceRef);
  store.close();
  runtime.configureTokens(enlarged);
  expect(summaryRequests).toHaveLength(4);
  await runtime.close();
  runtime = createAgentRuntime({ ...options, tokenSettings: enlarged });
  await runtime.initialize();
  expect(runtime.inspect(id, 'owner').status).toBe('paused');
  const restored = new SqliteContextStore(options.database);
  expect(restored.read(key, previous.pendingSummary!.sourceRef)).toEqual(previousSource);
  expect(restored.load(key)?.pendingSummary?.purpose).toBe('compact');
  expect(restored.load(key)?.pendingSummary?.attempts).toBe(4);
  restored.close();
  success = true;
  runtime.start();
  runtime.resume(id, 'owner');
  await until(() => runtime.inspect(id, 'owner').control.state === 'SLEEPING');
  expect(businessCalls).toBe(5);
  expect(summaryRequests[4]?.maxOutputTokens).toBe(65_536);
  expect(runtime.events(id, 'owner').filter((event) => event.type === 'summary_retry_requested')).toHaveLength(1);
  expect(runtime.messages(id, 'owner').map((message) => message.content)).toEqual(['请处理']);
});

it('桌面容量配置验证、500K与1M预设及重启持久化，不触发模型或清除未读', async () => {
  const path = await directory();
  const secrets = { available: () => false, encrypt: () => '', decrypt: () => '' };
  let desktop = new DesktopService(path, secrets);
  cleanup.push(() => desktop.close());
  await desktop.initialize();
  const id = await desktop.create({ name: '伙伴', objective: '长期协作',
    character: 'coordinator', workspaceId: null, access: 'none' });
  const before = desktop.snapshot();
  expect(before.settings.tokens).toEqual(tokenPresets['500K']);
  desktop.saveModel({ mode: 'demo', model: 'demo', apiKey: '', tokens: enlarged });
  expect(desktop.snapshot().settings.tokens).toEqual(enlarged);
  expect(desktop.snapshot().contacts.find((item) => item.id === id)?.rounds).toBe(0);
  expect(desktop.snapshot().conversations).toEqual(before.conversations);
  expect(() => desktop.saveModel({ mode: 'demo', model: 'demo', apiKey: '',
    tokens: { ...enlarged, contextTargetTokens: enlarged.contextMaxTokens } })).toThrow();
  expect(desktop.snapshot().settings.tokens).toEqual(enlarged);
  await desktop.close();
  desktop = new DesktopService(path, secrets);
  await desktop.initialize();
  expect(desktop.snapshot().settings.tokens).toEqual(enlarged);
  expect(desktop.snapshot().contacts[0]?.rounds).toBe(0);
});
