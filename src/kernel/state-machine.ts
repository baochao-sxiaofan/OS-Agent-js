import type { TaskState, TaskStatus } from './task-state.js';

const LEGAL_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  READY: ['RUNNING', 'TERMINATED'],
  RUNNING: ['BLOCKED', 'READY', 'TERMINATED'],
  BLOCKED: ['READY', 'TERMINATED'],
  TERMINATED: [],
};

export class InvalidTaskTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Invalid task state transition: ${from} -> ${to}`);
    this.name = 'InvalidTaskTransitionError';
  }
}

export function assertTaskTransition(
  current: TaskState,
  next: TaskState,
): void {
  if (!LEGAL_TRANSITIONS[current.status].includes(next.status)) {
    throw new InvalidTaskTransitionError(current.status, next.status);
  }
}

export function canTaskTransition(
  current: TaskState,
  next: TaskState,
): boolean {
  return LEGAL_TRANSITIONS[current.status].includes(next.status);
}
