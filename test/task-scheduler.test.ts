import { describe, expect, it, vi } from 'vitest';

import {
  AdmissionController,
  AgentPool,
  FakeContextCompactor,
  FakeModelProvider,
  InMemoryTaskStore,
  ReadyQueue,
  TaskControlBlock,
  TaskScheduler,
  ToolRegistry,
  type Clock,
  type JsonValue,
  type ModelRequest,
  type TaskStore,
  type Tool,
} from '../src/index.js';

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.001,
};

class ManualClock implements Clock {
  constructor(private timestamp = 0) {}

  now(): number {
    return this.timestamp;
  }

  advance(milliseconds: number): void {
    this.timestamp += milliseconds;
  }
}

function createRuntime(options?: {
  agentPool?: AgentPool;
  clock?: Clock;
  maxConcurrentRequests?: number;
  readyQueue?: ReadyQueue;
  requestsPerMinute?: number;
}) {
  const provider = new FakeModelProvider();
  const tools = new ToolRegistry();
  const store = new InMemoryTaskStore();
  const admission = new AdmissionController(
    {
      maxConcurrentRequests: options?.maxConcurrentRequests ?? 2,
      requestsPerMinute: options?.requestsPerMinute ?? 20,
      tokensPerMinute: 20_000,
    },
    options?.clock,
  );
  const scheduler = new TaskScheduler({
    provider,
    tools,
    store,
    admission,
    ...(options?.agentPool === undefined
      ? {}
      : { agentPool: options.agentPool }),
    ...(options?.readyQueue === undefined
      ? {}
      : { readyQueue: options.readyQueue }),
  });
  return { admission, provider, scheduler, store, tools };
}

