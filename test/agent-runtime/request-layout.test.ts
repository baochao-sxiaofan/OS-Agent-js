import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAgentRuntime, readRuntimeRequest } from '../../src/agent-runtime/index.js';
import type { ModelCompletionRequest, ModelCompletion } from '../../src/model-requester/index.js';
import { RuntimeStore } from '../../src/agent-runtime/internal/store.js';
import { withNativeHistory } from '../../src/agent-runtime/internal/native-history.js';
import { requestAction } from '../../src/agent-runtime/internal/protocol.js';
import { createRuntimeCharacters } from '../../src/agent-runtime/internal/characters.js';
import { createContextView, estimateContextTokens } from '../../src/agent-context/index.js';
import type { AgentWorkRound } from '../../src/agent-round/index.js';
import { apply, setupContext } from '../agent-context/helpers.js';
import { nativeMessage } from '../fixtures/native-message.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('timeout'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
it('ordinary tool rounds retain the exact request prefix and append only new work with fixed schemas', async () => {
  const path = await mkdtemp(join(tmpdir(), 'request-prefix-'));
  await writeFile(join(path, 'a.txt'), 'original-evidence-A');
  await writeFile(join(path, 'b.txt'), 'new-evidence-B');
  const requests: ModelCompletionRequest[] = [];
  const runtime = createAgentRuntime({ database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    requester: { provider: 'deepseek', model: 'fixture', async request(request) {
      requests.push(structuredClone(request));
      const index = requests.length;
      const message = nativeMessage(index <= 2 ? { kind: 'tools', calls: [{ name: 'file.read',
        arguments: { path: `workspace://current/${index === 1 ? 'a' : 'b'}.txt` } }] }
        : { kind: 'context', decision: { type: 'finish_turn' } });
      message.continuation = { provider: 'deepseek', model: 'fixture', data: { reasoning_content: `private-${index}` } };
      return { provider: 'deepseek', model: 'fixture', message, finishReason: 'tool_calls',
        usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35, cacheHitTokens: index === 1 ? 0 : 20, cacheMissTokens: index === 1 ? 30 : 10 } };
    } },
  });
  try {
    await runtime.initialize();
    await runtime.createAgent({ ownerId: 'owner', workspaceId: 'work', character: 'researcher', objective: 'read both',
      capabilities: [{ capability: 'file.read', scope: { kind: 'subtree', resource: 'workspace://current/' } }] });
    runtime.start(); await until(() => runtime.inspect(1, 'owner').control.state === 'SLEEPING');
    expect(requests).toHaveLength(3);
    for (let i = 1; i < requests.length; i++) {
      const prior = requests[i - 1]!; const next = requests[i]!;
      expect(next.tools).toEqual(prior.tools);
      expect(next.messages.slice(0, prior.messages.length)).toEqual(prior.messages);
      expect(next.messages[prior.messages.length]).toMatchObject({ role: 'assistant', continuation: {
        data: { reasoning_content: `private-${i}` },
      } });
    }
    const latest = readRuntimeRequest(requests[2]!);
    expect(JSON.stringify(latest)).toContain('original-evidence-A');
    expect(JSON.stringify(latest)).toContain('new-evidence-B');
    expect(JSON.stringify(latest)).not.toContain('private-');
    expect(JSON.stringify(requests[2]!.messages.at(-1))).not.toContain('original-evidence-A');
    expect(JSON.stringify(requests[0]!.tools)).not.toContain('allowedSourceRefs');
    expect(runtime.events(1, 'owner').filter((event) => event.type === 'model_completed').map((event) => event.data))
      .toMatchObject([{ cacheHitTokens: 0 }, { cacheHitTokens: 20 }, { cacheHitTokens: 20 }]);
  } finally { await runtime.close(); await rm(path, { recursive: true, force: true }); }
});

