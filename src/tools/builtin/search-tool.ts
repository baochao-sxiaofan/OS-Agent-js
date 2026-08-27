import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CapabilityInput } from '../../capability/capability.js';
import { CURRENT_WORKSPACE_RESOURCE } from '../../capability/workspace-capabilities.js';
import type { JsonValue } from '../../types/json.js';
import type { Tool, ToolExecutionContext } from '../tool.js';
import { WorkspaceResolver } from '../workspace-fs.js';

const MAX_MATCHES = 200;
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'out']);

/**
 * 在工作区内做纯文本子串搜索，返回命中文件、行号和该行内容。
 *
 * 只读能力，作用范围锁定在传入的目录别名子树内；跳过依赖和构建产物目录以控制
 * 结果规模。
 */
export const workspaceSearchTool: Tool = {
  name: 'workspace.search',
  description: [
    'Search workspace files for a literal substring.',
    'Input: { query, path? }. Returns matching file/line/text entries.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string' },
      path: { type: 'string' },
    },
    required: ['query'],
  },
  effect: 'read_only',
  validateInput(input) {
    if (typeof input['query'] !== 'string' || input['query'].length === 0) {
      return { valid: false, error: 'query must be a non-empty string.' };
    }
    const path = input['path'];
    if (
      path !== undefined &&
      (typeof path !== 'string' ||
        !path.startsWith(CURRENT_WORKSPACE_RESOURCE))
    ) {
      return {
        valid: false,
        error: `path must start with ${CURRENT_WORKSPACE_RESOURCE}.`,
      };
    }
    return { valid: true };
  },
  requiredCapabilities(input): readonly CapabilityInput[] {
    const scopeResource =
      typeof input['path'] === 'string'
        ? String(input['path'])
        : CURRENT_WORKSPACE_RESOURCE;
    return [
      {
        capability: 'directory.read',
        scope: { kind: 'subtree', resource: scopeResource },
      },
      {
        capability: 'file.read',
        scope: { kind: 'subtree', resource: scopeResource },
      },
    ];
  },
  async execute(input, context: ToolExecutionContext): Promise<JsonValue> {
    if (!context.workspaceRoot) {
      throw new Error(
        'workspace.search requires a mounted workspace; none is attached.',
      );
    }
    const resolver = await WorkspaceResolver.create(context.workspaceRoot);
    const aliasRoot =
      typeof input['path'] === 'string'
        ? String(input['path'])
        : CURRENT_WORKSPACE_RESOURCE;
    const hostRoot = resolver.toHostPath(aliasRoot);
    await resolver.assertResolvedInsideRoot(hostRoot);
    const query = String(input['query']);
    const matches: Array<{ path: string; line: number; text: string }> = [];

    const walk = async (directory: string): Promise<void> => {
      if (matches.length >= MAX_MATCHES) {
        return;
      }
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= MAX_MATCHES) {
          return;
        }
        if (entry.isDirectory()) {
          if (SKIP_DIRECTORIES.has(entry.name)) {
            continue;
          }
          await walk(join(directory, entry.name));
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const hostPath = join(directory, entry.name);
        let content: string;
        try {
          content = await readFile(hostPath, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1) {
          const text = lines[index];
          if (text !== undefined && text.includes(query)) {
            matches.push({
              path: resolver.toAliasPath(hostPath),
              line: index + 1,
              text: text.slice(0, 400),
            });
            if (matches.length >= MAX_MATCHES) {
              break;
            }
          }
        }
      }
    };

    await walk(hostRoot);
    return {
      query,
      truncated: matches.length >= MAX_MATCHES,
      matches,
    };
  },
};
