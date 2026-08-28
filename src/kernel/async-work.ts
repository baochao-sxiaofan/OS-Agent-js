import type { JsonValue } from '../types/json.js';
import type { CapabilityRequest } from '../capability/capability.js';
import type { Termination } from './task-state.js';

export type AsyncWorkKind = 'subagent' | 'tool';

export type AsyncWorkStatus =
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'running'
  | 'waiting_for_capability'
  | 'timed_out';

export type AsyncWorkTerminalStatus =
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'timed_out';

export function isAsyncWorkTerminalStatus(
  status: AsyncWorkStatus,
): status is AsyncWorkTerminalStatus {
  return status !== 'running' && status !== 'waiting_for_capability';
}

export type AsyncWorkRegistration = {
  workId: string;
  kind: AsyncWorkKind;
  label: string;
  graphNodeAlias?: string;
  childTaskId?: string;
  toolName?: string;
};

export type AsyncWorkCapabilityBlocker = {
  type: 'capability_request';
  requestRef: string;
  requests: CapabilityRequest[];
  blockedAt: number;
  deliveredAt?: number;
};

export type AsyncWorkRecord = AsyncWorkRegistration & {
  status: AsyncWorkStatus;
  startedAt: number;
  completedAt?: number;
  deliveredAt?: number;
  output?: JsonValue;
  termination?: Termination;
  error?: string;
  blocker?: AsyncWorkCapabilityBlocker;
};

export type AsyncWorkGeneration = {
  generationId: string;
  createdAt: number;
  work: AsyncWorkRecord[];
  batchDueAt?: number;
  closedAt?: number;
};

export type AsyncWorkResult = {
  workId: string;
  kind: AsyncWorkKind;
  label: string;
  graphNodeAlias?: string;
  status: AsyncWorkTerminalStatus;
  completedAt: number;
  output?: JsonValue;
  termination?: Termination;
  error?: string;
};

export type AsyncWorkPending = {
  workId: string;
  kind: AsyncWorkKind;
  label: string;
  graphNodeAlias?: string;
  startedAt: number;
  status?: 'running' | 'waiting_for_capability';
  blocker?: Omit<AsyncWorkCapabilityBlocker, 'deliveredAt'>;
};
