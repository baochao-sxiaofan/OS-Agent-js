import {
  ARTIFACT_KINDS,
  type ArtifactKind,
  type ArtifactStore,
} from '../../artifacts/artifact-store.js';
import type { CapabilityInput } from '../../capability/capability.js';
import type { JsonObject, JsonValue } from '../../types/json.js';
import type { Tool } from '../tool.js';

const ARTIFACT_RESOURCE = 'artifact://task/';

export function createArtifactTools(store: ArtifactStore): Tool[] {
  return [
    createArtifactWriteTool(store),
    createArtifactReadTool(store),
    createArtifactListTool(store),
  ];
}

function createArtifactWriteTool(store: ArtifactStore): Tool {
  return {
    name: 'artifact.write',
    description:
      'Persist a versioned design, patch, report, research note, review, test result, or document. Returns a stable artifact URI.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: [...ARTIFACT_KINDS] },
        title: { type: 'string' },
        content: {},
        mediaType: { type: 'string' },
        logicalName: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['kind', 'title', 'content'],
    },
    effect: 'side_effect',
    validateInput(input) {
      if (!isArtifactKind(input['kind'])) {
        return { valid: false, error: 'kind is unsupported.' };
      }
      if (!nonEmptyString(input['title'])) {
        return { valid: false, error: 'title must be a non-empty string.' };
      }
      if (input['content'] === undefined) {
        return { valid: false, error: 'content is required.' };
      }
      if (
        input['mediaType'] !== undefined &&
        !nonEmptyString(input['mediaType'])
      ) {
        return { valid: false, error: 'mediaType must be a string.' };
      }
      if (
        input['logicalName'] !== undefined &&
        !nonEmptyString(input['logicalName'])
      ) {
        return { valid: false, error: 'logicalName must be a string.' };
      }
      if (
        input['metadata'] !== undefined &&
        !isObject(input['metadata'])
      ) {
        return { valid: false, error: 'metadata must be an object.' };
      }
      return { valid: true };
    },
    requiredCapabilities(): readonly CapabilityInput[] {
      return [
        {
          capability: 'artifact.write',
          scope: { kind: 'subtree', resource: ARTIFACT_RESOURCE },
        },
      ];
    },
    async execute(input, context): Promise<JsonValue> {
      const record = store.create({
        taskId: context.taskId,
        rootTaskId: context.rootTaskId ?? context.taskId,
        ...(context.graphNodeAlias === undefined
          ? {}
          : { graphNodeAlias: context.graphNodeAlias }),
        kind: input['kind'] as ArtifactKind,
        title: String(input['title']),
        content: structuredClone(input['content'] as JsonValue),
        ...(typeof input['mediaType'] === 'string'
          ? { mediaType: input['mediaType'] }
          : {}),
        ...(typeof input['logicalName'] === 'string'
          ? { logicalName: input['logicalName'] }
          : {}),
        ...(isObject(input['metadata'])
          ? { metadata: structuredClone(input['metadata']) }
          : {}),
      });
      return toJson({
        artifactUri: record.uri,
        kind: record.kind,
        title: record.title,
        revision: record.revision,
      });
    },
  };
}

function createArtifactReadTool(store: ArtifactStore): Tool {
  return {
    name: 'artifact.read',
    description:
      'Read one persisted artifact by its artifact:// URI or artifact ID.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        artifact: { type: 'string' },
      },
      required: ['artifact'],
    },
    effect: 'read_only',
    validateInput(input) {
      return nonEmptyString(input['artifact'])
        ? { valid: true }
        : { valid: false, error: 'artifact must be a non-empty string.' };
    },
    requiredCapabilities(): readonly CapabilityInput[] {
      return [
        {
          capability: 'artifact.read',
          scope: { kind: 'subtree', resource: ARTIFACT_RESOURCE },
        },
      ];
    },
    async execute(input, context): Promise<JsonValue> {
      const id = String(input['artifact']).replace(/^artifact:\/\//u, '');
      const record = store.get(id);
      if (
        !record ||
        record.rootTaskId !== (context.rootTaskId ?? context.taskId)
      ) {
        throw new Error('Artifact was not found in the current task tree.');
      }
      return toJson(record);
    },
  };
}

function createArtifactListTool(store: ArtifactStore): Tool {
  return {
    name: 'artifact.list',
    description:
      'List persisted artifacts from the current task tree, newest first.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: [...ARTIFACT_KINDS] },
        ownTaskOnly: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    effect: 'read_only',
    validateInput(input) {
      if (input['kind'] !== undefined && !isArtifactKind(input['kind'])) {
        return { valid: false, error: 'kind is unsupported.' };
      }
      if (
        input['ownTaskOnly'] !== undefined &&
        typeof input['ownTaskOnly'] !== 'boolean'
      ) {
        return { valid: false, error: 'ownTaskOnly must be boolean.' };
      }
      if (
        input['limit'] !== undefined &&
        (!Number.isInteger(input['limit']) ||
          Number(input['limit']) < 1 ||
          Number(input['limit']) > 200)
      ) {
        return { valid: false, error: 'limit must be between 1 and 200.' };
      }
      return { valid: true };
    },
    requiredCapabilities(): readonly CapabilityInput[] {
      return [
        {
          capability: 'artifact.read',
          scope: { kind: 'subtree', resource: ARTIFACT_RESOURCE },
        },
      ];
    },
    async execute(input, context): Promise<JsonValue> {
      return toJson(
        store.list({
          rootTaskId: context.rootTaskId ?? context.taskId,
          ...(input['ownTaskOnly'] === true
            ? { taskId: context.taskId }
            : {}),
          ...(isArtifactKind(input['kind'])
            ? { kind: input['kind'] }
            : {}),
          ...(typeof input['limit'] === 'number'
            ? { limit: input['limit'] }
            : {}),
        }),
      );
    },
  };
}

function isArtifactKind(value: JsonValue | undefined): value is ArtifactKind {
  return (
    typeof value === 'string' &&
    ARTIFACT_KINDS.some((kind) => kind === value)
  );
}

function nonEmptyString(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
