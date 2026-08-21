import type { JsonValue } from '../types/json.js';
import type { Termination } from './task-state.js';

export type AsyncWorkKind = 'subagent' | 'tool';

export type AsyncWorkStatus =
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'running'
  | 'timed_out';

export type AsyncWorkTerminalStatus = Exclude<AsyncWorkStatus, 'running'>;

export type AsyncWorkRegistration = {
  workId: string;
  kind: AsyncWorkKind;
  label: string;
  childTaskId?: string;
  toolName?: string;
};

export type AsyncWorkRecord = AsyncWorkRegistration & {
  status: AsyncWorkStatus;
  startedAt: number;
  completedAt?: number;
  deliveredAt?: number;
  output?: JsonValue;
  termination?: Termination;
  error?: string;
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
  startedAt: number;
};
