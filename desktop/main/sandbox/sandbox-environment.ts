/**
 * 受限进程的环境变量构造。
 *
 * 绝不透传整个 `process.env`：那会把模型密钥、代理配置、SSH/Docker socket 和
 * 各类注入选项带进受限进程。这里只构造运行 Node 工具链所需的最小环境，并把
 * HOME、TMPDIR 和缓存目录重定向到一次性隔离运行目录内。
 */
export type SandboxEnvironmentOptions = {
  /** 工作区根目录（受限进程的 cwd）。 */
  workspaceRoot: string;
  /** 一次性隔离运行目录，用于 HOME/TMPDIR/缓存重定向。 */
  runtimeDir: string;
  /** 宿主 PATH，用于定位 node/npm 等可执行文件；缺省使用安全默认值。 */
  hostPath?: string | undefined;
};

const SAFE_DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * 构造受限进程使用的最小、干净的环境变量集合。
 *
 * 只保留运行所需的少量变量；HOME、TMPDIR 与 npm 缓存全部指向 runtimeDir，避免
 * 受限进程写入宿主主目录或系统临时目录。
 */
export function buildSandboxEnvironment(
  options: SandboxEnvironmentOptions,
): Record<string, string> {
  const { workspaceRoot, runtimeDir } = options;
  return {
    HOME: runtimeDir,
    TMPDIR: runtimeDir,
    PATH: options.hostPath?.trim() ? options.hostPath : SAFE_DEFAULT_PATH,
    PWD: workspaceRoot,
    // 关闭 npm 的更新检查与非工作区写入，并把缓存固定到隔离目录。
    npm_config_cache: `${runtimeDir}/npm-cache`,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    // 保持确定性、非交互式运行。
    CI: '1',
    NO_COLOR: '1',
    LANG: 'en_US.UTF-8',
  };
}
