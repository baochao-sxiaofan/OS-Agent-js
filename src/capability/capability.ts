/**
 * Capability 所约束的资源范围。
 *
 * `all` 适合无资源维度的能力或兼容旧的字符串 capability；
 * `exact` 只匹配单一资源；`subtree` 匹配资源本身及其层级后代。
 * 资源使用 URI 风格的稳定名称，例如 `file:///repo/src/auth`。
 */
export type ResourceScope =
  | {
      kind: 'all';
    }
  | {
      kind: 'exact';
      resource: string;
    }
  | {
      kind: 'subtree';
      resource: string;
    };

/** Agent 或宿主请求获得的一项能力。 */
export type CapabilityRequest = {
  capability: string;
  scope: ResourceScope;
  reason?: string;
};

/**
 * 兼容旧 API 的 capability 输入。
 *
 * 字符串会被解释为作用于全部资源的 capability。新代码应优先传入
 * `CapabilityRequest`，避免无意间申请全局范围。
 */
export type CapabilityInput = string | CapabilityRequest;

export type CapabilityGrantSource =
  | {
      type: 'root';
    }
  | {
      type: 'parent';
      issuerTaskId: string;
      parentGrantId: string;
    }
  | {
      type: 'human';
      approvalRequestId: string;
    };

/**
 * CapabilityManager 签发的授权事实。
 *
 * Agent 和模型只能请求能力，不能构造 Grant。`subjectTaskId`、来源链和
 * `delegable` 均由内核决定。
 */
export type CapabilityGrant = {
  grantId: string;
  subjectTaskId: string;
  capability: string;
  scope: ResourceScope;
  source: CapabilityGrantSource;
  delegable: boolean;
  /**
   * `human_approval_required` 表示该 Grant 只定义任务树权限上限，不能直接执行。
   * 人工批准后签发的单次 Grant 使用 `allowed`。
   */
  execution?: 'allowed' | 'human_approval_required';
  issuedAt: number;
  expiresAt?: number;
  /** 存在时表示剩余可授权执行次数；0 表示已经耗尽。 */
  remainingUses?: number;
  /** 单次 Grant 被消费后绑定的内核操作 ID，允许同一操作幂等恢复。 */
  consumedBy?: string;
};

export type CapabilityApprovalRoute = 'human' | 'parent';

/**
 * 能力的内核路由策略。
 *
 * 支持精确名称与以 `*` 结尾的前缀，例如 `payment.*`。规则按声明顺序
 * 匹配，未命中的能力默认交给父 Agent 审批。
 */
export type CapabilityPolicy = {
  capabilityPattern: string;
  approval: CapabilityApprovalRoute;
  delegable: boolean;
};

export type CapabilityRequestStatus =
  | 'denied'
  | 'granted'
  | 'pending';

export type CapabilityDelegationHop = {
  grantorTaskId: string;
  granteeTaskId: string;
  status: 'granted' | 'pending' | 'queued';
};

/**
 * 持久化在请求方 TCB 中的授权申请。
 *
 * 路由由 CapabilityManager 生成，模型不能指定。父 Agent 只会看到
 * `requestId` 的模型侧别名以及请求内容，看不到或修改这里的路由。
 */
export type CapabilityRequestRecord = {
  requestId: string;
  requests: CapabilityRequest[];
  route: CapabilityApprovalRoute;
  status: CapabilityRequestStatus;
  delegationPath?: CapabilityDelegationHop[];
  currentHopIndex?: number;
  createdAt: number;
  resolvedAt?: number;
  resolutionReason?: string;
};

export type CapabilityCheckResult =
  | {
      allowed: true;
      grants: CapabilityGrant[];
    }
  | {
      allowed: false;
      missing: CapabilityRequest[];
    };

export type CapabilityDelegationDecision =
  | {
      allowed: true;
      sourceGrants: CapabilityGrant[];
    }
  | {
      allowed: false;
      capability: string;
      reason: string;
    };

export type CapabilityRequestRouteDecision =
  | {
      routed: true;
      route: 'human';
    }
  | {
      routed: true;
      route: 'parent';
      delegationPath: CapabilityDelegationHop[];
    }
  | {
      routed: false;
      reason: string;
    };

export function normalizeCapabilityInput(
  input: CapabilityInput,
): CapabilityRequest {
  if (typeof input === 'string') {
    return {
      capability: requireCapabilityName(input),
      scope: { kind: 'all' },
    };
  }
  return {
    capability: requireCapabilityName(input.capability),
    scope: normalizeResourceScope(input.scope),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

export function normalizeResourceScope(scope: ResourceScope): ResourceScope {
  if (scope.kind === 'all') {
    return { kind: 'all' };
  }
  const resource = normalizeResource(scope.resource);
  return {
    kind: scope.kind,
    resource,
  };
}

export function scopeContains(
  granted: ResourceScope,
  requested: ResourceScope,
): boolean {
  if (granted.kind === 'all') {
    return true;
  }
  if (requested.kind === 'all') {
    return false;
  }
  if (granted.kind === 'exact') {
    return (
      requested.kind === 'exact' &&
      requested.resource === granted.resource
    );
  }

  const subtreePrefix = granted.resource.endsWith('/')
    ? granted.resource
    : `${granted.resource}/`;
  return (
    requested.resource === granted.resource ||
    requested.resource.startsWith(subtreePrefix)
  );
}

export function capabilityRequestKey(request: CapabilityRequest): string {
  const resource =
    request.scope.kind === 'all' ? '*' : request.scope.resource;
  return `${request.capability}\u0000${request.scope.kind}\u0000${resource}`;
}

function requireCapabilityName(capability: string): string {
  const normalized = capability.trim();
  if (!normalized) {
    throw new Error('Capability name must not be empty.');
  }
  return normalized;
}

function normalizeResource(resource: string): string {
  const input = resource.trim();
  if (!input) {
    throw new Error('Capability resource must not be empty.');
  }
  if (!input.includes('://')) {
    throw new Error(
      `Capability resource must use a URI-style name: ${input}`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Capability resource is not a valid URI: ${input}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      'Capability resources cannot contain credentials, queries, or fragments.',
    );
  }
  return parsed.pathname === '/'
    ? parsed.href
    : parsed.href.replace(/\/+$/u, '');
}
