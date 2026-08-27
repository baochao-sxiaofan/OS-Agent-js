import type { ModelUsage } from '../model/model-provider.js';
import type { JsonValue } from '../types/json.js';
import type {
  CapabilityApprovalRoute,
  CapabilityDelegationHop,
  CapabilityGrantSource,
  CapabilityRequest,
  CapabilityRequestStatus,
  ResourceScope,
} from '../capability/capability.js';
import type {
  AsyncWorkKind,
  AsyncWorkTerminalStatus,
} from './async-work.js';
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
    | 'async_work'
    | 'final'
    | 'needs_parent_action'
    | 'request_capabilities'
    | 'resolve_capability_request'
    | 'spawn_subagents'
    | 'tool_calls'
    | 'wait_for_async_work';
  usage: ModelUsage;
};

export type AsyncWorkRegisteredEvent = TaskEventBase & {
  type: 'async_work_registered';
  generationId: string;
  work: {
    workId: string;
    kind: AsyncWorkKind;
  }[];
};

export type AsyncWorkTerminalEvent = TaskEventBase & {
  type: 'async_work_terminal';
  generationId: string;
  workId: string;
  status: AsyncWorkTerminalStatus;
};

export type AsyncWorkDeliveredEvent = TaskEventBase & {
  type: 'async_work_delivered';
  generationId: string;
  workIds: string[];
  allFinished: boolean;
};

export type AsyncWorkCapabilityBlockedEvent = TaskEventBase & {
  type: 'async_work_capability_blocked';
  generationId: string;
  workId: string;
  requestRef: string;
  requests: CapabilityRequest[];
};

export type AsyncWorkCapabilityUnblockedEvent = TaskEventBase & {
  type: 'async_work_capability_unblocked';
  generationId: string;
  workId: string;
  requestRef: string;
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

export type CapabilityGrantedEvent = TaskEventBase & {
  type: 'capability_granted';
  grantId: string;
  capability: string;
  scope: ResourceScope;
  sourceType: CapabilityGrantSource['type'];
};

export type CapabilityGrantConsumedEvent = TaskEventBase & {
  type: 'capability_grant_consumed';
  grantId: string;
  capability: string;
  remainingUses: number;
  operationId: string;
};

export type CapabilityRequestCreatedEvent = TaskEventBase & {
  type: 'capability_request_created';
  requestId: string;
  route: CapabilityApprovalRoute;
  requests: CapabilityRequest[];
  delegationPath?: CapabilityDelegationHop[];
};

export type CapabilityRequestResolvedEvent = TaskEventBase & {
  type: 'capability_request_resolved';
  requestId: string;
  status: Exclude<CapabilityRequestStatus, 'pending'>;
  reason?: string;
};

export type CapabilityDelegationAdvancedEvent = TaskEventBase & {
  type: 'capability_delegation_advanced';
  requestId: string;
  grantedHopIndex: number;
  nextHopIndex?: number;
};

export type TaskEvent =
  | AsyncWorkCapabilityBlockedEvent
  | AsyncWorkCapabilityUnblockedEvent
  | AsyncWorkDeliveredEvent
  | AsyncWorkRegisteredEvent
  | AsyncWorkTerminalEvent
  | CapabilityGrantedEvent
  | CapabilityGrantConsumedEvent
  | CapabilityDelegationAdvancedEvent
  | CapabilityRequestCreatedEvent
  | CapabilityRequestResolvedEvent
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
