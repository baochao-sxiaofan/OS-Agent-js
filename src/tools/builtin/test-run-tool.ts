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
 * OS-level process isolation boundary.
 *
 * Implementations must constrain the complete child process tree, filesystem
 * access, network access, environment variables, and execution time. A plain
 * `child_process.spawn` implementation does not satisfy this contract.
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
 * Creates `test.run` around an injected OS-level sandbox.
 *
 * The runtime must not register this tool until a real ProcessSandbox is
 * configured. This prevents silently falling back to unrestricted host
 * execution.
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