describe('TaskScheduler', () => {
  it('runs READY -> RUNNING -> BLOCKED -> READY -> TERMINATED', async () => {
    let resolveTool: ((value: JsonValue) => void) | undefined;
    const toolResult = new Promise<JsonValue>((resolve) => {
      resolveTool = resolve;
    });
    const inspectTool: Tool = {
      name: 'inspect',
      description: 'Inspect a resource.',
      requiredCapability: 'resource:inspect',
      effect: 'read_only',
      validateInput: () => ({ valid: true }),
      execute: async () => await toolResult,
    };
    const { provider, scheduler, tools } = createRuntime();
    tools.register(inspectTool);
    const task = await scheduler.submit({
      id: 'tool-task',
      goal: 'Inspect the resource.',
      capabilities: ['resource:inspect'],
    });
    provider.setResponses(task.id, [
      {
        type: 'tool_calls',
        calls: [
          {
            callId: 'call-1',
            toolName: 'inspect',
            input: { resource: 'worker-1' },
          },
        ],
        usage,
      },
      {
        type: 'final',
        output: 'worker-1 is healthy',
        usage,
      },
    ]);

    const run = scheduler.runUntilIdle();
    await vi.waitFor(() => {
      expect(task.state.status).toBe('BLOCKED');
    });
    resolveTool?.({ healthy: true });
    await run;

    expect(task.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'completed',
        output: 'worker-1 is healthy',
      },
    });
    expect(
      task.events
        .filter((event) => event.type === 'state_transitioned')
        .map((event) => `${event.from}->${event.to.status}`),
    ).toEqual([
      'READY->RUNNING',
      'RUNNING->BLOCKED',
      'BLOCKED->READY',
      'READY->RUNNING',
      'RUNNING->TERMINATED',
    ]);
  });

  it('dispatches higher-priority ready tasks first', async () => {
    const { provider, scheduler } = createRuntime({
      maxConcurrentRequests: 1,
    });
    const lowPriority = await scheduler.submit({
      id: 'low',
      goal: 'Low priority task.',
      priority: 1,
    });
    const highPriority = await scheduler.submit({
      id: 'high',
      goal: 'High priority task.',
      priority: 10,
    });
    provider.setResponses(lowPriority.id, [
      { type: 'final', output: 'low done', usage },
    ]);
    provider.setResponses(highPriority.id, [
      { type: 'final', output: 'high done', usage },
    ]);

    await scheduler.runUntilIdle();

    expect(provider.requests.map((request) => request.taskId)).toEqual([
      'high',
      'low',
    ]);
  });

  it('keeps a task READY when request-rate capacity is exhausted', async () => {
    const clock = new ManualClock();
    const { provider, scheduler } = createRuntime({
      clock,
      requestsPerMinute: 1,
    });
    const first = await scheduler.submit({
      id: 'first',
      goal: 'First task.',
      priority: 2,
    });
    const second = await scheduler.submit({
      id: 'second',
      goal: 'Second task.',
      priority: 1,
    });
    provider.setResponses(first.id, [
      { type: 'final', output: 'first done', usage },
    ]);
    provider.setResponses(second.id, [
      { type: 'final', output: 'second done', usage },
    ]);

    const firstRun = await scheduler.runUntilIdle();

    expect(first.state.status).toBe('TERMINATED');
    expect(second.state.status).toBe('READY');
    expect(firstRun).toMatchObject({
      pendingReadyTasks: 1,
      stalled: true,
    });
    expect(
      second.events.some(
        (event) =>
          event.type === 'capacity_wait_recorded' &&
          event.reasons.includes('request_rate_exhausted'),
      ),
    ).toBe(true);

    clock.advance(60_000);
    await scheduler.runUntilIdle();

    expect(second.state.status).toBe('TERMINATED');
  });

  it('fails a task when the model requests a tool without capability', async () => {
    const privilegedTool: Tool = {
      name: 'write_file',
      description: 'Write a file.',
      requiredCapability: 'filesystem:write',
      effect: 'privileged',
      validateInput: () => ({ valid: true }),
      execute: async () => 'written',
    };
    const { provider, scheduler, tools } = createRuntime();
    tools.register(privilegedTool);
    const task = await scheduler.submit({
      id: 'unauthorized',
      goal: 'Attempt a privileged operation.',
    });
    provider.setResponses(task.id, [
      {
        type: 'tool_calls',
        calls: [
          {
            callId: 'write-1',
            toolName: 'write_file',
            input: { path: 'forbidden.txt' },
          },
        ],
        usage,
      },
    ]);

    await scheduler.runUntilIdle();

    expect(task.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'failed',
      },
    });
    if (task.state.status === 'TERMINATED') {
      expect(task.state.termination).toMatchObject({
        kind: 'failed',
        error: expect.stringContaining('lacks capability'),
      });
    }
  });

  it('terminates before calling the model when task budget is insufficient', async () => {
    const { provider, scheduler } = createRuntime();
    const task = await scheduler.submit({
      id: 'budget',
      goal: 'An unaffordable task.',
      budget: {
        maxCostUsd: 0.0001,
      },
    });

    const result = await scheduler.runUntilIdle();

    expect(provider.requests).toHaveLength(0);
    expect(result.stalled).toBe(false);
    expect(task.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'failed',
        error: expect.stringContaining('budget_exceeded'),
      },
    });
  });

  it('fails instead of waiting forever when one request exceeds TPM', async () => {
    const provider = new FakeModelProvider({
      estimate: {
        inputTokens: 15_000,
        maxOutputTokens: 10_000,
        estimatedCostUsd: 0.01,
      },
    });
    const scheduler = new TaskScheduler({
      provider,
      tools: new ToolRegistry(),
      store: new InMemoryTaskStore(),
      admission: new AdmissionController({
        maxConcurrentRequests: 1,
        requestsPerMinute: 10,
        tokensPerMinute: 20_000,
      }),
    });
    const task = await scheduler.submit({
      id: 'oversized',
      goal: 'A request that cannot fit in the configured token window.',
    });

    await scheduler.runUntilIdle();

    expect(provider.requests).toHaveLength(0);
    expect(task.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'failed',
        error: expect.stringContaining('request_token_limit_exceeded'),
      },
    });
  });

  it('serializes side-effecting tool calls from one model turn', async () => {
    let activeExecutions = 0;
    let maxActiveExecutions = 0;
    const mutationOrder: string[] = [];
    const mutationTool: Tool = {
      name: 'mutate',
      description: 'Apply a deterministic mutation.',
      requiredCapability: 'resource:mutate',
      effect: 'side_effect',
      validateInput: () => ({ valid: true }),
      execute: async (input) => {
        activeExecutions += 1;
        maxActiveExecutions = Math.max(
          maxActiveExecutions,
          activeExecutions,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        mutationOrder.push(String(input['step']));
        activeExecutions -= 1;
        return { applied: input['step'] ?? null };
      },
    };
    const { provider, scheduler, tools } = createRuntime();
    tools.register(mutationTool);
    const task = await scheduler.submit({
      id: 'mutations',
      goal: 'Apply mutations in order.',
      capabilities: ['resource:mutate'],
    });
    provider.setResponses(task.id, [
      {
        type: 'tool_calls',
        calls: [
          {
            callId: 'mutation-1',
            toolName: 'mutate',
            input: { step: 'first' },
          },
          {
            callId: 'mutation-2',
            toolName: 'mutate',
            input: { step: 'second' },
          },
        ],
        usage,
      },
      {
        type: 'final',
        output: 'mutations complete',
        usage,
      },
    ]);

    await scheduler.runUntilIdle();

    expect(maxActiveExecutions).toBe(1);
    expect(mutationOrder).toEqual(['first', 'second']);
  });

  it('runs a three-level delegation tree and wakes parents with results', async () => {
    const agentPool = new AgentPool({
      maxDepth: 3,
      maxLiveAgents: 3,
      maxSpawnedPerRoot: 2,
    });
    const { provider, scheduler } = createRuntime({
      agentPool,
      maxConcurrentRequests: 1,
    });
    const root = await scheduler.submit({
      id: 'root',
      goal: 'Coordinate the full task.',
    });
    provider.setResponses('root', [
      {
        type: 'spawn_subagents',
        children: [{ taskId: 'middle', goal: 'Coordinate the branch.' }],
        usage,
      },
      { type: 'final', output: 'root complete', usage },
    ]);
    provider.setResponses('middle', [
      {
        type: 'spawn_subagents',
        children: [{ taskId: 'leaf', goal: 'Complete concrete work.' }],
        usage,
      },
      { type: 'final', output: 'middle complete', usage },
    ]);
    provider.setResponses('leaf', [
      { type: 'final', output: 'leaf complete', usage },
    ]);

    await scheduler.runUntilIdle();

    const middle = scheduler.getTask('middle');
    const leaf = scheduler.getTask('leaf');
    expect(middle).toMatchObject({
      rootTaskId: 'root',
      parentTaskId: 'root',
      depth: 2,
    });
    expect(leaf).toMatchObject({
      rootTaskId: 'root',
      parentTaskId: 'middle',
      depth: 3,
    });
    expect(provider.requests.map((request) => request.taskId)).toEqual([
      'root',
      'middle',
      'leaf',
      'middle',
      'root',
    ]);
    expect(
      root.context.some(
        (item) =>
          item.type === 'async_work_update' &&
          item.results.some(
            (result) =>
              result.kind === 'subagent' &&
              result.workId === 'middle',
          ),
      ),
    ).toBe(true);
    expect(root.state.status).toBe('TERMINATED');
    expect(scheduler.liveAgentCount).toBe(0);
  });

  it('rejects depth-four delegation and lets the leaf report upward', async () => {
    const agentPool = new AgentPool({
      maxDepth: 3,
      maxLiveAgents: 4,
      maxSpawnedPerRoot: 10,
    });
    const { provider, scheduler } = createRuntime({
      agentPool,
      maxConcurrentRequests: 1,
    });
    const root = await scheduler.submit({
      id: 'root-depth',
      goal: 'Coordinate.',
    });
    provider.setResponses('root-depth', [
      {
        type: 'spawn_subagents',
        children: [{ taskId: 'middle-depth', goal: 'Coordinate.' }],
        usage,
      },
      { type: 'final', output: 'root handled fallback', usage },
    ]);
    provider.setResponses('middle-depth', [
      {
        type: 'spawn_subagents',
        children: [{ taskId: 'leaf-depth', goal: 'Do work.' }],
        usage,
      },
      { type: 'final', output: 'middle handled fallback', usage },
    ]);
    provider.setResponses('leaf-depth', [
      {
        type: 'spawn_subagents',
        children: [{ taskId: 'forbidden-depth', goal: 'Too deep.' }],
        usage,
      },
      {
        type: 'needs_parent_action',
        requiredWork: 'Prepare the missing input locally.',
        partialOutput: { inspected: true },
        usage,
      },
    ]);

    await scheduler.runUntilIdle();

    const leaf = scheduler.getTask('leaf-depth');
    expect(scheduler.getTask('forbidden-depth')).toBeUndefined();
    expect(
      leaf?.context.some(
        (item) =>
          item.type === 'subagent_spawn_rejected' &&
          item.reason === 'max_depth_exceeded',
      ),
    ).toBe(true);
    expect(
      root.context.some(
        (item) =>
          item.type === 'async_work_update' &&
          item.results.some(
            (result) =>
              result.kind === 'subagent' &&
              result.termination?.kind === 'completed',
          ),
      ),
    ).toBe(true);
    expect(root.state.status).toBe('TERMINATED');
  });

  it('keeps a parent runnable when the live-agent pool is full', async () => {
    const agentPool = new AgentPool({
      maxDepth: 3,
      maxLiveAgents: 1,
      maxSpawnedPerRoot: 10,
    });
    const { provider, scheduler } = createRuntime({
      agentPool,
      maxConcurrentRequests: 1,
    });
    const root = await scheduler.submit({
      id: 'pool-root',
      goal: 'Attempt delegation, then complete locally.',
    });
    provider.setResponses(root.id, [
      {
        type: 'spawn_subagents',
        children: [{ taskId: 'no-slot', goal: 'Cannot be created.' }],
        usage,
      },
      { type: 'final', output: 'completed without delegation', usage },
    ]);

    await scheduler.runUntilIdle();

    expect(scheduler.getTask('no-slot')).toBeUndefined();
    expect(
      root.events
        .filter((event) => event.type === 'state_transitioned')
        .map((event) => `${event.from}->${event.to.status}`),
    ).toEqual([
      'READY->RUNNING',
      'RUNNING->READY',
      'READY->RUNNING',
      'RUNNING->TERMINATED',
    ]);
    expect(
      root.context.some(
        (item) =>
          item.type === 'subagent_spawn_rejected' &&
          item.reason === 'live_pool_exhausted',
      ),
    ).toBe(true);
  });

  it('serializes concurrent spawn attempts for one parent', async () => {
    const backingStore = new InMemoryTaskStore();
    let releaseChildPersistence: (() => void) | undefined;
    const childPersistenceGate = new Promise<void>((resolve) => {
      releaseChildPersistence = resolve;
    });
    const store: TaskStore = {
      persist: async (task) => {
        if (task.parentTaskId !== undefined) {
          await childPersistenceGate;
        }
        await backingStore.persist(task);
      },
      load: async (taskId) => await backingStore.load(taskId),
      events: async (taskId) => await backingStore.events(taskId),
    };
    const scheduler = new TaskScheduler({
      provider: new FakeModelProvider(),
      tools: new ToolRegistry(),
      store,
      admission: new AdmissionController({
        maxConcurrentRequests: 1,
        requestsPerMinute: 10,
        tokensPerMinute: 10_000,
      }),
      agentPool: new AgentPool({
        maxDepth: 3,
        maxLiveAgents: 3,
        maxSpawnedPerRoot: 2,
      }),
    });
    const root = await scheduler.submit({
      id: 'concurrent-root',
      goal: 'Coordinate.',
    });
    root.transition(
      {
        status: 'RUNNING',
        enteredAt: Date.now(),
        providerId: 'fake-model',
        requestAttempt: 1,
      },
      'test_model_request',
    );

    const firstSpawn = scheduler.spawnChildren(root.id, [
      { id: 'first-child', goal: 'First branch.' },
    ]);
    await vi.waitFor(() => {
      expect(scheduler.liveAgentCount).toBe(2);
    });
    const secondSpawn = await scheduler.spawnChildren(root.id, [
      { id: 'second-child', goal: 'Second branch.' },
    ]);

    expect(secondSpawn).toMatchObject({
      spawned: false,
      reason: 'spawn_in_progress',
    });
    releaseChildPersistence?.();
    expect(await firstSpawn).toMatchObject({ spawned: true });
    expect(scheduler.getTask('second-child')).toBeUndefined();
  });

  it('stores piggyback summaries separately and sends a hybrid context', async () => {
    const provider = new FakeModelProvider({
      contextWindowTokens: 100,
      estimate: (request: ModelRequest) => ({
        inputTokens: request.context.reduce((total, item) => {
          switch (item.type) {
            case 'user':
              return total + item.content.length;
            case 'tool_call':
              return total + 10;
            case 'tool_result':
              return total + 35;
            case 'async_work_update':
              return total + 35;
            case 'context_summary':
              return total + 5;
            default:
              return total + 5;
          }
        }, 0),
        maxOutputTokens: 10,
        estimatedCostUsd: 0.001,
      }),
    });
    const inspectTool: Tool = {
      name: 'inspect_context',
      description: 'Return a large context item.',
      requiredCapability: 'context:inspect',
      effect: 'read_only',
      validateInput: () => ({ valid: true }),
      execute: async () => ({ content: 'x'.repeat(100) }),
    };
    const tools = new ToolRegistry();
    tools.register(inspectTool);
    const scheduler = new TaskScheduler({
      provider,
      tools,
      store: new InMemoryTaskStore(),
      admission: new AdmissionController({
        maxConcurrentRequests: 1,
        requestsPerMinute: 10,
        tokensPerMinute: 10_000,
      }),
    });
    const task = await scheduler.submit({
      id: 'hybrid-context',
      goal: 'Inspect and report.',
      capabilities: ['context:inspect'],
      context: [{ type: 'user', content: 'u'.repeat(40) }],
    });
    provider.setResponses(task.id, [
      {
        type: 'tool_calls',
        calls: [
          {
            callId: 'inspect-context-1',
            toolName: 'inspect_context',
            input: {},
          },
        ],
        turnSummary: {
          request: 'Inspect the context source.',
          outcome: 'Requested the context inspection tool.',
        },
        usage,
      },
      {
        type: 'final',
        output: 'inspection complete',
        turnSummary: {
          request: 'Report the inspection result.',
          outcome: 'Returned the final inspection report.',
        },
        usage,
      },
    ]);

    await scheduler.runUntilIdle();

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.summaryProtocol).toMatchObject({
      responseField: 'turnSummary',
      requiredFields: ['request', 'outcome'],
    });
    expect(provider.requests[1]?.context.map((item) => item.type)).toEqual([
      'context_summary',
      'tool_call',
      'async_work_update',
    ]);
    expect(task.context.map((item) => item.type)).toEqual([
      'user',
      'tool_call',
      'async_work_update',
    ]);
    expect(task.contextSummaries).toHaveLength(2);
    expect(task.contextSummaries[0]).toMatchObject({
      kind: 'turn',
      sourceStartIndex: 0,
      sourceEndIndex: 1,
    });
  });

  it('runs secondary compaction before queueing an oversized request', async () => {
    const provider = new FakeModelProvider({
      contextWindowTokens: 100,
      estimate: (request: ModelRequest) => ({
        inputTokens: request.context.reduce(
          (total, item) =>
            total + (item.type === 'context_summary' ? 5 : 30),
          0,
        ),
        maxOutputTokens: 10,
        estimatedCostUsd: 0.001,
      }),
    });
    const compactor = new FakeContextCompactor({
      contextWindowTokens: 200,
      estimate: {
        inputTokens: 50,
        maxOutputTokens: 10,
        estimatedCostUsd: 0.002,
      },
    });
    const scheduler = new TaskScheduler({
      provider,
      contextCompactor: compactor,
      tools: new ToolRegistry(),
      store: new InMemoryTaskStore(),
      admission: new AdmissionController({
        maxConcurrentRequests: 1,
        requestsPerMinute: 10,
        tokensPerMinute: 10_000,
      }),
    });
    const task = await scheduler.submit({
      id: 'secondary-compaction',
      goal: 'Process a large history.',
      context: [
        { type: 'user', content: 'first large turn' },
        { type: 'assistant', content: 'second large turn' },
        { type: 'user', content: 'third large turn' },
      ],
    });
    compactor.setResults(task.id, [
      {
        summary: {
          request: 'Process the accumulated history.',
          outcome: 'The earlier history was compressed.',
        },
        usage: {
          inputTokens: 50,
          outputTokens: 8,
          costUsd: 0.002,
        },
      },
    ]);
    provider.setResponses(task.id, [
      {
        type: 'final',
        output: 'done',
        usage,
      },
    ]);

    expect(scheduler.readyQueueSize).toBe(0);
    expect(provider.requests).toHaveLength(0);

    await scheduler.runUntilIdle();

    expect(compactor.requests).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.context).toEqual([
      {
        type: 'context_summary',
        request: 'Process the accumulated history.',
        outcome: 'The earlier history was compressed.',
      },
    ]);
    expect(task.context).toHaveLength(3);
    expect(task.contextSummaries).toContainEqual(
      expect.objectContaining({
        kind: 'secondary',
        sourceStartIndex: 0,
        sourceEndIndex: 3,
      }),
    );
    expect(task.budget.spentCostUsd).toBeCloseTo(0.003);
  });

  it('fails before queueing when oversized context cannot be compacted', async () => {
    const provider = new FakeModelProvider({
      contextWindowTokens: 100,
      estimate: {
        inputTokens: 90,
        maxOutputTokens: 10,
        estimatedCostUsd: 0.001,
      },
    });
    const scheduler = new TaskScheduler({
      provider,
      tools: new ToolRegistry(),
      store: new InMemoryTaskStore(),
      admission: new AdmissionController({
        maxConcurrentRequests: 1,
        requestsPerMinute: 10,
        tokensPerMinute: 10_000,
      }),
    });

    const task = await scheduler.submit({
      id: 'missing-compactor',
      goal: 'This request must not reach the model.',
      context: [{ type: 'user', content: 'oversized context' }],
    });

    expect(scheduler.readyQueueSize).toBe(0);
    expect(provider.requests).toHaveLength(0);
    expect(task.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'failed',
        error: expect.stringContaining('no context compactor'),
      },
    });
  });

  it('wakes a parent when a child fails context preflight', async () => {
    const provider = new FakeModelProvider({
      contextWindowTokens: 100,
      estimate: (request: ModelRequest) => ({
        inputTokens: request.taskId === 'oversized-child' ? 90 : 10,
        maxOutputTokens: 10,
        estimatedCostUsd: 0.001,
      }),
    });
    const scheduler = new TaskScheduler({
      provider,
      tools: new ToolRegistry(),
      store: new InMemoryTaskStore(),
      admission: new AdmissionController({
        maxConcurrentRequests: 1,
        requestsPerMinute: 10,
        tokensPerMinute: 10_000,
      }),
    });
    const root = await scheduler.submit({
      id: 'context-parent',
      goal: 'Delegate and handle a child preflight failure.',
    });
    provider.setResponses(root.id, [
      {
        type: 'spawn_subagents',
        children: [
          {
            taskId: 'oversized-child',
            goal: 'Cannot fit.',
            context: [{ type: 'user', content: 'oversized child context' }],
          },
        ],
        usage,
      },
      {
        type: 'final',
        output: 'parent handled the failure',
        usage,
      },
    ]);

    await scheduler.runUntilIdle();

    expect(scheduler.getTask('oversized-child')?.state).toMatchObject({
      status: 'TERMINATED',
      termination: { kind: 'failed' },
    });
    expect(
      root.context.some(
        (item) =>
          item.type === 'async_work_update' &&
          item.results.some(
            (result) =>
              result.workId === 'oversized-child' &&
              result.termination?.kind === 'failed',
          ),
      ),
    ).toBe(true);
    expect(root.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'completed',
        output: 'parent handled the failure',
      },
    });
  });

  it('fails deterministically when secondary compaction is still too large', async () => {
    const provider = new FakeModelProvider({
      contextWindowTokens: 100,
      estimate: {
        inputTokens: 90,
        maxOutputTokens: 10,
        estimatedCostUsd: 0.001,
      },
    });
    const compactor = new FakeContextCompactor({
      estimate: {
        inputTokens: 50,
        maxOutputTokens: 10,
        estimatedCostUsd: 0.002,
      },
    });
    const scheduler = new TaskScheduler({
      provider,
      contextCompactor: compactor,
      tools: new ToolRegistry(),
      store: new InMemoryTaskStore(),
      admission: new AdmissionController({
        maxConcurrentRequests: 1,
        requestsPerMinute: 10,
        tokensPerMinute: 10_000,
      }),
    });
    const task = await scheduler.submit({
      id: 'ineffective-compaction',
      goal: 'Fail without an infinite compaction loop.',
      context: [{ type: 'user', content: 'large context' }],
    });
    compactor.setResults(task.id, [
      {
        summary: {
          request: 'Compress the large context.',
          outcome: 'The result remained too large.',
        },
        usage: {
          inputTokens: 50,
          outputTokens: 10,
          costUsd: 0.002,
        },
      },
    ]);

    const result = await scheduler.runUntilIdle();

    expect(compactor.requests).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    expect(result.stalled).toBe(false);
    expect(task.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'failed',
        error: expect.stringContaining(
          'remains above the target after secondary compaction',
        ),
      },
    });
  });

  it('resolves waitForTermination with the task termination result', async () => {
    const { provider, scheduler } = createRuntime();
    const task = await scheduler.submit({
      id: 'await-complete',
      goal: 'Complete and notify the waiter.',
    });
    provider.setResponses(task.id, [
      { type: 'final', output: 'done', usage },
    ]);

    const completion = scheduler.waitForTermination(task.id);
    await scheduler.runUntilIdle();
    const termination = await completion;

    expect(termination).toMatchObject({
      kind: 'completed',
      output: 'done',
    });
  });

  it('resolves waitForTermination immediately for an already-terminated task', async () => {
    const { provider, scheduler } = createRuntime();
    const task = await scheduler.submit({
      id: 'await-late',
      goal: 'Complete before anyone waits.',
    });
    provider.setResponses(task.id, [
      { type: 'final', output: 'already done', usage },
    ]);

    await scheduler.runUntilIdle();
    const termination = await scheduler.waitForTermination(task.id);

    expect(termination).toMatchObject({
      kind: 'completed',
      output: 'already done',
    });
  });

  it('auto-wakes a rate-limited task after the retry window without external driving', async () => {
    const clock = new ManualClock();
    const provider = new FakeModelProvider();
    const admission = new AdmissionController(
      {
        maxConcurrentRequests: 1,
        requestsPerMinute: 1,
        tokensPerMinute: 20_000,
      },
      clock,
    );
    // 注入受控 wait：不真正休眠，只把时钟推进到重试窗口之后，保持测试确定性。
    const waits: number[] = [];
    const scheduler = new TaskScheduler({
      provider,
      tools: new ToolRegistry(),
      store: new InMemoryTaskStore(),
      admission,
      clock,
      wait: async (ms) => {
        waits.push(ms);
        clock.advance(ms);
      },
    });
    const first = await scheduler.submit({
      id: 'rate-first',
      goal: 'First task.',
      priority: 2,
    });
    const second = await scheduler.submit({
      id: 'rate-second',
      goal: 'Second task.',
      priority: 1,
    });
    provider.setResponses(first.id, [
      { type: 'final', output: 'first done', usage },
    ]);
    provider.setResponses(second.id, [
      { type: 'final', output: 'second done', usage },
    ]);

    const result = await scheduler.run();

    expect(first.state.status).toBe('TERMINATED');
    expect(second.state.status).toBe('TERMINATED');
    expect(result.stalled).toBe(false);
    expect(waits.length).toBeGreaterThan(0);
  });

  it('batches partial mixed work and reports remaining work to the parent', async () => {
    let resolveSlowTool: ((value: JsonValue) => void) | undefined;
    const slowToolResult = new Promise<JsonValue>((resolve) => {
      resolveSlowTool = resolve;
    });
    let releaseBatchWindow: (() => void) | undefined;
    const batchWindow = new Promise<void>((resolve) => {
      releaseBatchWindow = resolve;
    });
    const provider = new FakeModelProvider();
    const tools = new ToolRegistry();
    tools.register({
      name: 'quick_read',
      description: 'Return immediately.',
      requiredCapability: 'resource:read',
      effect: 'read_only',
      validateInput: () => ({ valid: true }),
      execute: async () => 'quick result',
    });
    tools.register({
      name: 'slow_read',
      description: 'Return after an external signal.',
      requiredCapability: 'resource:read',
      effect: 'read_only',
      validateInput: () => ({ valid: true }),
      execute: async () => await slowToolResult,
    });
    const scheduler = new TaskScheduler({
      provider,
      tools,
      store: new InMemoryTaskStore(),
      admission: new AdmissionController({
        maxConcurrentRequests: 5,
        requestsPerMinute: 50,
        tokensPerMinute: 50_000,
      }),
      asyncWorkPolicy: { batchWindowMs: 30_000 },
      wait: async (_ms, signal) => {
        await Promise.race([
          batchWindow,
          new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          }),
        ]);
      },
    });
    const root = await scheduler.submit({
      id: 'mixed-root',
      goal: 'Coordinate mixed asynchronous work.',
      capabilities: ['resource:read'],
      maxModelAttempts: 3,
    });
    provider.setResponses(root.id, [
      {
        type: 'async_work',
        children: [
          { taskId: 'mixed-a', goal: 'Complete branch A.' },
          { taskId: 'mixed-b', goal: 'Complete branch B.' },
        ],
        calls: [
          {
            callId: 'mixed-j1',
            toolName: 'quick_read',
            input: {},
          },
          {
            callId: 'mixed-j2',
            toolName: 'slow_read',
            input: {},
          },
        ],
        usage,
      },
      {
        type: 'wait_for_async_work',
        usage,
      },
      {
        type: 'final',
        output: 'mixed work complete',
        usage,
      },
    ]);
    provider.setResponses('mixed-a', [
      { type: 'final', output: 'A done', usage },
    ]);
    provider.setResponses('mixed-b', [
      { type: 'final', output: 'B done', usage },
    ]);

    const run = scheduler.runUntilIdle();
    await vi.waitFor(() => {
      const generation = root.activeAsyncWorkGeneration;
      expect(
        generation?.work.filter((work) => work.status !== 'running'),
      ).toHaveLength(3);
    });
    releaseBatchWindow?.();
    await vi.waitFor(() => {
      expect(
        provider.requests.filter((request) => request.taskId === root.id),
      ).toHaveLength(2);
    });

    const partialRequest = provider.requests.filter(
      (request) => request.taskId === root.id,
    )[1];
    const partialUpdate = partialRequest?.context.findLast(
      (item) => item.type === 'async_work_update',
    );
    expect(partialUpdate).toMatchObject({
      type: 'async_work_update',
      allFinished: false,
      pending: [
        expect.objectContaining({
          workId: 'mixed-j2',
        }),
      ],
    });
    if (partialUpdate?.type === 'async_work_update') {
      expect(
        partialUpdate.results.map((result) => result.workId),
      ).toEqual(
        expect.arrayContaining(['mixed-a', 'mixed-b', 'mixed-j1']),
      );
    }

    resolveSlowTool?.('slow result');
    await run;

    const rootRequests = provider.requests.filter(
      (request) => request.taskId === root.id,
    );
    expect(rootRequests).toHaveLength(3);
    const finalUpdate = rootRequests[2]?.context.findLast(
      (item) => item.type === 'async_work_update',
    );
    expect(finalUpdate).toMatchObject({
      type: 'async_work_update',
      allFinished: true,
      results: [
        expect.objectContaining({
          workId: 'mixed-j2',
          status: 'completed',
        }),
      ],
      pending: [],
    });
    expect(root.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'completed',
        output: 'mixed work complete',
      },
    });
  });

  it('cancels the batch timer and wakes immediately when all work finishes', async () => {
    let resolveSlowTool: ((value: JsonValue) => void) | undefined;
    const slowToolResult = new Promise<JsonValue>((resolve) => {
      resolveSlowTool = resolve;
    });
    let timerStarted = false;
    let timerCancelled = false;
    const provider = new FakeModelProvider();
    const tools = new ToolRegistry();
    tools.register({
      name: 'fast_job',
      description: 'Finish immediately.',
      requiredCapability: 'job:run',
      effect: 'read_only',
      validateInput: () => ({ valid: true }),
      execute: async () => 'fast',
    });
    tools.register({
      name: 'slow_job',
      description: 'Finish when released.',
      requiredCapability: 'job:run',
      effect: 'read_only',
      validateInput: () => ({ valid: true }),
      execute: async () => await slowToolResult,
    });
    const scheduler = new TaskScheduler({
      provider,
      tools,
      store: new InMemoryTaskStore(),
      admission: new AdmissionController({
        maxConcurrentRequests: 2,
        requestsPerMinute: 20,
        tokensPerMinute: 20_000,
      }),
      asyncWorkPolicy: { batchWindowMs: 30_000 },
      wait: async (_ms, signal) => {
        timerStarted = true;
        await new Promise<void>((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              timerCancelled = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    });
    const task = await scheduler.submit({
      id: 'all-done-fast-path',
      goal: 'Use the all-done fast path.',
      capabilities: ['job:run'],
    });
    provider.setResponses(task.id, [
      {
        type: 'tool_calls',
        calls: [
          { callId: 'fast', toolName: 'fast_job', input: {} },
          { callId: 'slow', toolName: 'slow_job', input: {} },
        ],
        usage,
      },
      {
        type: 'final',
        output: 'all jobs done',
        usage,
      },
    ]);

    const run = scheduler.runUntilIdle();
    await vi.waitFor(() => {
      expect(timerStarted).toBe(true);
    });
    resolveSlowTool?.('slow');
    await run;

    expect(timerCancelled).toBe(true);
    expect(provider.requests).toHaveLength(2);
    expect(task.context).toContainEqual(
      expect.objectContaining({
        type: 'async_work_update',
        allFinished: true,
      }),
    );
  });

  it('restores a persisted async work batch timer', async () => {
    const clock = new ManualClock(100);
    const store = new InMemoryTaskStore();
    const persisted = TaskControlBlock.create({
      id: 'restored-async-timer',
      goal: 'Resume a persisted batch timer.',
      createdAt: clock.now(),
    });
    persisted.transition(
      {
        status: 'RUNNING',
        enteredAt: clock.now(),
        providerId: 'fake-model',
        requestAttempt: 1,
        operation: 'model',
      },
      'test_setup',
    );
    const generationId = persisted.registerAsyncWork(
      [
        { workId: 'restored-done', kind: 'tool', label: 'done' },
        { workId: 'restored-pending', kind: 'tool', label: 'pending' },
      ],
      clock.now(),
    );
    persisted.completeToolWork('restored-done', 'done', clock.now());
    persisted.setAsyncWorkBatchDueAt(generationId, 150);
    persisted.transition(
      {
        status: 'BLOCKED',
        enteredAt: clock.now(),
        reason: 'async_work',
        waitingFor: ['restored-pending'],
      },
      'test_setup',
    );
    await store.persist(persisted);

    const waits: number[] = [];
    const provider = new FakeModelProvider();
    provider.setResponses(persisted.id, [
      { type: 'final', output: 'restored', usage },
    ]);
    const scheduler = new TaskScheduler({
      provider,
      tools: new ToolRegistry(),
      store,
      admission: new AdmissionController(
        {
          maxConcurrentRequests: 1,
          requestsPerMinute: 10,
          tokensPerMinute: 10_000,
        },
        clock,
      ),
      clock,
      wait: async (ms) => {
        waits.push(ms);
        clock.advance(ms);
      },
    });

    const restored = await scheduler.restore(persisted.id);
    await scheduler.runUntilIdle();

    expect(waits).toEqual([50]);
    expect(restored?.state.status).toBe('TERMINATED');
    expect(provider.requests[0]?.context).toContainEqual(
      expect.objectContaining({
        type: 'async_work_update',
        allFinished: false,
        pending: [
          expect.objectContaining({
            workId: 'restored-pending',
          }),
        ],
      }),
    );
  });

  it('delivers an expired async work batch when its timer deadline was cleared before persistence', async () => {
    const clock = new ManualClock(200);
    const store = new InMemoryTaskStore();
    const persisted = TaskControlBlock.create({
      id: 'restored-expired-batch',
      goal: 'Recover an expired delivery.',
      createdAt: clock.now(),
    });
    persisted.transition(
      {
        status: 'RUNNING',
        enteredAt: clock.now(),
        providerId: 'fake-model',
        requestAttempt: 1,
        operation: 'model',
      },
      'test_setup',
    );
    persisted.registerAsyncWork(
      [
        { workId: 'expired-done', kind: 'tool', label: 'done' },
        { workId: 'expired-pending', kind: 'tool', label: 'pending' },
      ],
      clock.now(),
    );
    persisted.completeToolWork('expired-done', 'done', clock.now());
    persisted.transition(
      {
        status: 'BLOCKED',
        enteredAt: clock.now(),
        reason: 'async_work',
        waitingFor: ['expired-pending'],
      },
      'test_setup',
    );
    await store.persist(persisted);

    const provider = new FakeModelProvider();
    provider.setResponses(persisted.id, [
      { type: 'final', output: 'recovered', usage },
    ]);
    const scheduler = new TaskScheduler({
      provider,
      tools: new ToolRegistry(),
      store,
      admission: new AdmissionController(
        {
          maxConcurrentRequests: 1,
          requestsPerMinute: 10,
          tokensPerMinute: 10_000,
        },
        clock,
      ),
      clock,
    });

    const restored = await scheduler.restore(persisted.id);
    expect(restored?.state.status).toBe('READY');

    await scheduler.runUntilIdle();

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.context).toContainEqual(
      expect.objectContaining({
        type: 'async_work_update',
        results: [
          expect.objectContaining({
            workId: 'expired-done',
          }),
        ],
      }),
    );
  });

  it('queues results that finish while the parent model request is running', async () => {
    let resolveSlowTool: ((value: JsonValue) => void) | undefined;
    const slowToolResult = new Promise<JsonValue>((resolve) => {
      resolveSlowTool = resolve;
    });
    let releaseBatchWindow: (() => void) | undefined;
    const batchWindow = new Promise<void>((resolve) => {
      releaseBatchWindow = resolve;
    });
    const provider = new FakeModelProvider({ latencyMs: 50 });
    const tools = new ToolRegistry();
    tools.register({
      name: 'running_fast',
      description: 'Finish immediately.',
      requiredCapability: 'job:run',
      effect: 'read_only',
      validateInput: () => ({ valid: true }),
      execute: async () => 'fast',
    });
    tools.register({
      name: 'running_slow',
      description: 'Finish during the next model turn.',
      requiredCapability: 'job:run',
      effect: 'read_only',
      validateInput: () => ({ valid: true }),
      execute: async () => await slowToolResult,
    });
    const scheduler = new TaskScheduler({
      provider,
      tools,
      store: new InMemoryTaskStore(),
      admission: new AdmissionController({
        maxConcurrentRequests: 2,
        requestsPerMinute: 20,
        tokensPerMinute: 20_000,
      }),
      asyncWorkPolicy: { batchWindowMs: 30_000 },
      wait: async (_ms, signal) => {
        await Promise.race([
          batchWindow,
          new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          }),
        ]);
      },
    });
    const task = await scheduler.submit({
      id: 'result-during-model',
      goal: 'Handle an interrupt during a model request.',
      capabilities: ['job:run'],
    });
    provider.setResponses(task.id, [
      {
        type: 'tool_calls',
        calls: [
          { callId: 'running-fast', toolName: 'running_fast', input: {} },
          { callId: 'running-slow', toolName: 'running_slow', input: {} },
        ],
        usage,
      },
      { type: 'wait_for_async_work', usage },
      { type: 'final', output: 'done', usage },
    ]);

    const run = scheduler.runUntilIdle();
    await vi.waitFor(() => {
      expect(
        task.activeAsyncWorkGeneration?.work.find(
          (work) => work.workId === 'running-fast',
        )?.status,
      ).toBe('completed');
    });
    releaseBatchWindow?.();
    await vi.waitFor(() => {
      expect(provider.requests).toHaveLength(2);
      expect(task.state.status).toBe('RUNNING');
    });
    resolveSlowTool?.('slow');
    await run;

    expect(provider.requests).toHaveLength(3);
    expect(
      task.events
        .filter(
          (event) =>
            event.type === 'state_transitioned' &&
            event.from === 'RUNNING' &&
            event.to.status === 'BLOCKED',
        ),
    ).toHaveLength(1);
    expect(provider.requests[2]?.context).toContainEqual(
      expect.objectContaining({
        type: 'async_work_update',
        allFinished: true,
      }),
    );
  });

  it('cancels live descendants when a parent finishes with work still pending', async () => {
    let releaseBatchWindow: (() => void) | undefined;
    const batchWindow = new Promise<void>((resolve) => {
      releaseBatchWindow = resolve;
    });
    let queuedSideEffectExecutions = 0;
    const provider = new FakeModelProvider();
    const tools = new ToolRegistry();
    tools.register({
      name: 'parent_quick',
      description: 'Give the parent a partial result.',
      requiredCapability: 'job:run',
      effect: 'read_only',
      validateInput: () => ({ valid: true }),
      execute: async () => 'partial',
    });
    tools.register({
      name: 'child_wait',
      description: 'Wait until cancellation.',
      requiredCapability: 'job:run',
      effect: 'read_only',
      validateInput: () => ({ valid: true }),
      execute: async (_input, context) =>
        await new Promise<JsonValue>((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(context.signal.reason),
            { once: true },
          );
        }),
    });
    tools.register({
      name: 'child_side_effect',
      description: 'Must not start after the child is cancelled.',
      requiredCapability: 'job:run',
      effect: 'side_effect',
      validateInput: () => ({ valid: true }),
      execute: async () => {
        queuedSideEffectExecutions += 1;
        return 'unexpected';
      },
    });
    const scheduler = new TaskScheduler({
      provider,
      tools,
      store: new InMemoryTaskStore(),
      admission: new AdmissionController({
        maxConcurrentRequests: 2,
        requestsPerMinute: 20,
        tokensPerMinute: 20_000,
      }),
      asyncWorkPolicy: { batchWindowMs: 30_000 },
      wait: async (_ms, signal) => {
        await Promise.race([
          batchWindow,
          new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          }),
        ]);
      },
    });
    const root = await scheduler.submit({
      id: 'terminating-parent',
      goal: 'Finish after one partial result.',
      capabilities: ['job:run'],
    });
    provider.setResponses(root.id, [
      {
        type: 'async_work',
        children: [
          {
            taskId: 'cancelled-child',
            goal: 'Wait for a local operation.',
            capabilities: ['job:run'],
          },
        ],
        calls: [
          {
            callId: 'parent-partial',
            toolName: 'parent_quick',
            input: {},
          },
        ],
        usage,
      },
      { type: 'final', output: 'parent done', usage },
    ]);
    provider.setResponses('cancelled-child', [
      {
        type: 'tool_calls',
        calls: [
          {
            callId: 'child-pending',
            toolName: 'child_wait',
            input: {},
          },
          {
            callId: 'child-side-effect',
            toolName: 'child_side_effect',
            input: {},
          },
        ],
        usage,
      },
    ]);

    const run = scheduler.runUntilIdle();
    await vi.waitFor(() => {
      expect(scheduler.getTask('cancelled-child')?.state.status).toBe(
        'BLOCKED',
      );
    });
    releaseBatchWindow?.();
    await run;

    expect(root.state.status).toBe('TERMINATED');
    expect(scheduler.getTask('cancelled-child')?.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'cancelled',
      },
    });
    expect(queuedSideEffectExecutions).toBe(0);
    expect(scheduler.liveAgentCount).toBe(0);
  });
});
