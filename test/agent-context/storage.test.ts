import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryContextStore, restoreAgentContextManager, SqliteContextStore,
} from '../../src/agent-context/index.js';
import { apply, descend, finishSummary, setupContext, summary } from './helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
});

describe.each(['memory', 'sqlite'] as const)('上下文原子存储：%s', (kind) => {
  function store() {
    if (kind === 'memory') return new InMemoryContextStore();
    const db = new SqliteContextStore(':memory:');
    cleanups.push(() => db.close());
    return db;
  }

  it('提交失败保留子层与父任务，恢复后继续同一总结并只合并一次', () => {
    const storage = store();
    const { context } = setupContext(storage);
    descend(context);
    apply(context, { type: 'complete' });
    const pending = context.beginSummaryAttempt();
    const before = context.checkpoint();
    const commit = vi.spyOn(storage, 'commit').mockImplementationOnce(() => { throw new Error('写盘失败'); });
    expect(() => context.commitSummary('summary-run', pending.id, summary(pending.sourceRef))).toThrow('写盘失败');
    expect(context.checkpoint()).toEqual(before);
    expect(storage.load('agent-1')).toEqual(before);
    commit.mockRestore();
    const restored = restoreAgentContextManager({ key: 'agent-1', store: storage });
    expect(restored.checkpoint().pendingSummary).toEqual(pending);
    restored.commitSummary('summary-run', pending.id, summary(pending.sourceRef));
    const after = restored.checkpoint();
    restored.commitSummary('summary-run', pending.id, summary(pending.sourceRef));
    expect(restored.checkpoint()).toEqual(after);
    expect(after.context.level2).toBeNull();
    expect(after.context.level1.taskChain.tasks[0]?.state).toBe('COMPLETED');
    expect(restored.roundReceipt('summary-run')?.intent).toBe('continue');
  });

  it('同一版本的两个管理器不能相互覆盖，归档冲突使整个事务回滚', () => {
    const storage = store();
    const { context } = setupContext(storage);
    const stale = restoreAgentContextManager({ key: 'agent-1', store: storage });
    apply(context, { type: 'continue' });
    expect(() => stale.apply('different-round', stale.cursor(), { type: 'plan', objectives: ['不能覆盖'] })).toThrow('冲突');
    const before = storage.load('agent-1')!;
    const ref = 'duplicate-ref';
    const write = { ref, record: { kind: 'frame' as const, context: before.context } };
    expect(() => storage.commit('agent-1', before.revision, {
      ...before, revision: before.revision + 1,
    }, [write, write], [{ key: 'must-rollback', intent: 'idle' }])).toThrow();
    expect(storage.load('agent-1')).toEqual(before);
    expect(storage.read('agent-1', ref)).toBeUndefined();
    expect(storage.receipt('agent-1', 'must-rollback')).toBeUndefined();
  });

  it('总结期间收件箱持久化且去重，已释放帧的结果不能写入新计划', () => {
    const storage = store();
    const { context } = setupContext(storage);
    descend(context);
    const old = context.cursor();
    apply(context, { type: 'complete' });
    const delivery = { key: 'late', target: old, entries: [{
      id: 'late-event', createdAt: 1, kind: 'event' as const, name: 'old_result', data: '旧结果',
    }] };
    context.receive([delivery, delivery]);
    expect(context.checkpoint().inbox).toHaveLength(1);
    expect(context.snapshot().level2?.memory.recentEntries).toEqual([]);
    const restored = restoreAgentContextManager({ key: 'agent-1', store: storage });
    finishSummary(restored);
    restored.prepare();
    expect(restored.snapshot().level1.memory.recentEntries).toHaveLength(1);
    expect(restored.snapshot().level1.memory.recentEntries[0]).toMatchObject({
      kind: 'event', name: 'stale_context_input',
    });
    apply(restored, { type: 'plan', objectives: ['新工作'] });
    restored.receive([delivery]);
    expect(restored.checkpoint().inbox).toEqual([]);
    expect(() => restored.receive([{ ...delivery, entries: [{ ...delivery.entries[0]!, data: '篡改' }] }])).toThrow('投递键');
  });
});

it('关闭 SQLite 后重新打开仍保留待总结次数和来源', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-context-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'context.sqlite');
  const first = new SqliteContextStore(path);
  const { context } = setupContext(first);
  apply(context, { type: 'idle' });
  const pending = context.beginSummaryAttempt();
  first.close();
  const second = new SqliteContextStore(path);
  cleanups.push(() => second.close());
  const restored = restoreAgentContextManager({ key: 'agent-1', store: second });
  expect(restored.checkpoint().pendingSummary).toEqual(pending);
  finishSummary(restored);
  expect(restored.needsRun()).toBe(false);
});

it('恢复时拒绝损坏的结构、父引用与总结来源', () => {
  const { context, store } = setupContext();
  descend(context);
  const original = context.checkpoint();
  vi.spyOn(store, 'load').mockReturnValue({
    ...original, context: { ...original.context, level2: {
      ...original.context.level2!, currentTask: { frameId: 'wrong', planRevision: 1, taskId: 'wrong' },
    } },
  });
  expect(() => restoreAgentContextManager({ key: 'agent-1', store })).toThrow('引用');
  vi.mocked(store.load).mockReturnValue({ ...original, schemaVersion: 2 } as never);
  expect(() => restoreAgentContextManager({ key: 'agent-1', store })).toThrow('版本');
});
