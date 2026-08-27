import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { CURRENT_WORKSPACE_RESOURCE } from '../capability/workspace-capabilities.js';

/**
 * 把 Agent 可见的 `workspace://current/...` 别名解析为宿主真实路径，并强制所有
 * 访问都留在挂载目录内。
 *
 * 别名是模型和 Capability 使用的稳定语义路径；真实宿主根目录只存在于控制平面。
 * 解析分两步防逃逸：先在字符串层拒绝 `..` 归一化后越界的路径，再在文件系统层
 * 用 `realpath` 消解符号链接后复查，确保软链接目标也落在挂载目录内。
 */
export class WorkspaceResolver {
  readonly #canonicalRoot: string;

  private constructor(canonicalRoot: string) {
    this.#canonicalRoot = canonicalRoot;
  }

  /**
   * 基于宿主目录创建解析器。
   *
   * `hostRootPath` 应该已经由控制平面通过 `realpath` 规范化；这里再消解一次，
   * 保证根目录自身不含未解析的符号链接。
   */
  static async create(hostRootPath: string): Promise<WorkspaceResolver> {
    const canonicalRoot = await realpath(hostRootPath);
    return new WorkspaceResolver(canonicalRoot);
  }

  /** 当前挂载的宿主根目录（已消解符号链接）。 */
  get root(): string {
    return this.#canonicalRoot;
  }

  /**
   * 把一个 `workspace://current/...` 别名解析为可安全访问的宿主路径。
   *
   * 校验在字符串层完成，不触碰文件系统，可用于尚未存在的目标（例如新建文件）。
   * 需要读取已存在目标时应额外调用 `assertResolvedInsideRoot`。
   */
  toHostPath(aliasPath: string): string {
    const relativePath = this.#toRelativePath(aliasPath);
    const hostPath = resolve(this.#canonicalRoot, relativePath);
    if (!this.#isInsideRoot(hostPath)) {
      throw new WorkspaceEscapeError(aliasPath);
    }
    return hostPath;
  }

  /**
   * 把一个宿主路径转换回 Agent 可见的别名。
   *
   * 用于把工具结果中的真实路径重新投影为语义别名，避免宿主目录结构外泄。
   */
  toAliasPath(hostPath: string): string {
    const relativePath = relative(this.#canonicalRoot, hostPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new WorkspaceEscapeError(hostPath);
    }
    const normalized = relativePath.split(sep).join('/');
    return normalized
      ? `${CURRENT_WORKSPACE_RESOURCE}${normalized}`
      : CURRENT_WORKSPACE_RESOURCE;
  }

  /**
   * 消解符号链接后复查目标仍在挂载目录内。
   *
   * 字符串层检查无法拦截“路径本身合法、但符号链接指向外部”的情况，因此读写
   * 已存在目标前必须调用本方法。
   */
  async assertResolvedInsideRoot(hostPath: string): Promise<string> {
    const resolved = await realpath(hostPath);
    if (!this.#isInsideRoot(resolved)) {
      throw new WorkspaceEscapeError(hostPath);
    }
    return resolved;
  }

  /**
   * 校验一个写入目标。
   *
   * 已存在目标按其真实路径检查；新目标要求父目录已经存在且其真实路径位于挂载
   * 根内。工具不得在这里隐式创建父目录，否则 `file.create` 会绕过
   * `directory.create`。
   */
  async resolveWriteTarget(aliasPath: string): Promise<string> {
    const hostPath = this.toHostPath(aliasPath);
    try {
      return await this.assertResolvedInsideRoot(hostPath);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    await this.assertResolvedInsideRoot(dirname(hostPath));
    return hostPath;
  }

  #toRelativePath(aliasPath: string): string {
    const trimmed = aliasPath.trim();
    if (!trimmed) {
      throw new WorkspaceEscapeError(aliasPath);
    }
    if (trimmed === CURRENT_WORKSPACE_RESOURCE || trimmed === 'workspace://current') {
      return '.';
    }
    if (!trimmed.startsWith(CURRENT_WORKSPACE_RESOURCE)) {
      throw new WorkspaceEscapeError(aliasPath);
    }
    const relativePart = trimmed.slice(CURRENT_WORKSPACE_RESOURCE.length);
    if (isAbsolute(relativePart)) {
      throw new WorkspaceEscapeError(aliasPath);
    }
    return relativePart;
  }

  #isInsideRoot(hostPath: string): boolean {
    if (hostPath === this.#canonicalRoot) {
      return true;
    }
    return hostPath.startsWith(`${this.#canonicalRoot}${sep}`);
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

export class WorkspaceEscapeError extends Error {
  constructor(readonly attemptedPath: string) {
    super(`Path escapes the workspace mount: ${attemptedPath}`);
    this.name = 'WorkspaceEscapeError';
  }
}

/** 把宿主根目录下的相对路径拼接为别名，主要用于测试与工具输出。 */
export function joinWorkspaceAlias(...segments: readonly string[]): string {
  const normalized = segments
    .flatMap((segment) => segment.split('/'))
    .filter((segment) => segment.length > 0)
    .join('/');
  return normalized
    ? `${CURRENT_WORKSPACE_RESOURCE}${normalized}`
    : CURRENT_WORKSPACE_RESOURCE;
}

/** 把宿主绝对路径限制在根目录内，供工具执行前的额外防御使用。 */
export function assertHostPathInsideRoot(
  root: string,
  hostPath: string,
): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(hostPath);
  const relativePath = relative(normalizedRoot, normalizedTarget);
  if (
    relativePath !== '' &&
    (relativePath.startsWith('..') || isAbsolute(relativePath))
  ) {
    throw new WorkspaceEscapeError(hostPath);
  }
}
