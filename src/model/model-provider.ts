import type { ContextItem } from '../kernel/context.js';
import type { JsonObject, JsonValue } from '../types/json.js';

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
  taskId?: string;
  goal: string;
  priority?: number;
  capabilities?: string[];
  context?: ContextItem[];
  maxModelAttempts?: number;
  maxCostUsd?: number;
};

export type ModelResponse =
  | {
      type: 'final';
      output: JsonValue;
      usage: ModelUsage;
    }
  | {
      type: 'tool_calls';
      calls: ToolCallRequest[];
      usage: ModelUsage;
    }
  | {
      type: 'spawn_subagents';
      children: SubagentSpawnRequest[];
      usage: ModelUsage;
    }
  | {
      type: 'needs_parent_action';
      requiredWork: string;
      partialOutput?: JsonValue;
      usage: ModelUsage;
    };

export type ModelRequest = {
  taskId: string;
  goal: string;
  context: readonly ContextItem[];
  tools: readonly ToolDescriptor[];
  attempt: number;
  delegation: {
    canSpawnSubagents: boolean;
    currentDepth: number;
    maxDepth: number;
    availableAgentSlots: number;
  };
};

export type ModelRequestEstimate = {
  inputTokens: number;
  maxOutputTokens: number;
  estimatedCostUsd: number;
};

export interface ModelProvider {
  readonly id: string;

  estimate(request: ModelRequest): ModelRequestEstimate;

  invoke(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}
