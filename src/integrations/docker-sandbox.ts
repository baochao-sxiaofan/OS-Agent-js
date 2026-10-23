import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { ProcessSandbox, SandboxedProcessRequest } from '../tools/builtin/test-run-tool.js';
import type { JsonValue } from '../types/json.js';

type DockerCommandResult =
  | { kind: 'closed'; exitCode: number | null; stdout: string; stderr: string }
  | { kind: 'spawn_error' }
  | { kind: 'deadline' };

type DockerCleanupFailureReason = 'creation_unconfirmed' | 'removal_failed' | 'cleanup_deadline';

export class DockerSandboxCleanupError extends Error {
  override readonly name = 'DockerSandboxCleanupError';
  readonly cleanupConfirmed = false;

  constructor(readonly containerName: string, readonly reason: DockerCleanupFailureReason) {
    super(`隔离容器停止及删除尚未确认：${containerName}（${reason}）。`);
  }
}

/** Docker 是宿主显式配置的隔离后端，命令和参数始终以数组传递。 */
export class DockerProcessSandbox implements ProcessSandbox {
  readonly #unconfirmedContainers = new Map<string, DockerSandboxCleanupError>();

  constructor(readonly options: {
    image: string; executable?: string; memory?: string; cpus?: string; cleanupTimeoutMs?: number;
  }) {
    if (!options.image.trim()) throw new Error('必须配置固定的隔离镜像。');
    const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10_000;
    if (!Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0 || cleanupTimeoutMs > 2_147_483_647) {
      throw new Error('Docker 清理截止时间必须是有效的正整数毫秒数。');
    }
  }

  /** 未确认状态不会因客户端退出而消失；宿主必须先处理这些容器。 */
  get unconfirmedContainers(): readonly DockerSandboxCleanupError[] {
    return [...this.#unconfirmedContainers.values()];
  }

  async run(request: SandboxedProcessRequest): Promise<JsonValue> {
    const unresolved = this.#unconfirmedContainers.values().next().value;
    if (unresolved) throw unresolved;
    request.signal.throwIfAborted();
    const cwd = await realpath(request.cwd);
    const unresolvedAfterResolution = this.#unconfirmedContainers.values().next().value;
    if (unresolvedAfterResolution) throw unresolvedAfterResolution;
    if (cwd.includes(',')) throw new Error('Docker 挂载路径不能包含逗号。');
    const name = `os-agent-${randomUUID()}`;
    const executable = this.options.executable ?? 'docker';
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]);
    signal.throwIfAborted();
    const args = [
      'create', '--name', name, '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128',
      `--memory=${this.options.memory ?? '512m'}`, `--cpus=${this.options.cpus ?? '1'}`,
      '--tmpfs', '/tmp:rw,nosuid,size=128m', '--mount', `type=bind,src=${cwd},dst=/workspace`,
      '--workdir=/workspace', '--env=HOME=/tmp',
      ...(typeof process.getuid === 'function' && typeof process.getgid === 'function'
        ? ['--user', `${process.getuid()}:${process.getgid()}`] : []),
      this.options.image,
      request.command, ...request.args,
    ];
    const clients = new Set<ChildProcess>();
    const launch = (commandArgs: readonly string[]): Promise<DockerCommandResult> =>
      new Promise((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(executable, commandArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
          });
        } catch {
          resolve({ kind: 'spawn_error' });
          return;
        }
        clients.add(child);
        let output = '';
        let errorOutput = '';
        child.stdout?.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-32_000); });
        child.stderr?.on('data', (data: Buffer) => { errorOutput = (errorOutput + data.toString()).slice(-8000); });
        child.on('error', () => {
          if (child.pid === undefined) resolve({ kind: 'spawn_error' });
        });
        child.on('close', (exitCode) => {
          clients.delete(child);
          resolve({ kind: 'closed', exitCode, stdout: output, stderr: errorOutput });
        });
      });

    const stopClients = (terminationSignal: 'SIGTERM' | 'SIGKILL') => {
      for (const client of clients) {
        // 结束客户端只用于回收本地资源，绝不作为容器已经停止的证据。
        try { client.kill(terminationSignal); } catch { /* 清理确认只依据删除命令的退出结果。 */ }
      }
    };
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineExpired = false;
    let expireCleanup: () => void = () => {};
    const deadline = new Promise<DockerCommandResult>((resolve) => {
      expireCleanup = () => resolve({ kind: 'deadline' });
    });
    const beginCleanup = () => {
      if (cleanupTimer !== undefined) return;
      // 创建等待、删除及客户端回收共用同一个截止时间，取消不能重置它。
      cleanupTimer = setTimeout(() => {
        deadlineExpired = true;
        stopClients('SIGKILL');
        expireCleanup();
      }, this.options.cleanupTimeoutMs ?? 10_000);
    };
    let notifyCancellation: () => void = () => {};
    const cancellation = new Promise<null>((resolve) => {
      notifyCancellation = () => resolve(null);
    });
    const stop = () => {
      beginCleanup();
      notifyCancellation();
    };
    const unconfirmed = (reason: DockerCleanupFailureReason): DockerSandboxCleanupError => {
      const error = new DockerSandboxCleanupError(name, reason);
      this.#unconfirmedContainers.set(name, error);
      return error;
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      signal.throwIfAborted();
      // 取消时先等待创建完成；否则过早删除后，后台创建仍可能生成新容器。
      const creation = await Promise.race([launch(args), deadline]);
      if (creation.kind === 'deadline') throw unconfirmed('creation_unconfirmed');
      if (creation.kind === 'spawn_error') throw new Error('隔离后端启动失败。');

      let execution: Promise<DockerCommandResult> | undefined;
      let result: DockerCommandResult | null = null;
      if (creation.exitCode === 0 && !signal.aborted) {
        execution = launch(['start', '--attach', name]);
        result = await Promise.race([execution, cancellation, deadline]);
      }
      beginCleanup();
      if (deadlineExpired) throw unconfirmed('cleanup_deadline');
      const removal = await Promise.race([launch(['rm', '--force', name]), deadline]);
      if (removal.kind === 'deadline') throw unconfirmed('cleanup_deadline');
      if (removal.kind !== 'closed' || removal.exitCode !== 0) {
        throw unconfirmed('removal_failed');
      }
      stopClients('SIGTERM');
      if (execution) await Promise.race([execution, deadline]);
      if (signal.aborted) throw new Error('隔离进程已经取消或超时。');
      if (creation.exitCode !== 0) throw new Error('隔离容器创建失败。');
      if (result?.kind !== 'closed') throw new Error('隔离后端启动失败。');
      return { exitCode: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr };
    } finally {
      signal.removeEventListener('abort', stop);
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      stopClients('SIGKILL');
    }
  }
}
