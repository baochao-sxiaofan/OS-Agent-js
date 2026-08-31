import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MacOSProcessSandbox,
  probeMacOSSandbox,
} from '../desktop/main/sandbox/index.js';

const sandboxAvailable =
  process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

// 只有在 macOS 且存在 sandbox-exec 时才运行真实进程隔离测试；其他环境跳过。
const describeSandbox = sandboxAvailable ? describe : describe.skip;

type RunResult = {
  status: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
};

describeSandbox('MacOSProcessSandbox (real seatbelt)', () => {
  it('probes the backend by verifying a real out-of-workspace denial', () => {
    expect(probeMacOSSandbox()).toEqual({ available: true });
  });

  it('allows writes inside the workspace root', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'os-agent-sbx-ws-'));
    try {
      const sandbox = new MacOSProcessSandbox();
      const result = (await sandbox.run({
        command: '/bin/sh',
        args: ['-c', 'printf inside > allowed.txt'],
        cwd: workspace,
        signal: new AbortController().signal,
        idempotencyKey: 'ws-1:call-1',
        timeoutMs: 30_000,
      })) as RunResult;
      expect(result.status).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(workspace, 'allowed.txt'), 'utf8')).toBe(
        'inside',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('blocks writes outside the workspace root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-agent-sbx-out-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'sentinel.txt');
    try {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(outside, 'protected', 'utf8');

      const sandbox = new MacOSProcessSandbox();
      const result = (await sandbox.run({
        command: '/bin/sh',
        args: ['-c', `printf breached > ${JSON.stringify(outside)}`],
        cwd: workspace,
        signal: new AbortController().signal,
        idempotencyKey: 'ws-2:call-1',
        timeoutMs: 30_000,
      })) as RunResult;

      expect(result.status).toBe('completed');
      expect(result.exitCode).not.toBe(0);
      // 哨兵文件必须保持不变，证明工作区外写入被内核拒绝。
      expect(readFileSync(outside, 'utf8')).toBe('protected');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports cancellation when aborted before start', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'os-agent-sbx-cancel-'));
    try {
      const controller = new AbortController();
      controller.abort();
      const sandbox = new MacOSProcessSandbox();
      const result = (await sandbox.run({
        command: '/bin/sh',
        args: ['-c', 'printf hi'],
        cwd: workspace,
        signal: controller.signal,
        idempotencyKey: 'ws-3:call-1',
        timeoutMs: 30_000,
      })) as RunResult;
      expect(result.status).toBe('cancelled');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
