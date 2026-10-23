import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createAgentRuntime, type AgentRuntime } from '../../src/agent-runtime/index.js';
import { ModelRequesterError, type ModelCompletionRequest, type ModelRequester } from '../../src/model-requester/index.js';
import { summary } from '../agent-context/helpers.js';
import { nativeMessage } from '../fixtures/native-message.js';

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const item of close.splice(0).reverse()) await item(); });
const response = (content: object) => ({
  provider: 'minimax' as const, model: 'test', finishReason: 'stop' as const,
  message: nativeMessage(content),
  usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
});
function summarizing(request: ModelCompletionRequest): { sourceRef: string } | null {
  return String(request.messages[0]?.content).includes('独立总结轮')
    ? JSON.parse(String(request.messages[1]?.content)) as { sourceRef: string } : null;
}
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'runtime-recovery-'));
  close.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const input = { ownerId: 'owner', workspaceId: 'work', character: 'code_auditor', objective: '任务', capabilities: [] };

it('持久退避期限跨重启恢复，不立刻请求；成功后休眠', async () => {
  const path = await directory();
  let calls = 0;
  const failing: ModelRequester = {
    provider: 'minimax', model: 'test', async request() {
      calls++; throw new ModelRequesterError('network', { provider: 'minimax', code: 'network_error', retryable: true });
    },
  };
  const options = { database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    limits: { retryBaseMs: 300, requestsPerMinute: 100, tokensPerMinute: 1_000_000 } };
  const first = createAgentRuntime({ ...options, requester: failing });
  close.push(() => first.close());
  await first.initialize();
  const agent = await first.createAgent(input);
  first.start();
  await until(() => first.interrupts(agent.control.agentId, 'owner').length === 1);
  await first.close();
  expect(calls).toBe(1);
  const succeeding: ModelRequester = {
    provider: 'minimax', model: 'test', async request(request) {
      calls++;
      const source = summarizing(request);
      return response(source ? summary(source.sourceRef) : { kind: 'context', decision: { type: 'idle' } });
    },
  };
  const second = createAgentRuntime({ ...options, requester: succeeding });
  close.push(() => second.close());
  await second.initialize();
  second.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(calls).toBe(1);
  await until(() => second.inspect(agent.control.agentId, 'owner').control.state === 'SLEEPING');
  expect(calls).toBe(3);
});

it('已持久完成的业务模型回复不会在恢复后重新请求，总结独立恢复', async () => {
  const path = await directory();
  let calls = 0;
  const model: ModelRequester = {
    provider: 'minimax', model: 'test', async request(request, signal) {
      calls++;
      const source = summarizing(request);
      if (source) return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
      return response({ kind: 'context', decision: { type: 'idle' } });
    },
  };
  const options = { database: join(path, 'runtime.sqlite'), workspaces: { work: path } };
  const first = createAgentRuntime({ ...options, requester: model });
  close.push(() => first.close());
  await first.initialize(); const agent = await first.createAgent(input); first.start();
  await until(() => calls === 2);
  await first.close();
  const restored = createAgentRuntime({ ...options, requester: {
    provider: 'minimax', model: 'test', async request(request) {
      calls++;
      const source = summarizing(request);
      expect(source).not.toBeNull();
      return response(summary(source!.sourceRef));
    },
  } });
  close.push(() => restored.close());
  await restored.initialize();
  // 停机保留暂停批次，宿主显式恢复后继续原总结。
  restored.resume(agent.control.agentId, 'owner');
  restored.start();
  await until(() => restored.inspect(agent.control.agentId, 'owner').control.state === 'SLEEPING');
  expect(calls).toBe(3);
});

it('连续失败与重复动作达到上限后暂停，取消和恢复可观测', async () => {
  const path = await directory();
  const model: ModelRequester = {
    provider: 'minimax', model: 'test', async request() {
      return response({ kind: 'context', decision: { type: 'continue' } });
    },
  };
  const runtime: AgentRuntime = createAgentRuntime({ database: join(path, 'runtime.sqlite'), requester: model,
    workspaces: { work: path }, limits: { repeatedActionLimit: 3 } });
  close.push(() => runtime.close());
  await runtime.initialize(); const agent = await runtime.createAgent(input); runtime.start();
  await until(() => runtime.inspect(agent.control.agentId, 'owner').status === 'paused');
  expect(runtime.interrupts(agent.control.agentId, 'owner').at(-1)?.kind).toBe('loop');
  await runtime.cancel(agent.control.agentId, 'owner');
  expect(runtime.inspect(agent.control.agentId, 'owner').status).toBe('cancelled');
});
