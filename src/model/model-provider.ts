import type {
  ContextItem,
  TurnSummary,
} from '../kernel/context.js';
import type {
  CapabilityInput,
  CapabilityRequest,
} from '../capability/capability.js';
import type { JsonObject, JsonValue } from '../types/json.js';

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

export type SubagentSpawnRequest = {
  goal: string;
  /** Compatibility shorthand for capabilities applying to all resources. */
  capabilities?: CapabilityInput[];
  requestedCapabilities?: CapabilityRequest[];
  context?: ContextItem[];
  maxModelAttempts?: number;
  maxCostUsd?: number;
};

export type ModelResponse =
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
  attempt: number;
  summaryProtocol: TurnSummaryProtocol;
  delegation: {
    canSpawnSubagents: boolean;
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
