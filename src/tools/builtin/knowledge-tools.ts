import { lstat, readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type { CapabilityInput } from '../../capability/capability.js';
import { CURRENT_WORKSPACE_RESOURCE } from '../../capability/workspace-capabilities.js';
import {
  workspaceKnowledgeKey,
  type KnowledgeStore,
} from '../../knowledge/knowledge-store.js';
import type { JsonValue } from '../../types/json.js';
import type { Tool } from '../tool.js';
import { WorkspaceResolver } from '../workspace-fs.js';

const INDEXABLE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.md',
  '.mjs',
  '.py',
  '.rs',
  '.sh',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.tmp',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release',
]);

const MAX_FILE_BYTES = 512_000;
const MAX_FILES_PER_INDEX = 5_000;

export function createKnowledgeTools(store: KnowledgeStore): Tool[] {
  return [
    createKnowledgeIndexTool(store),
    createKnowledgeSearchTool(store),
  ];
}

function createKnowledgeIndexTool(store: KnowledgeStore): Tool {
  return {
    name: 'knowledge.index',
    description:
      'Build or refresh the lightweight project knowledge index from text files in the mounted workspace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 32,
        },
      },
    },
    effect: 'side_effect',
    validateInput(input) {
      const paths = input['paths'];
      if (
        paths !== undefined &&
        (!Array.isArray(paths) ||
          paths.some((path) => typeof path !== 'string'))
      ) {
        return { valid: false, error: 'paths must be an array of strings.' };
      }
      return { valid: true };
    },
    requiredCapabilities(input): readonly CapabilityInput[] {
      const paths = Array.isArray(input['paths'])
        ? (input['paths'] as string[])
        : [CURRENT_WORKSPACE_RESOURCE];
      return [
        ...paths.map((path) => ({
          capability: 'file.read',
          scope: { kind: 'subtree' as const, resource: path },
        })),
        {
          capability: 'knowledge.write',
          scope: {
            kind: 'subtree',
            resource: CURRENT_WORKSPACE_RESOURCE,
          },
        },
      ];
    },
    async execute(input, context): Promise<JsonValue> {
      const root = requireWorkspaceRoot(context.workspaceRoot);
      const resolver = await WorkspaceResolver.create(root);
      const requestedPaths = Array.isArray(input['paths'])
        ? (input['paths'] as string[])
        : [CURRENT_WORKSPACE_RESOURCE];
      const files: string[] = [];
      const indexedScopes: Array<{
        uri: string;
        subtree: boolean;
      }> = [];
      for (const alias of requestedPaths) {
        const hostPath = resolver.toHostPath(alias);
        const resolved = await resolver.assertResolvedInsideRoot(hostPath);
        indexedScopes.push({
          uri: resolver.toAliasPath(resolved),
          subtree: (await lstat(resolved)).isDirectory(),
        });
        await collectFiles(resolved, files);
        if (files.length >= MAX_FILES_PER_INDEX) {
          break;
        }
      }

      const workspaceKey = workspaceKnowledgeKey(resolver.root);
      let indexedFiles = 0;
      let indexedChunks = 0;
      let skippedFiles = 0;
      const currentUris = new Set<string>();
      for (const hostPath of files.slice(0, MAX_FILES_PER_INDEX)) {
        try {
          const metadata = await lstat(hostPath);
          if (
            !metadata.isFile() ||
            metadata.size > MAX_FILE_BYTES ||
            !INDEXABLE_EXTENSIONS.has(extname(hostPath).toLowerCase())
          ) {
            skippedFiles += 1;
            continue;
          }
          const content = await readFile(hostPath, 'utf8');
          if (content.includes('\u0000')) {
            skippedFiles += 1;
            continue;
          }
          const uri = resolver.toAliasPath(hostPath);
          indexedChunks += store.replaceDocument(
            workspaceKey,
            uri,
            content,
          );
          currentUris.add(uri);
          indexedFiles += 1;
        } catch {
          skippedFiles += 1;
        }
      }
      let removedDocuments = 0;
      for (const uri of store.listDocumentUris(workspaceKey)) {
        if (
          indexedScopes.some((scope) => uriWithinScope(uri, scope)) &&
          !currentUris.has(uri)
        ) {
          store.removeDocument(workspaceKey, uri);
          removedDocuments += 1;
        }
      }
      return {
        indexedFiles,
        indexedChunks,
        skippedFiles,
        removedDocuments,
        truncated: files.length >= MAX_FILES_PER_INDEX,
      };
    },
  };
}

function createKnowledgeSearchTool(store: KnowledgeStore): Tool {
  return {
    name: 'knowledge.search',
    description:
      'Retrieve relevant indexed project chunks with stable workspace citations. Run knowledge.index when the index is missing or stale.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
    },
    effect: 'read_only',
    validateInput(input) {
      if (
        typeof input['query'] !== 'string' ||
        input['query'].trim().length < 2
      ) {
        return {
          valid: false,
          error: 'query must contain at least two characters.',
        };
      }
      if (
        input['limit'] !== undefined &&
        (!Number.isInteger(input['limit']) ||
          Number(input['limit']) < 1 ||
          Number(input['limit']) > 20)
      ) {
        return { valid: false, error: 'limit must be between 1 and 20.' };
      }
      return { valid: true };
    },
    requiredCapabilities(): readonly CapabilityInput[] {
      return [
        {
          capability: 'knowledge.read',
          scope: {
            kind: 'subtree',
            resource: CURRENT_WORKSPACE_RESOURCE,
          },
        },
      ];
    },
    async execute(input, context): Promise<JsonValue> {
      const root = requireWorkspaceRoot(context.workspaceRoot);
      const workspaceKey = workspaceKnowledgeKey(root);
      const hits = store.search(
        workspaceKey,
        String(input['query']),
        typeof input['limit'] === 'number' ? input['limit'] : 8,
      );
      return hits.map(({ uri, chunkIndex, score, excerpt }) => ({
        uri,
        chunkIndex,
        score,
        excerpt,
      }));
    },
  };
}

async function collectFiles(path: string, files: string[]): Promise<void> {
  if (files.length >= MAX_FILES_PER_INDEX) {
    return;
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    return;
  }
  if (metadata.isFile()) {
    files.push(path);
    return;
  }
  if (!metadata.isDirectory()) {
    return;
  }
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (
      files.length >= MAX_FILES_PER_INDEX ||
      (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) ||
      entry.isSymbolicLink()
    ) {
      continue;
    }
    await collectFiles(join(path, entry.name), files);
  }
}

function requireWorkspaceRoot(root: string | undefined): string {
  if (!root) {
    throw new Error('Knowledge tools require a mounted workspace.');
  }
  return root;
}

function uriWithinScope(
  uri: string,
  scope: { uri: string; subtree: boolean },
): boolean {
  if (!scope.subtree) {
    return uri === scope.uri;
  }
  const prefix = scope.uri.endsWith('/') ? scope.uri : `${scope.uri}/`;
  return uri === scope.uri || uri.startsWith(prefix);
}
