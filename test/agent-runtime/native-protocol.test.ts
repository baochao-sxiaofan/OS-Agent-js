import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createContextView } from '../../src/agent-context/index.js';
import type { AgentWorkRound } from '../../src/agent-round/index.js';
import { parseSummary } from '../../src/agent-round/requests.js';
import { parseAction, requestAction } from '../../src/agent-runtime/internal/protocol.js';
import { createRuntimeCharacters } from '../../src/agent-runtime/internal/characters.js';
import { RuntimeStore } from '../../src/agent-runtime/internal/store.js';
import { withNativeHistory } from '../../src/agent-runtime/internal/native-history.js';
import { defaultLimits, RequestAdmission, trackedRequester } from '../../src/agent-runtime/internal/limits.js';
import type { ModelCompletion, ModelCompletionRequest } from '../../src/model-requester/index.js';
import type { JsonValue } from '../../src/types/json.js';
import { nativeMessage } from '../fixtures/native-message.js';
import { apply, descend, setupContext, summary } from '../agent-context/helpers.js';

const reply = (value: object): ModelCompletion => ({
  provider: 'deepseek', model: 'fixture', finishReason: 'tool_calls', message: nativeMessage(value),
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

it('新响应正文中的动作或总结 JSON 不被执行，原生函数是唯一入口', () => {
  const text = { ...reply({}), finishReason: 'stop' as const, message: {
    role: 'assistant' as const, toolCalls: [], content: JSON.stringify({ kind: 'context', decision: { type: 'finish_turn' } }),
  } };
  expect(() => parseAction(text)).toThrow('缺少原生 tool_calls');
  expect(() => parseSummary({ ...text, message: { ...text.message, content: JSON.stringify(summary('source')) } }))
    .toThrow('原生 submit_summary');
  expect(parseAction(reply({ kind: 'context', decision: { type: 'finish_turn' } })))
    .toEqual({ kind: 'context', decision: { type: 'finish_turn' } });
});

it('升级前已持久化的文本回复可恢复，新请求的文本回复不进入兼容分支', async () => {
  const store = new RuntimeStore(':memory:');
  const saved = { ...reply({}), finishReason: 'stop' as const, message: {
    role: 'assistant' as const, toolCalls: [], content: JSON.stringify({
      kind: 'tools', calls: [{ name: 'file.create', arguments: { path: 'workspace://current/a', content: '原参数' } }],
    }),
  } };
  const input: ModelCompletionRequest = { messages: [{ role: 'user', content: '升级前请求' }] };
  const requester = trackedRequester({
    store, admission: new RequestAdmission(defaultLimits, store), limits: () => defaultLimits, batch: () => 'saved',
    agent: () => { throw new Error('恢复缓存不应重新计费'); }, update: () => { throw new Error('不应更新'); },
    requester: { provider: 'deepseek', model: 'fixture', async request() { throw new Error('不应重新请求'); } },
  });
  try {
    store.putRequest('saved', input); store.putCompletion('saved', saved);
    expect(parseAction(await requester.request(input))).toEqual({
      kind: 'tools', calls: [{ name: 'file.create', arguments: { path: 'workspace://current/a', content: '原参数' } }],
    });
    expect(store.completion('saved')).toEqual(saved);
    store.putMetadata('protocol-version:saved', 2);
    expect(() => parseAction(saved)).toThrow('缺少原生');
    const current = await requester.request(input);
    expect(() => parseAction(current)).toThrow('缺少原生');
  } finally { store.close(); }
});

it('L3 步骤 schema 固定且宿主校验本层来源，父层引用被原子拒绝，实际读取后可引用', async () => {
  const { context } = setupContext();
  descend(context, 3);
  apply(context, { type: 'plan', objectives: ['检查资料'] });
  apply(context, { type: 'advance' });
  const parentRef = context.snapshot().level2!.memory.historyRef!;
  const alias = `r${createHash('sha256').update(parentRef).digest('hex').slice(0, 12)}`;
  let request: ModelCompletionRequest | undefined;
  const invoke = () => requestAction({
    view: createContextView(context.snapshot()), idempotencyKey: 'test-round', signal: undefined,
    run: { batch: { pendingOperations: [] } } as unknown as AgentWorkRound['run'],
    request: async (input) => { request = input; return reply({
      kind: 'context', decision: { type: 'step_completed', result: summary(alias) },
    }); },
  }, { character: createRuntimeCharacters().get('coordinator'), tools: [], peers: [],
    previousError: null, repairAttempt: 0, capabilities: [] });
  const before = context.checkpoint();
  await expect(invoke()).rejects.toThrow('currentStepSourceRefs');
  expect(JSON.stringify(request!.tools!.find((tool) => tool.name === 'context_step_completed'))).not.toContain(alias);
  expect(context.checkpoint()).toEqual(before);
  context.receive([{ key: 'read-parent', target: context.cursor(), entries: [{ id: 'read', createdAt: 2, kind: 'event',
    name: 'artifact_page', data: { ref: parentRef, content: '父层资料' } }] }]);
  context.prepare();
  const action = await invoke();
  expect(JSON.stringify(request!.tools!.find((tool) => tool.name === 'context_step_completed'))).not.toContain(alias);
  for (const tool of request!.tools!) assertLocalReferences(tool.parameters, tool.parameters);
  expect(action).toMatchObject({ kind: 'context', decision: { result: { sourceRefs: [parentRef] } } });
  if (action.kind !== 'context') throw new Error('预期上下文动作。');
  apply(context, action.decision);
  expect(context.snapshot().level3?.taskChain.tasks[0]?.state).toBe('COMPLETED');
});

it('续接只重放完整已提交回执，保持原生 ID 和私有状态，按作用域隔离并整组裁剪', () => {
  const store = new RuntimeStore(':memory:');
  const input: ModelCompletionRequest = { messages: [{ role: 'system', content: '规则' },
    { role: 'user', content: JSON.stringify({ kind: 'runtime_context', view: { objective: '现场' } }) },
    { role: 'user', content: JSON.stringify({ kind: 'runtime_update', changes: [] }) }] };
  let committed = false;
  let secondResult = false;
  const completion = reply({ kind: 'tools', calls: [
    { name: 'file.read', arguments: { path: 'workspace://current/a' } },
    { name: 'file.read', arguments: { path: 'workspace://current/b' } },
  ] });
  completion.message.continuation = { provider: 'deepseek', model: 'fixture', data: { reasoning_content: '私有续接状态' } };
  const next = (key: string, scope = 'agent1:conversation1:L3:deepseek:fixture', maxInput = 2000) => withNativeHistory({
    store, key, scope, request: input, maxInput,
    receipt: () => committed, result: (_key, index) => index === 0 || secondResult ? { result: index } : undefined,
  });
  try {
    store.putRequest('one', next('one')); store.putCompletion('one', completion);
    expect(next('two').messages).toEqual(input.messages);
    committed = true;
    expect(next('three').messages).toEqual(input.messages);
    secondResult = true;
    const paired = next('four').messages;
    expect(paired[3]).toEqual(completion.message);
    expect(paired.slice(4, 6)).toEqual(completion.message.toolCalls.map((call, index) => ({
      role: 'tool', callId: call.id, content: { result: index },
    })));
    for (const scope of ['agent2:conversation1:L3:deepseek:fixture', 'agent1:conversation2:L3:deepseek:fixture',
      'agent1:conversation1:L2:deepseek:fixture', 'agent1:conversation1:L3:minimax:fixture',
      'agent1:conversation1:L3:deepseek:other-model']) expect(next('isolated', scope).messages).toEqual(input.messages);
    expect(next('small', undefined, 200).messages).toEqual(input.messages);
  } finally { store.close(); }
});

/** 服务端从参数根节点解析引用，不能只校验被嵌入的子结构。 */
function assertLocalReferences(value: JsonValue, root: JsonValue): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((item) => assertLocalReferences(item, root)); return; }
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/')) {
    let target: JsonValue | undefined = root;
    for (const encoded of value.$ref.slice(2).split('/')) {
      const key = encoded.replace(/~1/gu, '/').replace(/~0/gu, '~');
      target = target && typeof target === 'object' && !Array.isArray(target) ? target[key] : undefined;
    }
    expect(target, `无法从参数根节点解析 ${value.$ref}`).toBeDefined();
  }
  Object.values(value).forEach((item) => assertLocalReferences(item, root));
}
