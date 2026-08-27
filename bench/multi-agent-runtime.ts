import {
  AdmissionController,
  AgentPool,
  FakeModelProvider,
  InMemoryTaskStore,
  TaskScheduler,
  ToolRegistry,
  type TaskControlBlock,
} from '../src/index.js';

const MIDDLE_COUNT = 3;
const LEAVES_PER_MIDDLE = 4;
const EXPECTED_TASKS = 1 + MIDDLE_COUNT + MIDDLE_COUNT * LEAVES_PER_MIDDLE;
const EXPECTED_MODEL_REQUESTS =
  2 + MIDDLE_COUNT * 2 + MIDDLE_COUNT * LEAVES_PER_MIDDLE;
const FAKE_MODEL_LATENCY_MS = 20;
const CONCURRENCY_LEVELS = [1, 2, 4, 8] as const;

type BenchmarkResult = {
  concurrency: number;
  elapsedMs: number;
  throughputTasksPerSecond: number;
  requestCount: number;
  peakProviderRequests: number;
  peakLiveAgents: number;
  peakReadyQueue: number;
  averageReadyWaitMs: number;
  p95ReadyWaitMs: number;
  averageBlockedMs: number;
  rssDeltaKiB: number;
  depthOneRequests: number;
  depthTwoRequests: number;
  depthThreeRequests: number;
};

const results: BenchmarkResult[] = [];
for (const concurrency of CONCURRENCY_LEVELS) {
  results.push(await runScenario(concurrency));
}

console.table(
  results.map((result) => ({
    concurrency: result.concurrency,
    elapsedMs: result.elapsedMs.toFixed(1),
    tasksPerSecond: result.throughputTasksPerSecond.toFixed(1),
    requests: result.requestCount,
    peakRequests: result.peakProviderRequests,
    peakAgents: result.peakLiveAgents,
    peakReady: result.peakReadyQueue,
    avgReadyMs: result.averageReadyWaitMs.toFixed(1),
    p95ReadyMs: result.p95ReadyWaitMs.toFixed(1),
    avgBlockedMs: result.averageBlockedMs.toFixed(1),
    rssDeltaKiB: result.rssDeltaKiB,
    depthRequests: [
      result.depthOneRequests,
      result.depthTwoRequests,
      result.depthThreeRequests,
    ].join('/'),
  })),
);

async function runScenario(concurrency: number): Promise<BenchmarkResult> {
  const provider = new FakeModelProvider({
    latencyMs: FAKE_MODEL_LATENCY_MS,
    estimate: {
      inputTokens: 100,
      maxOutputTokens: 50,
      estimatedCostUsd: 0.0001,
    },
  });
  const agentPool = new AgentPool({
    maxDepth: 3,
    maxLiveAgents: 20,
    maxSpawnedPerRoot: 15,
  });
  const admission = new AdmissionController({
    maxConcurrentRequests: concurrency,
    requestsPerMinute: 10_000,
    tokensPerMinute: 10_000_000,
  });
  const taskIdsByGoal = new Map<string, string>();
  for (let middleIndex = 0; middleIndex < MIDDLE_COUNT; middleIndex += 1) {
    const firstNumber = middleIndex * LEAVES_PER_MIDDLE + 1;
    taskIdsByGoal.set(
      `Coordinate integers ${firstNumber} through ${firstNumber + 3}.`,
      `middle-${middleIndex + 1}`,
    );
  }
  for (
    let value = 1;
    value <= MIDDLE_COUNT * LEAVES_PER_MIDDLE;
    value += 1
  ) {
    taskIdsByGoal.set(`Return the square of ${value}.`, `leaf-${value}`);
  }
  const scheduler = new TaskScheduler({
    provider,
    agentPool,
    admission,
    tools: new ToolRegistry(),
    store: new InMemoryTaskStore(),
    asyncWorkPolicy: {
      batchWindowMs: 5_000,
    },
    taskIdGenerator: (request) => {
      const taskId = taskIdsByGoal.get(request.goal);
      if (!taskId) {
        throw new Error(`No benchmark task ID for goal: ${request.goal}`);
      }
      return taskId;
    },
  });

  const root = await scheduler.submit({
    id: `root-c${concurrency}`,
    goal: 'Coordinate three groups that compute squares from 1 through 12.',
    context: [
      {
        type: 'user',
        content:
          'Compute the square of each integer from 1 through 12 and return the total.',
      },
    ],
  });
  configureResponses(provider, root.id);

  const memoryBefore = process.memoryUsage().rss;
  const startedAt = performance.now();
  const runResult = await scheduler.runUntilIdle();
  const elapsedMs = performance.now() - startedAt;
  const memoryAfter = process.memoryUsage().rss;

  const tasks = collectTasks(scheduler, root.id);
  assertScenarioInvariants(
    scheduler,
    provider,
    root,
    tasks,
    runResult.stalled,
    concurrency,
  );

  const readyWaits = tasks.flatMap(collectReadyWaits);
  const blockedWaits = tasks.flatMap(collectBlockedWaits);
  const requestsByDepth = new Map<number, number>();
  for (const request of provider.requests) {
    const depth = scheduler.getTask(request.taskId)?.depth;
    if (depth !== undefined) {
      requestsByDepth.set(depth, (requestsByDepth.get(depth) ?? 0) + 1);
    }
  }

  return {
    concurrency,
    elapsedMs,
    throughputTasksPerSecond: (tasks.length * 1_000) / elapsedMs,
    requestCount: provider.requests.length,
    peakProviderRequests: admission.peakActiveRequests,
    peakLiveAgents: agentPool.peakLiveCount,
    peakReadyQueue: scheduler.metrics.readyQueue.peak,
    averageReadyWaitMs: average(readyWaits),
    p95ReadyWaitMs: percentile(readyWaits, 0.95),
    averageBlockedMs: average(blockedWaits),
    rssDeltaKiB: Math.round((memoryAfter - memoryBefore) / 1_024),
    depthOneRequests: requestsByDepth.get(1) ?? 0,
    depthTwoRequests: requestsByDepth.get(2) ?? 0,
    depthThreeRequests: requestsByDepth.get(3) ?? 0,
  };
}

