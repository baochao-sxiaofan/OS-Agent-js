import { expect, it, vi } from 'vitest';
import { createModelRequester, listAvailableModels, type ModelCompletionRequest } from '../src/model-requester/index.js';

const request: ModelCompletionRequest = { messages: [{ role: 'user', content: '读取文件' }],
  tools: [{ name: 'file.read', description: '读取', parameters: { type: 'object' } }],
  toolChoice: { name: 'file.read' }, parallelToolCalls: false, maxOutputTokens: 4096 };
const response = (message: object = { content: '完成' }) => ({
  id: 'reply', choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
});
type Wire = {
  model: string; thinking: { type: string }; reasoning_effort?: string; max_tokens: number;
  max_completion_tokens?: number; parallel_tool_calls: boolean; reasoning_split?: boolean;
  tools: { function: { name: string } }[]; tool_choice: string | { function: { name: string } };
  messages: { role: string; content: string; reasoning_content?: string; tool_calls?: { function: { name: string } }[] }[];
};
function requester(fetchImplementation: typeof fetch, extra = {}) {
  return createModelRequester({ provider: 'deepseek', model: 'test-model', apiKey: 'test-secret',
    fetchImplementation, ...extra });
}

it('DeepSeek 使用独立协议，点号工具稳定映射并还原，思考状态随工具续接重放', async () => {
  const bodies: Wire[] = [];
  const model = requester(async (url, init) => {
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-secret' });
    const body = JSON.parse(String(init?.body)) as Wire;
    bodies.push(body);
    return Response.json(bodies.length === 1 ? response({ content: null, reasoning_content: '私有续接状态',
      tool_calls: [{ id: 'call-1', type: 'function',
        function: { name: body.tools[0]!.function.name, arguments: '{"path":"a.txt"}' } }] }) : response());
  });
  const first = await model.request({ ...request, toolChoice: 'required' });
  expect(first).toMatchObject({ provider: 'deepseek', model: 'test-model',
    usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } });
  expect(first.message.content).toBe('');
  expect(first.message.toolCalls[0]).toEqual({ id: 'call-1', name: 'file.read', arguments: { path: 'a.txt' } });
  await model.request({ ...request, toolChoice: 'none', messages: [...request.messages, first.message,
    { role: 'tool', callId: 'call-1', content: { text: '文件内容' } }] });
  const body = bodies[0]!;
  const alias = body.tools[0]!.function.name;
  expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u);
  expect(body).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high',
    max_tokens: 4096, parallel_tool_calls: false, tool_choice: 'auto' });
  expect(body.max_completion_tokens).toBeUndefined();
  expect(body.reasoning_split).toBeUndefined();
  expect(bodies[1]!.messages[1]).toMatchObject({ reasoning_content: '私有续接状态',
    tool_calls: [{ function: { name: alias } }] });
  expect(bodies[1]!.messages[2]).toMatchObject({ role: 'tool', content: '{"text":"文件内容"}' });
});

it.each(['minimax', 'deepseek'] as const)('拒绝跨供应商或跨型号续接：%s', async (provider) => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(requester(fetcher).request({ messages: [{ role: 'assistant', content: '', toolCalls: [],
    continuation: { provider, model: provider === 'deepseek' ? 'other-model' : 'test-model', data: {} } }] }))
    .rejects.toMatchObject({ code: 'invalid_request', provider: 'deepseek' });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['required', { name: 'file.read' }] as const)('兼容强制工具契约，缺少调用拒绝返回：%j', async (toolChoice) => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)) as Wire;
    expect(wire.thinking.type).toBe(typeof toolChoice === 'object' ? 'disabled' : 'enabled');
    expect(wire.tool_choice).toEqual(typeof toolChoice === 'object'
      ? { type: 'function', function: { name: wire.tools[0]!.function.name } } : 'auto');
    return Response.json(response());
  });
  await expect(requester(fetcher).request({ ...request, toolChoice })).rejects.toMatchObject({
    code: 'invalid_response', retryable: true,
  });
  expect(fetcher).toHaveBeenCalledOnce();
});

