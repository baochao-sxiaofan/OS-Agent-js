import type { JsonValue } from '../types/json.js';

export type ReadyReason =
  | 'submitted'
  | 'capacity_available'
  | 'model_retry'
  | 'subagent_result_available'
  | 'tool_result_available'
  | 'restored';

export type BlockedReason =
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
