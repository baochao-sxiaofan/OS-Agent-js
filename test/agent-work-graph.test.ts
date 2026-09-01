import { describe, expect, it, vi } from 'vitest';

import {
  AdmissionController,
  CapabilityManager,
  FakeModelProvider,
  InMemoryTaskStore,
  TaskControlBlock,
  TaskScheduler,
  ToolRegistry,
  createAgentWorkGraph,
  validateAgentWorkGraphProposal,
  type AgentWorkGraphProposal,
  type Tool,
} from '../src/index.js';

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.001,
};

const selfGraph: AgentWorkGraphProposal = {
  goal: 'Inspect and finish the assigned work.',
  completionCriteria: ['The workspace was inspected.'],
  nodes: [
    {
      alias: 'inspect_workspace',
      kind: 'inspect',
      objective: 'Inspect the workspace state.',
      dependsOn: [],
      assignee: { type: 'self' },
      acceptanceCriteria: ['The current state is recorded.'],
    },
  ],
};

function createGraphRuntime(taskIds: readonly string[] = []) {
  const provider = new FakeModelProvider();
  const tools = new ToolRegistry();
  const store = new InMemoryTaskStore();
  const ids = [...taskIds];
  const scheduler = new TaskScheduler({
    provider,
    tools,
    store,
    coordinationMode: 'ai_graph',
    asyncWorkPolicy: { batchWindowMs: 1 },
    admission: new AdmissionController({
      maxConcurrentRequests: 2,
      requestsPerMinute: 100,
      tokensPerMinute: 100_000,
    }),
    ...(taskIds.length === 0
      ? {}
      : {
          taskIdGenerator: () => {
            const id = ids.shift();
            if (!id) {
              throw new Error('Graph test task IDs exhausted.');
            }
            return id;
          },
        }),
  });
  return { provider, scheduler, store, tools };
}

