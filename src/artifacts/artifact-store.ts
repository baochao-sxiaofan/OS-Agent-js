import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type { JsonObject, JsonValue } from '../types/json.js';

export const ARTIFACT_KINDS = [
  'design',
  'document',
  'patch',
  'report',
  'research',
  'review',
  'test_result',
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type ArtifactRecord = {
  id: string;
  uri: string;
  taskId: string;
  rootTaskId: string;
  graphNodeAlias?: string;
  kind: ArtifactKind;
  title: string;
  mediaType: string;
  content: JsonValue;
  metadata: JsonObject;
  logicalName?: string;
  revision: number;
  createdAt: number;
};

export type CreateArtifactInput = {
  taskId: string;
  rootTaskId: string;
  graphNodeAlias?: string;
  kind: ArtifactKind;
  title: string;
  mediaType?: string;
  content: JsonValue;
  metadata?: JsonObject;
  logicalName?: string;
};

export type ArtifactQuery = {
  rootTaskId: string;
  taskId?: string;
  kind?: ArtifactKind;
  limit?: number;
};

export interface ArtifactStore {
  create(input: CreateArtifactInput): ArtifactRecord;
  get(artifactId: string): ArtifactRecord | undefined;
  list(query: ArtifactQuery): ArtifactRecord[];
  close?(): void;
}

export class InMemoryArtifactStore implements ArtifactStore {
  readonly #artifacts = new Map<string, ArtifactRecord>();

  create(input: CreateArtifactInput): ArtifactRecord {
    const record = createArtifactRecord(
      input,
      this.nextRevision(input.rootTaskId, input.logicalName),
    );
    this.#artifacts.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  get(artifactId: string): ArtifactRecord | undefined {
    const record = this.#artifacts.get(artifactId);
    return record ? structuredClone(record) : undefined;
  }

  list(query: ArtifactQuery): ArtifactRecord[] {
    return [...this.#artifacts.values()]
      .filter(
        (record) =>
          record.rootTaskId === query.rootTaskId &&
          (query.taskId === undefined || record.taskId === query.taskId) &&
          (query.kind === undefined || record.kind === query.kind),
      )
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, normalizeLimit(query.limit))
      .map((record) => structuredClone(record));
  }

  private nextRevision(
    rootTaskId: string,
    logicalName: string | undefined,
  ): number {
    if (!logicalName) {
      return 1;
    }
    return (
      Math.max(
        0,
        ...[...this.#artifacts.values()]
          .filter(
            (record) =>
              record.rootTaskId === rootTaskId &&
              record.logicalName === logicalName,
          )
          .map((record) => record.revision),
      ) + 1
    );
  }
}

export type SqliteArtifactStoreOptions = {
  location: string;
};

/**
 * Immutable, versioned artifact storage. Artifact bodies remain JSON so every
 * result can be carried through the existing Tool/Context boundary.
 */
export class SqliteArtifactStore implements ArtifactStore {
  readonly #db: DatabaseSync;

  constructor(options: SqliteArtifactStoreOptions) {
    this.#db = new DatabaseSync(options.location);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        root_task_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        graph_node_alias TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        media_type TEXT NOT NULL,
        logical_name TEXT,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        body TEXT NOT NULL
      )
    `);
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS idx_artifacts_root_created
      ON artifacts (root_task_id, created_at DESC)
    `);
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS idx_artifacts_logical_revision
      ON artifacts (root_task_id, logical_name, revision DESC)
    `);
  }

  create(input: CreateArtifactInput): ArtifactRecord {
    const revision = this.nextRevision(
      input.rootTaskId,
      input.logicalName,
    );
    const record = createArtifactRecord(input, revision);
    this.#db
      .prepare(`
        INSERT INTO artifacts (
          artifact_id, root_task_id, task_id, graph_node_alias, kind,
          title, media_type, logical_name, revision, created_at, body
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.rootTaskId,
        record.taskId,
        record.graphNodeAlias ?? null,
        record.kind,
        record.title,
        record.mediaType,
        record.logicalName ?? null,
        record.revision,
        record.createdAt,
        JSON.stringify(record),
      );
    return structuredClone(record);
  }

  get(artifactId: string): ArtifactRecord | undefined {
    const row = this.#db
      .prepare('SELECT body FROM artifacts WHERE artifact_id = ?')
      .get(artifactId) as { body: string } | undefined;
    return row
      ? (JSON.parse(row.body) as ArtifactRecord)
      : undefined;
  }

  list(query: ArtifactQuery): ArtifactRecord[] {
    const conditions = ['root_task_id = ?'];
    const values: Array<string | number> = [query.rootTaskId];
    if (query.taskId !== undefined) {
      conditions.push('task_id = ?');
      values.push(query.taskId);
    }
    if (query.kind !== undefined) {
      conditions.push('kind = ?');
      values.push(query.kind);
    }
    values.push(normalizeLimit(query.limit));
    const rows = this.#db
      .prepare(`
        SELECT body FROM artifacts
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(...values) as { body: string }[];
    return rows.map((row) => JSON.parse(row.body) as ArtifactRecord);
  }

  close(): void {
    this.#db.close();
  }

  private nextRevision(
    rootTaskId: string,
    logicalName: string | undefined,
  ): number {
    if (!logicalName) {
      return 1;
    }
    const row = this.#db
      .prepare(`
        SELECT MAX(revision) AS latest
        FROM artifacts
        WHERE root_task_id = ? AND logical_name = ?
      `)
      .get(rootTaskId, logicalName) as { latest: number | null };
    return (row.latest ?? 0) + 1;
  }
}

function createArtifactRecord(
  input: CreateArtifactInput,
  revision: number,
): ArtifactRecord {
  const id = randomUUID();
  return {
    id,
    uri: `artifact://${id}`,
    taskId: input.taskId,
    rootTaskId: input.rootTaskId,
    ...(input.graphNodeAlias === undefined
      ? {}
      : { graphNodeAlias: input.graphNodeAlias }),
    kind: input.kind,
    title: requireNonEmpty(input.title, 'Artifact title'),
    mediaType: input.mediaType?.trim() || 'application/json',
    content: structuredClone(input.content),
    metadata: structuredClone(input.metadata ?? {}),
    ...(input.logicalName?.trim()
      ? { logicalName: input.logicalName.trim() }
      : {}),
    revision,
    createdAt: Date.now(),
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must not be empty.`);
  }
  return normalized;
}
