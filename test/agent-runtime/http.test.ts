import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAgentRuntime } from '../../src/agent-runtime/index.js';
import { createAgentServer } from '../../src/server/index.js';
import { summary } from '../agent-context/helpers.js';
import { nativeMessage } from '../fixtures/native-message.js';

it('认证 API 按宿主隔离，只接受预注册 profile，并优雅停机', async () => {
  const path = await mkdtemp(join(tmpdir(), 'runtime-http-'));
  const runtime = createAgentRuntime({ database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    requester: { provider: 'minimax', model: 'test', async request(request) {
      const summarizing = String(request.messages[0]?.content).includes('独立总结轮');
      const source = summarizing ? JSON.parse(String(request.messages[1]?.content)) as { sourceRef: string } : null;
      return { provider: 'minimax', model: 'test', finishReason: 'stop',
        message: nativeMessage(source ? summary(source.sourceRef) : { kind: 'context', decision: { type: 'idle' } }),
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
    } } });
  const server = createAgentServer({ runtime, port: 0, profiles: {
    reader: { workspaceId: 'work', character: 'code_auditor', capabilities: [] },
  }, principals: [
    { ownerId: 'one', token: 'token-owner-one-for-tests', profiles: ['reader'] },
    { ownerId: 'two', token: 'token-owner-two-for-tests', profiles: ['reader'] },
  ] });
  try {
    const address = await server.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const auth = { authorization: 'Bearer token-owner-one-for-tests', 'content-type': 'application/json' };
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/v1/agents`)).status).toBe(401);
    const created = await fetch(`${base}/v1/agents`, { method: 'POST', headers: auth,
      body: JSON.stringify({ profile: 'reader', objective: '任务' }) });
    expect(created.status).toBe(201);
    const result = await created.json() as { agent: { control: { agentId: number } } };
    const id = result.agent.control.agentId;
    expect(result.agent).not.toHaveProperty('parentId');
    expect(result.agent).not.toHaveProperty('depth');
    expect((await fetch(`${base}/v1/agents/${id}`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/v1/agents/${id}`, {
      headers: { authorization: 'Bearer token-owner-two-for-tests' },
    })).status).toBe(400);
    expect((await fetch(`${base}/v1/agents`, { method: 'POST', headers: auth,
      body: JSON.stringify({ profile: 'reader', objective: '任务', workspaceRoot: '/' }) })).status).toBe(400);
    expect((await fetch(`${base}/v1/agents`, { method: 'POST', headers: auth,
      body: JSON.stringify({ profile: 'reader', objective: '任务', parentId: id }) })).status).toBe(400);
    expect((await fetch(`${base}/v1/agents/${id}/spawn`, { method: 'POST', headers: auth,
      body: JSON.stringify({ profile: 'reader', objective: '任务' }) })).status).toBe(404);
    expect((await fetch(`${base}/v1/agents/${id}/events`, { headers: auth })).status).toBe(200);
  } finally {
    await server.close();
    await rm(path, { recursive: true, force: true });
  }
});