describe('Agent work graph', () => {
  it('rejects dependency cycles before the graph reaches the scheduler', () => {
    expect(() =>
      validateAgentWorkGraphProposal({
        goal: 'Invalid cycle.',
        completionCriteria: ['Never reached.'],
        nodes: [
          {
            alias: 'first',
            kind: 'design',
            objective: 'First.',
            dependsOn: ['second'],
            assignee: { type: 'self' },
            acceptanceCriteria: ['First done.'],
          },
          {
            alias: 'second',
            kind: 'implement',
            objective: 'Second.',
            dependsOn: ['first'],
            assignee: { type: 'self' },
            acceptanceCriteria: ['Second done.'],
          },
        ],
      }),
    ).toThrow('contain a cycle');
  });

  it('persists graph state as part of the task snapshot', () => {
    const task = TaskControlBlock.createAgent(
      {
        id: 'graph-snapshot',
        goal: 'Persist a graph.',
      },
      { kind: 'root' },
      10,
    );
    task.replaceWorkGraph(selfGraph, 20);

    const snapshot = task.snapshot();
    const restored = TaskControlBlock.restore(snapshot);

    expect(restored.workGraph).toEqual(
      createAgentWorkGraph(selfGraph, 1, 20),
    );
    expect(restored.workGraphMode).toBe('waiting');
  });

  it('runs plan -> self node -> plan and preserves Agent-level tools', async () => {
    const { provider, scheduler, tools } = createGraphRuntime();
    const inspectTool: Tool = {
      name: 'inspect',
      description: 'Inspect one resource.',
      requiredCapability: 'resource.inspect',
      effect: 'read_only',
      validateInput: () => ({ valid: true }),
      execute: async () => ({ inspected: true }),
    };
    tools.register(inspectTool);
    const task = await scheduler.submit({
      id: 'self-graph',
      goal: 'Inspect the resource.',
      capabilities: ['resource.inspect'],
      maxModelAttempts: 8,
    });
    provider.setResponses(task.id, [
      {
        type: 'set_graph',
        graph: selfGraph,
        usage,
      },
      {
        type: 'tool_calls',
        calls: [
          {
            callId: 'inspect-1',
            toolName: 'inspect',
            input: {},
          },
        ],
        usage,
      },
      {
        type: 'complete_node',
        output: 'Workspace inspected.',
        usage,
      },
      {
        type: 'final',
        output: 'Done.',
        usage,
      },
    ]);

    await scheduler.runUntilIdle();

    expect(provider.requests.map((request) => request.graph?.mode)).toEqual([
      'plan',
      'execute',
      'execute',
      'plan',
    ]);
    expect(
      provider.requests[1]?.tools.map((tool) => tool.name),
    ).toContain('inspect');
    expect(task.workGraph?.nodes[0]).toMatchObject({
      alias: 'inspect_workspace',
      status: 'completed',
      result: 'Workspace inspected.',
    });
    expect(task.state).toMatchObject({
      status: 'TERMINATED',
      termination: { kind: 'completed', output: 'Done.' },
    });
  });

  it('marks any active graph node blocked while its tool work is pending', async () => {
    let resolveTool: ((value: { inspected: boolean }) => void) | undefined;
    const result = new Promise<{ inspected: boolean }>((resolve) => {
      resolveTool = resolve;
    });
    const { provider, scheduler, tools } = createGraphRuntime();
    tools.register({
      name: 'inspect',
      description: 'Inspect one resource.',
      requiredCapability: 'resource.inspect',
      effect: 'read_only',
      validateInput: () => ({ valid: true }),
      execute: async () => await result,
    });
    const task = await scheduler.submit({
      id: 'blocked-graph-node',
      goal: 'Inspect asynchronously.',
      capabilities: ['resource.inspect'],
      maxModelAttempts: 8,
    });
    provider.setResponses(task.id, [
      { type: 'set_graph', graph: selfGraph, usage },
      {
        type: 'tool_calls',
        calls: [
          {
            callId: 'pending-inspect',
            toolName: 'inspect',
            input: {},
          },
        ],
        usage,
      },
      {
        type: 'complete_node',
        output: 'Inspection complete.',
        usage,
      },
      { type: 'final', output: 'Done.', usage },
    ]);

    const run = scheduler.runUntilIdle();
    await vi.waitFor(() => {
      expect(task.state.status).toBe('BLOCKED');
      expect(task.workGraph?.nodes[0]).toMatchObject({
        status: 'blocked',
        blockedReason: 'async_work',
        waitingFor: ['pending-inspect'],
      });
    });
    resolveTool?.({ inspected: true });
    await run;

    expect(task.workGraph?.nodes[0]?.status).toBe('completed');
  });

  it('delegates a graph node to a child that plans its own graph', async () => {
    const { provider, scheduler } = createGraphRuntime(['developer-child']);
    const root = await scheduler.submit({
      id: 'graph-root',
      goal: 'Coordinate one implementation.',
      characterId: 'coordinator',
      maxModelAttempts: 8,
    });
    provider.setResponses(root.id, [
      {
        type: 'set_graph',
        graph: {
          goal: root.goal,
          completionCriteria: ['Implementation completed.'],
          nodes: [
            {
              alias: 'implementation',
              kind: 'implement',
              objective: 'Implement the bounded feature.',
              dependsOn: [],
              assignee: {
                type: 'character',
                character: 'developer',
                requestedCapabilities: [],
              },
              acceptanceCriteria: ['Feature result is returned.'],
            },
          ],
        },
        usage,
      },
      { type: 'final', output: 'Integrated.', usage },
    ]);
    provider.setResponses('developer-child', [
      {
        type: 'set_graph',
        graph: {
          goal: 'Implement the bounded feature.',
          completionCriteria: ['Feature implemented.'],
          nodes: [
            {
              alias: 'build_feature',
              kind: 'implement',
              objective: 'Build the feature.',
              dependsOn: [],
              assignee: { type: 'self' },
              acceptanceCriteria: ['Implementation is complete.'],
            },
          ],
        },
        usage,
      },
      {
        type: 'complete_node',
        output: 'Feature built.',
        usage,
      },
      {
        type: 'final',
        output: 'Child complete.',
        usage,
      },
    ]);

    await scheduler.runUntilIdle();

    const child = scheduler.getTask('developer-child');
    expect(child?.workGraph?.revision).toBe(1);
    expect(root.workGraph?.nodes[0]).toMatchObject({
      alias: 'implementation',
      status: 'completed',
      childTaskId: 'developer-child',
    });
    expect(provider.requests.map((request) => [
      request.taskId,
      request.graph?.mode,
    ])).toEqual([
      ['graph-root', 'plan'],
      ['developer-child', 'plan'],
      ['developer-child', 'execute'],
      ['developer-child', 'plan'],
      ['graph-root', 'plan'],
    ]);
    const finalRootRequest = provider.requests.findLast(
      (request) => request.taskId === 'graph-root',
    );
    expect(finalRootRequest?.graph?.current?.nodes[0]).not.toHaveProperty(
      'childTaskId',
    );
    expect(finalRootRequest?.graph?.current?.nodes[0]).not.toHaveProperty(
      'waitingFor',
    );
  });

  it('allows a developer to delegate to depth three and closes delegation there', async () => {
    const { provider, scheduler } = createGraphRuntime([
      'developer-middle',
      'developer-leaf',
    ]);
    const root = await scheduler.submit({
      id: 'recursive-specialists',
      goal: 'Coordinate recursive implementation.',
      characterId: 'coordinator',
      maxModelAttempts: 8,
    });
    provider.setResponses(root.id, [
      {
        type: 'set_graph',
        graph: {
          goal: root.goal,
          completionCriteria: ['The implementation is complete.'],
          nodes: [
            {
              alias: 'implementation',
              kind: 'implement',
              objective: 'Implement the feature.',
              dependsOn: [],
              assignee: {
                type: 'character',
                character: 'developer',
                requestedCapabilities: [],
              },
              acceptanceCriteria: ['Implementation is returned.'],
            },
          ],
        },
        usage,
      },
      { type: 'final', output: 'Integrated.', usage },
    ]);
    provider.setResponses('developer-middle', [
      {
        type: 'set_graph',
        graph: {
          goal: 'Implement the feature.',
          completionCriteria: ['The nested implementation is complete.'],
          nodes: [
            {
              alias: 'nested_implementation',
              kind: 'implement',
              objective: 'Implement an independent module.',
              dependsOn: [],
              assignee: {
                type: 'character',
                character: 'developer',
                requestedCapabilities: [],
              },
              acceptanceCriteria: ['The module is returned.'],
            },
          ],
        },
        usage,
      },
      { type: 'final', output: 'Implementation complete.', usage },
    ]);
    provider.setResponses('developer-leaf', [
      { type: 'set_graph', graph: selfGraph, usage },
      { type: 'complete_node', output: 'Module complete.', usage },
      { type: 'final', output: 'Leaf complete.', usage },
    ]);

    await scheduler.runUntilIdle();

    expect(scheduler.getTask('developer-middle')).toMatchObject({
      depth: 2,
      characterId: 'developer',
    });
    expect(scheduler.getTask('developer-leaf')).toMatchObject({
      depth: 3,
      characterId: 'developer',
    });
    const middlePlan = provider.requests.find(
      (request) =>
        request.taskId === 'developer-middle' &&
        request.graph?.mode === 'plan',
    );
    expect(middlePlan?.delegation.canSpawnSubagents).toBe(true);
    expect(
      middlePlan?.delegation.availableCharacters?.map(({ id }) => id),
    ).toEqual([
      'developer',
      'code_auditor',
      'researcher',
      'tester',
    ]);

    const leafPlan = provider.requests.find(
      (request) =>
        request.taskId === 'developer-leaf' &&
        request.graph?.mode === 'plan',
    );
    expect(leafPlan?.delegation).toEqual({
      canSpawnSubagents: false,
    });
    expect(root.state).toMatchObject({
      status: 'TERMINATED',
      termination: { kind: 'completed', output: 'Integrated.' },
    });
  });

  it('rejects final while a self node is unfinished', async () => {
    const { provider, scheduler } = createGraphRuntime();
    const task = await scheduler.submit({
      id: 'premature-final',
      goal: 'Do not finish early.',
      maxModelAttempts: 8,
    });
    provider.setResponses(task.id, [
      { type: 'set_graph', graph: selfGraph, usage },
      { type: 'final', output: 'Too early.', usage },
      {
        type: 'complete_node',
        output: 'Actually complete.',
        usage,
      },
      { type: 'final', output: 'Done.', usage },
    ]);

    await scheduler.runUntilIdle();

    expect(task.context).toContainEqual({
      type: 'graph_action_rejected',
      action: 'final',
      message: 'Action final is not allowed in graph execute mode.',
    });
    expect(task.state).toMatchObject({
      status: 'TERMINATED',
      termination: { kind: 'completed', output: 'Done.' },
    });
  });

  it('keeps graph mutation and execution actions in their OS-owned phases', async () => {
    const { provider, scheduler } = createGraphRuntime();
    const task = await scheduler.submit({
      id: 'graph-protocol-guard',
      goal: 'Follow graph phases.',
      maxModelAttempts: 8,
    });
    provider.setResponses(task.id, [
      {
        type: 'tool_calls',
        calls: [
          {
            callId: 'forbidden-plan-tool',
            toolName: 'missing',
            input: {},
          },
        ],
        usage,
      },
      { type: 'set_graph', graph: selfGraph, usage },
      {
        type: 'complete_node',
        output: 'Node complete.',
        usage,
      },
      { type: 'final', output: 'Done.', usage },
    ]);

    await scheduler.runUntilIdle();

    expect(task.context).toContainEqual({
      type: 'graph_action_rejected',
      action: 'tool_calls',
      message: 'Action tool_calls is not allowed in graph plan mode.',
    });
    expect(task.state.status).toBe('TERMINATED');
  });

  it('returns to plan for graph replacement and preserves the old revision', async () => {
    const { provider, scheduler } = createGraphRuntime();
    const task = await scheduler.submit({
      id: 'graph-replan',
      goal: 'Revise the plan after discovery.',
      maxModelAttempts: 8,
    });
    provider.setResponses(task.id, [
      { type: 'set_graph', graph: selfGraph, usage },
      {
        type: 'request_replan',
        reason: 'The workspace requires implementation instead.',
        partialOutput: { discovered: true },
        usage,
      },
      {
        type: 'set_graph',
        graph: {
          goal: 'Implement after inspection.',
          completionCriteria: ['Implementation completed.'],
          nodes: [
            {
              alias: 'implement_change',
              kind: 'implement',
              objective: 'Implement the discovered change.',
              dependsOn: [],
              assignee: { type: 'self' },
              acceptanceCriteria: ['The change exists.'],
            },
          ],
        },
        usage,
      },
      {
        type: 'complete_node',
        output: 'Implemented.',
        usage,
      },
      { type: 'final', output: 'Done.', usage },
    ]);

    await scheduler.runUntilIdle();

    expect(task.workGraph?.revision).toBe(2);
    expect(task.context).toContainEqual(
      expect.objectContaining({
        type: 'work_graph_revision',
        revision: 1,
        nodes: [
          expect.objectContaining({
            alias: 'inspect_workspace',
            status: 'failed',
            result: { discovered: true },
          }),
        ],
      }),
    );
  });

  it('surfaces a delegated child capability request to the parent and resumes the child', async () => {
    const capabilityManager = new CapabilityManager({
      requestIdGenerator: () => 'graph-capability-1',
    });
    const provider = new FakeModelProvider();
    const ids = ['graph-developer-child'];
    const scheduler = new TaskScheduler({
      provider,
      tools: new ToolRegistry(),
      store: new InMemoryTaskStore(),
      coordinationMode: 'ai_graph',
      capabilityManager,
      asyncWorkPolicy: { batchWindowMs: 1 },
      admission: new AdmissionController({
        maxConcurrentRequests: 1,
        requestsPerMinute: 100,
        tokensPerMinute: 100_000,
      }),
      taskIdGenerator: () => {
        const id = ids.shift();
        if (!id) {
          throw new Error('Graph test task IDs exhausted.');
        }
        return id;
      },
    });
    const root = await scheduler.submit({
      id: 'graph-capability-root',
      goal: 'Coordinate a scoped implementation.',
      characterId: 'coordinator',
      maxModelAttempts: 12,
      capabilities: [
        {
          capability: 'file.write',
          scope: { kind: 'subtree', resource: 'file:///repo/src' },
        },
      ],
    });
    provider.setResponses(root.id, [
      {
        type: 'set_graph',
        graph: {
          goal: root.goal,
          completionCriteria: ['Implementation completed.'],
          nodes: [
            {
              alias: 'implementation',
              kind: 'implement',
              objective: 'Implement the bounded feature.',
              dependsOn: [],
              assignee: {
                type: 'character',
                character: 'developer',
                requestedCapabilities: [],
              },
              acceptanceCriteria: ['Feature result is returned.'],
            },
          ],
        },
        usage,
      },
      {
        type: 'resolve_capability_request',
        requestRef: 'graph-capability-1',
        decision: 'approve',
        usage,
      },
      { type: 'final', output: 'Integrated.', usage },
    ]);
    provider.setResponses('graph-developer-child', [
      {
        type: 'set_graph',
        graph: {
          goal: 'Implement the bounded feature.',
          completionCriteria: ['Feature implemented.'],
          nodes: [
            {
              alias: 'build_feature',
              kind: 'implement',
              objective: 'Build the feature.',
              dependsOn: [],
              assignee: { type: 'self' },
              acceptanceCriteria: ['Implementation is complete.'],
            },
          ],
        },
        usage,
      },
      {
        type: 'request_capabilities',
        requests: [
          {
            capability: 'file.write',
            scope: {
              kind: 'exact',
              resource: 'file:///repo/src/auth/token.ts',
            },
          },
        ],
        usage,
      },
      { type: 'complete_node', output: 'Feature built.', usage },
      { type: 'final', output: 'Child complete.', usage },
    ]);

    await scheduler.runUntilIdle();

    const child = scheduler.getTask('graph-developer-child');
    expect(child?.capabilityGrants).toContainEqual(
      expect.objectContaining({
        capability: 'file.write',
        scope: {
          kind: 'exact',
          resource: 'file:///repo/src/auth/token.ts',
        },
        source: expect.objectContaining({
          type: 'parent',
          issuerTaskId: root.id,
        }),
      }),
    );
    expect(child?.state).toMatchObject({
      status: 'TERMINATED',
      termination: { kind: 'completed', output: 'Child complete.' },
    });
    expect(root.context).toContainEqual(
      expect.objectContaining({
        type: 'async_work_update',
        pending: expect.arrayContaining([
          expect.objectContaining({
            status: 'waiting_for_capability',
            blocker: expect.objectContaining({
              requestRef: 'graph-capability-1',
            }),
          }),
        ]),
      }),
    );
    expect(root.state).toMatchObject({
      status: 'TERMINATED',
      termination: { kind: 'completed', output: 'Integrated.' },
    });
  });
});
