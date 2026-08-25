import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RuntimeService } from '../desktop/main/runtime-service.js';
import { SqliteTaskStore, TaskControlBlock } from '../src/index.js';

describe('RuntimeService persistence recovery', () => {
  it('loads persisted roots into conversations during initialization', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'os-agent-recovery-'));
    const databasePath = join(directory, 'tasks.db');
    const store = new SqliteTaskStore({ location: databasePath });
    const task = TaskControlBlock.createAgent(
      {
        id: 'persisted-root',
        goal: 'Recover this conversation after restart.',
      },
      { kind: 'root' },
      10,
    );
    const termination = {
      kind: 'completed' as const,
      output: 'already done',
    };
    task.transition(
      {
        status: 'TERMINATED',
        enteredAt: 20,
        termination,
      },
      'test_setup',
    );
    task.recordTermination(termination);
    await store.persist(task);
    store.close();

    const runtime = new RuntimeService(undefined, {
      storeLocation: databasePath,
    });
    try {
      await runtime.initialize();
      await runtime.initialize();

      const snapshot = runtime.getSnapshot();
      expect(snapshot.conversations).toHaveLength(1);
      expect(snapshot.conversations[0]).toMatchObject({
        rootTaskId: 'persisted-root',
        status: 'completed',
        rounds: [
          {
            rootTaskId: 'persisted-root',
            result: 'already done',
          },
        ],
      });
    } finally {
      runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
