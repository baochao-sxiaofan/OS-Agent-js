import type { JsonValue } from '../types/json.js';

export type ReadyReason =
  | 'async_work_result_available'
  | 'capability_result_available'
  | 'submitted'
  | 'capacity_available'
  | 'context_compacted'
  | 'graph_node_ready'
  | 'graph_replan'
  | 'graph_updated'
  | 'model_retry'
  | 'subagent_result_available'
  | 'tool_call_rejected'
  | 'tool_result_available'
  | 'restored';

export type BlockedReason =
  | 'async_work'
  | 'capability_request'
  | 'human_approval'
  | 'resource_lock'
  | 'subagent'
  | 'tool';

export type Termination =
  | {
      kind: 'completed';
      output: JsonValue;
    }
  | {
      kind: 'failed';
      error: string;
    }
  | {
      kind: 'cancelled';
      reason: string;
    }
  | {
      kind: 'needs_parent_action';
      requiredWork: string;
      partialOutput?: JsonValue;
    };

export type ReadyState = {
  status: 'READY';
  enteredAt: number;
  reason: ReadyReason;
};

export type RunningState = {
  status: 'RUNNING';
  enteredAt: number;
  providerId: string;
  requestAttempt: number;
  operation?: 'context_compaction' | 'graph_dispatch' | 'model';
};

export type BlockedState = {
  status: 'BLOCKED';
  enteredAt: number;
  reason: BlockedReason;
  waitingFor: string[];
};

export type TerminatedState = {
  status: 'TERMINATED';
  enteredAt: number;
  termination: Termination;
};

export type TaskState =
  | BlockedState
  | ReadyState
  | RunningState
  | TerminatedState;

export type TaskStatus = TaskState['status'];
