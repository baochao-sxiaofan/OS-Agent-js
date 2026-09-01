import { randomUUID } from 'node:crypto';

import type {
  CapabilityCheckResult,
  CapabilityDelegationHop,
  CapabilityDelegationDecision,
  CapabilityGrant,
  CapabilityInput,
  CapabilityPolicy,
  CapabilityRequest,
  CapabilityRequestRouteDecision,
} from './capability.js';
import {
  capabilityRequestKey,
  normalizeCapabilityInput,
  scopeContains,
} from './capability.js';

export const DEFAULT_CAPABILITY_POLICIES: readonly CapabilityPolicy[] = [
  {
    capabilityPattern: 'payment.*',
    approval: 'human',
    delegable: false,
  },
  {
    capabilityPattern: 'payment:*',
    approval: 'human',
    delegable: false,
  },
  {
    capabilityPattern: 'git.push',
    approval: 'human',
    delegable: false,
  },
  {
    capabilityPattern: 'git:push',
    approval: 'human',
    delegable: false,
  },
  {
    capabilityPattern: 'screen.capture',
    approval: 'human',
    delegable: false,
  },
  {
    capabilityPattern: 'deploy.production',
    approval: 'human',
    delegable: false,
  },
  {
    capabilityPattern: 'filesystem.external.*',
    approval: 'human',
    delegable: false,
  },
  {
    capabilityPattern: 'filesystem:external:*',
    approval: 'human',
    delegable: false,
  },
];

export type CapabilityManagerOptions = {
  policies?: readonly CapabilityPolicy[];
  grantIdGenerator?: () => string;
  requestIdGenerator?: () => string;
};

export type CapabilityAncestor = {
  taskId: string;
  grants: readonly CapabilityGrant[];
};

/**
 * Capability 的唯一裁决入口。
 *
 * Manager 不持有任务状态；Grant 与请求记录由 TCB 持久化。这样调度器恢复任务后
 * 可以继续使用同一套纯裁决逻辑，不需要维护第二份权限事实。
 */
export class CapabilityManager {
  readonly #policies: readonly CapabilityPolicy[];
  readonly #grantIdGenerator: () => string;
  readonly #requestIdGenerator: () => string;