it('指定工具保持完整定义，返回其他已声明工具仍拒绝', async () => {
  const model = requester(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)) as Wire;
    expect(wire.tools).toHaveLength(2);
    expect(wire.tools[0]?.function.name).toMatch(/^file_read__/u);
    expect(wire.thinking.type).toBe('disabled');
    expect(wire.reasoning_effort).toBeUndefined();
    return Response.json(response({ tool_calls: [{ id: 'wrong', function: { name: 'other', arguments: '{}' } }] }));
  });
  await expect(model.request({ ...request, tools: [...request.tools!,
    { name: 'other', description: '不能被选择', parameters: {} }] })).rejects.toMatchObject({ code: 'invalid_response' });
});

it.each(['required', { name: 'file.read' }] as const)('非思考模式保留原生强制工具参数：%j', async (toolChoice) => {
  const model = requester(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)) as Wire;
    const name = wire.tools[0]!.function.name;
    expect(wire.thinking.type).toBe('disabled');
    expect(wire.tool_choice).toEqual(typeof toolChoice === 'string' ? 'required'
      : { type: 'function', function: { name } });
    return Response.json(response({ tool_calls: [{ id: 'call', function: { name, arguments: '{}' } }] }));
  }, { thinking: 'disabled' });
  await expect(model.request({ ...request, toolChoice })).resolves.toMatchObject({
    message: { toolCalls: [{ name: 'file.read' }] },
  });
});

it('非思考模式不发送思考强度，续接数据不能覆盖内容和角色', async () => {
  const model = requester(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)) as Wire;
    expect(wire.thinking).toEqual({ type: 'disabled' });
    expect(wire.reasoning_effort).toBeUndefined();
    expect(wire.messages[0]).toEqual({ role: 'assistant', content: '原始内容' });
    return Response.json(response());
  }, { thinking: 'disabled' });
  await model.request({ messages: [{ role: 'assistant', content: '原始内容', toolCalls: [],
    continuation: { provider: 'deepseek', model: 'test-model', data: { role: 'system', content: '覆盖' } } }] });
});

it.each(['[]', '{"broken":', 'null'])('拒绝错误工具参数：%s', async (argumentsText) => {
  const model = requester(async () => Response.json(response({ tool_calls: [
    { id: 'call-1', function: { name: 'file_read', arguments: argumentsText } },
  ] })));
  await expect(model.request(request)).rejects.toMatchObject({ code: 'invalid_response' });
});

it('拒绝无工具的强制调用、不支持的图片和重复工具', async () => {
  const fetcher = vi.fn<typeof fetch>();
  for (const invalid of [
    { messages: request.messages, toolChoice: 'required' as const },
    { messages: [{ role: 'user' as const, content: [{ type: 'image' as const, url: 'https://example.com' }] }] },
    { ...request, tools: [...request.tools!, ...request.tools!] },
  ]) await expect(requester(fetcher).request(invalid)).rejects.toMatchObject({ code: 'invalid_request' });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([{ status: 401, retryable: false }, { status: 402, retryable: false },
  { status: 429, retryable: true }, { status: 503, retryable: true }])(
  'HTTP $status 保留错误分类但不泄漏服务端文案', async ({ status, retryable }) => {
    const model = requester(async () => Response.json({ error: { message: 'test-secret 敏感内容' } }, {
      status, headers: { 'retry-after': '2' },
    }));
    const error = await model.request(request).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'http_error', provider: 'deepseek', status, retryable, retryAfterMs: 2000 });
    expect(String(error)).not.toContain('test-secret');
    expect(String(error)).not.toContain('敏感内容');
  });

