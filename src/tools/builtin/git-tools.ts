import { relative } from 'node:path';

import type { CapabilityInput } from '../../capability/capability.js';
import { CURRENT_WORKSPACE_RESOURCE } from '../../capability/workspace-capabilities.js';
import type { JsonValue } from '../../types/json.js';
import type { Tool } from '../tool.js';
import { WorkspaceResolver } from '../workspace-fs.js';
import type { ProcessSandbox } from './test-run-tool.js';

const BRANCH_PATTERN = /^(?![-/.])(?!.*(?:\.\.|\/\/|@\{|[~^:?*[\]\\]))[A-Za-z0-9._/-]{1,120}$/u;
const PROTECTED_BRANCHES = new Set(['main', 'master']);

export function createGitTools(sandbox: ProcessSandbox): Tool[] {
  return [
    createGitStatusTool(sandbox),
    createGitDiffTool(sandbox),
    createGitLogTool(sandbox),
    createGitBranchTool(sandbox),
    createGitCommitTool(sandbox),
  ];
}

function createGitStatusTool(sandbox: ProcessSandbox): Tool {
  return gitReadTool(
    'git.status',
    'Inspect the current branch and concise workspace status.',
    ['status', '--short', '--branch'],
    sandbox,
  );
}

function createGitDiffTool(sandbox: ProcessSandbox): Tool {
  return {
    ...gitReadTool(
      'git.diff',
      'Inspect an unstaged or staged Git diff without changing the repository.',
      [],
      sandbox,
    ),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        staged: { type: 'boolean' },
        path: { type: 'string' },
      },
    },
    validateInput(input) {
      if (
        input['staged'] !== undefined &&
        typeof input['staged'] !== 'boolean'
      ) {
        return { valid: false, error: 'staged must be boolean.' };
      }
      if (
        input['path'] !== undefined &&
        typeof input['path'] !== 'string'
      ) {
        return { valid: false, error: 'path must be a workspace URI.' };
      }
      return { valid: true };
    },
    async execute(input, context): Promise<JsonValue> {
      const resolver = await requireResolver(context.workspaceRoot);
      const args = ['diff'];
      if (input['staged'] === true) {
        args.push('--cached');
      }
      if (typeof input['path'] === 'string') {
        args.push('--', await relativeWorkspacePath(resolver, input['path']));
      }
      return await runGit(sandbox, args, context);
    },
  };
}

function createGitLogTool(sandbox: ProcessSandbox): Tool {
  return {
    ...gitReadTool(
      'git.log',
      'Inspect recent Git commit history for project decisions and ownership context.',
      [],
      sandbox,
    ),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        path: { type: 'string' },
      },
    },
    validateInput(input) {
      if (
        input['limit'] !== undefined &&
        (!Number.isInteger(input['limit']) ||
          Number(input['limit']) < 1 ||
          Number(input['limit']) > 100)
      ) {
        return { valid: false, error: 'limit must be between 1 and 100.' };
      }
      if (
        input['path'] !== undefined &&
        typeof input['path'] !== 'string'
      ) {
        return { valid: false, error: 'path must be a workspace URI.' };
      }
      return { valid: true };
    },
    async execute(input, context): Promise<JsonValue> {
      const resolver = await requireResolver(context.workspaceRoot);
      const args = [
        'log',
        `-${typeof input['limit'] === 'number' ? input['limit'] : 20}`,
        '--oneline',
        '--decorate',
      ];
      if (typeof input['path'] === 'string') {
        args.push('--', await relativeWorkspacePath(resolver, input['path']));
      }
      return await runGit(sandbox, args, context);
    },
  };
}

function createGitBranchTool(sandbox: ProcessSandbox): Tool {
  return {
    name: 'git.branch.create',
    description:
      'Create and switch to a new local feature branch. Protected branch names are rejected.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    effect: 'side_effect',
    validateInput(input) {
      const name = input['name'];
      if (
        typeof name !== 'string' ||
        !BRANCH_PATTERN.test(name) ||
        PROTECTED_BRANCHES.has(name)
      ) {
        return { valid: false, error: 'name is not a safe feature branch.' };
      }
      return { valid: true };
    },
    requiredCapabilities: gitWriteCapabilities,
    async execute(input, context): Promise<JsonValue> {
      return await runGit(
        sandbox,
        ['switch', '-c', String(input['name'])],
        context,
      );
    },
  };
}

