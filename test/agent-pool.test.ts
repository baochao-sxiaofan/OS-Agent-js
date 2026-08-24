import { describe, expect, it } from 'vitest';

import { AgentPool, TaskControlBlock } from '../src/index.js';

describe('AgentPool', () => {
  it('enforces the live-agent limit before a parent can block', () => {
    const pool = new AgentPool({
      maxDepth: 3,
      maxLiveAgents: 1,
      maxSpawnedPerRoot: 10,
    });
    const root = TaskControlBlock.createAgent(
      {
        id: 'root',
        goal: 'Coordinate.',
      },
      { kind: 'root' },
    );
    pool.registerRoot(root);

    const decision = pool.tryReserveChildren(root, 1);

    expect(decision).toMatchObject({
      reserved: false,
      reason: 'live_pool_exhausted',
    });
    expect(root.state.status).toBe('READY');
    expect(pool.liveCount).toBe(1);
    expect(pool.peakLiveCount).toBe(1);
  });

  it('enforces max depth even when live slots remain', () => {
    const pool = new AgentPool({
      maxDepth: 3,
      maxLiveAgents: 20,
      maxSpawnedPerRoot: 10,
    });
    const root = TaskControlBlock.createAgent(
      {
        id: 'root',
        goal: 'Coordinate.',
      },
      { kind: 'root' },
    );
    pool.registerRoot(root);

    const middleReservation = pool.tryReserveChildren(root, 1);
    expect(middleReservation.reserved).toBe(true);
    if (!middleReservation.reserved) {
      return;
    }
    const middle = TaskControlBlock.createAgent(
      {
        id: 'middle',
        goal: 'Coordinate a branch.',
      },
      { kind: 'child', parent: root },
    );
    middleReservation.reservation.commit([middle]);

    const leafReservation = pool.tryReserveChildren(middle, 1);
    expect(leafReservation.reserved).toBe(true);
    if (!leafReservation.reserved) {
      return;
    }
    const leaf = TaskControlBlock.createAgent(
      {
        id: 'leaf',
        goal: 'Do concrete work.',
      },
      { kind: 'child', parent: middle },
    );
    leafReservation.reservation.commit([leaf]);

    expect(pool.liveCount).toBe(3);
    expect(pool.peakLiveCount).toBe(3);
    expect(pool.tryReserveChildren(leaf, 1)).toMatchObject({
      reserved: false,
      reason: 'max_depth_exceeded',
    });
  });

  it('does not reset the cumulative root spawn limit after release', () => {
    const pool = new AgentPool({
      maxDepth: 3,
      maxLiveAgents: 2,
      maxSpawnedPerRoot: 1,
    });
    const root = TaskControlBlock.createAgent(
      {
        id: 'root',
        goal: 'Coordinate.',
      },
      { kind: 'root' },
    );
    pool.registerRoot(root);

    const firstDecision = pool.tryReserveChildren(root, 1);
    expect(firstDecision.reserved).toBe(true);
    if (!firstDecision.reserved) {
      return;
    }
    const child = TaskControlBlock.createAgent(
      {
        id: 'first-child',
        goal: 'Complete one task.',
      },
      { kind: 'child', parent: root },
    );
    firstDecision.reservation.commit([child]);
    pool.release(child.id);

    expect(pool.availableLiveSlots).toBe(1);
    expect(pool.spawnedCount(root.id)).toBe(1);
    expect(pool.tryReserveChildren(root, 1)).toMatchObject({
      reserved: false,
      reason: 'root_spawn_limit_exceeded',
    });
  });
});
