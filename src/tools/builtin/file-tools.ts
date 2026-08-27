import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';

import type { CapabilityInput } from '../../capability/capability.js';
import { CURRENT_WORKSPACE_RESOURCE } from '../../capability/workspace-capabilities.js';
import type { JsonObject, JsonValue } from '../../types/json.js';
import type { Tool, ToolExecutionContext, ToolInputValidation } from '../tool.js';
import { WorkspaceResolver } from '../workspace-fs.js';

const MAX_READ_BYTES = 256 * 1024;

function requireStringField(
  input: JsonObject,
  field: string,
): ToolInputValidation {
  const value = input[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {
      valid: false,
      error: `${field} must be a non-empty string.`,
    };
  }
  if (!value.startsWith(CURRENT_WORKSPACE_RESOURCE)) {
    return {
      valid: false,
      error: `${field} must start with ${CURRENT_WORKSPACE_RESOURCE}.`,
    };
  }
  return { valid: true };
}

async function requireResolver(
  context: ToolExecutionContext,
): Promise<WorkspaceResolver> {
  if (!context.workspaceRoot) {
    throw new Error(
      'This tool requires a mounted workspace; none is attached to the conversation.',
    );
  }
  return await WorkspaceResolver.create(context.workspaceRoot);
}

/** 读取工作区内单个文件的文本内容。 */
export const fileReadTool: Tool = {
  name: 'file.read',
  description:
    'Read a UTF-8 text file inside the workspace. Input: { path: "workspace://current/..." }.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
  effect: 'read_only',
  validateInput(input) {
    return requireStringField(input, 'path');
  },
  requiredCapabilities(input): readonly CapabilityInput[] {
    return [
      {
        capability: 'file.read',
        scope: { kind: 'exact', resource: String(input['path']) },
      },
    ];
  },
  async execute(input, context): Promise<JsonValue> {
    const resolver = await requireResolver(context);
    const hostPath = resolver.toHostPath(String(input['path']));
    await resolver.assertResolvedInsideRoot(hostPath);
    const content = await readFile(hostPath, 'utf8');
    if (content.length > MAX_READ_BYTES) {
      return {
        path: String(input['path']),
        truncated: true,
        content: content.slice(0, MAX_READ_BYTES),
      };
    }
    return { path: String(input['path']), truncated: false, content };
  },
};

/** 覆盖写入工作区内已经存在的文件。 */
export const fileWriteTool: Tool = {
  name: 'file.write',
  description:
    'Overwrite an existing UTF-8 text file inside the workspace. Input: { path, content }.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  effect: 'side_effect',
  validateInput(input) {
    const pathValidation = requireStringField(input, 'path');
    if (!pathValidation.valid) {
      return pathValidation;
    }
    if (typeof input['content'] !== 'string') {
      return { valid: false, error: 'content must be a string.' };
    }
    return { valid: true };
  },
  requiredCapabilities(input): readonly CapabilityInput[] {
    return [
      {
        capability: 'file.write',
        scope: { kind: 'exact', resource: String(input['path']) },
      },
    ];
  },
  async execute(input, context): Promise<JsonValue> {
    const resolver = await requireResolver(context);
    const hostPath = resolver.toHostPath(String(input['path']));
    await resolver.assertResolvedInsideRoot(hostPath);
    await writeFile(hostPath, String(input['content']), 'utf8');
    return {
      path: String(input['path']),
      bytesWritten: String(input['content']).length,
    };
  },
};

/** 排他创建工作区内的新文件，目标已存在时拒绝覆盖。 */
export const fileCreateTool: Tool = {
  name: 'file.create',
  description:
    'Create a new UTF-8 text file inside the workspace without overwriting an existing file. Input: { path, content }.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  effect: 'side_effect',
  validateInput(input) {
    const pathValidation = requireStringField(input, 'path');
    if (!pathValidation.valid) {
      return pathValidation;
    }
    if (typeof input['content'] !== 'string') {
      return { valid: false, error: 'content must be a string.' };
    }
    return { valid: true };
  },
  requiredCapabilities(input): readonly CapabilityInput[] {
    return [
      {
        capability: 'file.create',
        scope: { kind: 'exact', resource: String(input['path']) },
      },
    ];
  },
  async execute(input, context): Promise<JsonValue> {
    const resolver = await requireResolver(context);
    const hostPath = await resolver.resolveWriteTarget(
      String(input['path']),
    );
    await writeFile(hostPath, String(input['content']), {
      encoding: 'utf8',
      flag: 'wx',
    });
    return {
      path: String(input['path']),
      bytesWritten: String(input['content']).length,
    };
  },
};

