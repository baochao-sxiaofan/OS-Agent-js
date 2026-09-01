import { describe, expect, it, vi } from 'vitest';

import { ResourceLockManager } from '../src/index.js';

const exact = (resource: string) => ({
  mode: 'exclusive' as const,
  scope: { kind: 'exact' as const, resource },
});

const subtree = (resource: string) => ({
  mode: 'exclusive' as const,
  scope: { kind: 'subtree' as const, resource },
});

describe('ResourceLockManager', () => {
  it('serializes overlapping subtree and exact resources', async () => {
    const manager = new ResourceLockManager();
    const first = await manager.acquire('agent-a', [
      subtree('workspace://current/src/'),
    ]);
    const secondResolved = vi.fn();
    const secondPromise = manager
      .acquire('agent-b', [
        exact('workspace://current/src/kernel/context.ts'),
      ])
      .then((lease) => {
        secondResolved();
        return lease;
      });

    await Promise.resolve();
    expect(secondResolved).not.toHaveBeenCalled();
    expect(manager.snapshots()).toHaveLength(1);

    first.close();
    const second = await secondPromise;
    expect(secondResolved).toHaveBeenCalledOnce();
    expect(manager.snapshots()[0]?.ownerTaskId).toBe('agent-b');
    second.close();
  });

  it('allows independent resources to execute concurrently', async () => {
    const manager = new ResourceLockManager();
    const [left, right] = await Promise.all([
      manager.acquire('agent-a', [
        exact('workspace://current/src/a.ts'),
      ]),
      manager.acquire('agent-b', [
        exact('workspace://current/src/b.ts'),
      ]),
    ]);

    expect(manager.snapshots()).toHaveLength(2);
    left.close();
    right.close();
    expect(manager.snapshots()).toEqual([]);
  });

  it('acquires multiple scopes atomically and avoids partial holds', async () => {
    const manager = new ResourceLockManager();
    const blocker = await manager.acquire('agent-a', [
      exact('workspace://current/src/a.ts'),
    ]);
    const waiting = manager.acquire('agent-b', [
      exact('workspace://current/src/a.ts'),
      exact('workspace://current/src/b.ts'),
    ]);
    const independent = await manager.acquire('agent-c', [
      exact('workspace://current/src/b.ts'),
    ]);

    expect(manager.snapshots().map((lock) => lock.ownerTaskId)).toEqual([
      'agent-a',
      'agent-c',
    ]);
    independent.close();
    blocker.close();
    const acquired = await waiting;
    expect(acquired.snapshot.requests).toHaveLength(2);
    acquired.close();
  });

  it('removes an aborted waiter without blocking later work', async () => {
    const manager = new ResourceLockManager();
    const first = await manager.acquire('agent-a', [
      exact('workspace://current/file.ts'),
    ]);
    const controller = new AbortController();
    const aborted = manager.acquire(
      'agent-b',
      [exact('workspace://current/file.ts')],
      controller.signal,
    );
    controller.abort();

    await expect(aborted).rejects.toThrow('aborted');
    first.close();
    const later = await manager.acquire('agent-c', [
      exact('workspace://current/file.ts'),
    ]);
    expect(later.snapshot.ownerTaskId).toBe('agent-c');
    later.close();
  });
});
