import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  InMemoryArtifactStore,
  SqliteArtifactStore,
  createArtifactTools,
  type ArtifactStore,
  type ToolExecutionContext,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.each([
  {
    name: 'memory',
    create(): ArtifactStore {
      return new InMemoryArtifactStore();
    },
  },
  {
    name: 'sqlite',
    create(): ArtifactStore {
      const directory = mkdtempSync(join(tmpdir(), 'artifact-store-'));
      temporaryDirectories.push(directory);
      return new SqliteArtifactStore({
        location: join(directory, 'artifacts.db'),
      });
    },
  },
])('ArtifactStore ($name)', ({ create }) => {
  it('creates immutable records and scopes queries to a task tree', () => {
    const store = create();
    const input = {
      taskId: 'developer-1',
      rootTaskId: 'root-1',
      graphNodeAlias: 'implement_store',
      kind: 'design' as const,
      title: 'Artifact design',
      content: { decision: 'immutable records' },
      metadata: { author: 'developer' },
      logicalName: 'artifact-design',
    };

    const created = store.create(input);
    input.content.decision = 'mutated by caller';
    input.metadata.author = 'mutated by caller';

    expect(created).toMatchObject({
      uri: `artifact://${created.id}`,
      revision: 1,
      graphNodeAlias: 'implement_store',
    });
    expect(store.get(created.id)).toMatchObject({
      content: { decision: 'immutable records' },
      metadata: { author: 'developer' },
    });
    expect(store.list({ rootTaskId: 'different-root' })).toEqual([]);
    store.close?.();
  });

  it('increments revisions only within the same root and logical name', () => {
    const store = create();
    const createVersion = (rootTaskId: string, logicalName: string) =>
      store.create({
        taskId: rootTaskId,
        rootTaskId,
        kind: 'document',
        title: logicalName,
        logicalName,
        content: 'body',
      });

    expect(createVersion('root-1', 'adr-auth').revision).toBe(1);
    expect(createVersion('root-1', 'adr-auth').revision).toBe(2);
    expect(createVersion('root-1', 'adr-storage').revision).toBe(1);
    expect(createVersion('root-2', 'adr-auth').revision).toBe(1);
    store.close?.();
  });
});

describe('SqliteArtifactStore durability', () => {
  it('restores artifacts after the store is reopened', () => {
    const directory = mkdtempSync(join(tmpdir(), 'artifact-reopen-'));
    temporaryDirectories.push(directory);
    const location = join(directory, 'artifacts.db');
    const first = new SqliteArtifactStore({ location });
    const created = first.create({
      taskId: 'reviewer-1',
      rootTaskId: 'root-1',
      kind: 'review',
      title: 'Review report',
      content: { findings: ['none'] },
    });
    first.close();

    const restored = new SqliteArtifactStore({ location });
    expect(restored.get(created.id)).toMatchObject({
      id: created.id,
      content: { findings: ['none'] },
    });
    expect(restored.list({ rootTaskId: 'root-1' })).toHaveLength(1);
    restored.close();
  });
});

describe('artifact tools', () => {
  it('binds artifacts to the current task tree and graph node', async () => {
    const store = new InMemoryArtifactStore();
    const [writeTool, readTool, listTool] = createArtifactTools(store);
    const context: ToolExecutionContext = {
      taskId: 'developer-1',
      rootTaskId: 'root-1',
      graphNodeAlias: 'implement_artifacts',
      signal: new AbortController().signal,
      idempotencyKey: 'developer-1:artifact-1',
    };

    const written = (await writeTool?.execute(
      {
        kind: 'patch',
        title: 'Implementation patch',
        content: { files: ['src/index.ts'] },
        logicalName: 'implementation',
      },
      context,
    )) as { artifactUri: string };
    expect(written.artifactUri).toMatch(/^artifact:\/\//u);

    await expect(
      readTool?.execute(
        { artifact: written.artifactUri },
        { ...context, rootTaskId: 'different-root' },
      ),
    ).rejects.toThrow('not found');
    await expect(
      listTool?.execute({}, context),
    ).resolves.toMatchObject([
      {
        graphNodeAlias: 'implement_artifacts',
        title: 'Implementation patch',
      },
    ]);
  });
});