function configureResponses(
  provider: FakeModelProvider,
  rootTaskId: string,
): void {
  const usage = {
    inputTokens: 100,
    outputTokens: 25,
    costUsd: 0.0001,
  };
  const middleIds = Array.from(
    { length: MIDDLE_COUNT },
    (_, index) => `middle-${index + 1}`,
  );
  provider.setResponses(rootTaskId, [
    {
      type: 'spawn_subagents',
      children: middleIds.map((_taskId, index) => ({
        goal: `Coordinate integers ${index * 4 + 1} through ${index * 4 + 4}.`,
      })),
      turnSummary: {
        request: 'Split the arithmetic work into three groups.',
        outcome: 'Created three middle tasks.',
      },
      usage,
    },
    {
      type: 'final',
      output: 650,
      turnSummary: {
        request: 'Combine the three group results.',
        outcome: 'Returned the total square sum of 650.',
      },
      usage,
    },
  ]);

  for (let middleIndex = 0; middleIndex < MIDDLE_COUNT; middleIndex += 1) {
    const middleId = middleIds[middleIndex];
    if (middleId === undefined) {
      throw new Error('Missing middle task ID.');
    }
    const firstNumber = middleIndex * LEAVES_PER_MIDDLE + 1;
    const leafNumbers = Array.from(
      { length: LEAVES_PER_MIDDLE },
      (_, leafIndex) => firstNumber + leafIndex,
    );
    const groupSum = leafNumbers.reduce(
      (total, value) => total + value * value,
      0,
    );
    provider.setResponses(middleId, [
      {
        type: 'spawn_subagents',
        children: leafNumbers.map((value) => ({
          goal: `Return the square of ${value}.`,
          maxModelAttempts: 1,
        })),
        turnSummary: {
          request: `Delegate squares ${leafNumbers.join(', ')}.`,
          outcome: 'Created four leaf tasks.',
        },
        usage,
      },
      {
        type: 'final',
        output: groupSum,
        turnSummary: {
          request: 'Combine the four leaf results.',
          outcome: `Returned group sum ${groupSum}.`,
        },
        usage,
      },
    ]);

    for (const value of leafNumbers) {
      provider.setResponses(`leaf-${value}`, [
        {
          type: 'final',
          output: value * value,
          turnSummary: {
            request: `Compute ${value} squared.`,
            outcome: `Returned ${value * value}.`,
          },
          usage,
        },
      ]);
    }
  }
}

