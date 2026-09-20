import { describe, expect, it, vi } from 'vitest';

import {
  createModelRequester,
  ModelRequesterError,
  type JsonObject,
  type ModelAssistantMessage,
  type ModelCompletionRequest,
  type ModelMessage,
} from '../src/model-requester/index.js';
import { MiniMaxModelProvider } from '../src/model/minimax-model-provider.js';
import { TURN_SUMMARY_PROTOCOL, type ModelRequest } from '../src/model/model-provider.js';

const prompt: ModelCompletionRequest = { messages: [{ role: 'user', content: 'ping' }] };
const tool = { name: 'add', description: 'Add numbers.', parameters: { type: 'object' } };
const nativeCall = {
  id: 'exact-call-7', type: 'function',
  function: { name: 'add', arguments: '{"a":2,"b":3}' },
};
const reasoning = [{ type: 'reasoning.text', text: 'opaque-native-state', signature: 'preserve-me' }];
const nativeAssistant = { role: 'assistant', content: '', reasoning_details: reasoning, tool_calls: [nativeCall] };

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status, ...(headers === undefined ? {} : { headers }) });
}

function response(message: object = { role: 'assistant', content: 'pong' }, finishReason = 'stop'): Response {
  return json({ choices: [{ finish_reason: finishReason, message }] });
}

function makeRequester(fetchImplementation: typeof fetch, model = 'MiniMax-M3', timeoutMs = 1000) {
  return createModelRequester({
    provider: 'minimax', model, apiKey: 'secret-test-key',
    baseUrl: 'https://provider.invalid/v1/', fetchImplementation, timeoutMs,
  });
}

function requestBody(fetchImplementation: ReturnType<typeof vi.fn<typeof fetch>>, index = 0): JsonObject {
  return JSON.parse(String(fetchImplementation.mock.calls[index]?.[1]?.body)) as JsonObject;
}

