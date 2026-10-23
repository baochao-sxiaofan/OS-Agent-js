import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createModelRequester, ModelRequesterError, type ModelCompletion } from '../../src/model-requester/index.js';
import { createAgentRuntime } from '../../src/agent-runtime/index.js';
import { CharacterRegistry } from '../../src/character/character-registry.js';
import { parseSummary, summaryRequest } from '../../src/agent-round/requests.js';
import { validateSummary } from '../../src/agent-context/index.js';
import { classifyFault } from '../../src/agent-runtime/internal/limits.js';
import { apply, setupContext } from '../agent-context/helpers.js';
import { nativeMessage } from '../fixtures/native-message.js';

function completion(value: object): ModelCompletion {
  return { provider: 'minimax', model: 'test', finishReason: 'stop',
    message: nativeMessage(value),
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
}

it('直接工作角色隐藏规划函数并拒绝强行调用，仍可完成工作并休眠', async () => {
  const path = await mkdtemp(join(tmpdir(), 'direct-character-'));
  let requests = 0;
  const runtime = createAgentRuntime({
    database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    characters: new CharacterRegistry([{
      id: 'direct', displayName: '直接工作', promptFragment: '处理当前来信',
      allowPlanning: false, visibleToolIds: [], capabilityCeiling: [],
      requestableCapabilities: [], allowedChildCharacters: [],
    }]),
    requester: { provider: 'minimax', model: 'test', async request(request) {
      expect(request.tools?.map((tool) => tool.name)).not.toContain('context_plan');
      expect(request.tools?.map((tool) => tool.name)).not.toContain('context_replan');
      const payload = JSON.parse(String(request.messages[1]?.content)) as { previousError: string | null };
      if (requests++ === 0) return completion({ kind: 'context', decision: { type: 'plan', objectives: ['不必要的计划'] } });
      expect(payload.previousError).toContain('本角色禁止安装或重建计划');
      return completion({ kind: 'context', decision: { type: 'finish_turn' } });
    } },
    limits: { retryBaseMs: 1 },
  });
  try {
    await runtime.initialize();
    await runtime.createAgent({ ownerId: 'owner', workspaceId: 'work', character: 'direct',
      objective: '直接工作', capabilities: [] });
    runtime.start();
    const deadline = Date.now() + 2000;
    while (runtime.inspect(1, 'owner').control.state !== 'SLEEPING') {
      if (runtime.inspect(1, 'owner').status === 'paused' || Date.now() > deadline) throw new Error('直接工作未完成。');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtime.inspect(1, 'owner').control.context.level2).toBeNull();
    expect(runtime.inspect(1, 'owner').control.context.level1.taskChain.tasks).toEqual([]);
    expect(requests).toBe(2);
  } finally {
    await runtime.close();
    await rm(path, { recursive: true, force: true });
  }
});

it('模型省略空集合时只补列表，核心存储校验仍要求完整结构', () => {
  const sparse = { outcome: '已回复用户', sourceRefs: ['source'] };
  const parsed = parseSummary(completion(sparse));
  expect(parsed).toEqual({ ...sparse, observations: [], decisions: [], artifactRefs: [],
    unresolved: [], nextResponsibilities: [], lessonCandidates: [] });
  expect(() => validateSummary(sparse)).toThrow();
});

it.each([
  { value: { outcome: '结果' }, field: 'sourceRefs' },
  { value: { sourceRefs: ['source'] }, field: 'outcome' },
  { value: { outcome: '结果', sourceRefs: ['source'], artifactRefs: null }, field: 'artifactRefs' },
  { value: { outcome: '结果', sourceRefs: ['source'], decisions: '不是数组' }, field: 'decisions' },
])('不推测必填来源，不容忍显式错误类型：$field', ({ value, field }) => {
  expect(() => parseSummary(completion(value))).toThrow(field);
});

it('补空列表不会绕过事实来源或封存引用检查', () => {
  expect(() => parseSummary(completion({ outcome: '结果', sourceRefs: ['source'],
    observations: [{ kind: 'fact', statement: '没有证据的事实', sourceRefs: [] }] }))).toThrow('事实必须带来源');
  const { context } = setupContext();
  apply(context, { type: 'idle' });
  const pending = context.beginSummaryAttempt();
  const parsed = parseSummary(completion({ outcome: '结果', sourceRefs: ['other-agent-source'] }));
  expect(() => context.commitSummary('round', pending.id, parsed)).toThrow('封存来源');
});

it('总结短编号贯穿请求和各类来源字段，入库只保存本次封存的真实来源', () => {
  const { context } = setupContext();
  const artifact = `artifact://operation/已读取文件/${'ab83'.repeat(16)}`;
  context.receive([{ key: 'read-evidence', entries: [{
    id: 'read-file', createdAt: 1, kind: 'message', role: 'assistant',
    content: '已读取真实资料', attachmentRefs: [artifact],
  }] }]);
  context.prepare();
  apply(context, { type: 'idle' });
  const pending = context.beginSummaryAttempt();
  const request = summaryRequest(context.checkpoint(), 32768);
  const payload = JSON.parse(String(request.messages[1]?.content)) as {
    sourceRef: string; allowedRefs: string[]; frame: { allowedSourceRefs: string[] };
  };
  expect(payload.sourceRef).toBe('s0');
  expect(payload.allowedRefs).toEqual(['s0', 's1']);
  expect(payload.frame.allowedSourceRefs).toEqual(['s1']);
  expect(JSON.stringify(request)).not.toContain(artifact);
  const parsed = parseSummary(completion({
    outcome: '保留资料结论', sourceRefs: ['s0'], artifactRefs: ['s1'],
    observations: [{ kind: 'fact', statement: '真实资料', sourceRefs: ['s1'] }],
    lessonCandidates: [{ statement: '资料可查证', scope: '本次工作', sourceRefs: ['s0', 's1'] }],
  }), pending.allowedRefs);
  context.commitSummary('short-refs', pending.id, parsed);
  expect(context.snapshot().level1.memory.summary).toMatchObject({
    sourceRefs: [pending.sourceRef], artifactRefs: [artifact],
    observations: [{ sourceRefs: [artifact] }],
    lessonCandidates: [{ sourceRefs: [pending.sourceRef, artifact] }],
  });
});

it.each(['s99', 'another-agent-source', 'artifact://operation/拼错哈希'])(
  '短编号映射拒绝未知或越权来源，不猜测相近 URI：%s', (invalid) => {
    expect(() => parseSummary(completion({
      outcome: '结果', sourceRefs: ['s0'],
      observations: [{ kind: 'fact', statement: '来源待验证', sourceRefs: [invalid] }],
    }), ['context-history://this-round'])).toThrow('封存来源');
  });

it('短编号不会补造必需封存来源，已落盘完整 URI 请求仍按严格来源校验恢复', () => {
  const { context } = setupContext();
  apply(context, { type: 'idle' });
  const pending = context.beginSummaryAttempt();
  const parsed = parseSummary(completion({ outcome: '结果', sourceRefs: [] }), pending.allowedRefs);
  expect(() => context.commitSummary('missing-source', pending.id, parsed)).toThrow('本次封存历史');
  const legacy = parseSummary(completion({ outcome: '旧请求结果', sourceRefs: [pending.sourceRef] }), pending.allowedRefs);
  context.commitSummary('legacy-source', pending.id, legacy);
  expect(context.snapshot().level1.memory.summary?.sourceRefs).toEqual([pending.sourceRef]);
});

it('宿主固定绑定所属封存，不补模型事实来源，也不接受其他封存元数据', () => {
  const current = 'context-history://current';
  const artifact = 'artifact://actually-read';
  const result = parseSummary(completion({
    outcome: '实际资料总结', sourceRefs: ['s1'],
    observations: [{ kind: 'fact', statement: '资料中确实存在的结论', sourceRefs: ['s1'] }],
  }), [current, artifact], current);
  expect(result.sourceRefs).toEqual([current, artifact]);
  expect(result.observations[0]?.sourceRefs).toEqual([artifact]);
  expect(() => parseSummary(completion({
    outcome: '未经证实', sourceRefs: [],
    observations: [{ kind: 'fact', statement: '没有依据', sourceRefs: [] }],
  }), [current], current)).toThrow('事实必须带来源');
  expect(() => parseSummary(completion({ outcome: '结果', sourceRefs: [] }),
    [current], 'context-history://another')).toThrow('宿主封存来源');
});

it('真实模型形态的总结省略空 artifactRefs 与 lessonCandidates，仍一次完成并休眠', async () => {
  const path = await mkdtemp(join(tmpdir(), 'live-model-summary-'));
  let requests = 0;
  const runtime = createAgentRuntime({
    database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    requester: { provider: 'minimax', model: 'test', async request(request) {
      requests++;
      if (!request.tools?.some((tool) => tool.name === 'submit_summary')) {
        return completion({ kind: 'output', content: '真实回复形态' });
      }
      const payload = JSON.parse(String(request.messages[1]?.content)) as { sourceRef: string };
      return { ...completion({}), finishReason: 'tool_calls',
        message: { role: 'assistant', content: '', toolCalls: [{ id: 'summary', name: 'submit_summary',
          arguments: { outcome: '已完成对话', observations: [], decisions: [], unresolved: [],
            nextResponsibilities: [], sourceRefs: [payload.sourceRef] } }] } };
    } },
  });
  try {
    await runtime.initialize();
    await runtime.createAgent({ ownerId: 'user', workspaceId: 'work', character: 'coordinator',
      objective: '长期工作', capabilities: [] });
    runtime.start();
    const deadline = Date.now() + 2000;
    while (runtime.inspect(1, 'user').control.state !== 'SLEEPING') {
      if (Date.now() > deadline) throw new Error('总结未完成。');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(requests).toBe(2);
    expect(runtime.interrupts(1, 'user')).toEqual([]);
    expect(runtime.messages(1, 'user')).toHaveLength(0);
    expect(runtime.legacyMessages(1, 'user')).toHaveLength(1);
  } finally { await runtime.close(); await rm(path, { recursive: true, force: true }); }
});

it.each([{ header: null, delay: 30_000 }, { header: '2', delay: 2000 }])(
  '529 默认等待恢复，服务端期限优先：$header', async ({ header, delay }) => {
    const requester = createModelRequester({ provider: 'minimax', model: 'test', apiKey: 'test-only-secret',
      fetchImplementation: async () => new Response(JSON.stringify({ error: { message: 'busy test-only-secret' } }), {
        status: 529, headers: header ? { 'retry-after': header } : {},
      }) });
    let caught: unknown;
    try { await requester.request({ messages: [{ role: 'user', content: 'test' }] }); }
    catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'http_error', status: 529, retryable: true, retryAfterMs: delay });
    const fault = classifyFault(caught);
    expect(fault.message).toContain('模型服务暂时繁忙');
    expect(fault.message).not.toContain('test-only-secret');
    expect(fault.delayUntil).toBeGreaterThanOrEqual(Date.now() + delay - 100);
  });

it('持久错误保留结构化代码，不包含供应商原始敏感文案', () => {
  const error = new ModelRequesterError('sensitive-server-payload', {
    provider: 'minimax', code: 'provider_error', apiCode: 1008, status: 200,
  });
  expect(classifyFault(error).message).toContain('API 1008');
  expect(classifyFault(error).message).not.toContain('sensitive-server-payload');
});