function collectTasks(
  scheduler: TaskScheduler,
  rootTaskId: string,
): TaskControlBlock[] {
  const taskIds = [
    rootTaskId,
    ...Array.from(
      { length: MIDDLE_COUNT },
      (_, index) => `middle-${index + 1}`,
    ),
    ...Array.from(
      { length: MIDDLE_COUNT * LEAVES_PER_MIDDLE },
      (_, index) => `leaf-${index + 1}`,
    ),
  ];
  return taskIds.map((taskId) => {
    const task = scheduler.getTask(taskId);
    if (!task) {
      throw new Error(`Expected task was not created: ${taskId}`);
    }
    return task;
  });
}

function assertScenarioInvariants(
  scheduler: TaskScheduler,
  provider: FakeModelProvider,
  root: TaskControlBlock,
  tasks: readonly TaskControlBlock[],
  stalled: boolean,
  concurrency: number,
): void {
  assert(!stalled, 'The scheduler stalled.');
  assert(tasks.length === EXPECTED_TASKS, 'Unexpected task count.');
  assert(
    provider.requests.length === EXPECTED_MODEL_REQUESTS,
    `Unexpected model request count: expected ${EXPECTED_MODEL_REQUESTS}, received ${provider.requests.length}. Sequence: ${provider.requests.map((request) => request.taskId).join(' -> ')}`,
  );
  assert(
    admissionPeakDoesNotExceed(scheduler, concurrency),
    'Provider concurrency exceeded the configured limit.',
  );
  assert(
    scheduler.metrics.liveAgents.peak <= EXPECTED_TASKS &&
      scheduler.metrics.liveAgents.peak > 1,
    'Agent pool peak is outside the expected bounds.',
  );
  assert(
    scheduler.metrics.liveAgents.current === 0,
    'Agent pool leaked live tasks after completion.',
  );
  assert(
    tasks.every((task) => task.state.status === 'TERMINATED'),
    'At least one task did not terminate.',
  );
  assert(
    root.state.status === 'TERMINATED' &&
      root.state.termination.kind === 'completed' &&
      root.state.termination.output === 650,
    'Root result is incorrect.',
  );
  assert(
    tasks.reduce(
      (total, task) => total + task.contextSummaries.length,
      0,
    ) === EXPECTED_MODEL_REQUESTS,
    'The summary channel is missing model-turn summaries.',
  );

  const rootUpdate = root.context.find(
    (item) => item.type === 'async_work_update',
  );
  assert(
    rootUpdate?.type === 'async_work_update' &&
      rootUpdate.allFinished &&
      rootUpdate.results.length === MIDDLE_COUNT,
    'Root did not receive exactly three completed middle results.',
  );
  assert(
    root.context[0]?.type === 'user',
    'The full context channel lost the original user input.',
  );

  for (let index = 1; index <= MIDDLE_COUNT; index += 1) {
    const middle = scheduler.getTask(`middle-${index}`);
    const update = middle?.context.find(
      (item) => item.type === 'async_work_update',
    );
    assert(
      update?.type === 'async_work_update' &&
        update.allFinished &&
        update.results.length === LEAVES_PER_MIDDLE,
      `Middle task ${index} did not receive four completed leaf results.`,
    );
  }
}

function admissionPeakDoesNotExceed(
  scheduler: TaskScheduler,
  concurrency: number,
): boolean {
  return scheduler.metrics.providerRequests.peakActive <= concurrency;
}

function collectReadyWaits(task: TaskControlBlock): number[] {
  const waits: number[] = [];
  let readyAt = task.createdAt;
  for (const event of task.events) {
    if (event.type !== 'state_transitioned') {
      continue;
    }
    if (event.from === 'READY' && event.to.status === 'RUNNING') {
      waits.push(Math.max(0, event.to.enteredAt - readyAt));
    }
    if (event.to.status === 'READY') {
      readyAt = event.to.enteredAt;
    }
  }
  return waits;
}

function collectBlockedWaits(task: TaskControlBlock): number[] {
  const waits: number[] = [];
  let blockedAt: number | undefined;
  for (const event of task.events) {
    if (event.type !== 'state_transitioned') {
      continue;
    }
    if (event.to.status === 'BLOCKED') {
      blockedAt = event.to.enteredAt;
      continue;
    }
    if (event.from === 'BLOCKED' && blockedAt !== undefined) {
      waits.push(Math.max(0, event.to.enteredAt - blockedAt));
      blockedAt = undefined;
    }
  }
  return waits;
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * ratio) - 1,
  );
  return sorted[index] ?? 0;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
