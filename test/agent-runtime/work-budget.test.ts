import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAgentRuntime, type AgentRuntimeOptions } from '../../src/agent-runtime/index.js';
import { ModelRequesterError } from '../../src/model-requester/index.js';
import { nativeMessage } from '../fixtures/native-message.js';

async function until(check: () => boolean) {
  const end = Date.now() + 6000;
  while (!check()) {
    if (Date.now() > end) throw new Error('等待工作额度验证超时。');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
const agent = { ownerId: 'owner', workspaceId: 'work', character: 'coordinator', objective: '长期工作', capabilities: [] };
const silent = { kind: 'context', decision: { type: 'finish_turn' } };
const complete = (value: object) => ({ provider: 'deepseek' as const, model: 'fixture',
  finishReason: 'tool_calls' as const, message: nativeMessage(value),
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });

it('累计超过128次仍可处理新收件批次，工作额度和累计统计跨重启分别保留', async () => {
  const path = await mkdtemp(join(tmpdir(), 'work-lifetime-'));
  const options: AgentRuntimeOptions = {
    database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    requester: { provider: 'deepseek', model: 'fixture', async request() { return complete(silent); } },
    limits: { maxRounds: 1, requestsPerMinute: 1000, tokensPerMinute: 1_000_000_000 },
    memoryPolicy: { compactAfterMessages: 1000, compactAfterTokens: 1_000_000 },
    conversationPolicy: { quietMs: 1, maxWaitMs: 1 },
  };
  let runtime = createAgentRuntime(options);
  try {
    await runtime.initialize(); await runtime.createAgent({ ...agent, startMode: 'on_message' }); runtime.start();
    for (let index = 1; index <= 130; index++) {
      runtime.submit(1, 'owner', `工作${index}`, `work-${index}`);
      await until(() => runtime.inspect(1, 'owner').rounds === index && runtime.inspect(1, 'owner').control.state === 'SLEEPING');
      expect(runtime.inspect(1, 'owner').status).toBe('active');
      if (index === 128) {
        await runtime.close(); runtime = createAgentRuntime(options); await runtime.initialize(); runtime.start();
      }
    }
    expect(runtime.inspect(1, 'owner').totalTokens).toBe(260);
    expect(runtime.interrupts(1, 'owner')).toEqual([]);
  } finally { await runtime.close(); await rm(path, { recursive: true, force: true }); }
}, 20_000);

it('同一工作的重试和重启不会重置额度，显式继续可追加，累计Token不会归零', async () => {
  const path = await mkdtemp(join(tmpdir(), 'work-resume-'));
  let calls = 0;
  const options: AgentRuntimeOptions = {
    database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    limits: { maxRounds: 2, maxRetries: 3, retryBaseMs: 1, tokensPerMinute: 10_000_000 },
    requester: { provider: 'deepseek', model: 'fixture', async request() {
      calls++;
      if (calls === 1) throw new ModelRequesterError('网络异常', { provider: 'deepseek', code: 'network_error', retryable: true });
      return complete(calls === 2 ? { kind: 'context', decision: { type: 'continue' } } : silent);
    } },
  };
  let runtime = createAgentRuntime(options);
  try {
    await runtime.initialize(); await runtime.createAgent(agent); runtime.start();
    await until(() => runtime.inspect(1, 'owner').status === 'paused');
    expect(calls).toBe(2);
    expect(runtime.inspect(1, 'owner').lastError).toContain('本次工作已用完 2 轮');
    const previousTokens = runtime.inspect(1, 'owner').totalTokens;
    await runtime.close(); runtime = createAgentRuntime(options); await runtime.initialize(); runtime.start();
    expect(runtime.inspect(1, 'owner').status).toBe('paused');
    expect(calls).toBe(2);
    runtime.resume(1, 'owner');
    await until(() => runtime.inspect(1, 'owner').control.state === 'SLEEPING');
    expect(calls).toBe(3);
    expect(runtime.inspect(1, 'owner').rounds).toBe(3);
    expect(runtime.inspect(1, 'owner').totalTokens).toBe(previousTokens + 2);
    expect(runtime.events(1, 'owner').filter((event) => event.type === 'work_budget_renewed')).toHaveLength(1);
  } finally { await runtime.close(); await rm(path, { recursive: true, force: true }); }
});

it('适配器协议失败会重建带纠错反馈的请求，原始供应商文案不进入提示或日志', async () => {
  const path = await mkdtemp(join(tmpdir(), 'native-repair-'));
  const requests: string[] = [];
  const runtime = createAgentRuntime({
    database: join(path, 'runtime.sqlite'), workspaces: { work: path }, limits: { retryBaseMs: 1 },
    requester: { provider: 'deepseek', model: 'fixture', async request(input) {
      requests.push(JSON.stringify(input));
      if (requests.length === 1) throw new ModelRequesterError('secret-provider-payload', {
        provider: 'deepseek', code: 'invalid_response', protocolReason: 'missing_tool_calls', retryable: true,
      });
      expect(requests[1]).not.toEqual(requests[0]);
      expect(requests[1]).toContain('缺少原生 tool_calls');
      expect(requests[1]).not.toContain('secret-provider-payload');
      return complete(silent);
    } },
  });
  try {
    await runtime.initialize(); await runtime.createAgent(agent); runtime.start();
    await until(() => runtime.inspect(1, 'owner').control.state === 'SLEEPING');
    expect(requests).toHaveLength(2);
    expect(runtime.interrupts(1, 'owner')).toMatchObject([{ kind: 'protocol', action: 'retry' }]);
    expect(JSON.stringify(runtime.events(1, 'owner'))).not.toContain('secret-provider-payload');
  } finally { await runtime.close(); await rm(path, { recursive: true, force: true }); }
});
