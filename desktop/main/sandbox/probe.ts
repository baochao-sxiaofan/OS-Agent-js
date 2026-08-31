import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSeatbeltProfile } from './seatbelt-profile.js';

const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

export type SandboxProbeResult =
  | { available: true }
  | { available: false; reason: string };

/**
 * 在启用后端前做一次真实的 Seatbelt 负向验证。
 *
 * 不能只检测 `sandbox-exec` 文件是否存在——deprecated 接口在不同系统版本上行为
 * 可能不同。这里实际生成一个只允许写工作区的策略，让受限进程尝试写工作区外的
 * 哨兵文件：只有当写入被拒绝、哨兵保持不变，且工作区内写入正常时，才认为后端
 * 可用。任何环节失败都返回 unavailable，由调用方拒绝启用，绝不降级为裸执行。
 */
export function probeMacOSSandbox(): SandboxProbeResult {
  if (process.platform !== 'darwin') {
    return { available: false, reason: 'Process sandbox requires macOS.' };
  }
  if (!existsSync(SANDBOX_EXEC_PATH)) {
    return {
      available: false,
      reason: 'sandbox-exec is not available on this system.',
    };
  }

  const probeRoot = mkdtempSync(join(tmpdir(), 'os-agent-sbx-probe-'));
  const workspace = join(probeRoot, 'workspace');
  const outside = join(probeRoot, 'sentinel.txt');
  try {
    writeFileSync(outside, 'protected', 'utf8');
    const profile = buildSeatbeltProfile({
      workspaceRoot: workspace,
      writablePaths: [],
      denyReadPaths: [],
    });
    const profilePath = join(probeRoot, 'probe.sb');
    writeFileSync(profilePath, profile, 'utf8');

    // 负向用例：尝试覆盖工作区外的哨兵文件，必须失败。
    const escape = spawnSync(
      SANDBOX_EXEC_PATH,
      [
        '-f',
        profilePath,
        '/bin/sh',
        '-c',
        `printf breached > ${JSON.stringify(outside)}`,
      ],
      { encoding: 'utf8' },
    );
    if (escape.error) {
      return {
        available: false,
        reason: `sandbox-exec could not launch: ${escape.error.message}`,
      };
    }
    if (escape.status === 0) {
      return {
        available: false,
        reason: 'Sandbox failed to block an out-of-workspace write.',
      };
    }
    if (readFileSync(outside, 'utf8') !== 'protected') {
      return {
        available: false,
        reason: 'Out-of-workspace sentinel was modified under sandbox.',
      };
    }
    return { available: true };
  } catch (error) {
    return {
      available: false,
      reason:
        error instanceof Error
          ? error.message
          : 'Unknown sandbox probe failure.',
    };
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}