function createGitCommitTool(sandbox: ProcessSandbox): Tool {
  return {
    name: 'git.commit',
    description:
      'Stage explicit workspace paths and create one local commit. This tool never pushes or merges.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message: { type: 'string', minLength: 1, maxLength: 200 },
        paths: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: { type: 'string' },
        },
      },
      required: ['message', 'paths'],
    },
    effect: 'side_effect',
    validateInput(input) {
      if (
        typeof input['message'] !== 'string' ||
        !input['message'].trim() ||
        input['message'].length > 200
      ) {
        return { valid: false, error: 'message must contain 1-200 characters.' };
      }
      if (
        !Array.isArray(input['paths']) ||
        input['paths'].length === 0 ||
        input['paths'].length > 100 ||
        input['paths'].some((path) => typeof path !== 'string')
      ) {
        return { valid: false, error: 'paths must be a non-empty URI array.' };
      }
      return { valid: true };
    },
    requiredCapabilities: gitWriteCapabilities,
    async execute(input, context): Promise<JsonValue> {
      const resolver = await requireResolver(context.workspaceRoot);
      const branchResult = await runGit(
        sandbox,
        ['branch', '--show-current'],
        context,
      );
      const branch = gitStdout(branchResult).trim();
      if (!branch || PROTECTED_BRANCHES.has(branch)) {
        throw new Error(
          'git.commit requires a non-protected local feature branch.',
        );
      }
      const paths: string[] = [];
      for (const path of input['paths'] as string[]) {
        paths.push(await relativeWorkspacePath(resolver, path));
      }
      const add = await runGit(sandbox, ['add', '--', ...paths], context);
      const commit = await runGit(
        sandbox,
        ['commit', '-m', String(input['message']).trim()],
        context,
      );
      return { add, commit };
    },
  };
}

function gitReadTool(
  name: string,
  description: string,
  args: readonly string[],
  sandbox: ProcessSandbox,
): Tool {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    effect: 'read_only',
    validateInput() {
      return { valid: true };
    },
    requiredCapabilities: gitReadCapabilities,
    async execute(_input, context): Promise<JsonValue> {
      return await runGit(sandbox, args, context);
    },
  };
}

function gitReadCapabilities(): readonly CapabilityInput[] {
  return [
    {
      capability: 'git.read',
      scope: {
        kind: 'subtree',
        resource: CURRENT_WORKSPACE_RESOURCE,
      },
    },
  ];
}

function gitWriteCapabilities(): readonly CapabilityInput[] {
  return [
    {
      capability: 'git.write',
      scope: {
        kind: 'subtree',
        resource: CURRENT_WORKSPACE_RESOURCE,
      },
    },
  ];
}

async function runGit(
  sandbox: ProcessSandbox,
  args: readonly string[],
  context: {
    workspaceRoot?: string;
    signal: AbortSignal;
    idempotencyKey: string;
  },
): Promise<JsonValue> {
  const resolver = await requireResolver(context.workspaceRoot);
  const result = await sandbox.run({
    command: 'git',
    args,
    cwd: resolver.root,
    signal: context.signal,
    idempotencyKey: context.idempotencyKey,
    timeoutMs: 120_000,
  });
  if (
    !isObject(result) ||
    result['status'] !== 'completed' ||
    result['exitCode'] !== 0
  ) {
    const detail =
      isObject(result) && typeof result['stderr'] === 'string'
        ? result['stderr'].trim()
        : '';
    throw new Error(
      detail ? `Git command failed: ${detail}` : 'Git command failed.',
    );
  }
  return result;
}

async function requireResolver(
  workspaceRoot: string | undefined,
): Promise<WorkspaceResolver> {
  if (!workspaceRoot) {
    throw new Error('Git tools require a mounted workspace.');
  }
  return await WorkspaceResolver.create(workspaceRoot);
}

async function relativeWorkspacePath(
  resolver: WorkspaceResolver,
  alias: string,
): Promise<string> {
  const hostPath = await resolver.resolveWriteTarget(alias);
  return relative(resolver.root, hostPath) || '.';
}

function gitStdout(result: JsonValue): string {
  return isObject(result) && typeof result['stdout'] === 'string'
    ? result['stdout']
    : '';
}

function isObject(
  value: JsonValue,
): value is Record<string, JsonValue> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}
