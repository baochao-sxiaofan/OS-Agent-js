import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  InMemoryKnowledgeStore,
  SqliteKnowledgeStore,
  createKnowledgeTools,
  workspaceKnowledgeKey,
  type KnowledgeStore,
  type ToolExecutionContext,
} from '../src/index.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.each([
  {
    name: 'memory',
    create(): KnowledgeStore {
      return new InMemoryKnowledgeStore();
    },
  },
  {
    name: 'sqlite',
    create(): KnowledgeStore {
      const directory = mkdtempSync(join(tmpdir(), 'knowledge-store-'));
      directories.push(directory);
      return new SqliteKnowledgeStore(join(directory, 'knowledge.db'));
    },
  },
])('KnowledgeStore ($name)', ({ create }) => {
  it('replaces stale document chunks and returns cited matches', () => {
    const store = create();
    const key = 'workspace-1';
    store.replaceDocument(
      key,
      'workspace://current/architecture.md',
      'The scheduler owns task admission and AgentPool limits.',
    );
    expect(store.search(key, 'scheduler AgentPool')).toMatchObject([
      {
        uri: 'workspace://current/architecture.md',
        chunkIndex: 0,
      },
    ]);

    store.replaceDocument(
      key,
      'workspace://current/architecture.md',
      'Artifacts are immutable and versioned.',
    );
    expect(store.search(key, 'scheduler AgentPool')).toEqual([]);
    expect(store.search(key, 'immutable versioned')[0]?.excerpt).toContain(
      'Artifacts are immutable',
    );
    store.close?.();
  });

  it('isolates identical documents between workspaces', () => {
    const store = create();
    store.replaceDocument('workspace-a', 'workspace://current/notes.md', 'alpha');
    store.replaceDocument('workspace-b', 'workspace://current/notes.md', 'beta');

    expect(store.search('workspace-a', 'beta')).toEqual([]);
    expect(store.search('workspace-b', 'beta')).toHaveLength(1);
    store.close?.();
  });
});

describe('knowledge tools', () => {
  it('indexes workspace text while ignoring dependencies and oversized files', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'knowledge-tools-'));
    directories.push(workspace);
    mkdirSync(join(workspace, 'src'));
    mkdirSync(join(workspace, 'node_modules'));
    writeFileSync(
      join(workspace, 'src', 'scheduler.ts'),
      'export const schedulerPolicy = "weighted round robin";',
    );
    writeFileSync(
      join(workspace, 'node_modules', 'ignored.ts'),
      'secret dependency phrase',
    );
    writeFileSync(
      join(workspace, 'src', 'huge.txt'),
      'x'.repeat(512_001),
    );

    const store = new InMemoryKnowledgeStore();
    const [indexTool, searchTool] = createKnowledgeTools(store);
    const context: ToolExecutionContext = {
      taskId: 'root',
      rootTaskId: 'root',
      workspaceRoot: realpathSync(workspace),
      signal: new AbortController().signal,
      idempotencyKey: 'root:index',
    };

    const result = await indexTool?.execute({}, context);
    expect(result).toMatchObject({
      indexedFiles: 1,
      skippedFiles: 1,
    });
    const hits = await searchTool?.execute(
      { query: 'weighted round robin' },
      context,
    );
    expect(hits).toMatchObject([
      {
        uri: 'workspace://current/src/scheduler.ts',
      },
    ]);
    expect(
      store.search(workspaceKnowledgeKey(realpathSync(workspace)), 'secret'),
    ).toEqual([]);

    rmSync(join(workspace, 'src', 'scheduler.ts'));
    await indexTool?.execute({}, context);
    expect(
      store.search(
        workspaceKnowledgeKey(realpathSync(workspace)),
        'weighted round robin',
      ),
    ).toEqual([]);
  });
});
