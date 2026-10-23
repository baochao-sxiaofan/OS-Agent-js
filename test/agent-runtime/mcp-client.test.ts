import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect, it } from 'vitest';
import { RuntimeMcpClient } from '../../src/integrations/index.js';

it('真实 HTTP MCP 握手和工具调用保留幂等键，不把远端结果当作授权', async () => {
  const protocol = new Server({ name: 'test', version: '1' }, { capabilities: { tools: {} } });
  protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
  ] }));
  let idempotencyKey: string | undefined;
  protocol.setRequestHandler(CallToolRequestSchema, async (request) => {
    idempotencyKey = String(request.params._meta?.['os-agent/idempotency-key']);
    return { content: [{ type: 'text', text: String(request.params.arguments?.message) }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await protocol.connect(transport as Transport);
  const server = createServer((request, response) => {
    void transport.handleRequest(request, response).catch(() => { response.writeHead(500); response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试地址无效');
  const client = new RuntimeMcpClient({ echo: { transport: 'http', url: `http://127.0.0.1:${address.port}` } });
  try {
    const result = await client.callTool({
      serverId: 'echo', toolName: 'echo', arguments: { message: 'hello' },
      idempotencyKey: 'stable-key', signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ content: [{ text: 'hello' }] });
    expect(idempotencyKey).toBe('stable-key');
  } finally {
    await client.close(); await protocol.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('真实 stdio MCP 进程执行协议，不继承宿主模型凭据', async () => {
  const client = new RuntimeMcpClient({ echo: {
    transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('../fixtures/mcp-server.mjs', import.meta.url))],
  } });
  try {
    const result = await client.callTool({
      serverId: 'echo', toolName: 'echo', arguments: { message: 'stdio-ok' },
      signal: new AbortController().signal, idempotencyKey: 'stable',
    });
    expect(result).toMatchObject({ content: [{ text: 'stdio-ok' }] });
  } finally { await client.close(); }
});
