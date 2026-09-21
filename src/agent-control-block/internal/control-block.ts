import {
  AgentState,
  InvalidAgentTransitionError,
  type AgentControlBlock,
  type ManagedAgentControlBlock,
} from '../api.js';

const transitions: Readonly<Record<AgentState, readonly AgentState[]>> = {
  [AgentState.SLEEPING]: [AgentState.READY],
  [AgentState.READY]: [AgentState.RUNNING],
  [AgentState.RUNNING]: [AgentState.READY, AgentState.BLOCKED, AgentState.SLEEPING],
  [AgentState.BLOCKED]: [AgentState.READY],
};

/** 仅判断状态边是否合法；队列、批次和等待条件由调度器掌握。 */
export function canAgentTransition(from: AgentState, to: AgentState): boolean {
  return transitions[from]?.includes(to) ?? false;
}

export function createAgentControlBlock(initial: AgentControlBlock): ManagedAgentControlBlock {
  if (!Number.isSafeInteger(initial.agentId) || initial.agentId <= 0) {
    throw new RangeError('agentId 必须为正安全整数。');
  }
  if (!Number.isSafeInteger(initial.createdAt) || initial.createdAt < 0) {
    throw new RangeError('createdAt 必须为非负安全整数。');
  }
  if (!Object.values(AgentState).includes(initial.state)) {
    throw new TypeError('未知的 Agent 状态。');
  }
  return new ControlBlock(initial);
}

class ControlBlock implements ManagedAgentControlBlock {
  readonly agentId: number;
  #data: AgentControlBlock;

  constructor(initial: AgentControlBlock) {
    this.#data = structuredClone(initial);
    this.agentId = initial.agentId;
    // 固定公开身份，私有状态仍只能通过 transition 更新。
    Object.freeze(this);
  }

  getState(): AgentState {
    return this.#data.state;
  }

  transition(next: AgentState): void {
    if (!canAgentTransition(this.#data.state, next)) {
      throw new InvalidAgentTransitionError(this.#data.state, next);
    }
    this.#data = { ...this.#data, state: next };
  }

  snapshot(): AgentControlBlock {
    return structuredClone(this.#data);
  }
}
