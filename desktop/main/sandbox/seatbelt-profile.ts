/**
 * Seatbelt (SBPL) 策略生成。
 *
 * 采用 Apple `sandbox-exec` 使用的 Sandbox Profile Language：默认拒绝，再按需
 * 放开。本版本提供的核心保证是「写入限定」和「默认断网」：受限进程及其后代只能
 * 写入工作区根目录和一次性隔离运行目录，不能对外发起网络连接。
 *
 * 读取目前仍然较宽（toolchain、系统动态库需要），只对已知敏感目录显式拒绝；
 * 更严格的读取白名单与按 Grant 收窄的写入子树留待后续阶段，见
 * `docs/macos-process-sandbox-design.md`。`sandbox-exec` 已被 Apple 标注为
 * deprecated，因此该后端始终作为可探测、可禁用的实验性实现。
 */
export type SeatbeltProfileOptions = {
  /** 允许写入的工作区根目录（须为已 realpath 的规范绝对路径）。 */
  workspaceRoot: string;
  /** 额外可写的绝对路径，例如一次性隔离运行目录。 */
  writablePaths: readonly string[];
  /** 显式拒绝读取的敏感绝对路径（凭据、密钥等）。 */
  denyReadPaths: readonly string[];
};

/**
 * 转义 SBPL 字符串字面量，防止工作区路径中的引号或反斜杠造成策略注入。
 */
function quoteSbplString(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

function assertAbsolute(path: string, label: string): void {
  if (!path.startsWith('/')) {
    throw new Error(`${label} must be an absolute path: ${path}`);
  }
}

/**
 * 生成一次执行使用的完整 SBPL 策略字符串。
 *
 * 规则顺序遵循 SBPL「后匹配优先」语义：先广开读取，再对敏感目录追加 deny，
 * 使敏感路径的拒绝规则覆盖前面的放行。
 */
export function buildSeatbeltProfile(
  options: SeatbeltProfileOptions,
): string {
  assertAbsolute(options.workspaceRoot, 'workspaceRoot');
  const writable = [options.workspaceRoot, ...options.writablePaths];
  for (const path of writable) {
    assertAbsolute(path, 'writable path');
  }
  for (const path of options.denyReadPaths) {
    assertAbsolute(path, 'denyRead path');
  }

  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    // 允许启动子进程链（npm -> node 等）与基本进程内省。
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow process-info*)',
    '(allow signal)',
    // 基础系统查询与服务查找；网络因默认拒绝而保持关闭。
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    // toolchain 与系统动态库需要广泛读取；敏感目录在后面显式拒绝。
    '(allow file-read*)',
    // 受控管道之外，仅放开少量必要设备写入。
    '(allow file-write-data (literal "/dev/null"))',
    '(allow file-write-data (literal "/dev/dtracehelper"))',
    '(allow file-ioctl (literal "/dev/dtracehelper"))',
  ];

  for (const path of writable) {
    lines.push(`(allow file-write* (subpath ${quoteSbplString(path)}))`);
  }
  // 敏感目录的读取拒绝放在最后，覆盖前面的广开读取规则。
  for (const path of options.denyReadPaths) {
    lines.push(`(deny file-read* (subpath ${quoteSbplString(path)}))`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * 根据宿主主目录推导默认拒绝读取的敏感目录集合。
 *
 * 这是纵深防御，不能替代更严格的读取白名单；只列出最常见的凭据/密钥位置。
 */
export function defaultDeniedReadPaths(homeDir: string): string[] {
  assertAbsolute(homeDir, 'homeDir');
  return [
    `${homeDir}/.ssh`,
    `${homeDir}/.aws`,
    `${homeDir}/.gnupg`,
    `${homeDir}/.config/gcloud`,
    `${homeDir}/.docker`,
    `${homeDir}/.kube`,
    `${homeDir}/.npmrc`,
    `${homeDir}/Library/Keychains`,
    '/Library/Keychains',
  ];
}
