import type { ResourceScope } from '../capability/capability.js';
import type { AgentContext } from '../agent-context/index.js';

/**
 * 持久 Agent 身份，独立于任务和模型请求 ID。
 * 宿主负责分配唯一的正安全整数，并在恢复时保留原值。
 */
export type AgentId = number;

/** Agent 的调度状态，与内部任务链进度相互独立。 */
export enum AgentState {
  /** 已有封存输入，等待获得模型处理机。 */
  READY = 'READY',
  /** 当前批次正在请求模型或处理本轮返回。 */
  RUNNING = 'RUNNING',
  /** 当前没有可发送批次，正在等待明确的异步操作结果。 */
  BLOCKED = 'BLOCKED',
  /** 没有可运行工作或在途操作，等待新的外部事件。 */
  SLEEPING = 'SLEEPING',
}

/**
 * 宿主管理的 Agent 文件权限，复用现有能力名称与资源范围表示。
 * 此处不复用任务绑定的授权记录；签发、校验和撤销协议留待后续实现。
 */
export type AgentFilePermission = {
  /** 文件系统操作，例如 file.read 或 directory.list。 */
  readonly capability: string;
  /** 精确资源、目录子树或全部资源。 */
  readonly scope: ResourceScope;
};

/**
 * 持续履行角色职责的长期 Agent 数据快照，对外只读。
 * 不包含 TCB、传输对象或可执行工具；运行状态通过专用接口更新。
 */
export type AgentControlBlock = {
  readonly agentId: AgentId;
  /** 已注册的角色标识，例如 sales、developer 或 tester。 */
  readonly character: string;
  /** 通信用的展示名称；实际寻址使用 agentId。 */
  readonly agentName: string;
  readonly state: AgentState;
  /** 文件系统访问权限，与工具调用能力分开管理。 */
  readonly capacity: readonly AgentFilePermission[];
  /** 可以调用的已注册工具 ID，工具定义保存在外部注册表。 */
  readonly skills: readonly string[];
  /** 由 agent-context 管理的三级工作与记忆快照。 */
  readonly context: AgentContext;
  /** Agent 创建时的 Unix 毫秒时间戳，必须为非负安全整数。 */
  readonly createdAt: number;
  /** 宿主管理的模型配置引用，不包含凭据。 */
  readonly modelConfigId: string;
};

/**
 * 仅向可信调度器提供的同步状态端口，不暴露 Context 或权限字段。
 * 实现必须同步提交或抛错，不能异步更新，也不能重入调度器。
 */
export interface AgentSchedulingHandle {
  readonly agentId: AgentId;
  getState(): AgentState;
  transition(next: AgentState): void;
}

/** 宿主持有的 ACB 实例；快照不会向调用者泄露可变内部对象。 */
export interface ManagedAgentControlBlock extends AgentSchedulingHandle {
  snapshot(): AgentControlBlock;
}

export class InvalidAgentTransitionError extends Error {
  constructor(readonly from: AgentState, readonly to: AgentState) {
    super(`非法 Agent 状态转换：${from} -> ${to}`);
    this.name = 'InvalidAgentTransitionError';
  }
}
