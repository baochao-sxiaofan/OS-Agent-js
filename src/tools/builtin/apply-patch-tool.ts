import { mkdir, readFile, writeFile } from 'node:fs/promises';

import type { CapabilityInput } from '../../capability/capability.js';
import { CURRENT_WORKSPACE_RESOURCE } from '../../capability/workspace-capabilities.js';
import type { JsonValue } from '../../types/json.js';
import type { Tool, ToolExecutionContext } from '../tool.js';
import { WorkspaceResolver } from '../workspace-fs.js';

/**
 * 结构化补丁：以“查找-替换”方式修改工作区内已存在的文件。
 *
 * 采用精确唯一匹配而不是行号 diff：`find` 必须在文件中恰好出现一次，否则拒绝，
 * 避免模型基于过期行号造成错误覆盖。
 */
export const fileApplyPatchTool: Tool = {
  name: 'file.apply_patch',
  description: [
    'Apply a unique find/replace edit to an existing workspace file.',
    'Input: { path, find, replace }. `find` must occur exactly once.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      find: { type: 'string' },
      replace: { type: 'string' },
    },
    required: ['path', 'find', 'replace'],
  },
  effect: 'side_effect',
  validateInput(input) {
    const path = input['path'];
    if (typeof path !== 'string' || !path.startsWith(CURRENT_WORKSPACE_RESOURCE)) {
      return {
        valid: false,
        error: `path must start with ${CURRENT_WORKSPACE_RESOURCE}.`,
      };
    }
    if (typeof input['find'] !== 'string' || input['find'].length === 0) {
      return { valid: false, error: 'find must be a non-empty string.' };
    }
    if (typeof input['replace'] !== 'string') {
      return { valid: false, error: 'replace must be a string.' };
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
  async execute(input, context: ToolExecutionContext): Promise<JsonValue> {
    if (!context.workspaceRoot) {
      throw new Error(
        'file.apply_patch requires a mounted workspace; none is attached.',
      );
    }
    const resolver = await WorkspaceResolver.create(context.workspaceRoot);
    const hostPath = resolver.toHostPath(String(input['path']));
    await resolver.assertResolvedInsideRoot(hostPath);
    const original = await readFile(hostPath, 'utf8');
    const find = String(input['find']);
    const firstIndex = original.indexOf(find);
    if (firstIndex === -1) {
      throw new Error('file.apply_patch found no match for `find`.');
    }
    if (original.indexOf(find, firstIndex + find.length) !== -1) {
      throw new Error(
        'file.apply_patch matched `find` more than once; make it unique.',
      );
    }
    const updated =
      original.slice(0, firstIndex) +
      String(input['replace']) +
      original.slice(firstIndex + find.length);
    const parent = hostPath.slice(0, hostPath.lastIndexOf('/'));
    await mkdir(parent, { recursive: true });
    await writeFile(hostPath, updated, 'utf8');
    return {
      path: String(input['path']),
      replaced: true,
      bytesWritten: updated.length,
    };
  },
};
