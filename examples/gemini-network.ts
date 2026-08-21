import {
  AdmissionController,
  GeminiModelProvider,
  InMemoryTaskStore,
  TaskScheduler,
  ToolRegistry,
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
  maxOutputTokens: 128,
});

const scheduler = new TaskScheduler({
  provider,
  tools: new ToolRegistry(),
  store: new InMemoryTaskStore(),
  admission: new AdmissionController({
    maxConcurrentRequests: 1,
    requestsPerMinute: 5,
    tokensPerMinute: 2_000,
  }),
});

const task = await scheduler.submit({
  id: 'gemini-network-check',
  goal: 'Reply with exactly the single lowercase word pong.',
  context: [
    {
      type: 'user',
      content: 'Reply with exactly the single lowercase word pong.',
    },
  ],
  maxModelAttempts: 1,
  budget: {
    maxCostUsd: 0.01,
  },
});

await scheduler.run();

console.log(
  JSON.stringify(
    {
      provider: provider.id,
      state: task.state,
      summaries: task.contextSummaries,
      usageEvents: task.events.filter(
        (event) => event.type === 'model_response_recorded',
      ),
    },
    null,
    2,
  ),
);
