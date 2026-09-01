import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type KnowledgeChunk = {
  workspaceKey: string;
  uri: string;
  chunkIndex: number;
  content: string;
};

export type KnowledgeSearchHit = KnowledgeChunk & {
  score: number;
  excerpt: string;
};

export interface KnowledgeStore {
  replaceDocument(
    workspaceKey: string,
    uri: string,
    content: string,
  ): number;
  removeDocument(workspaceKey: string, uri: string): void;
  listDocumentUris(workspaceKey: string): string[];
  search(
    workspaceKey: string,
    query: string,
    limit?: number,
  ): KnowledgeSearchHit[];
  close?(): void;
}

export function workspaceKnowledgeKey(canonicalRoot: string): string {
  return createHash('sha256')
    .update(canonicalRoot)
    .digest('hex')
    .slice(0, 24);
}

export class InMemoryKnowledgeStore implements KnowledgeStore {
  readonly #chunks = new Map<string, KnowledgeChunk[]>();

  replaceDocument(
    workspaceKey: string,
    uri: string,
    content: string,
  ): number {
    const chunks = chunkDocument(workspaceKey, uri, content);
    this.#chunks.set(documentKey(workspaceKey, uri), chunks);
    return chunks.length;
  }

  removeDocument(workspaceKey: string, uri: string): void {
    this.#chunks.delete(documentKey(workspaceKey, uri));
  }

  listDocumentUris(workspaceKey: string): string[] {
    return [...this.#chunks.values()]
      .flat()
      .filter((chunk) => chunk.workspaceKey === workspaceKey)
      .map((chunk) => chunk.uri)
      .filter((uri, index, uris) => uris.indexOf(uri) === index)
      .sort();
  }

  search(
    workspaceKey: string,
    query: string,
    limit = 8,
  ): KnowledgeSearchHit[] {
    const terms = queryTerms(query);
    if (terms.length === 0) {
      return [];
    }
    return [...this.#chunks.values()]
      .flat()
      .filter((chunk) => chunk.workspaceKey === workspaceKey)
      .map((chunk) => {
        const lower = chunk.content.toLowerCase();
        const matches = terms.reduce(
          (count, term) =>
            count + (lower.includes(term.toLowerCase()) ? 1 : 0),
          0,
        );
        return {
          ...chunk,
          score: matches / terms.length,
          excerpt: excerpt(chunk.content, terms),
        };
      })
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, normalizeLimit(limit));
  }
}

export class SqliteKnowledgeStore implements KnowledgeStore {
  readonly #db: DatabaseSync;

  constructor(location: string) {
    this.#db = new DatabaseSync(location);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks USING fts5(
        workspace_key UNINDEXED,
        uri UNINDEXED,
        chunk_index UNINDEXED,
        content,
        tokenize = 'unicode61'
      )
    `);
  }

  replaceDocument(
    workspaceKey: string,
    uri: string,
    content: string,
  ): number {
    const chunks = chunkDocument(workspaceKey, uri, content);
    const remove = this.#db.prepare(
      'DELETE FROM knowledge_chunks WHERE workspace_key = ? AND uri = ?',
    );
    const insert = this.#db.prepare(`
      INSERT INTO knowledge_chunks (
        workspace_key, uri, chunk_index, content
      ) VALUES (?, ?, ?, ?)
    `);
    this.#db.exec('BEGIN');
    try {
      remove.run(workspaceKey, uri);
      for (const chunk of chunks) {
        insert.run(
          chunk.workspaceKey,
          chunk.uri,
          chunk.chunkIndex,
          chunk.content,
        );
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return chunks.length;
  }

  removeDocument(workspaceKey: string, uri: string): void {
    this.#db
      .prepare(
        'DELETE FROM knowledge_chunks WHERE workspace_key = ? AND uri = ?',
      )
      .run(workspaceKey, uri);
  }

  listDocumentUris(workspaceKey: string): string[] {
    const rows = this.#db
      .prepare(`
        SELECT DISTINCT uri
        FROM knowledge_chunks
        WHERE workspace_key = ?
        ORDER BY uri
      `)
      .all(workspaceKey) as Array<{ uri: string }>;
    return rows.map((row) => row.uri);
  }

  search(
    workspaceKey: string,
    query: string,
    limit = 8,
  ): KnowledgeSearchHit[] {
    const terms = queryTerms(query);
    if (terms.length === 0) {
      return [];
    }
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    const rows = this.#db
      .prepare(`
        SELECT
          workspace_key,
          uri,
          chunk_index,
          content,
          bm25(knowledge_chunks) AS rank
        FROM knowledge_chunks
        WHERE knowledge_chunks MATCH ? AND workspace_key = ?
        ORDER BY rank
        LIMIT ?
      `)
      .all(match, workspaceKey, normalizeLimit(limit)) as Array<{
        workspace_key: string;
        uri: string;
        chunk_index: number;
        content: string;
        rank: number;
      }>;
    return rows.map((row) => ({
      workspaceKey: row.workspace_key,
      uri: row.uri,
      chunkIndex: row.chunk_index,
      content: row.content,
      score: Math.max(0, -row.rank),
      excerpt: excerpt(row.content, terms),
    }));
  }

  close(): void {
    this.#db.close();
  }
}

const CHUNK_SIZE = 1_800;
const CHUNK_OVERLAP = 240;

function chunkDocument(
  workspaceKey: string,
  uri: string,
  content: string,
): KnowledgeChunk[] {
  const normalized = content.replace(/\r\n?/gu, '\n');
  if (!normalized.trim()) {
    return [];
  }
  const chunks: KnowledgeChunk[] = [];
  let offset = 0;
  while (offset < normalized.length) {
    let end = Math.min(normalized.length, offset + CHUNK_SIZE);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf('\n', end);
      if (boundary > offset + CHUNK_SIZE / 2) {
        end = boundary;
      }
    }
    chunks.push({
      workspaceKey,
      uri,
      chunkIndex: chunks.length,
      content: normalized.slice(offset, end),
    });
    if (end >= normalized.length) {
      break;
    }
    offset = Math.max(offset + 1, end - CHUNK_OVERLAP);
  }
  return chunks;
}

function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .normalize('NFKC')
        .match(/[\p{L}\p{N}_-]{2,}/gu)
        ?.slice(0, 16) ?? [],
    ),
  ];
}

function excerpt(content: string, terms: readonly string[]): string {
  const lower = content.toLowerCase();
  const firstIndex = Math.min(
    ...terms
      .map((term) => lower.indexOf(term.toLowerCase()))
      .filter((index) => index >= 0),
  );
  const start = Number.isFinite(firstIndex)
    ? Math.max(0, firstIndex - 180)
    : 0;
  return content.slice(start, start + 700);
}

function documentKey(workspaceKey: string, uri: string): string {
  return `${workspaceKey}\u0000${uri}`;
}

function normalizeLimit(limit: number): number {
  return Math.max(1, Math.min(20, Math.floor(limit)));
}
