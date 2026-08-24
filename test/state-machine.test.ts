import { describe, expect, it } from 'vitest';

import {
  InvalidTaskTransitionError,
  TaskControlBlock,
} from '../src/index.js';

describe('TaskControlBlock state machine', () => {
  it('derives lineage, depth, and creation time through one Agent factory', () => {
    const root = TaskControlBlock.createAgent(
      {
        id: 'root',
        goal: 'Coordinate the task tree.',
      },
      { kind: 'root' },
      100,
    );
    const middle = TaskControlBlock.createAgent(
      {
        id: 'middle',
        goal: 'Coordinate one branch.',
      },
      { kind: 'child', parent: root },
      200,
    );
    const leaf = TaskControlBlock.createAgent(
      {
        id: 'leaf',
        goal: 'Complete concrete work.',
      },
      { kind: 'child', parent: middle },
      300,
    );

    expect(root).toMatchObject({
      rootTaskId: 'root',
      parentTaskId: undefined,
      depth: 1,
      createdAt: 100,
    });
    expect(middle).toMatchObject({
      rootTaskId: 'root',
      parentTaskId: 'root',
      depth: 2,
      createdAt: 200,
    });
    expect(leaf).toMatchObject({
      rootTaskId: 'root',
      parentTaskId: 'middle',
      depth: 3,
      createdAt: 300,
    });
    expect(() =>
      TaskControlBlock.createAgent(
        {
          id: 'too-deep',
          goal: 'Attempt an invalid fourth level.',
        },
        { kind: 'child', parent: leaf },
        400,
      ),
    ).toThrow('Cannot create an Agent deeper than 3 levels.');
  });

  it('allows the canonical agent lifecycle', () => {
    const task = TaskControlBlock.createAgent(
      {
        id: 'lifecycle-task',
        goal: 'Exercise the state machine.',
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
    task.transition(
      {
        status: 'BLOCKED',
        enteredAt: 3,
        reason: 'tool',
        waitingFor: ['call-1'],
      },
      'tool_requested',
    );
    task.transition(
      {
        status: 'READY',
        enteredAt: 4,
        reason: 'tool_result_available',
      },
      'tool_completed',
    );
    task.transition(
      {
        status: 'RUNNING',
        enteredAt: 5,
        providerId: 'fake',
        requestAttempt: 2,
      },
      'admitted',
    );
    task.transition(
      {
        status: 'TERMINATED',
        enteredAt: 6,
        termination: {
          kind: 'completed',
          output: 'done',
        },
      },
      'completed',
    );

    expect(task.state.status).toBe('TERMINATED');
    expect(
      task.events
        .filter((event) => event.type === 'state_transitioned')
        .map((event) => `${event.from}->${event.to.status}`),
    ).toEqual([
      'READY->RUNNING',
      'RUNNING->BLOCKED',
      'BLOCKED->READY',
      'READY->RUNNING',
      'RUNNING->TERMINATED',
    ]);
  });

  it('rejects transitions that bypass the scheduler lifecycle', () => {
    const task = TaskControlBlock.createAgent(
      {
        id: 'invalid-task',
        goal: 'Attempt an invalid transition.',
      },
      { kind: 'root' },
    );

    expect(() =>
      task.transition(
        {
          status: 'BLOCKED',
          enteredAt: 2,
          reason: 'tool',
          waitingFor: ['call-1'],
        },
        'invalid',
      ),
    ).toThrow(InvalidTaskTransitionError);
  });

  it('creates a detached snapshot that can be restored', () => {
    const task = TaskControlBlock.createAgent(
      {
        id: 'snapshot-task',
        goal: 'Persist state.',
        capabilities: ['resource:read'],
        context: [{ type: 'user', content: 'Persist this.' }],
      },
      { kind: 'root' },
    );
    task.completeModelTurn({
      request: 'Persist the task context.',
      outcome: 'The context was persisted.',
    });
    const snapshot = task.snapshot();
    const restored = TaskControlBlock.restore(snapshot);

    snapshot.context.push({ type: 'assistant', content: 'mutated snapshot' });
    snapshot.contextSummaries?.push({
      id: 'mutated-summary',
      kind: 'turn',
      sourceStartIndex: 0,
      sourceEndIndex: 1,
      summary: {
        request: 'Mutate the snapshot.',
        outcome: 'The snapshot was mutated.',
      },
      createdAt: 1,
    });

    expect(restored.id).toBe(task.id);
    expect(restored.capabilities).toEqual(['resource:read']);
    expect(restored.context).toHaveLength(1);
    expect(restored.contextSummaries).toHaveLength(1);
  });
});
