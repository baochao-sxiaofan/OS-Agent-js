import {
  AdmissionController,
  AgentPool,
  GeminiModelProvider,
  InMemoryTaskStore,
  TaskScheduler,
  ToolRegistry,
  type TaskControlBlock,
} from '../src/index.js';

const apiKey = process.env['GEMINI_API_KEY'];
if (!apiKey) {
  throw new Error(
    'GEMINI_API_KEY is required. Export it in the current shell before running this example.',
  );
}

const provider = new GeminiModelProvider({
  apiKey,
  model: process.env['GEMINI_MODEL'] ?? 'gemini-3.5-flash-lite',
  maxOutputTokens: 320,
});
const scheduler = new TaskScheduler({
  provider,
  tools: new ToolRegistry(),
  store: new InMemoryTaskStore(),
  admission: new AdmissionController({
    maxConcurrentRequests: 2,
    requestsPerMinute: 10,
    tokensPerMinute: 10_000,
  }),
  agentPool: new AgentPool({
    maxDepth: 2,
    maxLiveAgents: 3,
    maxSpawnedPerRoot: 2,
  }),
  asyncWorkPolicy: {
    batchWindowMs: 5_000,
  },
});

const root = await scheduler.submit({
  id: 'gemini-root',
  goal: [
    'This task must use exactly two subagents before producing a final answer.',
    'On the first turn, return spawn_subagents with exactly these children:',
    '1. goal: Return final output exactly "4".',
    '2. goal: Return final output exactly "9".',
    'Set maxModelAttempts to 1 for both children.',
    'After an async_work_update with allFinished=true arrives, return final output exactly "4+9=13".',
  ].join(' '),
  context: [
    {
      type: 'user',
      content: 'Use two leaf agents to compute 2 squared and 3 squared.',
    },
  ],
  maxModelAttempts: 2,
  budget: {
    maxCostUsd: 0.02,
  },
});

await scheduler.run();

const leafTaskIds = root.events
  .filter((event) => event.type === 'subagent_spawned')
  .map((event) => event.childTaskId);
const leaves = leafTaskIds.map((taskId) => {
  const task = scheduler.getTask(taskId);
  if (!task) {
    throw new Error(`Gemini did not create expected child ${taskId}.`);
  }
  return task;
});

assertCompleted(root, '4+9=13');
assertCompleted(leaves[0], '4');
assertCompleted(leaves[1], '9');

const rootUpdate = root.context.find(
  (item) => item.type === 'async_work_update',
);
if (
  rootUpdate?.type !== 'async_work_update' ||
  !rootUpdate.allFinished ||
  rootUpdate.results.length !== 2
) {
  throw new Error('Root did not receive the expected async_work_update.');
}

console.log(
  JSON.stringify(
    {
      root: summarizeTask(root),
      leaves: leaves.map(summarizeTask),
      rootContextTypes: root.context.map((item) => item.type),
      asyncWorkUpdate: rootUpdate,
      schedulerMetrics: scheduler.metrics,
    },
    null,
    2,
  ),
);

function assertCompleted(
  task: TaskControlBlock | undefined,
  expectedOutput: string,
): asserts task is TaskControlBlock {
  if (
    !task ||
    task.state.status !== 'TERMINATED' ||
    task.state.termination.kind !== 'completed' ||
    task.state.termination.output !== expectedOutput
  ) {
    throw new Error(
      `Task ${task?.id ?? 'missing'} did not complete with ${expectedOutput}.`,
    );
  }
}

function summarizeTask(task: TaskControlBlock) {
  return {
    id: task.id,
    depth: task.depth,
    state: task.state,
    summaries: task.contextSummaries.map((record) => record.summary),
    modelResponses: task.events
      .filter((event) => event.type === 'model_response_recorded')
      .map((event) => ({
        responseType: event.responseType,
        usage: event.usage,
      })),
  };
}
