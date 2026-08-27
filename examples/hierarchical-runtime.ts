import {
  AdmissionController,
  AgentPool,
  FakeModelProvider,
  InMemoryTaskStore,
  TaskScheduler,
  ToolRegistry,
} from '../src/index.js';

const provider = new FakeModelProvider();
const generatedTaskIds = ['middle', 'leaf'];
const scheduler = new TaskScheduler({
  provider,
  tools: new ToolRegistry(),
  store: new InMemoryTaskStore(),
  admission: new AdmissionController({
    maxConcurrentRequests: 1,
    requestsPerMinute: 20,
    tokensPerMinute: 20_000,
  }),
  agentPool: new AgentPool({
    maxDepth: 3,
    maxLiveAgents: 3,
    maxSpawnedPerRoot: 2,
  }),
  taskIdGenerator: () => {
    const taskId = generatedTaskIds.shift();
    if (!taskId) {
      throw new Error('Example task ID sequence was exhausted.');
    }
    return taskId;
  },
});

const usage = {
  inputTokens: 50,
  outputTokens: 10,
  costUsd: 0.001,
};

const root = await scheduler.submit({
  id: 'root',
  goal: 'Coordinate a three-level investigation.',
});

provider.setResponses('root', [
  {
    type: 'spawn_subagents',
    children: [
      {
        goal: 'Coordinate the concrete investigation.',
      },
    ],
    usage,
  },
  {
    type: 'final',
    output: 'The investigation is complete.',
    usage,
  },
]);
provider.setResponses('middle', [
  {
    type: 'spawn_subagents',
    children: [
      {
        goal: 'Inspect the concrete evidence.',
      },
    ],
    usage,
  },
  {
    type: 'final',
    output: 'The evidence has been summarized.',
    usage,
  },
]);
provider.setResponses('leaf', [
  {
    type: 'final',
    output: 'The concrete evidence is valid.',
    usage,
  },
]);

await scheduler.runUntilIdle();

console.log('Model request order:');
console.log(provider.requests.map((request) => request.taskId).join(' -> '));
console.log(`Root state: ${root.state.status}`);
console.log(`Live agents after completion: ${scheduler.liveAgentCount}`);
