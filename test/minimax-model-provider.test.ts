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
      tool_choice?: string;
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
      tool_choice: 'auto',
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

  it('reserves enough completion tokens in the desktop registry', () => {
    const provider = createConfiguredProvider(
      {
        providerId: 'minimax',
        apiKey: 'test-key',
        modelId: 'MiniMax-M3',
      },
      192,
    );

    expect(provider).toBeInstanceOf(MiniMaxModelProvider);
    expect(provider.estimate(request).maxOutputTokens).toBe(4_096);
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
