import { describe, expect, it } from 'vitest';

import {
  ReadyQueue,
  TaskControlBlock,
  type Clock,
} from '../src/index.js';

class ManualClock implements Clock {
  constructor(private timestamp = 0) {}

  now(): number {
    return this.timestamp;
  }

  advance(milliseconds: number): void {
    this.timestamp += milliseconds;
  }
}

function createHierarchy() {
  const root = TaskControlBlock.create({
    id: 'root',
    goal: 'Coordinate the task tree.',
    createdAt: 0,
  });
  const middleOne = TaskControlBlock.createChild(root, {
    id: 'middle-1',
    goal: 'Coordinate one branch.',
  });
  const middleTwo = TaskControlBlock.createChild(root, {
    id: 'middle-2',
    goal: 'Coordinate another branch.',
  });
  const leaves = Array.from({ length: 4 }, (_, index) =>
    TaskControlBlock.createChild(middleOne, {
      id: `leaf-${index + 1}`,
      goal: `Complete leaf task ${index + 1}.`,
    }),
  );
  return { leaves, middleOne, middleTwo, root };
}

describe('ReadyQueue hierarchical scheduling', () => {
  it('uses the default 4:2:1 weighted depth rotation', () => {
    const queue = new ReadyQueue();
    const { leaves, middleOne, middleTwo, root } = createHierarchy();

    queue.enqueue(root);
    queue.enqueue(middleOne);
    queue.enqueue(middleTwo);
    for (const leaf of leaves) {
      queue.enqueue(leaf);
    }

    expect(queue.peakSize).toBe(7);
    expect(
      Array.from({ length: 7 }, () => queue.dequeue()?.id),
    ).toEqual([
      'leaf-1',
      'leaf-2',
      'leaf-3',
      'leaf-4',
      'middle-1',
      'middle-2',
      'root',
    ]);
  });

  it('promotes a long-waiting shallow task through aging', () => {
    const clock = new ManualClock();
    const queue = new ReadyQueue(
      {
        depthWeights: { 1: 1, 2: 2, 3: 4 },
        agingThresholdMs: 100,
      },
      clock,
    );
    const { leaves, root } = createHierarchy();
    const firstLeaf = leaves[0];
    if (!firstLeaf) {
      throw new Error('Expected a leaf task.');
    }

    queue.enqueue(root);
    clock.advance(200);
    queue.enqueue(firstLeaf);

    expect(queue.dequeue()?.id).toBe('root');
  });

  it('gives a resumed parent one dispatch boost over leaf work', () => {
    const queue = new ReadyQueue();
    const { leaves, root } = createHierarchy();
    const firstLeaf = leaves[0];
    if (!firstLeaf) {
      throw new Error('Expected a leaf task.');
    }

    queue.enqueue(firstLeaf);
    queue.enqueue(root, { parentWakeupBoost: true });

    expect(queue.dequeue()?.id).toBe('root');
    expect(queue.dequeue()?.id).toBe('leaf-1');
  });
});
