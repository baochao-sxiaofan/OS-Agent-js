import type {
  ContextItem,
  TurnSummary,
} from '../kernel/context.js';
import type {
  CapabilityInput,
  CapabilityRequest,
} from '../capability/capability.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import type {
  AgentWorkGraph,
  AgentWorkGraphMode,
  AgentWorkGraphProposal,
  AgentWorkNode,
  AgentWorkNodeKindDefinition,
} from '../graph/agent-work-graph.js';

export type TurnSummaryProtocol = {
  version: 1;
  instruction: string;
  responseField: 'turnSummary';
  requiredFields: readonly ['request', 'outcome'];
  schema: {
    type: 'object';
    additionalProperties: false;
    properties: {
      request: {
        type: 'string';
      };
      outcome: {
        type: 'string';
      };
    };
    required: readonly ['request', 'outcome'];
  };
};

export const TURN_SUMMARY_PROTOCOL: TurnSummaryProtocol = {
  version: 1,
  instruction:
    'Alongside the normal response, return a structured summary of this turn. Write one concise sentence for the request and one concise sentence for the completed work or outcome.',
  responseField: 'turnSummary',
  requiredFields: ['request', 'outcome'],
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      request: {
        type: 'string',
      },
      outcome: {
        type: 'string',
      },
    },
    required: ['request', 'outcome'],
  },
};

export type ToolDescriptor = {
  name: string;
  description: string;
  /** 描述工具输入的 JSON Schema。 */
  inputSchema?: JsonObject;
};

export type ToolCallRequest = {
  callId: string;
  toolName: string;
  input: JsonObject;
};

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type ModelReasoningEffort =
  | 'auto'
  | 'low'
  | 'medium'
  | 'high';

export type ModelRuntimePreferences = {
  /** 每个任务的上下文上限，调度器会将其限制在服务商允许范围内。 */
  maxContextTokens?: number;
  /** 所选服务商或模型支持时使用的采样温度。 */
  temperature?: number;
  /** 与厂商无关的推理深度提示，不支持的服务商会忽略它。 */
  reasoningEffort?: ModelReasoningEffort;
};

export type SubagentSpawnRequest = {
  goal: string;
  /** 子 Agent 扮演的 Character 标识；由内核校验是否允许创建。 */
  character?: string;
  /** 作用于全部资源的能力简写，用于兼容旧调用方。 */
  capabilities?: CapabilityInput[];
  requestedCapabilities?: CapabilityRequest[];
  context?: ContextItem[];
  maxModelAttempts?: number;
  maxCostUsd?: number;
};

export type ModelResponse = ModelActionResponse & {
  /** 交错推理和工具结果配对所需的原生模型回复历史。 */
  providerMessage?: { providerId: string; message: JsonObject };
};

type ModelActionResponse =
  | {
      type: 'set_graph';
      graph: AgentWorkGraphProposal;
      turnSummary?: TurnSummary;
      usage: ModelUsage;
    }
  | {
      type: 'complete_node';
      output: JsonValue;
      turnSummary?: TurnSummary;
      usage: ModelUsage;
    }
  | {
      type: 'request_replan';
      reason: string;
      partialOutput?: JsonValue;
      turnSummary?: TurnSummary;
      usage: ModelUsage;
    }
  | {
      type: 'final';
      output: JsonValue;
      turnSummary?: TurnSummary;
      usage: ModelUsage;
    }
  | {
      type: 'tool_calls';
      calls: ToolCallRequest[];
      turnSummary?: TurnSummary;
      usage: ModelUsage;
    }
  | {
      type: 'spawn_subagents';
      children: SubagentSpawnRequest[];
      turnSummary?: TurnSummary;
      usage: ModelUsage;
    }
  | {
      type: 'async_work';
      children: SubagentSpawnRequest[];
      calls: ToolCallRequest[];
      turnSummary?: TurnSummary;
      usage: ModelUsage;
    }
  | {
      type: 'wait_for_async_work';
      turnSummary?: TurnSummary;
      usage: ModelUsage;
    }
  | {
      type: 'request_capabilities';
      requests: CapabilityRequest[];
      turnSummary?: TurnSummary;
      usage: ModelUsage;
    }
  | {
      type: 'resolve_capability_request';
      requestRef: string;
      decision: 'approve' | 'deny';
      reason?: string;
      turnSummary?: TurnSummary;
      usage: ModelUsage;
    }
  | {
      type: 'needs_parent_action';
      requiredWork: string;
      partialOutput?: JsonValue;
      turnSummary?: TurnSummary;
      usage: ModelUsage;
    };

export type ModelRequest = {
  taskId: string;
  goal: string;
  context: readonly ContextItem[];
  tools: readonly ToolDescriptor[];
  /** 当前可执行能力的对外投影，不包含内部 Grant ID。 */
  capabilities?: readonly CapabilityRequest[];
  character?: {
    id: string;
    displayName: string;
    instructions: string;
    requestableCapabilities: readonly string[];
  };
  attempt: number;
  preferences?: ModelRuntimePreferences;
  summaryProtocol: TurnSummaryProtocol;
  graph?: {
    mode: AgentWorkGraphMode;
    current?: AgentWorkGraph;
    activeNode?: AgentWorkNode;
    availableNodeKinds: readonly AgentWorkNodeKindDefinition[];
  };
  delegation: {
    canSpawnSubagents: boolean;
    availableCharacters?: readonly {
      id: string;
      displayName: string;
      description: string;
      capabilityCeiling: readonly string[];
    }[];
  };
};

export type ModelRequestEstimate = {
  inputTokens: number;
  maxOutputTokens: number;
  estimatedCostUsd: number;
};

export interface ModelProvider {
  readonly id: string;
  readonly contextWindowTokens: number;

  estimate(request: ModelRequest): ModelRequestEstimate;

  invoke(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}
