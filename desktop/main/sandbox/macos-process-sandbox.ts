import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  JsonValue,
  ProcessSandbox,
  SandboxedProcessRequest,
} from '../../../src/index.js';
import {
  buildSeatbeltProfile,
  defaultDeniedReadPaths,
} from './seatbelt-profile.js';
import { buildSandboxEnvironment } from './sandbox-environment.js';

/** Apple 提供的 Seatbelt 启动器；已 deprecated，仅作实验性后端。 */
const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/** 受限进程输出的最大保留字节数，超出后截断，避免撑爆内存与界面。 */
const MAX_OUTPUT_BYTES = 1_000_000;

export type MacOSProcessSandboxOptions = {
  /** 供测试注入的宿主主目录；缺省使用真实 homedir()。 */
  homeDir?: string;
  /** 供测试注入的宿主 PATH。 */
  hostPath?: string;
};

/**
 * 基于 macOS Seatbelt 的实验性进程沙箱。
 *
 * 直接以 argv 数组调用 `/usr/bin/sandbox-exec`，不经过宿主 shell，也不加载用户
 * shell 启动配置。受限进程及其后代只能写入工作区与一次性隔离运行目录，默认断网，
 * 并使用清洗后的最小环境变量。取消与超时会终止整个进程组。
 *
 * 这是 `docs/macos-process-sandbox-design.md` 第一阶段实现：拒绝一切未授权的
 * 工作区外写入，尚未接入按 Grant 收窄的子树与外部资源单次审批。
 */
export class MacOSProcessSandbox implements ProcessSandbox {
  readonly #homeDir: string;
  readonly #hostPath: string | undefined;

  constructor(options: MacOSProcessSandboxOptions = {}) {
    this.#homeDir = options.homeDir ?? homedir();
    this.#hostPath = options.hostPath ?? process.env['PATH'];
  }

  async run(request: SandboxedProcessRequest): Promise<JsonValue> {
    if (request.signal.aborted) {
      return toJson({ status: 'cancelled', reason: 'Aborted before start.' });
    }

    const runtimeDir = mkdtempSync(join(tmpdir(), 'os-agent-sbx-'));
    try {
      return toJson(await this.#runInSandbox(request, runtimeDir));
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  }

  #runInSandbox(
    request: SandboxedProcessRequest,
    runtimeDir: string,
  ): Promise<JsonRunResult> {
    // Seatbelt 按真实路径匹配 subpath；macOS 的 /var、/tmp 均为符号链接，
    // 必须先消解为规范路径，否则工作区内的写入也会被策略拒绝。
    const canonicalCwd = realpathSync(request.cwd);
    const canonicalRuntimeDir = realpathSync(runtimeDir);
    const profile = buildSeatbeltProfile({
      workspaceRoot: canonicalCwd,
      writablePaths: [canonicalRuntimeDir],
      denyReadPaths: defaultDeniedReadPaths(this.#homeDir),
    });
    const profilePath = join(runtimeDir, 'policy.sb');
    writeFileSync(profilePath, profile, 'utf8');

    const env = buildSandboxEnvironment({
      workspaceRoot: canonicalCwd,
      runtimeDir: canonicalRuntimeDir,
      hostPath: this.#hostPath,
    });

    const child = spawn(
      SANDBOX_EXEC_PATH,
      ['-f', profilePath, request.command, ...request.args],
      {
        cwd: canonicalCwd,
        env,
        // 独立进程组，便于对整棵进程树做取消/超时清理。
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    return new Promise<JsonRunResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;

      const appendStdout = (chunk: Buffer): void => {
        if (stdout.length >= MAX_OUTPUT_BYTES) {
          stdoutTruncated = true;
          return;
        }
        stdout += chunk.toString('utf8');
        if (stdout.length > MAX_OUTPUT_BYTES) {
          stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
          stdoutTruncated = true;
        }
      };
      const appendStderr = (chunk: Buffer): void => {
        if (stderr.length >= MAX_OUTPUT_BYTES) {
          stderrTruncated = true;
          return;
        }
        stderr += chunk.toString('utf8');
        if (stderr.length > MAX_OUTPUT_BYTES) {
          stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
          stderrTruncated = true;
        }
      };

      child.stdout?.on('data', appendStdout);
      child.stderr?.on('data', appendStderr);

      const killTree = (): void => {
        if (child.pid === undefined) {
          return;
        }
        // 负 PID 终止整个进程组，覆盖 npm 派生的 node/后台子进程。
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // 进程已退出，忽略。
          }
        }
      };

      const finish = (result: JsonRunResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        request.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const onAbort = (): void => {
        killTree();
        finish({ status: 'cancelled', reason: 'Execution was cancelled.' });
      };

      const timeoutHandle = setTimeout(() => {
        killTree();
        finish({
          status: 'timed_out',
          timeoutMs: request.timeoutMs,
          stdout,
          stderr,
        });
      }, request.timeoutMs);

      request.signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (error: Error) => {
        finish({
          status: 'start_failed',
          reason: error.message,
        });
      });

      child.on('close', (code, signalName) => {
        finish({
          status: 'completed',
          exitCode: code,
          signal: signalName,
          stdout,
          stderr,
          ...(stdoutTruncated || stderrTruncated
            ? { outputTruncated: true }
            : {}),
        });
      });
    });
  }
}

/**
 * 结构化执行结果的可辨识联合类型。
 *
 * 与设计文档一致：区分完成、启动失败、取消和超时；宿主路径不外泄，只返回退出码
 * 与受限文本输出。JSON 兼容以便进入 Work Table 与模型上下文。
 */
export type JsonRunResult =
  | {
      status: 'completed';
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
      outputTruncated?: true;
    }
  | {
      status: 'start_failed';
      reason: string;
    }
  | {
      status: 'cancelled';
      reason: string;
    }
  | {
      status: 'timed_out';
      timeoutMs: number;
      stdout: string;
      stderr: string;
    };

/**
 * 把结构化结果投影为 JsonValue。
 *
 * 结果字段都是 JSON 基本类型（`null` 已替代 `undefined`），一次 parse/stringify
 * 即可满足 ProcessSandbox 契约要求的 JsonValue 边界类型。
 */
function toJson(result: JsonRunResult): JsonValue {
  return JSON.parse(JSON.stringify(result)) as JsonValue;
}
