import type { CapabilityInput } from '../../capability/capability.js';
import { CURRENT_WORKSPACE_RESOURCE } from '../../capability/workspace-capabilities.js';
import type { JsonValue } from '../../types/json.js';
import type { Tool } from '../tool.js';
import { WorkspaceResolver } from '../workspace-fs.js';

const ALLOWED_COMMANDS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'vitest',
  'tsc',
  'jest',
]);

export type SandboxedProcessRequest = {
  command: string;
  args: readonly string[];
  cwd: string;
  signal: AbortSignal;
  idempotencyKey: string;
  timeoutMs: number;
};

/**
 * 操作系统级进程隔离边界。
 *
 * 实现必须约束整棵子进程树、文件系统访问、网络访问、
 * 环境变量和执行时间。仅调用
 * `child_process.spawn` 无法满足此协议。
 */
export interface ProcessSandbox {
  run(request: SandboxedProcessRequest): Promise<JsonValue>;
}

function toStringArgs(value: JsonValue | undefined): string[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const args: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      return undefined;
    }
    args.push(item);
  }
  return args;
}

/**
 * 基于宿主注入的操作系统级沙箱创建 `test.run`。
 *
 * 运行时只有在配置真实 ProcessSandbox 后才能注册此工具，
 * 防止静默退化为不受限制的
 * 宿主进程执行。
 */
export function createTestRunTool(sandbox: ProcessSandbox): Tool {
  return {
    name: 'test.run',
    description: [
      'Run a test, type-check, or build command in an isolated workspace.',
      'Input: { command, args?: string[] }. The command must be whitelisted.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: {
          type: 'string',
          enum: [...ALLOWED_COMMANDS],
        },
        args: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['command'],
    },
    effect: 'privileged',
    validateInput(input) {
      const command = input['command'];
      if (typeof command !== 'string' || command.length === 0) {
        return {
          valid: false,
          error: 'command must be a non-empty string.',
        };
      }
      if (!ALLOWED_COMMANDS.has(command)) {
        return {
          valid: false,
          error: `command must be one of: ${[...ALLOWED_COMMANDS].join(', ')}.`,
        };
      }
      if (toStringArgs(input['args']) === undefined) {
        return {
          valid: false,
          error: 'args must be an array of strings.',
        };
      }
      return { valid: true };
    },
    requiredCapabilities(): readonly CapabilityInput[] {
      return [
        {
          capability: 'test.run',
          scope: {
            kind: 'subtree',
            resource: CURRENT_WORKSPACE_RESOURCE,
          },
        },
      ];
    },
    async execute(input, context): Promise<JsonValue> {
      if (!context.workspaceRoot) {
        throw new Error(
          'test.run requires a mounted workspace; none is attached.',
        );
      }
      const resolver = await WorkspaceResolver.create(
        context.workspaceRoot,
      );
      return await sandbox.run({
        command: String(input['command']),
        args: toStringArgs(input['args']) ?? [],
        cwd: resolver.root,
        signal: context.signal,
        idempotencyKey: context.idempotencyKey,
        timeoutMs: 120_000,
      });
    },
  };
}
