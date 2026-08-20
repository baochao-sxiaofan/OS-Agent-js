import type { ModelUsage } from '../model/model-provider.js';
import type { JsonValue } from '../types/json.js';
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
  responseType: 'final' | 'tool_calls';
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

export type TaskEvent =
  | CapacityWaitRecordedEvent
  | ModelResponseRecordedEvent
  | StateTransitionedEvent
  | TaskCreatedEvent
  | TaskTerminatedEvent
  | ToolCallRecordedEvent
  | ToolResultRecordedEvent;
