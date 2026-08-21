import { describe, expect, it } from 'vitest';

import {
  ContextWindowManager,
  TaskControlBlock,
} from '../src/index.js';

describe('dual-channel context management', () => {
  it('keeps full history while selecting summaries for the model request', () => {
    const task = TaskControlBlock.create({
      id: 'dual-channel',
      goal: 'Verify dual-channel context.',
      context: [
        {
          type: 'user',
          content: 'first original turn with durable details',
        },
      ],
    });
    task.completeModelTurn({
      request: 'Handle the first original turn.',
      outcome: 'Preserved the first durable result.',
    });
    task.appendContext({
      type: 'assistant',
      content: 'second original turn with additional details',
    });
    task.completeModelTurn({
      request: 'Handle the second original turn.',
      outcome: 'Preserved the second durable result.',
    });
    task.appendContext({
      type: 'user',
      content: 'recent request that must remain verbatim',
    });

    const manager = new ContextWindowManager(100, {
      warningRatio: 0.8,
      targetRatio: 0.6,
    });
    const selection = manager.select(
      task.context,
      task.contextSummaries,
      (context) =>
        context.reduce(
          (tokens, item) =>
            tokens + (item.type === 'context_summary' ? 5 : 35),
          0,
        ),
    );

    expect(selection).toMatchObject({
      mode: 'hybrid',
      tokenEstimate: 45,
      needsSecondaryCompaction: false,
    });
    expect(selection.context).toEqual([
      {
        type: 'context_summary',
        request: 'Handle the first original turn.',
        outcome: 'Preserved the first durable result.',
      },
      {
        type: 'context_summary',
        request: 'Handle the second original turn.',
        outcome: 'Preserved the second durable result.',
      },
      {
        type: 'user',
        content: 'recent request that must remain verbatim',
      },
    ]);

    expect(task.context).toEqual([
      {
        type: 'user',
        content: 'first original turn with durable details',
      },
      {
        type: 'assistant',
        content: 'second original turn with additional details',
      },
      {
        type: 'user',
        content: 'recent request that must remain verbatim',
      },
    ]);
    expect(task.contextSummaries).toHaveLength(2);

    const restored = TaskControlBlock.restore(task.snapshot());
    expect(restored.context).toEqual(task.context);
    expect(restored.contextSummaries).toEqual(task.contextSummaries);
  });
});
