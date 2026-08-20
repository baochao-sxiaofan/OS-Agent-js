import {
  AdmissionController,
  FakeModelProvider,
  InMemoryTaskStore,
  TaskScheduler,
  ToolRegistry,
  type Tool,
} from '../src/index.js';

const inspectResourceTool: Tool = {
  name: 'inspect_resource',
  description: 'Inspect a named local resource without modifying it.',
  requiredCapability: 'resource:inspect',
  effect: 'read_only',
  validateInput: (input) =>
    typeof input['name'] === 'string'
      ? { valid: true }
      : { valid: false, error: 'name must be a string' },
  execute: async (input) => ({
    resource: input['name'] ?? null,
    status: 'available',
  }),
};

const provider = new FakeModelProvider();
const tools = new ToolRegistry();
tools.register(inspectResourceTool);

const scheduler = new TaskScheduler({
  provider,
  tools,
  store: new InMemoryTaskStore(),
  admission: new AdmissionController({
    maxConcurrentRequests: 2,
    requestsPerMinute: 20,
    tokensPerMinute: 20_000,
  }),
});

const task = await scheduler.submit({
  id: 'demo-task',
  goal: 'Inspect the build worker and report its status.',
  capabilities: ['resource:inspect'],
  context: [
    {
      type: 'user',
      content: 'Inspect the build worker and report its status.',
    },
  ],
});

provider.setResponses(task.id, [
  {
    type: 'tool_calls',
    calls: [
      {
        callId: 'inspect-1',
        toolName: 'inspect_resource',
        input: { name: 'build-worker-1' },
      },
    ],
    usage: {
      inputTokens: 80,
      outputTokens: 20,
      costUsd: 0.001,
    },
  },
  {
    type: 'final',
    output: 'build-worker-1 is available.',
    usage: {
      inputTokens: 120,
      outputTokens: 12,
      costUsd: 0.0012,
    },
  },
]);

await scheduler.runUntilIdle();

console.log(`Task state: ${task.state.status}`);
console.log('State transitions:');
for (const event of task.events) {
  if (event.type === 'state_transitioned') {
    console.log(`  ${event.from} -> ${event.to.status}`);
  }
}
