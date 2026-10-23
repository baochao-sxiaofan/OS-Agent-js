import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAgentRuntime } from '../../src/agent-runtime/index.js';
import { createAgentServer } from '../../src/server/index.js';
import { nativeMessage } from '../fixtures/native-message.js';

it('HTTP 提供备注、摘要和来源检索；认证用户不能借管理参数代写 Agent 备注', async () => {
  const path = await mkdtemp(join(tmpdir(), 'memory-http-'));
  const runtime = createAgentRuntime({ database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    requester: { provider: 'minimax', model: 'test', async request() {
      return { provider: 'minimax', model: 'test', finishReason: 'stop',
        message: nativeMessage({ kind: 'context', decision: { type: 'finish_turn' } }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    } } });
  const server = createAgentServer({ runtime, port: 0, profiles: {},
    principals: [{ ownerId: 'owner', token: 'test-token-memory-owner', profiles: [] },
      { ownerId: 'other', token: 'test-token-memory-other', profiles: [] }] });
  try {
    const address = await server.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const auth = { authorization: 'Bearer test-token-memory-owner', 'content-type': 'application/json' };
    const agent = await runtime.createAgent({ ownerId: 'owner', workspaceId: 'work', character: 'coordinator',
      objective: '查看记忆', capabilities: [], startMode: 'on_message' });
    const id = agent.control.agentId;
    const dm = runtime.directConversation(id, 'owner').id;
    const message = runtime.sendMessage(dm, 'owner', { content: '历史暗号青竹882', idempotencyKey: 'one' });
    const input = { target: { kind: 'agent', id }, introduction: '说明', body: '用户自己的长备注'.repeat(100),
      tags: ['伙伴'], unresolved: ['待确认'], sourceRefs: [{ conversationId: dm, messageId: message.id }],
      expectedVersion: 0, idempotencyKey: 'note-first' };
    const put = await fetch(`${base}/v1/memory/notes`, { method: 'PUT', headers: auth, body: JSON.stringify(input) });
    expect(put.status).toBe(200);
    const saved = await put.json() as { note: { author: object; body: string } };
    expect(saved.note.author).toEqual({ kind: 'user', id: 'owner' });
    expect(saved.note.body).toBe(input.body);
    expect((await fetch(`${base}/v1/memory/notes?inspectAgentId=${id}`, {
      method: 'PUT', headers: auth, body: JSON.stringify(input),
    })).status).toBe(400);
    expect((await fetch(`${base}/v1/memory/notes`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ ...input, author: { kind: 'agent', id } }),
    })).status).toBe(400);
    const managed = await fetch(`${base}/v1/memory/notes?inspectAgentId=${id}`, { headers: auth });
    expect(await managed.json()).toEqual({ notes: [] });
    const single = await fetch(`${base}/v1/memory/note`, { method: 'POST', headers: auth, body: JSON.stringify(input.target) });
    expect((await single.json() as { note: { body: string } }).note.body).toBe(input.body);
    const search = await fetch(`${base}/v1/memory/search`, {
      method: 'POST', headers: auth, body: JSON.stringify({ query: '青竹882' }),
    });
    const hits = await search.json() as { hits: { messageId: string }[] };
    expect(hits.hits[0]?.messageId).toBe(message.id);
    const read = await fetch(`${base}/v1/memory/read`, {
      method: 'POST', headers: auth, body: JSON.stringify({ conversationId: dm, messageId: message.id }),
    });
    expect((await read.json() as { messages: { content: string }[] }).messages[0]?.content).toBe(message.content);
    const summary = await fetch(`${base}/v1/conversations/${dm}/summary`, { headers: auth });
    expect(await summary.json()).toEqual({ summary: null });
    expect((await fetch(`${base}/v1/memory/read?inspectAgentId=${id}`, {
      method: 'POST', headers: { ...auth, authorization: 'Bearer test-token-memory-other' },
      body: JSON.stringify({ conversationId: dm }),
    })).status).toBe(400);
    expect((await fetch(`${base}/v1/memory/search`, {
      method: 'POST', headers: auth, body: JSON.stringify({ query: '青竹', ownerId: 'other' }),
    })).status).toBe(400);
  } finally { await server.close(); await rm(path, { recursive: true, force: true }); }
});
