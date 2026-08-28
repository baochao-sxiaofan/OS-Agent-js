import { describe, expect, it, vi } from 'vitest';

import { createConfiguredProvider } from '../desktop/main/provider-registry.js';
import {
  MiniMaxModelProvider,
  TURN_SUMMARY_PROTOCOL,
  type ModelRequest,
} from '../src/index.js';

const request: ModelRequest = {
  taskId: 'minimax-provider-test',
  goal: 'Return pong.',
  context: [{ type: 'user', content: 'ping' }],
  tools: [],
  attempt: 1,
  summaryProtocol: TURN_SUMMARY_PROTOCOL,
  delegation: {
    canSpawnSubagents: false,
  },
};

const structuredOutput = JSON.stringify({
  action: 'final',
  output: 'pong',
  turnSummary: {
    request: 'Return pong.',
    outcome: 'Returned pong.',
  },
});

const toolRequest: ModelRequest = {
  taskId: 'minimax-tool-test',
  goal: 'Create the entry file for the game.',
  context: [{ type: 'user', content: 'build it' }],
  tools: [
    {
      name: 'file.create',
      description: 'Create a new file in the workspace.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  ],
  attempt: 1,
  summaryProtocol: TURN_SUMMARY_PROTOCOL,
  delegation: {
    canSpawnSubagents: false,
  },
};

describe('MiniMaxModelProvider', () => {
  it('uses the documented reasoning and function-calling protocol', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              reasoning_details: [
                {
                  type: 'reasoning.text',
                  text: 'Reasoning is separated from content.',
                },
              ],
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'submit_agent_response',
                    arguments: structuredOutput,
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 30,
        },
        base_resp: {
          status_code: 0,
          status_msg: '',
        },
      }),
    );
    const provider = new MiniMaxModelProvider({
      apiKey: 'secret-minimax-key',
      baseUrl: 'https://api.example.test/v1',
      model: 'MiniMax-M3',
      maxOutputTokens: 4_096,
      fetchImplementation,
    });

    await expect(
      provider.invoke(request, new AbortController().signal),
    ).resolves.toMatchObject({
      type: 'final',
      output: 'pong',
      usage: {
        inputTokens: 20,
        outputTokens: 30,
      },
    });

    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe('https://api.example.test/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer secret-minimax-key',
    );
    const body = JSON.parse(String(init?.body)) as {
      max_completion_tokens?: number;
      reasoning_split?: boolean;
      response_format?: unknown;
      tool_choice?: unknown;
      tools?: Array<{
        function?: {
          name?: string;
          parameters?: {
            properties?: Record<string, unknown>;
          };
        };
      }>;
    };
    expect(body).toMatchObject({
      max_completion_tokens: 4_096,
      reasoning_split: true,
      tool_choice: 'required',
    });
    expect(body).not.toHaveProperty('response_format');
    expect(body.tools?.[0]?.function?.name).toBe(
      'submit_agent_response',
    );
    expect(
      body.tools?.[0]?.function?.parameters?.properties,
    ).toHaveProperty('action');
  });

  it('falls back to JSON content after removing native think tags', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: `<think>private reasoning</think>
\`\`\`json
${structuredOutput}
\`\`\``,
            },
          },
        ],
      }),
    );
    const provider = new MiniMaxModelProvider({
      apiKey: 'test-key',
      model: 'MiniMax-M3',
      fetchImplementation,
    });

    await expect(
      provider.invoke(request, new AbortController().signal),
    ).resolves.toMatchObject({
      type: 'final',
      output: 'pong',
    });
  });

  it('recovers the action object from content wrapped in prose', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: `Model here is the action you requested:\n${structuredOutput}\nLet me know if you need more.`,
              reasoning_details: [
                {
                  type: 'reasoning.text',
                  text: 'Private model reasoning.',
                },
              ],
            },
          },
        ],
      }),
    );
    const provider = new MiniMaxModelProvider({
      apiKey: 'test-key',
      model: 'MiniMax-M3',
      fetchImplementation,
    });

    await expect(
      provider.invoke(request, new AbortController().signal),
    ).resolves.toMatchObject({
      type: 'final',
      output: 'pong',
    });
  });

  it('reports truncation diagnostics without exposing response content', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            finish_reason: 'length',
            message: {
              content: '',
              reasoning_details: [
                {
                  type: 'reasoning.text',
                  text: 'Private model reasoning.',
                },
              ],
            },
          },
        ],
      }),
    );
    const provider = new MiniMaxModelProvider({
      apiKey: 'test-key',
      model: 'MiniMax-M3',
      fetchImplementation,
    });

    await expect(
      provider.invoke(request, new AbortController().signal),
    ).rejects.toThrow(
      /finishReason=length, contentLength=0, reasoningPresent=true/u,
    );
  });

  it('does not inject a desktop completion-token cap by default', () => {
    const provider = createConfiguredProvider(
      {
        providerId: 'minimax',
        apiKey: 'test-key',
        modelId: 'MiniMax-M3',
      },
    );

    expect(provider).toBeInstanceOf(MiniMaxModelProvider);
    expect(provider.estimate(request).maxOutputTokens).toBe(0);
  });

  it('maps a native business tool call to a tool_calls action', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'native-call-1',
                  type: 'function',
                  function: {
                    name: 'file.create',
                    arguments: JSON.stringify({
                      path: 'workspace://current/index.html',
                      content: '<!doctype html>',
                    }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const provider = new MiniMaxModelProvider({
      apiKey: 'test-key',
      model: 'MiniMax-M3',
      fetchImplementation,
    });

    const result = await provider.invoke(
      toolRequest,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      type: 'tool_calls',
      calls: [
        {
          callId: 'native-call-1',
          toolName: 'file.create',
          input: {
            path: 'workspace://current/index.html',
            content: '<!doctype html>',
          },
        },
      ],
    });
    expect(result.turnSummary).toMatchObject({
      outcome: expect.stringContaining('file.create'),
    });

    const [, init] = fetchImplementation.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as {
      tools?: Array<{ function?: { name?: string } }>;
    };
    const toolNames = (body.tools ?? []).map(
      (tool) => tool.function?.name,
    );
    expect(toolNames).toContain('submit_agent_response');
    expect(toolNames).toContain('file.create');
  });

  it('rejects a native call to a tool that is not visible this turn', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'native-call-2',
                  type: 'function',
                  function: {
                    name: 'git.push',
                    arguments: '{}',
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const provider = new MiniMaxModelProvider({
      apiKey: 'test-key',
      model: 'MiniMax-M3',
      fetchImplementation,
    });

    await expect(
      provider.invoke(toolRequest, new AbortController().signal),
    ).rejects.toThrow(/unavailable tool: git\.push/u);
  });

  it('tolerates a missing turnSummary on the control channel', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'ctrl-1',
                  type: 'function',
                  function: {
                    name: 'submit_agent_response',
                    arguments: JSON.stringify({
                      action: 'final',
                      output: 'done',
                    }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const provider = new MiniMaxModelProvider({
      apiKey: 'test-key',
      model: 'MiniMax-M3',
      fetchImplementation,
    });

    await expect(
      provider.invoke(request, new AbortController().signal),
    ).resolves.toMatchObject({
      type: 'final',
      output: 'done',
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}
