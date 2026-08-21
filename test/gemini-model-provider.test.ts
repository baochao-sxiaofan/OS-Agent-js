import { describe, expect, it, vi } from 'vitest';

import {
  AdmissionController,
  GeminiModelProvider,
  GeminiProviderError,
  InMemoryTaskStore,
  TaskScheduler,
  TURN_SUMMARY_PROTOCOL,
  ToolRegistry,
  type ModelRequest,
} from '../src/index.js';

const request: ModelRequest = {
  taskId: 'gemini-test',
  goal: 'Reply with pong.',
  context: [
    {
      type: 'user',
      content: 'Reply with pong.',
    },
  ],
  tools: [],
  attempt: 1,
  summaryProtocol: TURN_SUMMARY_PROTOCOL,
  delegation: {
    canSpawnSubagents: false,
    currentDepth: 0,
    maxDepth: 3,
    availableAgentSlots: 0,
  },
};

describe('GeminiModelProvider', () => {
  it('sends a structured generateContent request and parses the final result', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      action: 'final',
                      output: 'pong',
                      turnSummary: {
                        request: 'The user requested a pong response.',
                        outcome: 'Returned pong.',
                      },
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 24,
            candidatesTokenCount: 8,
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    const provider = new GeminiModelProvider({
      apiKey: 'test-api-key',
      model: 'gemini-test-model',
      baseUrl: 'https://gemini.invalid/v1beta/',
      maxOutputTokens: 64,
      pricing: {
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 2,
      },
      fetchImplementation,
    });

    const response = await provider.invoke(request, new AbortController().signal);

    expect(response).toEqual({
      type: 'final',
      output: 'pong',
      turnSummary: {
        request: 'The user requested a pong response.',
        outcome: 'Returned pong.',
      },
      usage: {
        inputTokens: 24,
        outputTokens: 8,
        costUsd: 0.00004,
      },
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();

    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://gemini.invalid/v1beta/models/gemini-test-model:generateContent',
    );
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe(
      'test-api-key',
    );

    const body = JSON.parse(String(init?.body)) as {
      generationConfig?: {
        maxOutputTokens?: number;
        responseMimeType?: string;
        responseJsonSchema?: {
          required?: string[];
        };
      };
    };
    expect(body.generationConfig).toMatchObject({
      maxOutputTokens: 64,
      responseMimeType: 'application/json',
    });
    expect(body.generationConfig?.responseJsonSchema?.required).toEqual([
      'action',
      'turnSummary',
    ]);
  });

  it('estimates input tokens and configured cost before admission', () => {
    const provider = new GeminiModelProvider({
      apiKey: 'test-api-key',
      maxOutputTokens: 32,
      pricing: {
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 2,
      },
      fetchImplementation: vi.fn<typeof fetch>(),
    });

    const estimate = provider.estimate(request);

    expect(estimate.inputTokens).toBeGreaterThan(0);
    expect(estimate.maxOutputTokens).toBe(32);
    expect(estimate.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('surfaces provider errors without including the API key', async () => {
    const provider = new GeminiModelProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn<typeof fetch>(async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: 'The model is unavailable.',
            },
          }),
          { status: 503 },
        );
      }),
    });

    await expect(
      provider.invoke(request, new AbortController().signal),
    ).rejects.toMatchObject({
      name: 'GeminiProviderError',
      status: 503,
      message: 'Gemini request failed (503): The model is unavailable.',
    });
    await expect(
      provider.invoke(request, new AbortController().signal),
    ).rejects.not.toThrow('secret-test-key');
  });

  it('rejects malformed structured model output at the provider boundary', async () => {
    const provider = new GeminiModelProvider({
      apiKey: 'test-api-key',
      fetchImplementation: vi.fn<typeof fetch>(async () => {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        action: 'final',
                        output: 'pong',
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    });

    await expect(
      provider.invoke(request, new AbortController().signal),
    ).rejects.toBeInstanceOf(GeminiProviderError);
  });

  it('propagates cancellation through fetch', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const provider = new GeminiModelProvider({
      apiKey: 'test-api-key',
      fetchImplementation,
    });
    const controller = new AbortController();

    const invocation = provider.invoke(request, controller.signal);
    controller.abort(new Error('cancelled by test'));

    await expect(invocation).rejects.toThrow('cancelled by test');
  });

  it('runs through the scheduler and terminates with a structured result', async () => {
    const provider = new GeminiModelProvider({
      apiKey: 'test-api-key',
      maxOutputTokens: 64,
      fetchImplementation: vi.fn<typeof fetch>(async () => {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        action: 'final',
                        output: 'pong',
                        turnSummary: {
                          request: 'The user requested pong.',
                          outcome: 'Returned pong.',
                        },
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 20,
              candidatesTokenCount: 8,
            },
          }),
          { status: 200 },
        );
      }),
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
      id: 'gemini-scheduler-integration',
      goal: 'Reply with pong.',
      maxModelAttempts: 1,
    });

    await scheduler.run();

    expect(task.state).toEqual({
      status: 'TERMINATED',
      enteredAt: expect.any(Number),
      termination: {
        kind: 'completed',
        output: 'pong',
      },
    });
    expect(task.contextSummaries).toMatchObject([
      {
        kind: 'turn',
        summary: {
          request: 'The user requested pong.',
          outcome: 'Returned pong.',
        },
      },
    ]);
  });

  it('parses subagent requests and preserves hybrid context in the prompt', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      action: 'spawn_subagents',
                      children: [
                        {
                          taskId: 'leaf-a',
                          goal: 'Return the square of 2.',
                          maxModelAttempts: 1,
                        },
                        {
                          taskId: 'leaf-b',
                          goal: 'Return the square of 3.',
                          maxModelAttempts: 1,
                        },
                      ],
                      turnSummary: {
                        request: 'Delegate two arithmetic checks.',
                        outcome: 'Created two leaf tasks.',
                      },
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const provider = new GeminiModelProvider({
      apiKey: 'test-api-key',
      fetchImplementation,
    });
    const hybridRequest: ModelRequest = {
      ...request,
      context: [
        {
          type: 'context_summary',
          request: 'Review the earlier requirements.',
          outcome: 'The stable constraints were preserved.',
        },
        {
          type: 'user',
          content: 'Delegate two arithmetic checks.',
        },
      ],
      delegation: {
        canSpawnSubagents: true,
        currentDepth: 1,
        maxDepth: 2,
        availableAgentSlots: 2,
      },
    };

    const response = await provider.invoke(
      hybridRequest,
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      type: 'spawn_subagents',
      children: [
        {
          taskId: 'leaf-a',
          goal: 'Return the square of 2.',
          maxModelAttempts: 1,
        },
        {
          taskId: 'leaf-b',
          goal: 'Return the square of 3.',
          maxModelAttempts: 1,
        },
      ],
    });

    const [, init] = fetchImplementation.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as {
      contents?: Array<{
        parts?: Array<{
          text?: string;
        }>;
      }>;
    };
    const promptText = body.contents?.[0]?.parts?.[0]?.text;
    const prompt = JSON.parse(promptText ?? '{}') as {
      context?: Array<{ type?: string }>;
      delegation?: {
        canSpawnSubagents?: boolean;
        availableAgentSlots?: number;
      };
    };
    expect(prompt.context?.map((item) => item.type)).toEqual([
      'context_summary',
      'user',
    ]);
    expect(prompt.delegation).toEqual({
      canSpawnSubagents: true,
      currentDepth: 1,
      maxDepth: 2,
      availableAgentSlots: 2,
    });
  });

  it('rejects a subagent action when delegation is disabled', async () => {
    const provider = new GeminiModelProvider({
      apiKey: 'test-api-key',
      fetchImplementation: vi.fn<typeof fetch>(async () => {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        action: 'spawn_subagents',
                        children: [
                          {
                            taskId: 'forbidden-child',
                            goal: 'This child must not be created.',
                          },
                        ],
                        turnSummary: {
                          request: 'Attempt an invalid delegation.',
                          outcome: 'Requested a child.',
                        },
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    });

    await expect(
      provider.invoke(request, new AbortController().signal),
    ).rejects.toThrow('delegation is disabled');
  });
});
