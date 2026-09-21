import {
  AgentState,
  type AgentControlBlock,
} from '../src/agent-control-block/index.js';
import type {
  AgentContext,
  ContextBudget,
  ContextMemory,
  ContextSummary,
} from '../src/agent-context/index.js';

// 以下限制仅用于示例，不是库的默认值。
const budget: ContextBudget = {
  maxTokens: 8_000,
  compactAtTokens: 6_000,
  targetTokens: 4_000,
  maxTasks: 12,
};

const emptyMemory: ContextMemory = {
  summary: null,
  lessons: [],
  recentEntries: [],
  historyRef: null,
};

const profileResult: ContextSummary = {
  outcome: 'Loaded the customer profile.',
  observations: [
    {
      kind: 'fact',
      statement: 'The customer is buying for the first time.',
      sourceRefs: ['crm://customers/17'],
    },
  ],
  decisions: ['Use the first-purchase price policy.'],
  artifactRefs: [],
  unresolved: [],
  nextResponsibilities: ['Read the latest customer message.'],
  lessonCandidates: [
    {
      statement: 'Check purchase history before selecting a price policy.',
      scope: 'Preparing a customer quote.',
      sourceRefs: ['crm://customers/17'],
    },
  ],
  sourceRefs: ['history://sales/17/profile-lookup'],
};

/**
 * 一个 Agent 包含三层上下文，每层维护各自的任务链。
 * 子层引用父层任务链中的任务，不复制任务状态。
 * 下方所有 ID 均模拟后续管理模块分配的内部身份。
 */
export const salesContext: AgentContext = {
  schemaVersion: 1,
  level1: {
    id: 'sales-root',
    level: 1,
    instructions: ['Serve customers using current company sales policies.'],
    currentTask: { id: 'sales-role', objective: 'Perform ongoing sales work.' },
    taskChain: {
      target: 2,
      revision: 1,
      phase: 'EXECUTING',
      currentTaskId: 'follow-up',
      tasks: [
        { id: 'follow-up', objective: 'Follow up with a new customer.', state: 'RUNNING' },
        { id: 'sales-report', objective: 'Update the sales report.', state: 'WAITING' },
      ],
    },
    memory: emptyMemory,
    budget,
  },
  level2: {
    id: 'customer-stage',
    level: 2,
    currentTask: {
      frameId: 'sales-root',
      planRevision: 1,
      taskId: 'follow-up',
    },
    taskChain: {
      target: 3,
      revision: 1,
      phase: 'EXECUTING',
      currentTaskId: 'read-customer',
      tasks: [
        { id: 'read-customer', objective: 'Read customer information.', state: 'RUNNING' },
        { id: 'prepare-reply', objective: 'Prepare the first reply.', state: 'WAITING' },
      ],
    },
    memory: emptyMemory,
    budget,
  },
  level3: {
    id: 'customer-reading',
    level: 3,
    currentTask: {
      frameId: 'customer-stage',
      planRevision: 1,
      taskId: 'read-customer',
    },
    taskChain: {
      target: 'local',
      revision: 1,
      phase: 'EXECUTING',
      currentTaskId: 'read-message',
      tasks: [
        {
          id: 'query-profile',
          objective: 'Query the customer profile.',
          state: 'COMPLETED',
          result: profileResult,
        },
        { id: 'read-message', objective: 'Read the latest message.', state: 'RUNNING' },
        { id: 'summarize', objective: 'Summarize customer information.', state: 'WAITING' },
      ],
    },
    memory: {
      ...emptyMemory,
      summary: profileResult,
      historyRef: 'history://sales/17',
    },
    budget,
  },
};

export const salesAgent: AgentControlBlock = {
  agentId: 1,
  character: 'sales',
  agentName: 'Sales Assistant',
  state: AgentState.READY,
  capacity: [],
  skills: ['crm.read', 'communication.read'],
  context: salesContext,
  createdAt: 1_789_862_400_000,
  modelConfigId: 'sales-default',
};
