import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createAgentRuntime, type AgentRuntimeOptions } from '../../src/agent-runtime/index.js';
import { ModelRequesterError } from '../../src/model-requester/index.js';
import { nativeMessage } from '../fixtures/native-message.js';
import { classifyFault } from '../../src/agent-runtime/internal/limits.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待升级恢复超时。');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

it('HTTP402暂停并明确说明账户额度，不诱导持续重试或泄漏服务端正文', () => {
  const fault = classifyFault(new ModelRequesterError('private-balance-response', {
    provider: 'deepseek', code: 'http_error', status: 402,
  }));
  expect(fault.retry).toBe(false);
  expect(fault.message).toContain('账户余额或可用额度不足');
  expect(fault.message).not.toContain('private-balance-response');
});

it('升级重建未完成的第二版请求，归档原请求且保留累计用量', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'request-upgrade-'));
  let recovered = false;
  let calls = 0;
  const options: AgentRuntimeOptions = {
    database: join(directory, 'runtime.sqlite'), workspaces: { work: directory },
    requester: { provider: 'deepseek', model: 'fixture', async request(input) {
      calls++;
      if (!recovered) throw new ModelRequesterError('不能发送的旧结构', {
        provider: 'deepseek', code: 'http_error', status: 400, requestReason: 'invalid_tool_schema',
      });
      expect(JSON.stringify(input)).not.toContain('invalid-old-schema');
      return { provider: 'deepseek', model: 'fixture', finishReason: 'tool_calls',
        message: nativeMessage({ kind: 'context', decision: { type: 'finish_turn' } }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    } },
  };
  let runtime = createAgentRuntime(options);
  try {
    await runtime.initialize();
    await runtime.createAgent({ ownerId: 'owner', workspaceId: 'work', character: 'coordinator',
      objective: '完成当前工作', capabilities: [] });
    runtime.start();
    await until(() => runtime.inspect(1, 'owner').status === 'paused');
    expect(runtime.inspect(1, 'owner').lastError).toContain('JSON Schema 无效');
    const previous = runtime.inspect(1, 'owner').totalTokens;
    await runtime.close();
    const db = new DatabaseSync(options.database);
    const request = db.prepare('SELECT id FROM runtime_requests').get();
    expect(typeof request?.id).toBe('string');
    db.prepare("UPDATE runtime_requests SET body=? WHERE id=?").run(JSON.stringify({
      messages: [{ role: 'user', content: 'invalid-old-schema' }],
    }), request!.id!);
    db.prepare('UPDATE runtime_metadata SET body=? WHERE id=?').run('2', `protocol-version:${request!.id}`);
    db.close();
    recovered = true;
    runtime = createAgentRuntime(options);
    await runtime.initialize();
    runtime.resume(1, 'owner'); runtime.start();
    await until(() => runtime.inspect(1, 'owner').control.state === 'SLEEPING');
    expect(calls).toBe(2);
    expect(runtime.inspect(1, 'owner').totalTokens).toBe(previous + 2);
    const verify = new DatabaseSync(options.database, { readOnly: true });
    expect(verify.prepare('SELECT request FROM runtime_request_history').get()?.request).toContain('invalid-old-schema');
    verify.close();
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