/** 删除工作区内的文件。 */
export const fileDeleteTool: Tool = {
  name: 'file.delete',
  description:
    'Delete a file inside the workspace. Input: { path: "workspace://current/..." }.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
  effect: 'side_effect',
  validateInput(input) {
    return requireStringField(input, 'path');
  },
  requiredCapabilities(input): readonly CapabilityInput[] {
    return [
      {
        capability: 'file.delete',
        scope: { kind: 'exact', resource: String(input['path']) },
      },
    ];
  },
  async execute(input, context): Promise<JsonValue> {
    const resolver = await requireResolver(context);
    const hostPath = resolver.toHostPath(String(input['path']));
    await resolver.assertResolvedInsideRoot(hostPath);
    await rm(hostPath, { force: true });
    return { path: String(input['path']), deleted: true };
  },
};

/** 列出工作区内目录的直接条目。 */
export const directoryListTool: Tool = {
  name: 'directory.list',
  description:
    'List entries of a directory inside the workspace. Input: { path: "workspace://current/..." }.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
  effect: 'read_only',
  validateInput(input) {
    return requireStringField(input, 'path');
  },
  requiredCapabilities(input): readonly CapabilityInput[] {
    return [
      {
        capability: 'directory.read',
        scope: { kind: 'subtree', resource: String(input['path']) },
      },
    ];
  },
  async execute(input, context): Promise<JsonValue> {
    const resolver = await requireResolver(context);
    const hostPath = resolver.toHostPath(String(input['path']));
    await resolver.assertResolvedInsideRoot(hostPath);
    const entries = await readdir(hostPath, { withFileTypes: true });
    return {
      path: String(input['path']),
      entries: entries.map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? 'directory' : 'file',
      })),
    };
  },
};

/** 创建工作区内的单层目录；父目录必须已经存在。 */
export const directoryCreateTool: Tool = {
  name: 'directory.create',
  description:
    'Create one directory inside the workspace. Its parent directory must already exist. Input: { path }.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
  effect: 'side_effect',
  validateInput(input) {
    return requireStringField(input, 'path');
  },
  requiredCapabilities(input): readonly CapabilityInput[] {
    return [
      {
        capability: 'directory.create',
        scope: { kind: 'exact', resource: String(input['path']) },
      },
    ];
  },
  async execute(input, context): Promise<JsonValue> {
    const resolver = await requireResolver(context);
    const hostPath = await resolver.resolveWriteTarget(
      String(input['path']),
    );
    await mkdir(hostPath);
    return { path: String(input['path']), created: true };
  },
};

/** 递归删除工作区内目录。 */
export const directoryDeleteTool: Tool = {
  name: 'directory.delete',
  description:
    'Recursively delete one directory inside the workspace. Input: { path }.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
  effect: 'side_effect',
  validateInput(input) {
    const validation = requireStringField(input, 'path');
    if (!validation.valid) {
      return validation;
    }
    return input['path'] === CURRENT_WORKSPACE_RESOURCE
      ? {
          valid: false,
          error: 'The workspace root directory cannot be deleted.',
        }
      : { valid: true };
  },
  requiredCapabilities(input): readonly CapabilityInput[] {
    return [
      {
        capability: 'directory.delete',
        scope: { kind: 'exact', resource: String(input['path']) },
      },
    ];
  },
  async execute(input, context): Promise<JsonValue> {
    const resolver = await requireResolver(context);
    const hostPath = resolver.toHostPath(String(input['path']));
    await resolver.assertResolvedInsideRoot(hostPath);
    await rm(hostPath, { recursive: true, force: true });
    return { path: String(input['path']), deleted: true };
  },
};
