import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SafeWebAccess } from '../desktop/main/network/safe-web-access.js';
import {
  CapabilityManager,
  createGitTools,
  createScreenCaptureTool,
  MODEL_IMAGE_MARKER,
  type ProcessSandbox,
  type ToolExecutionContext,
} from '../src/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('enterprise external tools', () => {
  it('routes screen capture through human approval and preserves image metadata', async () => {
    const manager = new CapabilityManager();
    const rootGrants = manager.issueRootGrants(
      'root',
      [
        {
          capability: 'screen.capture',
          scope: { kind: 'exact', resource: 'screen://primary' },
        },
      ],
      1,
    );
    expect(rootGrants[0]).toMatchObject({
      delegable: false,
      execution: 'human_approval_required',
    });

    const tool = createScreenCaptureTool({
      capturePrimaryScreen: async () => ({
        mimeType: 'image/png',
        dataBase64: 'cG5n',
        width: 800,
        height: 600,
        sourceName: 'primary-screen',
      }),
    });
    expect(tool.requiredCapabilities?.({})).toEqual([
      {
        capability: 'screen.capture',
        scope: { kind: 'exact', resource: 'screen://primary' },
      },
    ]);
    await expect(
      tool.execute({}, toolContext()),
    ).resolves.toMatchObject({
      marker: MODEL_IMAGE_MARKER,
      mimeType: 'image/png',
      dataBase64: 'cG5n',
    });
  });

  it('rejects private destinations before issuing a web request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const access = new SafeWebAccess();

    await expect(
      access.fetch(
        'https://127.0.0.1/internal',
        new AbortController().signal,
      ),
    ).rejects.toThrow('Private');
    await expect(
      access.fetch(
        'https://[::ffff:127.0.0.1]/internal',
        new AbortController().signal,
      ),
    ).rejects.toThrow('Private');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a chunked response when it crosses the byte limit', async () => {
    const payload = 'x'.repeat(1_000_001);
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(payload, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    );
    const access = new SafeWebAccess();

    await expect(
      access.fetch(
        'https://93.184.216.34/large',
        new AbortController().signal,
      ),
    ).rejects.toThrow('1 MB');
  });

  it('passes Git operations as argv and never exposes push or merge', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'git-tools-'));
    try {
      mkdirSync(join(workspace, 'src'));
      writeFileSync(join(workspace, 'src', 'new.ts'), 'export {};\n');
      const calls: Array<{ command: string; args: readonly string[] }> = [];
      const sandbox: ProcessSandbox = {
        async run(request) {
          calls.push({
            command: request.command,
            args: [...request.args],
          });
          return {
            status: 'completed',
            exitCode: 0,
            stdout:
              request.args[0] === 'branch'
                ? 'feat/enterprise-preview\n'
                : '',
            stderr: '',
          };
        },
      };
      const tools = createGitTools(sandbox);
      expect(tools.map((tool) => tool.name)).toEqual([
        'git.status',
        'git.diff',
        'git.log',
        'git.branch.create',
        'git.commit',
      ]);

      const branch = tools.find((tool) => tool.name === 'git.branch.create');
      expect(branch?.validateInput({ name: 'main' })).toMatchObject({
        valid: false,
      });
      expect(
        branch?.validateInput({ name: 'feat/enterprise-preview' }),
      ).toEqual({ valid: true });
      await branch?.execute(
        { name: 'feat/enterprise-preview' },
        toolContext(workspace),
      );

      const commit = tools.find((tool) => tool.name === 'git.commit');
      await commit?.execute(
        {
          message: 'test: verify argv isolation; touch /tmp/never',
          paths: ['workspace://current/src/new.ts'],
        },
        toolContext(workspace),
      );

      expect(calls).toEqual([
        {
          command: 'git',
          args: ['switch', '-c', 'feat/enterprise-preview'],
        },
        {
          command: 'git',
          args: ['branch', '--show-current'],
        },
        {
          command: 'git',
          args: ['add', '--', 'src/new.ts'],
        },
        {
          command: 'git',
          args: [
            'commit',
            '-m',
            'test: verify argv isolation; touch /tmp/never',
          ],
        },
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('refuses to commit on a protected branch', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'git-main-'));
    try {
      writeFileSync(join(workspace, 'change.ts'), 'export {};\n');
      const sandbox: ProcessSandbox = {
        async run(request) {
          return {
            status: 'completed',
            exitCode: 0,
            stdout:
              request.args[0] === 'branch' ? 'main\n' : '',
            stderr: '',
          };
        },
      };
      const commit = createGitTools(sandbox).find(
        (tool) => tool.name === 'git.commit',
      );

      await expect(
        commit?.execute(
          {
            message: 'feat: unsafe direct commit',
            paths: ['workspace://current/change.ts'],
          },
          toolContext(workspace),
        ),
      ).rejects.toThrow('non-protected');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

function toolContext(workspaceRoot?: string): ToolExecutionContext {
  return {
    taskId: 'tester-1',
    rootTaskId: 'root-1',
    signal: new AbortController().signal,
    idempotencyKey: 'tester-1:call-1',
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  };
}