  constructor(options: CapabilityManagerOptions = {}) {
    this.#policies = [
      ...(options.policies ?? []),
      ...DEFAULT_CAPABILITY_POLICIES,
    ];
    this.#grantIdGenerator =
      options.grantIdGenerator ?? randomUUID;
    this.#requestIdGenerator =
      options.requestIdGenerator ?? randomUUID;
    for (const policy of this.#policies) {
      validatePolicy(policy);
    }
  }

  nextRequestId(): string {
    return requireGeneratedId(
      this.#requestIdGenerator(),
      'Capability request',
    );
  }

  normalizeRequests(
    inputs: readonly CapabilityInput[],
  ): CapabilityRequest[] {
    const requests = inputs.map(normalizeCapabilityInput);
    const unique = new Map(
      requests.map((request) => [capabilityRequestKey(request), request]),
    );
    return [...unique.values()];
  }

  /**
   * 根任务的初始能力来自宿主边界，视为用户已经授予。
   *
   * human-only 能力只形成 Root Authority Ceiling；执行前仍需人工签发单次 Grant，
   * 并且不能由 Agent 向下转授。
   */
  issueRootGrants(
    subjectTaskId: string,
    inputs: readonly CapabilityInput[],
    issuedAt: number,
  ): CapabilityGrant[] {
    return this.normalizeRequests(inputs).map((request) => {
      const policy = this.policyFor(request.capability);
      return {
        grantId: this.nextGrantId(),
        subjectTaskId,
        capability: request.capability,
        scope: structuredClone(request.scope),
        source: { type: 'root' },
        delegable: policy.delegable,
        execution:
          policy.approval === 'human'
            ? 'human_approval_required'
            : 'allowed',
        issuedAt,
      };
    });
  }

  validateDelegation(
    parentGrants: readonly CapabilityGrant[],
    inputs: readonly CapabilityInput[],
    now: number,
  ): CapabilityDelegationDecision {
    const requests = this.normalizeRequests(inputs);
    const sourceGrants: CapabilityGrant[] = [];

    for (const request of requests) {
      const policy = this.policyFor(request.capability);
      if (policy.approval === 'human' || !policy.delegable) {
        return {
          allowed: false,
          capability: request.capability,
          reason: `Capability ${request.capability} cannot be delegated by an Agent.`,
        };
      }
      const source = this.findGrant(parentGrants, request, now, true);
      if (!source) {
        return {
          allowed: false,
          capability: request.capability,
          reason: `Parent Agent cannot delegate capability ${request.capability} for the requested resource scope.`,
        };
      }
      sourceGrants.push(source);
    }

    return {
      allowed: true,
      sourceGrants,
    };
  }

  delegate(
    parentTaskId: string,
    parentGrants: readonly CapabilityGrant[],
    childTaskId: string,
    inputs: readonly CapabilityInput[],
    issuedAt: number,
  ): CapabilityGrant[] {
    const requests = this.normalizeRequests(inputs);
    const decision = this.validateDelegation(
      parentGrants,
      requests,
      issuedAt,
    );
    if (!decision.allowed) {
      throw new CapabilityDelegationError(
        decision.capability,
        decision.reason,
      );
    }

    return requests.map((request, index) => {
      const parentGrant = decision.sourceGrants[index];
      if (!parentGrant) {
        throw new Error('Capability delegation lost its source grant.');
      }
      return {
        grantId: this.nextGrantId(),
        subjectTaskId: childTaskId,
        capability: request.capability,
        scope: structuredClone(request.scope),
        source: {
          type: 'parent',
          issuerTaskId: parentTaskId,
          parentGrantId: parentGrant.grantId,
        },
        delegable: this.policyFor(request.capability).delegable,
        execution: 'allowed',
        issuedAt,
        ...(parentGrant.expiresAt === undefined
          ? {}
          : { expiresAt: parentGrant.expiresAt }),
      };
    });
  }

  check(
    grants: readonly CapabilityGrant[],
    inputs: readonly CapabilityInput[],
    now: number,
    operationId?: string,
  ): CapabilityCheckResult {
    const requests = this.normalizeRequests(inputs);
    const matched: CapabilityGrant[] = [];
    const missing: CapabilityRequest[] = [];

    for (const request of requests) {
      const grant = this.findGrant(
        grants,
        request,
        now,
        false,
        operationId,
      );
      if (grant) {
        matched.push(grant);
      } else {
        missing.push(request);
      }
    }
    return missing.length === 0
      ? { allowed: true, grants: matched }
      : { allowed: false, missing };
  }

  /**
   * 先验证根 Agent 的权限上限，再计算从最近持权祖先到请求者的逐跳委派路径。
   *
   * `ancestors` 必须按直接父任务到根任务的顺序传入。
   */
  planRequest(
    requesterTaskId: string,
    ancestors: readonly CapabilityAncestor[],
    inputs: readonly CapabilityInput[],
    now: number,
  ): CapabilityRequestRouteDecision {
    const requests = this.normalizeRequests(inputs);
    if (requests.length === 0) {
      return {
        routed: false,
        reason: 'At least one capability must be requested.',
      };
    }
    const root = ancestors.at(-1);
    if (!root) {
      return {
        routed: false,
        reason: 'Root Agent cannot acquire capabilities outside its authority ceiling.',
      };
    }
    for (const request of requests) {
      const rootGrant = this.findGrant(
        root.grants,
        request,
        now,
        false,
        undefined,
        true,
      );
      if (!rootGrant) {
        return {
          routed: false,
          reason: `Root Agent authority does not cover capability ${request.capability} for the requested resource scope.`,
        };
      }
    }
    if (
      requests.some(
        (request) =>
          this.policyFor(request.capability).approval === 'human',
      )
    ) {
      return { routed: true, route: 'human' };
    }

    const holderIndex = ancestors.findIndex((ancestor) =>
      this.validateDelegation(
        ancestor.grants,
        requests,
        now,
      ).allowed,
    );
    if (holderIndex < 0) {
      return {
        routed: false,
        reason:
          'No ancestor holds a delegable grant covering the requested capabilities.',
      };
    }

    const delegationPath: CapabilityDelegationHop[] = [];
    for (let index = holderIndex; index >= 0; index -= 1) {
      const grantor = ancestors[index];
      const grantee =
        index === 0
          ? { taskId: requesterTaskId }
          : ancestors[index - 1];
      if (!grantor || !grantee) {
        throw new Error('Capability delegation path is incomplete.');
      }
      delegationPath.push({
        grantorTaskId: grantor.taskId,
        granteeTaskId: grantee.taskId,
        status:
          index === holderIndex ? 'pending' : 'queued',
      });
    }
    return {
      routed: true,
      route: 'parent',
      delegationPath,
    };
  }

  grantByParent(
    parentTaskId: string,
    parentGrants: readonly CapabilityGrant[],
    childTaskId: string,
    requests: readonly CapabilityRequest[],
    issuedAt: number,
  ): CapabilityGrant[] {
    return this.delegate(
      parentTaskId,
      parentGrants,
      childTaskId,
      requests,
      issuedAt,
    );
  }

  grantByHuman(
    subjectTaskId: string,
    approvalRequestId: string,
    requests: readonly CapabilityRequest[],
    issuedAt: number,
  ): CapabilityGrant[] {
    return this.normalizeRequests(requests).map((request) => {
      const policy = this.policyFor(request.capability);
      return {
        grantId: this.nextGrantId(),
        subjectTaskId,
        capability: request.capability,
        scope: structuredClone(request.scope),
        source: {
          type: 'human' as const,
          approvalRequestId,
        },
        delegable: policy.delegable,
        execution: 'allowed',
        issuedAt,
        ...(policy.approval === 'human'
          ? { remainingUses: 1 }
          : {}),
      };
    });
  }

  private findGrant(
    grants: readonly CapabilityGrant[],
    request: CapabilityRequest,
    now: number,
    requireDelegable: boolean,
    operationId?: string,
    allowApprovalRequired = false,
  ): CapabilityGrant | undefined {
    return grants.find(
      (grant) =>
        grant.capability === request.capability &&
        (grant.expiresAt === undefined || grant.expiresAt > now) &&
        (allowApprovalRequired ||
          (grant.execution ?? 'allowed') === 'allowed') &&
        (grant.remainingUses === undefined ||
          grant.remainingUses > 0 ||
          (operationId !== undefined &&
            grant.consumedBy === operationId)) &&
        (!requireDelegable || grant.delegable) &&
        scopeContains(grant.scope, request.scope),
    );
  }

  private policyFor(capability: string): CapabilityPolicy {
    return (
      this.#policies.find((policy) =>
        matchesPattern(capability, policy.capabilityPattern),
      ) ?? {
        capabilityPattern: capability,
        approval: 'parent',
        delegable: true,
      }
    );
  }

  private nextGrantId(): string {
    return requireGeneratedId(
      this.#grantIdGenerator(),
      'Capability grant',
    );
  }
}

export class CapabilityDelegationError extends Error {
  constructor(
    readonly capability: string,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityDelegationError';
  }
}

function matchesPattern(capability: string, pattern: string): boolean {
  return pattern.endsWith('*')
    ? capability.startsWith(pattern.slice(0, -1))
    : capability === pattern;
}

function validatePolicy(policy: CapabilityPolicy): void {
  if (!policy.capabilityPattern.trim()) {
    throw new Error('Capability policy pattern must not be empty.');
  }
  if (
    policy.capabilityPattern.includes('*') &&
    !policy.capabilityPattern.endsWith('*')
  ) {
    throw new Error(
      'Capability policy wildcard is only supported at the end.',
    );
  }
}

function requireGeneratedId(id: string, kind: string): string {
  const normalized = id.trim();
  if (!normalized) {
    throw new Error(`${kind} ID generator returned an empty ID.`);
  }
  return normalized;
}
