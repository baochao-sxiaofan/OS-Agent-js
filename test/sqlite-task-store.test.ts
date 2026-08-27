import { describe, expect, it } from 'vitest';

import { SqliteTaskStore, TaskControlBlock } from '../src/index.js';

function createRunningTask(id: string) {
  const task = TaskControlBlock.createAgent(
    {
      id,
      goal: 'Persist across restarts.',
      context: [{ type: 'user', content: 'do the work' }],
    },
    { kind: 'root' },
    1,
  );
  task.transition(
    {
      status: 'RUNNING',
      enteredAt: 2,
      providerId: 'fake',
      requestAttempt: 1,
    },
    'admitted',
  );
  return task;
}

describe('SqliteTaskStore', () => {
  it('persists a snapshot and reloads it after a fresh open', async () => {
    const store = new SqliteTaskStore({ location: ':memory:' });
    const task = createRunningTask('persist-task');

    await store.persist(task);
    const loaded = await store.load('persist-task');

    expect(loaded?.id).toBe('persist-task');
    expect(loaded?.state.status).toBe('RUNNING');
    expect(loaded?.context).toEqual([
      { type: 'user', content: 'do the work' },
    ]);
    store.close();
  });

  it('appends events incrementally and stays idempotent on re-persist', async () => {
    const store = new SqliteTaskStore({ location: ':memory:' });
    const task = createRunningTask('incremental-task');

    await store.persist(task);
    const firstCount = (await store.events('incremental-task')).length;

    // 再次 persist 相同状态：事件不应重复写入。
    await store.persist(task);
    const afterRePersist = await store.events('incremental-task');
    expect(afterRePersist).toHaveLength(firstCount);

    // 新增一次跃迁后，只应追加新事件。
    task.transition(
      {
        status: 'BLOCKED',
        enteredAt: 3,
        reason: 'tool',
        waitingFor: ['call-1'],
      },
      'tool_requested',
    );
    await store.persist(task);
    const afterTransition = await store.events('incremental-task');
    expect(afterTransition.length).toBe(firstCount + 1);

    const sequences = afterTransition.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    store.close();
  });

  it('keeps snapshot and events consistent through a restore round-trip', async () => {
    const store = new SqliteTaskStore({ location: ':memory:' });
    const task = createRunningTask('restore-task');
    await store.persist(task);

    const snapshot = await store.load('restore-task');
    expect(snapshot).toBeDefined();
    if (!snapshot) {
      return;
    }
    const restored = TaskControlBlock.restore(snapshot);

    expect(restored.id).toBe(task.id);
    expect(restored.rootTaskId).toBe(task.rootTaskId);
    expect(restored.depth).toBe(task.depth);
    expect(restored.state.status).toBe('RUNNING');
    store.close();
  });

  it('returns undefined for unknown tasks and empty events lists', async () => {
    const store = new SqliteTaskStore({ location: ':memory:' });
    expect(await store.load('missing')).toBeUndefined();
    expect(await store.events('missing')).toEqual([]);
    store.close();
  });

  it('stores runtime metadata beside task snapshots', () => {
    const store = new SqliteTaskStore({ location: ':memory:' });

    expect(store.readRuntimeMetadata('conversations')).toBeUndefined();
    store.writeRuntimeMetadata('conversations', '{"version":1}');
    expect(store.readRuntimeMetadata('conversations')).toBe(
      '{"version":1}',
    );
    store.writeRuntimeMetadata('conversations', '{"version":2}');
    expect(store.readRuntimeMetadata('conversations')).toBe(
      '{"version":2}',
    );

    store.close();
  });

  it('persists capability grants and pending approval requests', async () => {
    const store = new SqliteTaskStore({ location: ':memory:' });
    const task = TaskControlBlock.createAgent(
      {
        id: 'approval-task',
        goal: 'Wait for a sensitive capability.',
        capabilities: ['file.read'],
      },
      { kind: 'root' },
      1,
    );
    task.transition(
      {
        status: 'RUNNING',
        enteredAt: 2,
        providerId: 'fake',
        requestAttempt: 1,
      },
      'admitted',
    );
    task.registerCapabilityRequest({
      requestId: 'approval-1',
      requests: [
        {
          capability: 'git.push',
          scope: {
            kind: 'exact',
            resource: 'git://repo/origin/main',
          },
        },
      ],
      route: 'human',
      status: 'pending',
      createdAt: 3,
    });
    task.transition(
      {
        status: 'BLOCKED',
        enteredAt: 3,
        reason: 'human_approval',
        waitingFor: ['approval-1'],
      },
      'waiting_for_human_capability_approval',
    );

    await store.persist(task);
    const snapshot = await store.load(task.id);
    expect(snapshot).toBeDefined();
    if (!snapshot) {
      return;
    }
    const restored = TaskControlBlock.restore(snapshot);

    expect(restored.capabilities).toEqual(['file.read']);
    expect(restored.capabilityRequests).toEqual([
      expect.objectContaining({
        requestId: 'approval-1',
        route: 'human',
        status: 'pending',
      }),
    ]);
    expect(restored.state).toMatchObject({
      status: 'BLOCKED',
      reason: 'human_approval',
    });
    store.close();
  });
});
