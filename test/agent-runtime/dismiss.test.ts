import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { CharacterRegistry } from '../../src/character/character-registry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RuntimeStore } from '../../src/agent-runtime/internal/store.js';
import { createAgentRuntime, readRuntimeRequest, type AgentRuntimeOptions } from '../../src/agent-runtime/index.js';
import { createAgentServer } from '../../src/server/index.js';
import { DesktopService } from '../../desktop-next/main/service.js';
import { nativeMessage } from '../fixtures/native-message.js';

const employee = { ownerId: 'owner', workspaceId: 'work', character: 'coordinator', objective: 'help', capabilities: [], startMode: 'on_message' as const };
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('timeout'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
it('dismiss is permanent, owner-only and idempotent; releases capacity, preserves unread history and lets colleagues work', async () => {
  const path = await mkdtemp(join(tmpdir(), 'dismiss-agent-'));
  const called: number[] = [];
  const options: AgentRuntimeOptions = { database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    limits: { maxAgents: 2 }, conversationPolicy: { quietMs: 5, maxWaitMs: 10, groupQuietMs: 5 },
    requester: { provider: 'deepseek', model: 'fixture', async request(request) {
      const data = readRuntimeRequest(request) as { self: { id: number }; conversation: { id: string }; peers: string[] };
      called.push(data.self.id); expect(data.peers).not.toContain('agent-1');
      return { provider: 'deepseek', model: 'fixture', finishReason: 'tool_calls',
        message: nativeMessage({ kind: 'send_message', conversationId: data.conversation.id, content: 'colleague reply', finish: true }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    } } };
  let runtime = createAgentRuntime(options);
  try {
    await runtime.initialize(); await runtime.createAgent(employee); await runtime.createAgent(employee);
    const group = runtime.createConversation({ ownerId: 'owner', workspaceId: 'work', kind: 'group',
      members: [{ kind: 'user', id: 'owner' }, { kind: 'agent', id: 1 }, { kind: 'agent', id: 2 }] });
    runtime.submit(1, 'owner', 'unprocessed history', 'original');
    await expect(runtime.dismiss(1, 'other')).rejects.toThrow();
    await runtime.dismiss(1, 'owner'); await runtime.dismiss(1, 'owner');
    expect(runtime.list('owner').map((agent) => agent.control.agentId)).toEqual([2]);
    expect(runtime.list('owner', { includeDismissed: true })).toHaveLength(2);
    expect(runtime.inspect(1, 'owner')).toMatchObject({ status: 'dismissed', grants: [] });
    expect(runtime.events(1, 'owner').filter((event) => event.type === 'agent_dismissed')).toHaveLength(1);
    expect(() => runtime.resume(1, 'owner')).toThrow('已解雇');
    await expect(runtime.pause(1, 'owner')).rejects.toThrow('已解雇');
    expect(() => runtime.submit(1, 'owner', 'no', 'no')).toThrow('已解雇');
    expect(() => runtime.sendMessage(group.id, 'owner', { content: 'no', mentions: [1], idempotencyKey: 'mention' })).toThrow();
    expect(runtime.messages(1, 'owner')).toMatchObject([{ content: 'unprocessed history' }]);
    const dm = runtime.directConversation(1, 'owner');
    expect(runtime.conversationMailboxes(dm.id, 'owner')[0]).toMatchObject({ state: 'dismissed', processedSequence: 0 });
    await runtime.createAgent(employee);
    await runtime.close(); runtime = createAgentRuntime(options); await runtime.initialize();
    expect(runtime.inspect(1, 'owner').status).toBe('dismissed');
    expect(runtime.list('owner')).toHaveLength(2);
    runtime.start(); runtime.sendMessage(group.id, 'owner', { content: 'keep working', mentions: [2], idempotencyKey: 'new-work' });
    await until(() => runtime.conversationMessages(group.id, 'owner').some((message) => message.content === 'colleague reply'));
    expect(called).toEqual([2]);
    expect(runtime.messages(1, 'owner')).toHaveLength(1);
  } finally { await runtime.close(); await rm(path, { recursive: true, force: true }); }
});

it('dismiss aborts an in-flight model request without publishing late output', async () => {
  const path = await mkdtemp(join(tmpdir(), 'dismiss-running-'));
  let started = false; let aborted = false;
  const runtime = createAgentRuntime({ database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    requester: { provider: 'deepseek', model: 'fixture', async request(_input, signal) {
      started = true;
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
    } } });
  try {
    await runtime.initialize(); await runtime.createAgent({ ...employee, startMode: 'immediate' }); runtime.start();
    await until(() => started); await runtime.dismiss(1, 'owner');
    expect(aborted).toBe(true); expect(runtime.inspect(1, 'owner').status).toBe('dismissed');
    expect(runtime.messages(1, 'owner')).toEqual([]); expect(runtime.isReady()).toBe(true);
  } finally { await runtime.close(); await rm(path, { recursive: true, force: true }); }
});

it('dismiss after a model completion is persisted prevents its pending action from modifying notes', async () => {
  const path = await mkdtemp(join(tmpdir(), 'dismiss-completed-model-'));
  const runtime = createAgentRuntime({ database: join(path, 'runtime.sqlite'), workspaces: { work: path },
    requester: { provider: 'deepseek', model: 'fixture', async request() {
      return { provider: 'deepseek', model: 'fixture', finishReason: 'tool_calls',
        message: nativeMessage({ kind: 'contact_note_set', target: { kind: 'user', id: 'owner' },
          introduction: '', body: 'late mutation', tags: [], unresolved: [], sourceRefs: [], expectedVersion: 0 }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    } } });
  let dismissed: Promise<void> | undefined;
  const original = RuntimeStore.prototype.event;
  const spy = vi.spyOn(RuntimeStore.prototype, 'event').mockImplementation(function (this: RuntimeStore, id, type, data) {
    const event = original.call(this, id, type, data);
    if (type === 'model_completed') dismissed = runtime.dismiss(id, 'owner');
    return event;
  });
  try {
    await runtime.initialize(); await runtime.createAgent({ ...employee, startMode: 'immediate' }); runtime.start();
    await until(() => dismissed !== undefined); await dismissed;
    expect(runtime.inspect(1, 'owner').status).toBe('dismissed');
    expect(runtime.contactNote('owner', { kind: 'user', id: 'owner' }, 1)).toBeNull();
    expect(runtime.events(1, 'owner').filter((event) => event.type === 'action')).toEqual([]);
  } finally { spy.mockRestore(); await runtime.close(); await rm(path, { recursive: true, force: true }); }
});

it('desktop and authenticated DELETE expose dismissal and retain archived conversations after restart', async () => {
  const path = await mkdtemp(join(tmpdir(), 'dismiss-desktop-'));
  const secrets = { available: () => false, encrypt: () => { throw new Error('unavailable'); }, decrypt: () => '' };
  let desktop = new DesktopService(path, secrets);
  try {
    await desktop.initialize(); const id = await desktop.create({ name: 'employee', objective: 'help', character: 'coordinator', workspaceId: null, access: 'none' });
    const dm = desktop.snapshot().contacts[0]!.directConversationId;
    await desktop.control(id, 'dismiss');
    expect(desktop.snapshot().contacts[0]).toMatchObject({ status: 'dismissed' });
    expect(desktop.snapshot().conversations.some((chat) => chat.id === dm)).toBe(true);
    expect(() => desktop.send(dm, 'no', 'no')).toThrow('已解雇');
    await desktop.close(); desktop = new DesktopService(path, secrets); await desktop.initialize();
    expect(desktop.snapshot().contacts[0]?.status).toBe('dismissed');
  } finally { await desktop.close(); }
  const runtime = createAgentRuntime({ database: join(path, 'server.sqlite'), workspaces: { work: path },
    requester: { provider: 'deepseek', model: 'fixture', async request() { throw new Error('unexpected request'); } } });
  const server = createAgentServer({ runtime, profiles: {}, principals: [{ token: 'owner-token-with-length', ownerId: 'owner', profiles: [] },
    { token: 'other-token-with-length', ownerId: 'other', profiles: [] }] });
  try {
    await runtime.initialize(); await runtime.createAgent(employee);
    const address = await server.listen(); const url = `http://127.0.0.1:${address.port}/v1/agents/1`;
    expect((await fetch(url, { method: 'DELETE', headers: { authorization: 'Bearer other-token-with-length' } })).status).toBe(400);
    const result = await fetch(url, { method: 'DELETE', headers: { authorization: 'Bearer owner-token-with-length' } });
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ agent: { status: 'dismissed' } });
  } finally { await server.close(); await runtime.close(); await rm(path, { recursive: true, force: true }); }
});

it('dismiss aborts writes but retains unknown effects for reconciliation without restarting the employee', async () => {
  const path = await mkdtemp(join(tmpdir(), 'dismiss-side-effect-'));
  let started = false; let aborted = false; let effects = 0;
  const tools = new ToolRegistry();
  tools.register({ name: 'test.write', description: 'write fixture', effect: 'side_effect', requiredCapability: 'test.write',
    validateInput: () => ({ valid: true }), async execute(_args, context) {
      effects++; started = true;
      return new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => {
        aborted = true; reject(context.signal.reason);
      }, { once: true }));
    } });
  const options: AgentRuntimeOptions = { database: join(path, 'runtime.sqlite'), workspaces: { work: path }, tools,
    characters: new CharacterRegistry([{ id: 'writer', displayName: 'writer', promptFragment: 'write',
      visibleToolIds: ['test.write'], capabilityCeiling: ['test.write'], requestableCapabilities: [], allowedChildCharacters: [] }]),
    requester: { provider: 'deepseek', model: 'fixture', async request() {
      return { provider: 'deepseek', model: 'fixture', finishReason: 'tool_calls',
        message: nativeMessage({ kind: 'tools', calls: [{ name: 'test.write', arguments: {} }] }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    } } };
  let runtime = createAgentRuntime(options);
  try {
    await runtime.initialize(); await runtime.createAgent({ ...employee, character: 'writer', startMode: 'immediate',
      capabilities: [{ capability: 'test.write', scope: { kind: 'all' } }] }); runtime.start();
    await until(() => started); await runtime.dismiss(1, 'owner');
    await until(() => runtime.approvals(1, 'owner').some((operation) => operation.state === 'unknown'));
    expect(aborted).toBe(true); expect(runtime.inspect(1, 'owner').status).toBe('dismissed');
    const operation = runtime.approvals(1, 'owner')[0]!;
    await runtime.close(); runtime = createAgentRuntime(options); await runtime.initialize(); runtime.start();
    expect(runtime.approvals(1, 'owner')[0]?.operationId).toBe(operation.operationId);
    runtime.reconcile(1, 'owner', operation.operationId, { outcome: 'failed', result: 'verified no write' });
    expect(runtime.inspect(1, 'owner').status).toBe('dismissed');
    expect(runtime.approvals(1, 'owner')).toEqual([]); expect(effects).toBe(1);
    expect(() => runtime.resume(1, 'owner')).toThrow('已解雇');
  } finally { await runtime.close(); await rm(path, { recursive: true, force: true }); }
});
