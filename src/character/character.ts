import type { CapabilityRequest } from '../capability/capability.js';

/**
 * Character 是内核级别的角色策略包，而不仅仅是一段 Prompt。
 *
 * 它同时约束四件事：模型可见的工具集合、允许持有的能力上限、允许运行时申请的
 * 能力，以及允许创建的子 Character。真正的授权仍由 CapabilityManager 裁决；
 * Character 只负责把“角色应有的边界”变成可校验的策略事实。
 */
export type CharacterDefinition = {
  /** 稳定的角色标识，例如 `developer`、`code_auditor`、`researcher`。 */
  id: string;
  /** 展示用的角色名称。 */
  displayName: string;
  /** 该角色是否只能用于初始根 Agent，不能出现在任何子 Agent 上。 */
  rootOnly?: boolean;
  /**
   * 注入模型上下文的职责边界说明。
   *
   * 只描述职责、输出契约和禁止事项，不承担安全边界职责——安全边界由能力上限
   * 和工具可见性强制保证。
   */
  promptFragment: string;
  /**
   * 该角色在模型请求中可见的工具名称。
   *
   * 可见性不等于可执行：即便工具可见，具体调用仍需通过 CapabilityManager 校验。
   */
  visibleToolIds: readonly string[];
  /**
   * 该角色允许持有的能力名称上限。
   *
   * 父 Agent 转授或角色运行时申请的能力必须落在此集合内；资源范围仍由委派
   * 衰减和 workspace 边界进一步收窄。`*` 表示不额外限制能力名称。
   */
  capabilityCeiling: readonly string[];
  /**
   * 允许该角色在运行时通过 `request_capabilities` 申请的能力名称。
   *
   * 必须是 `capabilityCeiling` 的子集；用于区分“角色可以被授予”与“角色可以
   * 主动申请”。
   */
  requestableCapabilities: readonly string[];
  /**
   * 该角色可以创建的子 Character 标识。
   *
   * 空数组表示该角色不能创建任何子 Agent，从结构上阻止低权限角色凭空造出
   * 高权限下属。
   */
  allowedChildCharacters: readonly string[];
};

/** 表示能力名称不受限制的通配符。 */
export const ANY_CAPABILITY = '*';

/**
 * 判断某个能力名称是否落在角色的能力上限内。
 *
 * 通配符 `*` 表示角色对能力名称不设额外限制；资源范围仍由委派链和 workspace
 * 边界收窄。
 */
export function characterAllowsCapability(
  ceiling: readonly string[],
  capability: string,
): boolean {
  return ceiling.includes(ANY_CAPABILITY) || ceiling.includes(capability);
}

/**
 * 校验一组能力请求是否全部落在角色能力上限内。
 *
 * 返回第一个越界的能力名称，便于调度器给出结构化拒绝原因。
 */
export function findCapabilityOutsideCeiling(
  ceiling: readonly string[],
  requests: readonly CapabilityRequest[],
): string | undefined {
  for (const request of requests) {
    if (!characterAllowsCapability(ceiling, request.capability)) {
      return request.capability;
    }
  }
  return undefined;
}
