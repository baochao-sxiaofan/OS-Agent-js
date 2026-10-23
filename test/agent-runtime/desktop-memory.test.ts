import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DesktopService } from '../../desktop-next/main/service.js';

const secrets = { available: () => false, encrypt: () => '', decrypt: () => '' };
async function until(check: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待记忆处理超时。');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it('桌面备注经主进程验证作者、来源和版本，历史分页不改变未读，重启保留长备注', async () => {
  const path = await mkdtemp(join(tmpdir(), 'desktop-memory-'));
  let desktop = new DesktopService(path, secrets);
  try {
    await desktop.initialize();
    const id = await desktop.create({ name: '记忆助手', objective: '长期协作',
      character: 'coordinator', workspaceId: null, access: 'none' });
    const conversationId = desktop.snapshot().contacts[0]!.directConversationId;
    desktop.send(conversationId, '请记住暗号青竹882。'.repeat(100), 'history');
    await until(() => desktop.snapshot().conversations[0]!.unread === 1);
    const before = desktop.snapshot();
    const message = before.conversations[0]!.messages[0]!;
    const source = { conversationId, messageId: message.id };
    const input = { target: { kind: 'agent' as const, id }, introduction: '熟悉背景的协作伙伴',
      body: '喜欢先理解需求，再给出有依据的答复。'.repeat(50), tags: ['项目伙伴'], unresolved: ['确认交付时间'],
      sourceRefs: [source], expectedVersion: 0, idempotencyKey: 'note-1' };
    const first = desktop.saveNote(input);
    expect(first.author).toEqual({ kind: 'user', id: 'desktop-user' });
    expect(desktop.saveNote(input)).toEqual(first);
    expect(desktop.contactNotes(id)).toEqual([]);
    expect(() => desktop.saveNote({ ...input, author: { kind: 'agent', id } })).toThrow();
    expect(() => desktop.saveNote({ ...input, inspectAgentId: id })).toThrow();
    expect(() => desktop.saveNote({ ...input, expectedVersion: 1, idempotencyKey: 'bad-source',
      sourceRefs: [{ ...source, messageId: 'missing' }] })).toThrow('来源');
    const next = desktop.saveNote({ ...input, body: '更新后的备注', expectedVersion: 1, idempotencyKey: 'note-2' });
    expect(next.version).toBe(2);
    expect(() => desktop.saveNote({ ...input, idempotencyKey: 'stale' })).toThrow('版本冲突');
    expect(desktop.saveNote(input).version).toBe(1);
    expect(desktop.contactNotes()[0]?.version).toBe(2);
    const search = desktop.searchHistory({ query: '青竹882', limit: 1 });
    expect(search.hits).toHaveLength(1);
    expect(search.nextBeforeSequence).not.toBeNull();
    expect(desktop.searchHistory({ query: '青竹882', beforeSequence: search.nextBeforeSequence! }).hits[0]?.messageId).toBe(message.id);
    let result = desktop.readHistory(source);
    let content = result.messages[0]!.content;
    while (result.next?.messageId === message.id) {
      result = desktop.readHistory(result.next);
      content += result.messages[0]!.content;
    }
    expect(content).toBe(message.content);
    expect(desktop.memorySummary(conversationId)).toBeNull();
    expect(desktop.snapshot().conversations[0]).toEqual(before.conversations[0]);
    expect(desktop.snapshot().contacts[0]?.rounds).toBe(before.contacts[0]?.rounds);
    await desktop.close();
    desktop = new DesktopService(path, secrets);
    await desktop.initialize();
    expect(desktop.contactNotes()[0]).toEqual(next);
    expect(desktop.snapshot().conversations[0]?.unread).toBe(1);
  } finally { await desktop.close(); await rm(path, { recursive: true, force: true }); }
});

it('桌面跨会话检索受成员身份约束，管理视角只能读取所属 Agent 的原文', async () => {
  const path = await mkdtemp(join(tmpdir(), 'desktop-memory-scope-'));
  const desktop = new DesktopService(path, secrets);
  try {
    await desktop.initialize();
    const input = { objective: '长期协作', character: 'coordinator', workspaceId: null, access: 'none' };
    const first = await desktop.create({ ...input, name: '甲' });
    await desktop.create({ ...input, name: '乙' });
    const third = await desktop.create({ ...input, name: '丙' });
    desktop.send(desktop.snapshot().contacts[0]!.directConversationId, '和乙聊聊', 'peers');
    await until(() => desktop.snapshot(first).inspector!.conversations.some((item) =>
      !item.includesUser && item.messages.length === 2 && item.mailboxes.every((mailbox) => mailbox.state === 'processed')));
    const peer = desktop.snapshot(first).inspector!.conversations.find((item) => !item.includesUser)!;
    const source = { conversationId: peer.id, messageId: peer.messages[0]!.id };
    expect(desktop.searchHistory({ query: '负责什么' }).hits).toEqual([]);
    expect(desktop.searchHistory({ query: '负责什么' }, first).hits[0]?.messageId).toBe(source.messageId);
    expect(() => desktop.readHistory(source)).toThrow('参加');
    expect(() => desktop.readHistory(source, third)).toThrow('参加');
    expect(desktop.readHistory(source, first).messages[0]?.content).toBe(peer.messages[0]!.content);
    expect(() => desktop.memorySummary(peer.id)).toThrow('参加');
    expect(desktop.memorySummary(peer.id, first)).toBeNull();
    expect(() => desktop.contactNotes(999)).toThrow();
    expect(() => desktop.saveNote({ target: { kind: 'agent', id: first }, body: '', introduction: '',
      tags: [], unresolved: [], sourceRefs: [source], expectedVersion: 0, idempotencyKey: 'private-source' })).toThrow('参加');
  } finally { await desktop.close(); await rm(path, { recursive: true, force: true }); }
});
