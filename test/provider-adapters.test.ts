import { describe, expect, it, vi } from 'vitest';

import {
  AnthropicModelProvider,
  OpenAiCompatibleModelProvider,
  TURN_SUMMARY_PROTOCOL,
  type ModelRequest,
} from '../src/index.js';

const request: ModelRequest = {
  taskId: 'provider-test',
  goal: 'Return pong.',
  context: [{ type: 'user', content: 'ping' }],
  tools: [
    {
      name: 'file.read',
      description: 'Read a file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ],
  capabilities: [
    {
      capability: 'file.read',
      scope: {
        kind: 'subtree',
        resource: 'workspace://current/',
      },
    },
  ],
  character: {
    id: 'developer',
    displayName: 'Developer',
    instructions: 'Read before editing.',
    requestableCapabilities: ['file.read', 'file.write'],
  },
  attempt: 1,
  summaryProtocol: TURN_SUMMARY_PROTOCOL,
  delegation: {
    canSpawnSubagents: false,
    availableCharacters: [],
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

describe('provider adapters', () => {
  it('keeps OpenAI-compatible credentials in headers', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: structuredOutput,
              },
            },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 10,
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const provider = new OpenAiCompatibleModelProvider({
      providerId: 'mimo',
      apiKey: 'secret-test-key',
      baseUrl: 'https://api.example.test/v1',
      model: 'test-model',
      apiKeyHeader: 'api-key',
      maxTokensField: 'max_completion_tokens',
      fetchImplementation,
    });

    const result = await provider.invoke(request, new AbortController().signal);

    expect(result).toMatchObject({
      type: 'final',
      output: 'pong',
    });
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe('https://api.example.test/v1/chat/completions');
    expect(String(url)).not.toContain('secret-test-key');
    expect(new Headers(init?.headers).get('api-key')).toBe(
      'secret-test-key',
    );
    const body = JSON.parse(String(init?.body)) as {
      max_completion_tokens?: number;
      messages?: Array<{ content?: string; role?: string }>;
    };
    expect(body).not.toHaveProperty('max_completion_tokens');
    const modelInput = JSON.parse(
      body.messages?.[1]?.content ?? '{}',
    ) as {
      taskId?: string;
      tools?: Array<{ inputSchema?: unknown }>;
      capabilities?: unknown[];
    };
    expect(modelInput).not.toHaveProperty('taskId');
    expect(body.messages?.[0]?.content).toContain(
      'Your character is developer',
    );
    expect(modelInput).toMatchObject({
      character: {
        id: 'developer',
      },
    });
    expect(modelInput.tools?.[0]?.inputSchema).toBeDefined();
    expect(modelInput.capabilities).toHaveLength(1);
  });

  it('uses Anthropic headers and parses structured text content', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: structuredOutput,
            },
          ],
          usage: {
            input_tokens: 30,
            output_tokens: 12,
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const provider = new AnthropicModelProvider({
      apiKey: 'secret-anthropic-key',
      model: 'test-model',
      fetchImplementation,
    });

    const result = await provider.invoke(request, new AbortController().signal);

    expect(result).toMatchObject({
      type: 'final',
      output: 'pong',
    });
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(String(url)).not.toContain('secret-anthropic-key');
    expect(new Headers(init?.headers).get('x-api-key')).toBe(
      'secret-anthropic-key',
    );
    expect(new Headers(init?.headers).get('anthropic-version')).toBe(
      '2023-06-01',
    );
    const body = JSON.parse(String(init?.body)) as {
      system?: string;
      messages?: Array<{ content?: string }>;
    };
    const modelInput = JSON.parse(
      body.messages?.[0]?.content ?? '{}',
    ) as {
      taskId?: string;
      tools?: Array<{ inputSchema?: unknown }>;
      capabilities?: unknown[];
    };
    expect(modelInput).not.toHaveProperty('taskId');
    expect(body.system).toContain('Your character is developer');
    expect(modelInput).toMatchObject({
      character: {
        id: 'developer',
      },
    });
    expect(modelInput.tools?.[0]?.inputSchema).toBeDefined();
    expect(modelInput.capabilities).toHaveLength(1);
  });

  it('parses a real-provider tool call response', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'tool_calls',
                  calls: [
                    {
                      callId: 'read-1',
                      toolName: 'file.read',
                      input: {
                        path: 'workspace://current/src/index.ts',
                      },
                    },
                  ],
                  turnSummary: {
                    request: 'Inspect the entrypoint.',
                    outcome: 'Prepared a file read.',
                  },
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 10,
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const provider = new OpenAiCompatibleModelProvider({
      providerId: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://api.example.test/v1',
      model: 'test-model',
      fetchImplementation,
    });

    await expect(
      provider.invoke(request, new AbortController().signal),
    ).resolves.toMatchObject({
      type: 'tool_calls',
      calls: [
        {
          callId: 'read-1',
          toolName: 'file.read',
        },
      ],
    });
  });
});
