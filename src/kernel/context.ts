import type { JsonValue } from '../types/json.js';
import type {
  CapabilityRequest,
  ResourceScope,
} from '../capability/capability.js';
import type {
  AsyncWorkPending,
  AsyncWorkResult,
} from './async-work.js';
import type { Termination } from './task-state.js';
import type {
  AgentWorkNodeKind,
  AgentWorkNodeStatus,
} from '../graph/agent-work-graph.js';

/**
 * 一轮模型交互的精简摘要。
 *
 * 摘要与完整上下文分开保存，用于上下文窗口不足时替换较早的原始记录。
 */
export type TurnSummary = {
  /** 本轮模型需要处理的请求或问题。 */
  request: string;
  /** 本轮已经完成的工作及结果。 */
  outcome: string;
};

/**
 * 上下文摘要的生成层级。
 *
 * - `turn`：模型正常响应时顺带生成的单轮摘要。
 * - `secondary`：上下文仍然过长时，由 ContextCompactor 生成的二次聚合摘要。
 */
export type ContextSummaryKind = 'secondary' | 'turn';

/**
 * 持久化保存的一段上下文摘要。
 *
 * 记录摘要覆盖的原始上下文范围，使 ContextWindowManager 可以用摘要替换
 * 对应区间，同时保留未被覆盖的近期原文。
 */
export type ContextSummaryRecord = {
  /** 摘要记录的唯一 ID。 */
  id: string;
  /** 摘要来自单轮搭载还是二次压缩。 */
  kind: ContextSummaryKind;
  /** 被摘要原始上下文的起始索引，包含该位置。 */
  sourceStartIndex: number;
  /** 被摘要原始上下文的结束索引，不包含该位置。 */
  sourceEndIndex: number;
  /** 可替代上述原始上下文区间的结构化摘要。 */
  summary: TurnSummary;
  /** 摘要创建时的 Unix 毫秒时间戳。 */
  createdAt: number;
};

/** 由运行时注入、用于约束模型行为的系统上下文。 */
export type SystemContextItem = {
  /** 判别联合使用的固定类型标识。 */
  type: 'system';
  /** 系统指令正文。 */
  content: string;
};

/** 用户提交给当前 Agent 的目标、补充信息或后续问题。 */
export type UserContextItem = {
  /** 判别联合使用的固定类型标识。 */
  type: 'user';
  /** 用户输入正文。 */
  content: string;
};

/** 模型此前产生并被运行时保留的回复内容。 */
export type AssistantContextItem = {
  /** 判别联合使用的固定类型标识。 */
  type: 'assistant';
  /** 模型回复正文。 */
  content: string;
};

/**
 * 发送给模型的摘要上下文项。
 *
 * 它是 `ContextSummaryRecord` 的模型侧投影，不携带内部 ID、索引和时间戳。
 */
export type ContextSummaryItem = {
  /** 判别联合使用的固定类型标识。 */
  type: 'context_summary';
  /** 被压缩上下文原本要求完成的工作。 */
  request: string;
  /** 被压缩上下文中已经得到的结果。 */
  outcome: string;
};

/**
 * Completion Mailbox 向父 Agent 投递的一批异步工作进展。
 *
 * 模型通过 `results` 消费本批新增结果，通过 `pending` 判断是否仍需等待，
 * 并在 `allFinished` 为真时执行最终汇总。
 */
export type AsyncWorkUpdateContextItem = {
  /** 判别联合使用的固定类型标识。 */
  type: 'async_work_update';
  /** 对应的异步工作批次 ID。 */
  generationId: string;
  /** 本次投递给父 Agent 的终态结果。 */
  results: AsyncWorkResult[];
  /** 同一批次中仍在执行的工作摘要。 */
  pending: AsyncWorkPending[];
  /** 当前 generation 是否已经没有任何运行中工作。 */
  allFinished: boolean;
};

