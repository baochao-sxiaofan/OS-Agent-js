import type {
  CapabilityGrant,
  CapabilityRequest,
} from './capability.js';

/**
 * Agent 可见的当前 Conversation 工作区挂载点。
 *
 * 真实宿主路径只保存在控制平面；模型和 Capability 使用稳定语义别名，避免把
 * 不必要的系统目录信息扩散到任务树中。
 */
export const CURRENT_WORKSPACE_RESOURCE = 'workspace://current/';

/** Root Agent 在当前工作区内默认持有的文件系统能力。 */
export const WORKSPACE_FILESYSTEM_CAPABILITIES = [
  'file.read',
  'file.write',
  'file.create',
  'file.delete',
  'directory.read',
  'directory.create',
  'directory.delete',
] as const;

export type WorkspaceCapabilityOptions = {
  includeArtifactStore?: boolean;
  includeKnowledgeStore?: boolean;
  includeTestRun?: boolean;
};

/**
 * 为一轮 Root Agent 创建完整的工作区文件系统 Authority Ceiling。
 *
 * 这些能力只覆盖 `workspace://current/` 子树，不包含进程执行、网络、Git
 * 推送或任何宿主文件系统路径。
 */
export function createWorkspaceCapabilityRequests(
  options: WorkspaceCapabilityOptions = {},
): CapabilityRequest[] {
  const requests: CapabilityRequest[] =
    WORKSPACE_FILESYSTEM_CAPABILITIES.map((capability) => ({
      capability,
      scope: {
        kind: 'subtree',
        resource: CURRENT_WORKSPACE_RESOURCE,
      },
    }));
  if (options.includeTestRun) {
    requests.push({
      capability: 'test.run',
      scope: {
        kind: 'subtree',
        resource: CURRENT_WORKSPACE_RESOURCE,
      },
    });
  }
  if (options.includeArtifactStore) {
    requests.push(
      {
        capability: 'artifact.read',
        scope: {
          kind: 'subtree',
          resource: 'artifact://task/',
        },
      },
      {
        capability: 'artifact.write',
        scope: {
          kind: 'subtree',
          resource: 'artifact://task/',
        },
      },
    );
  }
  if (options.includeKnowledgeStore) {
    requests.push(
      {
        capability: 'knowledge.read',
        scope: {
          kind: 'subtree',
          resource: CURRENT_WORKSPACE_RESOURCE,
        },
      },
      {
        capability: 'knowledge.write',
        scope: {
          kind: 'subtree',
          resource: CURRENT_WORKSPACE_RESOURCE,
        },
      },
    );
  }
  return requests;
}

/**
 * 提取可由下一轮 Root 重新签发的 Authority Ceiling。
 *
 * 只继承宿主签发的 root Grant；人工审批产生的单次执行 Grant 不跨轮继承。
 */
export function extractInheritableRootAuthority(
  grants: readonly CapabilityGrant[],
  now = Date.now(),
): CapabilityRequest[] {
  return grants
    .filter(
      (grant) =>
        grant.source.type === 'root' &&
        (grant.expiresAt === undefined || grant.expiresAt > now),
    )
    .map((grant) => ({
      capability: grant.capability,
      scope: structuredClone(grant.scope),
    }));
}