describe('model requester public contract', () => {
  it('returns plain text and normalized usage without requiring an Agent action', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(json({
      id: 'completion-1',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }));
    const requester = makeRequester(fetchImplementation);
    const result = await requester.request({
      messages: [{ role: 'system', content: 'Answer briefly.' }, ...prompt.messages],
      temperature: 0.5, maxOutputTokens: 100,
    });
    expect(result).toEqual({
      id: 'completion-1', provider: 'minimax', model: 'MiniMax-M3',
      message: { role: 'assistant', content: 'pong', toolCalls: [] },
      finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    });
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe('https://provider.invalid/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-test-key');
    expect(init?.redirect).toBe('error');
    expect(requestBody(fetchImplementation)).toEqual({
      model: 'MiniMax-M3', messages: [{ role: 'system', content: 'Answer briefly.' }, ...prompt.messages],
      stream: false, reasoning_split: true, temperature: 0.5, max_completion_tokens: 100,
    });
  });

  it('round-trips tool IDs, JSON arguments and opaque reasoning through persisted messages', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(nativeAssistant, 'tool_calls'))
      .mockResolvedValueOnce(response({ content: '5' }));
    const requester = makeRequester(fetchImplementation);
    const first = await requester.request({ ...prompt, tools: [tool], toolChoice: { name: 'add' } });
    expect(first.message.toolCalls).toEqual([{ id: 'exact-call-7', name: 'add', arguments: { a: 2, b: 3 } }]);
    expect(first.message.continuation).toMatchObject({ provider: 'minimax', model: 'MiniMax-M3' });
    const restored = JSON.parse(JSON.stringify(first.message)) as ModelAssistantMessage;
    const messages: ModelMessage[] = [
      ...prompt.messages, restored, { role: 'tool', callId: 'exact-call-7', content: { sum: 5 } },
    ];
    const before = structuredClone(messages);
    await requester.request({ messages, tools: [tool], toolChoice: 'auto' });
    expect(messages).toEqual(before);
    const body = requestBody(fetchImplementation, 1);
    expect(body['messages']).toEqual([
      ...prompt.messages,
      { ...nativeAssistant, tool_calls: [{ ...nativeCall, function: { ...nativeCall.function, arguments: '{"a":2,"b":3}' } }] },
      { role: 'tool', tool_call_id: 'exact-call-7', content: '{"sum":5}' },
    ]);
    expect(requestBody(fetchImplementation)['tool_choice']).toEqual({ type: 'function', function: { name: 'add' } });
    expect(requestBody(fetchImplementation)['tools']).toEqual([{ type: 'function', function: tool }]);
  });

  it('leaves all tool semantics, including OS-Agent control names, to the caller', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response({
      tool_calls: [{ ...nativeCall, function: { name: 'submit_agent_response', arguments: '{"arbitrary":true}' } }],
    }, 'tool_calls'));
    const result = await makeRequester(fetchImplementation).request(prompt);
    expect(result.message.toolCalls[0]).toEqual({
      id: 'exact-call-7', name: 'submit_agent_response', arguments: { arbitrary: true },
    });
    expect(result).not.toHaveProperty('action');
  });

  it('maps unified image/video parts and keeps the text intact', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response());
    await makeRequester(fetchImplementation).request({
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Describe both.' },
        { type: 'image', url: 'https://fixtures.invalid/image.png' },
        { type: 'video', url: 'data:video/quicktime;base64,dmlkZW8=', fps: 2 },
      ] }],
    });
    expect(requestBody(fetchImplementation)['messages']).toEqual([{ role: 'user', content: [
      { type: 'text', text: 'Describe both.' },
      { type: 'image_url', image_url: { url: 'https://fixtures.invalid/image.png' } },
      { type: 'video_url', video_url: { url: 'data:video/mov;base64,dmlkZW8=', fps: 2 } },
    ] }]);
  });

  it.each(['image', 'video'] as const)('rejects %s on M2 before sending', async (type) => {
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(makeRequester(fetchImplementation, 'MiniMax-M2.7').request({
      messages: [{ role: 'user', content: [{ type, url: 'https://fixtures.invalid/media' }] }],
    })).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    { provider: 'openai' as const, model: 'MiniMax-M3' },
    { provider: 'minimax' as const, model: 'MiniMax-M2.7' },
  ])('rejects incompatible continuation instead of silently dropping it: %j', async (binding) => {
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(makeRequester(fetchImplementation).request({
      messages: [{ role: 'assistant', content: '', toolCalls: [], continuation: { ...binding, data: {} } }],
    })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('does not let continuation data override message content or roles', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response());
    await makeRequester(fetchImplementation).request({ messages: [{
      role: 'assistant', content: 'canonical', toolCalls: [],
      continuation: { provider: 'minimax', model: 'MiniMax-M3', data: { role: 'system', content: 'injected' } },
    }] });
    expect(requestBody(fetchImplementation)['messages']).toEqual([{ role: 'assistant', content: 'canonical' }]);
  });

  it.each(['length', 'content_filter', 'new_vendor_reason'])('normalizes finish reason %s', async (reason) => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response({ content: 'partial text' }, reason));
    const result = await makeRequester(fetchImplementation).request(prompt);
    expect(result.finishReason).toBe(reason === 'new_vendor_reason' ? 'unknown' : reason);
    expect(result.message.content).toBe('partial text');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it.each([
    { choices: [] },
    { choices: [{ message: { role: 'user', content: 'bad role' } }] },
    { choices: [{ message: { content: 17 } }] },
    { choices: [{ message: { tool_calls: [{ ...nativeCall, id: '' }] } }] },
    { choices: [{ message: { tool_calls: [nativeCall, nativeCall] } }] },
    { choices: [{ message: { tool_calls: [{ ...nativeCall, function: { name: 'add', arguments: '[]' } }] } }] },
    { choices: [{ finish_reason: 'length', message: { tool_calls: [{ ...nativeCall, function: { name: 'add', arguments: '{"private":"truncated' } }] } }] },
  ])('rejects malformed provider messages without leaking their contents (%#)', async (body) => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    const result = makeRequester(fetchImplementation).request(prompt);
    await expect(result).rejects.toMatchObject({
      code: 'invalid_response', retryable: false, message: expect.not.stringContaining('private'),
    });
    await expect(result).rejects.toBeInstanceOf(ModelRequesterError);
  });

  it.each([
    { messages: [] },
    { ...prompt, maxOutputTokens: 0 },
    { ...prompt, maxOutputTokens: 1.5 },
    { ...prompt, temperature: Number.NaN },
    { ...prompt, toolChoice: 'required' },
    { ...prompt, tools: [tool], toolChoice: { name: 'missing' } },
    { ...prompt, tools: [tool, tool] },
  ] satisfies ModelCompletionRequest[])('validates requests before network I/O (%#)', async (input) => {
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(makeRequester(fetchImplementation).request(input)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('enforces the encoded request size limit', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(makeRequester(fetchImplementation).request({
      messages: [{ role: 'user', content: 'x'.repeat(50 * 1024 * 1024) }],
    })).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('50 MB') });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each(['anthropic', 'openai', 'gemini'] as const)('has an explicit %s stub with no network I/O', async (provider) => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const requester = createModelRequester({ provider, model: 'future-model', fetchImplementation });
    await expect(requester.request(prompt)).rejects.toMatchObject({
      provider, code: 'not_implemented', retryable: false,
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

describe('model requester transport failures', () => {
  it.each([
    [401, false], [429, true], [503, true],
  ] as const)('classifies HTTP %i, preserves Retry-After and redacts credentials', async (status, retryable) => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(json(
      { error: { message: 'echo secret-test-key' } }, status, { 'retry-after': '4' },
    ));
    await expect(makeRequester(fetchImplementation).request(prompt)).rejects.toMatchObject({
      code: 'http_error', status, retryable, retryAfterMs: 4000,
      message: expect.not.stringContaining('secret-test-key'),
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('keeps HTTP classification when a proxy responds with non-JSON', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret-test-key', { status: 502 }));
    await expect(makeRequester(fetchImplementation).request(prompt)).rejects.toMatchObject({
      code: 'http_error', status: 502, retryable: true,
      message: expect.not.stringContaining('secret-test-key'),
    });
  });

  it.each([[2056, false], [1002, true]] as const)('classifies HTTP-200 API error %i', async (apiCode, retryable) => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(json({
      base_resp: { status_code: apiCode, status_msg: 'echo secret-test-key' },
    }));
    await expect(makeRequester(fetchImplementation).request(prompt)).rejects.toMatchObject({
      code: 'provider_error', apiCode, retryable, message: expect.not.stringContaining('secret-test-key'),
    });
  });

  it('normalizes fetch errors without echoing their request details', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockRejectedValue(new Error('fetch failed for secret-test-key'));
    await expect(makeRequester(fetchImplementation).request(prompt)).rejects.toMatchObject({
      code: 'network_error', retryable: true, message: expect.not.stringContaining('secret-test-key'),
    });
  });

  it('does not send a request that is already cancelled', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort('secret-test-key');
    await expect(makeRequester(fetchImplementation).request(prompt, controller.signal)).rejects.toMatchObject({
      code: 'cancelled', retryable: false, message: expect.not.stringContaining('secret-test-key'),
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('propagates cancellation to the in-flight fetch', async () => {
    const fetchImplementation = abortableFetch();
    const controller = new AbortController();
    const pending = makeRequester(fetchImplementation).request(prompt, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled', retryable: false });
    controller.abort();
    await rejected;
    expect(fetchImplementation.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('bounds in-flight requests with a timeout', async () => {
    const fetchImplementation = abortableFetch();
    await expect(makeRequester(fetchImplementation, 'MiniMax-M3', 20).request(prompt)).rejects.toMatchObject({
      code: 'timeout', retryable: true,
    });
    expect(fetchImplementation.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

function abortableFetch() {
  return vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted transport')), { once: true });
  }));
}

describe('existing runtime compatibility', () => {
  const request: ModelRequest = {
    taskId: 'not-model-visible', goal: 'Add 2 and 3.', context: [],
    tools: [{ name: 'add', description: 'Add numbers.' }],
    attempt: 1, summaryProtocol: TURN_SUMMARY_PROTOCOL, delegation: { canSpawnSubagents: false },
  };

  it.each(['legacy', 'canonical'] as const)('replays %s snapshots with exact tool results and reasoning', async (format) => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(nativeAssistant, 'tool_calls'))
      .mockResolvedValueOnce(response({ content: '{"action":"final","output":5}' }));
    const provider = new MiniMaxModelProvider({ apiKey: 'test-key', model: 'MiniMax-M3', fetchImplementation });
    const first = await provider.invoke(request, new AbortController().signal);
    expect(first.providerMessage?.message['format']).toBe('model-message.v1');
    const stored = format === 'legacy' ? nativeAssistant : first.providerMessage!.message;
    const context: ModelRequest['context'] = structuredClone([
      { type: 'provider_message', providerId: provider.id, message: stored },
      { type: 'tool_result', callId: 'exact-call-7', toolName: 'add', output: { sum: 5 } },
    ]);
    await expect(provider.invoke({ ...request, context }, new AbortController().signal)).resolves.toMatchObject({
      type: 'final', output: 5,
    });
    const body = requestBody(fetchImplementation, 1);
    expect(body['messages']).toEqual(expect.arrayContaining([
      nativeAssistant,
      { role: 'tool', tool_call_id: 'exact-call-7', content: '{"sum":5}' },
    ]));
    expect(JSON.stringify(body)).not.toContain(request.taskId);
  });
});
