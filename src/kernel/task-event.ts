import type { ModelUsage } from '../model/model-provider.js';
import type { JsonValue } from '../types/json.js';
import type {
  ContextSummaryKind,
  TurnSummary,
} from './context.js';
import type { TaskState, TaskStatus, Termination } from './task-state.js';

type TaskEventBase = {
  eventId: string;
  taskId: string;
  occurredAt: number;
  sequence: number;
};

export type TaskCreatedEvent = TaskEventBase & {
  type: 'task_created';
  goal: string;
  initialState: TaskState;
};

export type StateTransitionedEvent = TaskEventBase & {
  type: 'state_transitioned';
  from: TaskStatus;
  to: TaskState;
  reason: string;
};

export type CapacityWaitRecordedEvent = TaskEventBase & {
  type: 'capacity_wait_recorded';
  reasons: string[];
  retryAt?: number;
};

export type ModelResponseRecordedEvent = TaskEventBase & {
  type: 'model_response_recorded';
  responseType:
    | 'final'
    | 'needs_parent_action'
    | 'spawn_subagents'
    | 'tool_calls';
  usage: ModelUsage;
};

export type ContextSummaryRecordedEvent = TaskEventBase & {
  type: 'context_summary_recorded';
  kind: ContextSummaryKind;
  sourceStartIndex: number;
  sourceEndIndex: number;
  summary: TurnSummary;
};

export type ContextCompactionRecordedEvent = TaskEventBase & {
  type: 'context_compaction_recorded';
  usage: ModelUsage;
};

export type ToolCallRecordedEvent = TaskEventBase & {
  type: 'tool_call_recorded';
  callId: string;
  toolName: string;
};

export type ToolResultRecordedEvent = TaskEventBase & {
  type: 'tool_result_recorded';
  callId: string;
  toolName: string;
  output: JsonValue;
};

export type TaskTerminatedEvent = TaskEventBase & {
  type: 'task_terminated';
  termination: Termination;
};

export type SubagentSpawnedEvent = TaskEventBase & {
  type: 'subagent_spawned';
  childTaskId: string;
  childDepth: number;
};

export type SubagentResultRecordedEvent = TaskEventBase & {
  type: 'subagent_result_recorded';
  childTaskId: string;
  result: Termination;
};

export type TaskEvent =
  | CapacityWaitRecordedEvent
  | ContextCompactionRecordedEvent
  | ContextSummaryRecordedEvent
  | ModelResponseRecordedEvent
  | StateTransitionedEvent
  | SubagentResultRecordedEvent
  | SubagentSpawnedEvent
  | TaskCreatedEvent
  | TaskTerminatedEvent
  | ToolCallRecordedEvent
  | ToolResultRecordedEvent;
