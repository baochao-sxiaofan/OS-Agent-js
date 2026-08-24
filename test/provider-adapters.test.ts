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
  });
});
