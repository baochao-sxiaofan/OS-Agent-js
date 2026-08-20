import { describe, expect, it, vi } from 'vitest';

import {
  AdmissionController,
  FakeModelProvider,
  InMemoryTaskStore,
  TaskScheduler,
  ToolRegistry,
  type Clock,
  type JsonValue,
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
  clock?: Clock;
  maxConcurrentRequests?: number;
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
});
