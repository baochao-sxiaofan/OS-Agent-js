import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { RuntimeService } from '../desktop/main/runtime-service.js';
import { SqliteTaskStore, TaskControlBlock } from '../src/index.js';

describe('RuntimeService persistence recovery', () => {
  it('waits for the scheduler before closing persistent stores', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'os-agent-close-'));
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const runtime = new RuntimeService(undefined, {
      storeLocation: join(directory, 'tasks.db'),
    });
    try {
      await runtime.initialize();
      const conversation = runtime.getSnapshot().conversations[0];
      expect(conversation).toBeDefined();
      if (!conversation) {
        return;
      }
      await runtime.submitTask({
        conversationId: conversation.id,
        task: 'Complete a short task before shutdown.',
      });

      await runtime.close();
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      expect(consoleError).not.toHaveBeenCalledWith(
        'Runtime scheduler failed:',
        expect.objectContaining({ code: 'ERR_INVALID_STATE' }),
      );
    } finally {
      consoleError.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('allows a conversation without a workspace and grants no file capabilities', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'os-agent-unbound-'));
    const runtime = new RuntimeService();
    try {
      await runtime.initialize();
      const conversation = runtime.getSnapshot().conversations[0];
      expect(conversation).toBeDefined();
      if (!conversation) {
        return;
      }

      const submitted = await runtime.submitTask({
        conversationId: conversation.id,
        task: 'Answer without touching files.',
      });
      const root = submitted.conversations[0]?.agents.find(
        (agent) => agent.depth === 1,
      );
      expect(root?.capabilities).toEqual([
        'artifact.read',
        'artifact.write',
      ]);
      expect(root?.capabilities).not.toContain('file.read');
      expect(root?.characterId).toBe('coordinator');
      await expect(
        runtime.setConversationWorkspace(conversation.id, directory),
      ).rejects.toThrow('正在执行');
      if (root) {
        await runtime.cancelTask(root.id);
      }
      await waitForRuntimeIdle(runtime);
    } finally {
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists an empty conversation with its canonical workspace', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'os-agent-workspace-'));
    const databasePath = join(directory, 'tasks.db');
    const workspacePath = join(directory, 'project');
    mkdirSync(workspacePath);

    const firstRuntime = new RuntimeService(undefined, {
      storeLocation: databasePath,
    });
    let conversationId: string;
    try {
      await firstRuntime.initialize();
      const initialConversation =
        firstRuntime.getSnapshot().conversations[0];
      expect(initialConversation).toMatchObject({
        status: 'empty',
      });
      expect(initialConversation?.workspacePath).toBeUndefined();
      conversationId = initialConversation?.id ?? '';

      const updated = await firstRuntime.setConversationWorkspace(
        conversationId,
        workspacePath,
      );
      expect(updated.conversations).toHaveLength(1);
      expect(updated.conversations[0]?.workspacePath).toBe(
        realpathSync(workspacePath),
      );
    } finally {
      await firstRuntime.close();
    }

    const restoredRuntime = new RuntimeService(undefined, {
      storeLocation: databasePath,
    });
    try {
      await restoredRuntime.initialize();
      expect(restoredRuntime.getSnapshot().conversations).toMatchObject([
        {
          id: conversationId,
          workspacePath: realpathSync(workspacePath),
          status: 'empty',
        },
      ]);
    } finally {
      await restoredRuntime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function waitForRuntimeIdle(runtime: RuntimeService): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (runtime.isBusy && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(runtime.isBusy).toBe(false);
}
