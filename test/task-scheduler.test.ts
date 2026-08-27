import { describe, expect, it, vi } from 'vitest';

import {
  AdmissionController,
  AgentPool,
  CapabilityManager,
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
  asyncWorkBatchWindowMs?: number;
  capabilityManager?: CapabilityManager;
  clock?: Clock;
  maxConcurrentRequests?: number;
  readyQueue?: ReadyQueue;
  requestsPerMinute?: number;
  taskIds?: readonly string[];
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
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
  const taskIds = [...(options?.taskIds ?? [])];
  const scheduler = new TaskScheduler({
    provider,
    tools,
    store,
    admission,
    ...(options?.wait === undefined ? {} : { wait: options.wait }),
    ...(options?.asyncWorkBatchWindowMs === undefined
      ? {}
      : {
          asyncWorkPolicy: {
            batchWindowMs: options.asyncWorkBatchWindowMs,
          },
        }),
    ...(options?.capabilityManager === undefined
      ? {}
      : { capabilityManager: options.capabilityManager }),
    ...(options?.agentPool === undefined
      ? {}
      : { agentPool: options.agentPool }),
    ...(options?.readyQueue === undefined
      ? {}
      : { readyQueue: options.readyQueue }),
    ...(options?.taskIds === undefined
      ? {}
      : {
          taskIdGenerator: () => {
            const taskId = taskIds.shift();
            if (!taskId) {
              throw new Error('Test task ID sequence was exhausted.');
            }
            return taskId;
          },
        }),
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

  it('dispatches same-depth ready tasks in FIFO order', async () => {
    const { provider, scheduler } = createRuntime({
      maxConcurrentRequests: 1,
    });
    const first = await scheduler.submit({
      id: 'first',
      goal: 'First submitted task.',
    });
    const second = await scheduler.submit({
      id: 'second',
      goal: 'Second submitted task.',
    });
    provider.setResponses(first.id, [
      { type: 'final', output: 'first done', usage },
    ]);
    provider.setResponses(second.id, [
      { type: 'final', output: 'second done', usage },
    ]);

    await scheduler.runUntilIdle();

    expect(provider.requests.map((request) => request.taskId)).toEqual([
      'first',
      'second',
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
    });
    const second = await scheduler.submit({
      id: 'second',
      goal: 'Second task.',
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

  it('returns a capability requirement when a tool call is unauthorized', async () => {
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
      {
        type: 'final',
        output: 'continued without the privileged operation',
        usage,
      },
    ]);

    await scheduler.runUntilIdle();

    expect(task.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'completed',
        output: 'continued without the privileged operation',
      },
    });
    expect(task.context).toContainEqual({
      type: 'tool_call_rejected',
      toolName: 'write_file',
      reason: 'capability_required',
      message: 'Tool write_file requires additional capability.',
      requiredCapabilities: [
        {
          capability: 'filesystem:write',
          scope: { kind: 'all' },
        },
      ],
    });
    expect(provider.requests[0]?.tools).toContainEqual({
      name: 'write_file',
      description: 'Write a file.',
    });
  });

  it('derives resource-scoped capability requirements from tool input', async () => {
    const writes: string[] = [];
    const scopedWriteTool: Tool = {
      name: 'write_scoped_file',
      description: 'Write one scoped file.',
      effect: 'side_effect',
      validateInput: (input) =>
        typeof input['resource'] === 'string'
          ? { valid: true }
          : { valid: false, error: 'resource is required' },
      requiredCapabilities: (input) => [
        {
          capability: 'file.write',
          scope: {
            kind: 'exact',
            resource: String(input['resource']),
          },
        },
      ],
      execute: async (input) => {
        writes.push(String(input['resource']));
        return 'written';
      },
    };
    const { provider, scheduler, tools } = createRuntime();
    tools.register(scopedWriteTool);
    const task = await scheduler.submit({
      id: 'scoped-writer',
      goal: 'Write only inside the assigned directory.',
      capabilities: [
        {
          capability: 'file.write',
          scope: {
            kind: 'subtree',
            resource: 'file:///repo/src/auth',
          },
        },
      ],
    });
    provider.setResponses(task.id, [
      {
        type: 'tool_calls',
        calls: [
          {
            callId: 'allowed-write',
            toolName: 'write_scoped_file',
            input: {
              resource: 'file:///repo/src/auth/token.ts',
            },
          },
        ],
        usage,
      },
      {
        type: 'tool_calls',
        calls: [
          {
            callId: 'denied-write',
            toolName: 'write_scoped_file',
            input: {
              resource: 'file:///repo/src/shared/config.ts',
            },
          },
        ],
        usage,
      },
      {
        type: 'final',
        output: 'stopped at the assigned boundary',
        usage,
      },
    ]);

    await scheduler.runUntilIdle();

    expect(writes).toEqual(['file:///repo/src/auth/token.ts']);
    expect(task.context).toContainEqual(
      expect.objectContaining({
        type: 'tool_call_rejected',
        reason: 'capability_required',
        requiredCapabilities: [
          {
            capability: 'file.write',
            scope: {
              kind: 'exact',
              resource: 'file:///repo/src/shared/config.ts',
            },
          },
        ],
      }),
    );
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
      taskIds: ['middle', 'leaf'],
    });
    const root = await scheduler.submit({
      id: 'root',
      goal: 'Coordinate the full task.',
    });
    provider.setResponses('root', [
      {
        type: 'spawn_subagents',
        children: [{ goal: 'Coordinate the branch.' }],
        usage,
      },
      { type: 'final', output: 'root complete', usage },
    ]);
    provider.setResponses('middle', [
      {
        type: 'spawn_subagents',
        children: [{ goal: 'Complete concrete work.' }],
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

  it('retries internal child ID collisions without involving the model', async () => {
    const { provider, scheduler } = createRuntime({
      maxConcurrentRequests: 1,
      taskIds: ['collision-root', 'generated-child'],
    });
    const root = await scheduler.submit({
      id: 'collision-root',
      goal: 'Delegate one branch.',
    });
    provider.setResponses(root.id, [
      {
        type: 'spawn_subagents',
        children: [{ goal: 'Complete the generated branch.' }],
        usage,
      },
      { type: 'final', output: 'root complete', usage },
    ]);
    provider.setResponses('generated-child', [
      { type: 'final', output: 'child complete', usage },
    ]);

    await scheduler.runUntilIdle();

    expect(scheduler.getTask('generated-child')).toBeDefined();
    expect(provider.requests.map((request) => request.taskId)).toEqual([
      'collision-root',
      'generated-child',
      'collision-root',
    ]);
    expect(
      root.context.some(
        (item) => item.type === 'subagent_spawn_rejected',
      ),
    ).toBe(false);
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
      taskIds: ['middle-depth', 'leaf-depth'],
    });
    const root = await scheduler.submit({
      id: 'root-depth',
      goal: 'Coordinate.',
    });
    provider.setResponses('root-depth', [
      {
        type: 'spawn_subagents',
        children: [{ goal: 'Coordinate.' }],
        usage,
      },
      { type: 'final', output: 'root handled fallback', usage },
    ]);
    provider.setResponses('middle-depth', [
      {
        type: 'spawn_subagents',
        children: [{ goal: 'Do work.' }],
        usage,
      },
      { type: 'final', output: 'middle handled fallback', usage },
    ]);
    provider.setResponses('leaf-depth', [
      {
        type: 'spawn_subagents',
        children: [{ goal: 'Too deep.' }],
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
        children: [{ goal: 'Cannot be created.' }],
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

  it('admits concurrent spawns for one parent without a lock', async () => {
    const scheduler = new TaskScheduler({
      provider: new FakeModelProvider(),
      tools: new ToolRegistry(),
      store: new InMemoryTaskStore(),
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
      taskIdGenerator: (() => {
        const taskIds = ['first-child', 'second-child'];
        return () => taskIds.shift() ?? 'unexpected-child';
      })(),
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

    // 两次创建请求在同一事件循环中并发发起（各自的同步准入段先后原子执行）。
    const [firstSpawn, secondSpawn] = await Promise.all([
      scheduler.spawnChildren(root.id, [
        { goal: 'First branch.' },
      ]),
      scheduler.spawnChildren(root.id, [
        { goal: 'Second branch.' },
      ]),
    ]);

    expect(firstSpawn).toMatchObject({ spawned: true });
    expect(secondSpawn).toMatchObject({ spawned: true });
    expect(scheduler.getTask('first-child')).toBeDefined();
    expect(scheduler.getTask('second-child')).toBeDefined();
    // 池未超卖：root 加两个子 Agent 恰好占满 3 个存活槽位。
    expect(scheduler.liveAgentCount).toBe(3);
  });

  it('returns the pool slot when sending a spawned child fails', async () => {
    const backingStore = new InMemoryTaskStore();
    const store: TaskStore = {
      persist: async (task) => {
        if (task.id === 'doomed-child') {
          throw new Error('disk offline');
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
        maxSpawnedPerRoot: 5,
      }),
      taskIdGenerator: () => 'doomed-child',
    });
    const root = await scheduler.submit({
      id: 'send-fail-root',
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

    const result = await scheduler.spawnChildren(root.id, [
      { goal: 'Will fail to send.' },
    ]);

    expect(result).toMatchObject({ spawned: true });
    // 发送失败后槽位被 V 回，只剩 root 存活。
    expect(scheduler.liveAgentCount).toBe(1);
    expect(scheduler.getTask('doomed-child')).toBeUndefined();
    // 父任务收到失败结果，而不是永久等待一个未就绪的子 Agent。
    expect(
      root.context.some(
        (item) =>
          item.type === 'async_work_update' &&
          item.results.some(
            (workResult) =>
              workResult.workId === 'doomed-child' &&
              workResult.status === 'failed',
          ),
      ),
    ).toBe(true);
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
      taskIdGenerator: () => 'oversized-child',
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
    });
    const second = await scheduler.submit({
      id: 'rate-second',
      goal: 'Second task.',
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
      taskIdGenerator: (() => {
        const taskIds = ['mixed-a', 'mixed-b'];
        return () => taskIds.shift() ?? 'unexpected-mixed-child';
      })(),
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
          { goal: 'Complete branch A.' },
          { goal: 'Complete branch B.' },
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
    const persisted = TaskControlBlock.createAgent(
      {
        id: 'restored-async-timer',
        goal: 'Resume a persisted batch timer.',
      },
      { kind: 'root' },
      clock.now(),
    );
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
    const persisted = TaskControlBlock.createAgent(
      {
        id: 'restored-expired-batch',
        goal: 'Recover an expired delivery.',
      },
      { kind: 'root' },
      clock.now(),
    );
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
      taskIdGenerator: () => 'cancelled-child',
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

  it('restores an interrupted model request as READY and sends it again', async () => {
    const clock = new ManualClock(50);
    const store = new InMemoryTaskStore();
    const persisted = TaskControlBlock.createAgent(
      {
        id: 'restore-running',
        goal: 'Resume the interrupted request.',
      },
      { kind: 'root' },
      10,
    );
    persisted.startModelAttempt();
    persisted.transition(
      {
        status: 'RUNNING',
        enteredAt: 20,
        providerId: 'fake-model',
        requestAttempt: 1,
        operation: 'model',
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

    const [restored] = await scheduler.restoreMany([persisted.id]);

    expect(restored?.state).toEqual({
      status: 'READY',
      enteredAt: 50,
      reason: 'restored',
    });
    await scheduler.runUntilIdle();

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.attempt).toBe(2);
    expect(restored?.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'completed',
        output: 'recovered',
      },
    });
  });

  it('keeps single-child restore compatible when its parent is not loaded', async () => {
    const store = new InMemoryTaskStore();
    const parent = TaskControlBlock.createAgent(
      {
        id: 'unloaded-parent',
        goal: 'Remain outside this partial restore.',
      },
      { kind: 'root' },
      10,
    );
    const child = TaskControlBlock.createAgent(
      {
        id: 'partial-restore-child',
        goal: 'Restore only this child.',
      },
      { kind: 'child', parent },
      20,
    );
    await store.persist(child);
    const scheduler = new TaskScheduler({
      provider: new FakeModelProvider(),
      tools: new ToolRegistry(),
      store,
      admission: new AdmissionController({
        maxConcurrentRequests: 1,
        requestsPerMinute: 10,
        tokensPerMinute: 10_000,
      }),
    });

    const restored = await scheduler.restore(child.id);

    expect(restored?.state.status).toBe('READY');
    expect(scheduler.readyQueueSize).toBe(1);
    expect(scheduler.liveAgentCount).toBe(1);
  });

  it('cancels an orphaned child during an explicit full-store recovery', async () => {
    const store = new InMemoryTaskStore();
    const parent = TaskControlBlock.createAgent(
      {
        id: 'missing-parent',
        goal: 'This snapshot is intentionally absent.',
      },
      { kind: 'root' },
      10,
    );
    const child = TaskControlBlock.createAgent(
      {
        id: 'orphaned-child',
        goal: 'Must not continue without a result receiver.',
      },
      { kind: 'child', parent },
      20,
    );
    await store.persist(child);
    const scheduler = new TaskScheduler({
      provider: new FakeModelProvider(),
      tools: new ToolRegistry(),
      store,
      admission: new AdmissionController({
        maxConcurrentRequests: 1,
        requestsPerMinute: 10,
        tokensPerMinute: 10_000,
      }),
    });

    const [restored] = await scheduler.restoreMany(
      [child.id],
      { cancelOrphans: true },
    );

    expect(restored?.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'cancelled',
      },
    });
    expect(scheduler.readyQueueSize).toBe(0);
    expect(scheduler.liveAgentCount).toBe(0);
  });

  it('reconciles a persisted terminal child before waking its parent', async () => {
    const clock = new ManualClock(100);
    const store = new InMemoryTaskStore();
    const parent = TaskControlBlock.createAgent(
      {
        id: 'restore-parent',
        goal: 'Combine the child result.',
      },
      { kind: 'root' },
      10,
    );
    parent.transition(
      {
        status: 'RUNNING',
        enteredAt: 20,
        providerId: 'fake-model',
        requestAttempt: 1,
        operation: 'model',
      },
      'test_setup',
    );
    const child = TaskControlBlock.createAgent(
      {
        id: 'restore-child',
        goal: 'Finish one branch.',
      },
      { kind: 'child', parent },
      30,
    );
    parent.registerAsyncWork(
      [
        {
          workId: child.id,
          kind: 'subagent',
          label: child.goal,
          childTaskId: child.id,
        },
      ],
      30,
    );
    parent.transition(
      {
        status: 'BLOCKED',
        enteredAt: 40,
        reason: 'async_work',
        waitingFor: [child.id],
      },
      'test_setup',
    );
    const childTermination = {
      kind: 'completed' as const,
      output: 'child result',
    };
    child.transition(
      {
        status: 'TERMINATED',
        enteredAt: 50,
        termination: childTermination,
      },
      'test_setup',
    );
    child.recordTermination(childTermination);
    await store.persist(parent);
    await store.persist(child);

    const provider = new FakeModelProvider();
    provider.setResponses(parent.id, [
      { type: 'final', output: 'combined', usage },
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

    const restored = await scheduler.restoreMany([child.id, parent.id]);
    const restoredParent = restored.find((task) => task.id === parent.id);
    expect(restoredParent?.state.status).toBe('READY');

    await scheduler.runUntilIdle();

    expect(provider.requests[0]?.context).toContainEqual(
      expect.objectContaining({
        type: 'async_work_update',
        allFinished: true,
        results: [
          expect.objectContaining({
            workId: child.id,
            status: 'completed',
            termination: childTermination,
          }),
        ],
      }),
    );
    expect(restoredParent?.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'completed',
        output: 'combined',
      },
    });
  });

  it('restarts persisted running tool work with the original idempotency key', async () => {
    const clock = new ManualClock(100);
    const store = new InMemoryTaskStore();
    const capabilityManager = new CapabilityManager();
    const grants = capabilityManager.grantByHuman(
      'restore-tool',
      'approved-transfer',
      [
        {
          capability: 'payment:write',
          scope: { kind: 'all' },
        },
      ],
      10,
    );
    const task = TaskControlBlock.createAgent(
      {
        id: 'restore-tool',
        goal: 'Resume tool work.',
      },
      { kind: 'root' },
      10,
      grants,
    );
    task.transition(
      {
        status: 'RUNNING',
        enteredAt: 20,
        providerId: 'fake-model',
        requestAttempt: 1,
        operation: 'model',
      },
      'test_setup',
    );
    task.registerAsyncWork(
      [
        {
          workId: 'transfer-1',
          kind: 'tool',
          label: 'transfer',
          toolName: 'transfer',
        },
      ],
      30,
    );
    task.recordToolCall('transfer-1', 'transfer');
    task.consumeCapabilityGrant(
      grants[0]?.grantId ?? '',
      'transfer-1',
    );
    task.appendContext({
      type: 'tool_call',
      callId: 'transfer-1',
      toolName: 'transfer',
      input: { amount: 100 },
    });
    task.transition(
      {
        status: 'BLOCKED',
        enteredAt: 40,
        reason: 'async_work',
        waitingFor: ['transfer-1'],
      },
      'test_setup',
    );
    await store.persist(task);

    const idempotencyKeys: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: 'transfer',
      description: 'Transfer funds.',
      requiredCapability: 'payment:write',
      effect: 'side_effect',
      validateInput: () => ({ valid: true }),
      execute: async (_input, context) => {
        idempotencyKeys.push(context.idempotencyKey);
        return { transferred: true };
      },
    });
    const provider = new FakeModelProvider();
    provider.setResponses(task.id, [
      { type: 'final', output: 'transfer confirmed', usage },
    ]);
    const scheduler = new TaskScheduler({
      provider,
      tools,
      store,
      capabilityManager,
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

    const [restored] = await scheduler.restoreMany([task.id]);
    await scheduler.runUntilIdle();

    expect(idempotencyKeys).toEqual(['restore-tool:transfer-1']);
    expect(provider.requests[0]?.context).toContainEqual(
      expect.objectContaining({
        type: 'async_work_update',
        allFinished: true,
        results: [
          expect.objectContaining({
            workId: 'transfer-1',
            output: { transferred: true },
          }),
        ],
      }),
    );
    expect(restored?.state.status).toBe('TERMINATED');
  });

  it('routes a normal capability request to the parent for approval', async () => {
    const capabilityManager = new CapabilityManager({
      requestIdGenerator: () => 'capability-request-1',
    });
    const { provider, scheduler } = createRuntime({
      asyncWorkBatchWindowMs: 1,
      capabilityManager,
      maxConcurrentRequests: 1,
      taskIds: ['capability-child'],
    });
    const root = await scheduler.submit({
      id: 'capability-root',
      goal: 'Coordinate a scoped code change.',
      capabilities: [
        {
          capability: 'file.write',
          scope: {
            kind: 'subtree',
            resource: 'file:///repo/src',
          },
        },
      ],
    });
    provider.setResponses(root.id, [
      {
        type: 'spawn_subagents',
        children: [{ goal: 'Modify one authentication file.' }],
        usage,
      },
      {
        type: 'resolve_capability_request',
        requestRef: 'capability-request-1',
        decision: 'approve',
        usage,
      },
      {
        type: 'final',
        output: 'change integrated',
        usage,
      },
    ]);
    provider.setResponses('capability-child', [
      {
        type: 'request_capabilities',
        requests: [
          {
            capability: 'file.write',
            scope: {
              kind: 'exact',
              resource: 'file:///repo/src/auth/token.ts',
            },
            reason: 'The assigned implementation requires this file.',
          },
        ],
        usage,
      },
      {
        type: 'final',
        output: 'child change complete',
        usage,
      },
    ]);

    await scheduler.runUntilIdle();

    const child = scheduler.getTask('capability-child');
    expect(child?.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'completed',
        output: 'child change complete',
      },
    });
    expect(child?.capabilityGrants).toEqual([
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
    ]);
    expect(root.context).toContainEqual(
      expect.objectContaining({
        type: 'async_work_update',
        pending: [
          expect.objectContaining({
            status: 'waiting_for_capability',
            blocker: expect.objectContaining({
              requestRef: 'capability-request-1',
            }),
          }),
        ],
      }),
    );
    expect(root.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'completed',
        output: 'change integrated',
      },
    });
  });

  it('propagates capability grants down the Agent ancestry one hop at a time', async () => {
    const capabilityManager = new CapabilityManager({
      requestIdGenerator: () => 'nested-capability-request',
    });
    const { provider, scheduler } = createRuntime({
      asyncWorkBatchWindowMs: 1,
      capabilityManager,
      maxConcurrentRequests: 1,
      taskIds: ['middle-agent', 'leaf-agent'],
    });
    const root = await scheduler.submit({
      id: 'root-authority',
      goal: 'Coordinate a nested implementation.',
      capabilities: [
        {
          capability: 'file.write',
          scope: {
            kind: 'subtree',
            resource: 'file:///repo/src',
          },
        },
      ],
    });
    provider.setResponses(root.id, [
      {
        type: 'spawn_subagents',
        children: [{ goal: 'Coordinate the implementation branch.' }],
        usage,
      },
      {
        type: 'resolve_capability_request',
        requestRef: 'nested-capability-request',
        decision: 'approve',
        usage,
      },
      { type: 'final', output: 'root complete', usage },
    ]);
    provider.setResponses('middle-agent', [
      {
        type: 'spawn_subagents',
        children: [{ goal: 'Modify the assigned source file.' }],
        usage,
      },
      {
        type: 'resolve_capability_request',
        requestRef: 'nested-capability-request',
        decision: 'approve',
        usage,
      },
      { type: 'final', output: 'middle complete', usage },
    ]);
    provider.setResponses('leaf-agent', [
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
      { type: 'final', output: 'leaf complete', usage },
    ]);

    await scheduler.runUntilIdle();

    const middle = scheduler.getTask('middle-agent');
    const leaf = scheduler.getTask('leaf-agent');
    expect(middle?.capabilityGrants).toEqual([
      expect.objectContaining({
        capability: 'file.write',
        source: expect.objectContaining({
          type: 'parent',
          issuerTaskId: root.id,
        }),
      }),
    ]);
    expect(leaf?.capabilityGrants).toEqual([
      expect.objectContaining({
        capability: 'file.write',
        source: expect.objectContaining({
          type: 'parent',
          issuerTaskId: 'middle-agent',
        }),
      }),
    ]);
    const rootRequestUpdate = root.context.find(
      (item) =>
        item.type === 'async_work_update' &&
        item.pending.some(
          (pending) =>
            pending.label === 'Coordinate the implementation branch.' &&
            pending.blocker?.requestRef ===
              'nested-capability-request',
        ),
    );
    const middleRequestUpdate = middle?.context.find(
      (item) =>
        item.type === 'async_work_update' &&
        item.pending.some(
          (pending) =>
            pending.label === 'Modify the assigned source file.' &&
            pending.blocker?.requestRef ===
              'nested-capability-request',
        ),
    );
    expect(rootRequestUpdate).toBeDefined();
    expect(middleRequestUpdate).toBeDefined();
    expect(root.state.status).toBe('TERMINATED');
  });

  it('batches concurrent child capability blockers on the parent work table', async () => {
    const requestIds = ['batch-capability-1', 'batch-capability-2'];
    let releaseBatchWindow: (() => void) | undefined;
    const batchWindow = new Promise<void>((resolve) => {
      releaseBatchWindow = resolve;
    });
    const capabilityManager = new CapabilityManager({
      requestIdGenerator: () =>
        requestIds.shift() ?? 'unexpected-capability-request',
    });
    const { provider, scheduler } = createRuntime({
      asyncWorkBatchWindowMs: 5,
      capabilityManager,
      maxConcurrentRequests: 2,
      taskIds: ['batch-child-a', 'batch-child-b'],
      wait: async () => await batchWindow,
    });
    const root = await scheduler.submit({
      id: 'batch-capability-root',
      goal: 'Coordinate two scoped changes.',
      capabilities: ['file.write'],
      maxModelAttempts: 5,
    });
    provider.setResponses(root.id, [
      {
        type: 'spawn_subagents',
        children: [
          { goal: 'Modify module A.' },
          { goal: 'Modify module B.' },
        ],
        usage,
      },
      {
        type: 'resolve_capability_request',
        requestRef: 'batch-capability-1',
        decision: 'approve',
        usage,
      },
      {
        type: 'resolve_capability_request',
        requestRef: 'batch-capability-2',
        decision: 'approve',
        usage,
      },
      { type: 'final', output: 'both changes complete', usage },
    ]);
    for (const [taskId, resource] of [
      ['batch-child-a', 'file:///repo/a.ts'],
      ['batch-child-b', 'file:///repo/b.ts'],
    ] as const) {
      provider.setResponses(taskId, [
        {
          type: 'request_capabilities',
          requests: [
            {
              capability: 'file.write',
              scope: { kind: 'exact', resource },
            },
          ],
          usage,
        },
        { type: 'final', output: `${taskId} complete`, usage },
      ]);
    }

    const run = scheduler.runUntilIdle();
    await vi.waitFor(() => {
      expect(scheduler.getTask('batch-child-a')?.state.status).toBe(
        'BLOCKED',
      );
      expect(scheduler.getTask('batch-child-b')?.state.status).toBe(
        'BLOCKED',
      );
    });
    expect(
      provider.requests.filter((request) => request.taskId === root.id),
    ).toHaveLength(1);

    releaseBatchWindow?.();
    await run;

    const batchedUpdate = root.context.find(
      (item) =>
        item.type === 'async_work_update' &&
        item.pending.filter(
          (pending) =>
            pending.status === 'waiting_for_capability',
        ).length === 2,
    );
    expect(batchedUpdate).toBeDefined();
    expect(
      root.context.filter(
        (item) => item.type === 'async_work_update',
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(root.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'completed',
        output: 'both changes complete',
      },
    });
  });

  it('does not let a parent approve capability it does not hold', async () => {
    const capabilityManager = new CapabilityManager({
      requestIdGenerator: () => 'unowned-request-1',
    });
    const { provider, scheduler } = createRuntime({
      capabilityManager,
      maxConcurrentRequests: 1,
      taskIds: ['unowned-child'],
    });
    const root = await scheduler.submit({
      id: 'unowned-root',
      goal: 'Coordinate without write authority.',
    });
    provider.setResponses(root.id, [
      {
        type: 'spawn_subagents',
        children: [{ goal: 'Attempt a scoped change.' }],
        usage,
      },
      {
        type: 'final',
        output: 'fallback complete',
        usage,
      },
    ]);
    provider.setResponses('unowned-child', [
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
      {
        type: 'final',
        output: 'continued without write access',
        usage,
      },
    ]);

    await scheduler.runUntilIdle();

    const child = scheduler.getTask('unowned-child');
    expect(child?.capabilityGrants).toEqual([]);
    expect(child?.context).toContainEqual(
      expect.objectContaining({
        type: 'capability_request_result',
        requestRef: 'unowned-request-1',
        status: 'denied',
        reason: expect.stringContaining(
          'Root Agent authority does not cover capability file.write',
        ),
      }),
    );
    expect(child?.state.status).toBe('TERMINATED');
  });

  it('routes sensitive capability requests directly to human approval', async () => {
    const capabilityManager = new CapabilityManager({
      requestIdGenerator: () => 'human-request-1',
    });
    const { provider, scheduler } = createRuntime({
      capabilityManager,
      maxConcurrentRequests: 1,
      taskIds: ['sensitive-child'],
    });
    const root = await scheduler.submit({
      id: 'sensitive-root',
      goal: 'Coordinate a release.',
      capabilities: [
        {
          capability: 'git.push',
          scope: {
            kind: 'exact',
            resource: 'git://repo/origin/main',
          },
        },
      ],
    });
    provider.setResponses(root.id, [
      {
        type: 'spawn_subagents',
        children: [{ goal: 'Publish the approved commit.' }],
        usage,
      },
      {
        type: 'final',
        output: 'release complete',
        usage,
      },
    ]);
    provider.setResponses('sensitive-child', [
      {
        type: 'request_capabilities',
        requests: [
          {
            capability: 'git.push',
            scope: {
              kind: 'exact',
              resource: 'git://repo/origin/main',
            },
            reason: 'The release must publish the reviewed commit.',
          },
        ],
        usage,
      },
      {
        type: 'final',
        output: 'commit published',
        usage,
      },
    ]);

    await scheduler.runUntilIdle();

    const child = scheduler.getTask('sensitive-child');
    expect(child?.state).toMatchObject({
      status: 'BLOCKED',
      reason: 'human_approval',
      waitingFor: ['human-request-1'],
    });
    expect(scheduler.pendingHumanCapabilityApprovals()).toEqual([
      expect.objectContaining({
        requestId: 'human-request-1',
        requesterTaskId: 'sensitive-child',
      }),
    ]);
    expect(
      root.context.some(
        (item) =>
          item.type === 'async_work_update' &&
          item.pending.some(
            (pending) =>
              pending.blocker?.requestRef === 'human-request-1',
          ),
      ),
    ).toBe(false);

    await scheduler.resolveHumanCapabilityRequest(
      'human-request-1',
      'approve',
    );
    await scheduler.runUntilIdle();

    expect(child?.capabilityGrants).toEqual([
      expect.objectContaining({
        capability: 'git.push',
        source: {
          type: 'human',
          approvalRequestId: 'human-request-1',
        },
      }),
    ]);
    expect(root.state).toMatchObject({
      status: 'TERMINATED',
      termination: {
        kind: 'completed',
        output: 'release complete',
      },
    });
  });
});
