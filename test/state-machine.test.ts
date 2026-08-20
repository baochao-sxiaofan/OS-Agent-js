import { describe, expect, it } from 'vitest';

import {
  InvalidTaskTransitionError,
  TaskControlBlock,
} from '../src/index.js';

describe('TaskControlBlock state machine', () => {
  it('allows the canonical agent lifecycle', () => {
    const task = TaskControlBlock.create({
      id: 'lifecycle-task',
      goal: 'Exercise the state machine.',
      createdAt: 1,
    });

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
    const task = TaskControlBlock.create({
      id: 'invalid-task',
      goal: 'Attempt an invalid transition.',
    });

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
    const task = TaskControlBlock.create({
      id: 'snapshot-task',
      goal: 'Persist state.',
      capabilities: ['resource:read'],
      context: [{ type: 'user', content: 'Persist this.' }],
    });
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
