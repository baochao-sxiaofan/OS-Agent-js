import type { JsonValue } from '../types/json.js';
import type {
  AsyncWorkPending,
  AsyncWorkResult,
} from './async-work.js';
import type { Termination } from './task-state.js';

export type TurnSummary = {
  request: string;
  outcome: string;
};

export type ContextSummaryKind = 'secondary' | 'turn';

export type ContextSummaryRecord = {
  id: string;
  kind: ContextSummaryKind;
  sourceStartIndex: number;
  sourceEndIndex: number;
  summary: TurnSummary;
  createdAt: number;
};

export type SystemContextItem = {
  type: 'system';
  content: string;
};

export type UserContextItem = {
  type: 'user';
  content: string;
};

export type AssistantContextItem = {
  type: 'assistant';
  content: string;
};

export type ContextSummaryItem = {
  type: 'context_summary';
  request: string;
  outcome: string;
};

export type AsyncWorkUpdateContextItem = {
  type: 'async_work_update';
  generationId: string;
  results: AsyncWorkResult[];
  pending: AsyncWorkPending[];
  allFinished: boolean;
};

export type ToolCallContextItem = {
  type: 'tool_call';
  callId: string;
  toolName: string;
  input: JsonValue;
};

export type ToolResultContextItem = {
  type: 'tool_result';
  callId: string;
  toolName: string;
  output: JsonValue;
};

export type SubagentResultContextItem = {
  type: 'subagent_result';
  childTaskId: string;
  result: Termination;
};

export type SubagentSpawnRejectedContextItem = {
  type: 'subagent_spawn_rejected';
  reason:
    | 'capability_escalation'
    | 'invalid_spawn_request'
    | 'invalid_parent_state'
    | 'live_pool_exhausted'
    | 'max_depth_exceeded'
    | 'parent_not_live'
    | 'root_spawn_limit_exceeded'
    | 'spawn_in_progress';
  message: string;
};

export type ContextItem =
  | AssistantContextItem
  | AsyncWorkUpdateContextItem
  | ContextSummaryItem
  | SubagentResultContextItem
  | SubagentSpawnRejectedContextItem
  | SystemContextItem
  | ToolCallContextItem
  | ToolResultContextItem
  | UserContextItem;