/** 记录模型发起的一次工具调用。 */
export type ToolCallContextItem = {
  /** 判别联合使用的固定类型标识。 */
  type: 'tool_call';
  /** 本次调用的唯一 ID，用于关联工具结果。 */
  callId: string;
  /** ToolRegistry 中的工具名称。 */
  toolName: string;
  /** 经过工具输入校验的 JSON 参数。 */
  input: JsonValue;
};

/** 记录一次工具调用返回的结果。 */
export type ToolResultContextItem = {
  /** 判别联合使用的固定类型标识。 */
  type: 'tool_result';
  /** 与 `ToolCallContextItem.callId` 对应的调用 ID。 */
  callId: string;
  /** 返回结果的工具名称。 */
  toolName: string;
  /** 工具产生的 JSON 可序列化输出。 */
  output: JsonValue;
};

/** 子 Agent 结束后回传给父 Agent 的结构化结果。 */
export type SubagentResultContextItem = {
  /** 判别联合使用的固定类型标识。 */
  type: 'subagent_result';
  /** 已结束子任务的任务 ID。 */
  childTaskId: string;
  /** 子任务的完成、失败、取消或父任务协助请求信息。 */
  result: Termination;
};

/**
 * 子 Agent 创建请求被调度器拒绝后的反馈。
 *
 * 拒绝原因覆盖权限升级、请求或父状态非法、AgentPool/深度/根任务额度耗尽等
 * 情况。模型收到后应调整计划，而不是让父任务等待一个并不存在的子 Agent。
 */
export type SubagentSpawnRejectedContextItem = {
  /** 判别联合使用的固定类型标识。 */
  type: 'subagent_spawn_rejected';
  /** 调度器给出的机器可读拒绝原因。 */
  reason:
    | 'capability_escalation'
    | 'invalid_spawn_request'
    | 'invalid_parent_state'
    | 'live_pool_exhausted'
    | 'max_depth_exceeded'
    | 'parent_not_live'
    | 'root_spawn_limit_exceeded';
  /** 面向模型和诊断界面的详细拒绝说明。 */
  message: string;
};

/** Tool 调用在进入执行器前被内核拒绝。 */
export type ToolCallRejectedContextItem = {
  type: 'tool_call_rejected';
  toolName: string;
  reason: 'capability_required' | 'invalid_input' | 'tool_not_found';
  message: string;
  requiredCapabilities?: CapabilityRequest[];
};

/** 模型提交的 Graph 动作被内核策略拒绝后的可恢复反馈。 */
export type GraphActionRejectedContextItem = {
  type: 'graph_action_rejected';
  action: string;
  message: string;
};

/** Graph 换版时保留的上一 revision 结果，避免已完成节点产出从模型上下文消失。 */
export type WorkGraphRevisionContextItem = {
  type: 'work_graph_revision';
  revision: number;
  goal: string;
  completionCriteria: string[];
  nodes: Array<{
    alias: string;
    kind: AgentWorkNodeKind;
    status: AgentWorkNodeStatus;
    result?: JsonValue;
    error?: string;
  }>;
};

/** CapabilityManager 向请求方投递的最终授权结果。 */
export type CapabilityRequestResultContextItem = {
  type: 'capability_request_result';
  requestRef: string;
  status: 'denied' | 'granted';
  capabilities: Array<{
    capability: string;
    scope: ResourceScope;
  }>;
  reason?: string;
};

/**
 * Agent 完整上下文中允许出现的所有记录类型。
 *
 * 这是以 `type` 字段区分成员的判别联合。Provider 可以据此进行穷尽匹配，
 * 将内核上下文转换为不同模型厂商所需的请求格式。
 */
export type ContextItem =
  | AssistantContextItem
  | AsyncWorkUpdateContextItem
  | CapabilityRequestResultContextItem
  | ContextSummaryItem
  | GraphActionRejectedContextItem
  | SubagentResultContextItem
  | SubagentSpawnRejectedContextItem
  | SystemContextItem
  | ToolCallContextItem
  | ToolCallRejectedContextItem
  | ToolResultContextItem
  | UserContextItem
  | WorkGraphRevisionContextItem;