it.each([
  ["Invalid schema for function 'private-tool': Pointer '/private' does not exist", 'invalid_tool_schema'],
  ['Missing reasoning_content field in an assistant message', 'invalid_tool_history'],
  ['maximum context length exceeded', 'context_length_exceeded'],
  ['private-request-content', undefined],
] as const)('HTTP400 返回可操作的安全分类：%s', async (message, requestReason) => {
  const error = await requester(async () => Response.json({ error: { message: `${message} test-secret` } }, { status: 400 }))
    .request(request).catch((value: unknown) => value);
  expect(error).toMatchObject({ code: 'http_error', status: 400, retryable: false, requestReason });
  expect(String(error)).not.toContain(message);
  expect(String(error)).not.toContain('test-secret');
  expect(JSON.stringify(error)).not.toContain('test-secret');
});

it('错误正文过大或不是JSON时保留HTTP状态，不泄漏正文', async () => {
  for (const text of ['x'.repeat(20_000), 'test-secret-invalid-json']) {
    await expect(requester(async () => new Response(text, { status: 400 })).request(request))
      .rejects.toMatchObject({ code: 'http_error', status: 400, requestReason: undefined });
  }
});

it('超时和取消贯穿请求，不泄漏底层网络异常', async () => {
  const hanging: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('test-secret')), { once: true });
  });
  await expect(requester(hanging, { timeoutMs: 10 }).request(request)).rejects.toMatchObject({ code: 'timeout' });
  const controller = new AbortController();
  const pending = requester(hanging).request(request, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled', retryable: false });
  const fetcher = vi.fn<typeof fetch>();
  await expect(requester(fetcher).request(request, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
  expect(fetcher).not.toHaveBeenCalled();
  const network = await requester(async () => { throw new Error('test-secret'); }).request(request).catch((e: unknown) => e);
  expect(network).toMatchObject({ code: 'network_error' });
  expect(String(network)).not.toContain('test-secret');
});

it('从官方 /models 读取实际型号，去重，不依赖硬编码名称', async () => {
  const fetcher: typeof fetch = async (url, init) => {
    expect(url).toBe('https://api.deepseek.com/models');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-secret' });
    return Response.json({ object: 'list', data: [{ id: 'new-model-b' }, { id: 'new-model-a' }, { id: 'new-model-b' }] });
  };
  const result = await listAvailableModels({ provider: 'deepseek', apiKey: 'test-secret', fetchImplementation: fetcher });
  expect(result).toEqual({ provider: 'deepseek', source: 'api',
    models: [{ id: 'new-model-a', label: 'new-model-a' }, { id: 'new-model-b', label: 'new-model-b' }] });
});

it('型号发现处理空列表、无效响应与认证失败，MiniMax 列表无需联网', async () => {
  const options = { provider: 'deepseek' as const, apiKey: 'test-secret' };
  await expect(listAvailableModels({ ...options, fetchImplementation: async () => Response.json({ object: 'list', data: [] }) }))
    .resolves.toMatchObject({ models: [] });
  await expect(listAvailableModels({ ...options, fetchImplementation: async () => Response.json({ data: [{ id: '' }] }) }))
    .rejects.toMatchObject({ code: 'invalid_response' });
  await expect(listAvailableModels({ ...options, fetchImplementation: async () => new Response('test-secret', { status: 401 }) }))
    .rejects.toMatchObject({ code: 'http_error', status: 401 });
  const fetcher = vi.fn<typeof fetch>();
  await expect(listAvailableModels({ provider: 'deepseek', fetchImplementation: fetcher })).rejects.toMatchObject({ code: 'invalid_request' });
  const minimax = await listAvailableModels({ provider: 'minimax', fetchImplementation: fetcher });
  expect(minimax.source).toBe('builtin');
  expect(minimax.models.length).toBeGreaterThan(1);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([{ prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 4 },
  { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 12 }, {}])('cache usage preserves zero and absence: %j', async (cache) => {
  const model = requester(async () => Response.json({ ...response(), usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13, ...cache } }));
  const result = await model.request({ messages: request.messages });
  if ('prompt_cache_hit_tokens' in cache) expect(result.usage).toMatchObject({ cacheHitTokens: cache.prompt_cache_hit_tokens, cacheMissTokens: cache.prompt_cache_miss_tokens });
  else expect(result.usage).not.toHaveProperty('cacheHitTokens');
});