it('optional memory fits the final request envelope while preserving required context', async () => {
  const { context } = setupContext();
  let captured: ModelCompletionRequest | undefined;
  const round: AgentWorkRound = {
    view: createContextView(context.snapshot()), idempotencyKey: 'memory-budget', signal: undefined,
    run: { batch: { pendingOperations: [] } } as unknown as AgentWorkRound['run'],
    request: async (request) => {
      captured = request;
      return { provider: 'deepseek', model: 'fixture', finishReason: 'tool_calls',
        message: nativeMessage({ kind: 'context', decision: { type: 'finish_turn' } }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
  };
  const options = { character: createRuntimeCharacters().get('coordinator'), tools: [], peers: [],
    previousError: null, repairAttempt: 0, capabilities: [] };
  await requestAction(round, options);
  const maxInputTokens = estimateContextTokens(captured!) + 1000;
  const budgets: number[] = [];
  await requestAction(round, { ...options, maxInputTokens, memory: (available) => {
    budgets.push(available);
    return { purpose: 'historical_reference_only', tokenBudget: available, omittedConversations: 0,
      conversations: [], omittedNotes: 0, notes: [{ target: { kind: 'user', id: 'owner' }, version: 1,
        introduction: 'reference', tags: [], excerpt: '"\\'.repeat(available), truncated: true }] };
  } });
  expect(budgets.length).toBeGreaterThan(1);
  expect(estimateContextTokens(captured!)).toBeLessThanOrEqual(maxInputTokens);
  expect(readRuntimeRequest(captured!).context).toEqual(round.view);
  expect(readRuntimeRequest(captured!).crossConversationMemory).toMatchObject({ purpose: 'historical_reference_only' });
});

it.each([false, true])('expected action guidance agrees with pending operation state: %s', async (pending) => {
  const { context } = setupContext();
  apply(context, { type: 'plan', objectives: ['planned work'] });
  const expected = pending ? null : 'advance';
  const decision = pending ? 'wait' : 'advance';
  await expect(requestAction({ view: createContextView(context.snapshot()), idempotencyKey: 'expected', signal: undefined,
    run: { batch: { pendingOperations: pending ? [{}] : [] } } as unknown as AgentWorkRound['run'],
    request: async (request) => {
      expect(readRuntimeRequest(request).nextExpectedAction).toBe(expected);
      return { provider: 'deepseek', model: 'fixture', finishReason: 'tool_calls',
        message: nativeMessage({ kind: 'context', decision: { type: decision } }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
  }, { character: createRuntimeCharacters().get('coordinator'), tools: [], peers: [],
    previousError: null, repairAttempt: 0, capabilities: [] })).resolves.toEqual({ kind: 'context', decision: { type: decision } });
});

it('persisted request prefixes survive reopening; capacity or context changes rebase without partial tool pairs', async () => {
  const path = await mkdtemp(join(tmpdir(), 'request-prefix-recovery-'));
  const input: ModelCompletionRequest = { tools: [{ name: 'read', description: 'fixed', parameters: {} }], messages: [
    { role: 'system', content: 'fixed rules' },
    { role: 'user', content: JSON.stringify({ kind: 'runtime_context', view: { objective: 'stage-one' } }) },
    { role: 'user', content: JSON.stringify({ kind: 'runtime_update', changes: [{ path: ['records'], value: ['first'] }] }) },
  ] };
  const completion: ModelCompletion = { provider: 'deepseek', model: 'fixture', finishReason: 'tool_calls',
    message: nativeMessage({ kind: 'tools', calls: [{ name: 'read', arguments: {} }] }),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  let store = new RuntimeStore(join(path, 'runtime.sqlite'));
  const prepare = (key: string, request = input, maxInput = 10000, scope = 'same') => withNativeHistory({
    store, key, request, maxInput, scope, receipt: () => true, result: () => ({ content: 'real result' }),
  });
  try {
    store.putRequest('first', prepare('first')); store.putCompletion('first', completion);
    store.close(); store = new RuntimeStore(join(path, 'runtime.sqlite'));
    const next = prepare('second');
    expect(next.messages.slice(0, input.messages.length)).toEqual(input.messages);
    expect(next.messages[input.messages.length]).toEqual(completion.message);
    expect(prepare('bounded', input, 100).messages).toEqual(input.messages);
    expect(prepare('isolated', input, 10000, 'another-agent').messages).toEqual(input.messages);
    const changed = { ...input, messages: [{ role: 'system' as const, content: 'new rules' }, ...input.messages.slice(1)] };
    expect(prepare('changed', changed).messages).toEqual(changed.messages);
  } finally { store.close(); await rm(path, { recursive: true, force: true }); }
});
