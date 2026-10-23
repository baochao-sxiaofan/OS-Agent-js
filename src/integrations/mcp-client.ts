import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpClientPort } from '../tools/mcp-tool-adapter.js';
import { ToolExecutionError } from '../tools/tool.js';
import type { JsonValue } from '../types/json.js';
import { jsonSchema } from '../types/json-schema.js';

export type McpConnection =
  | { readonly transport: 'stdio'; readonly command: string; readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>; readonly cwd?: string }
  | { readonly transport: 'http'; readonly url: string; readonly headers?: Readonly<Record<string, string>> };

/** 连接定义只由可信宿主提供；远端工具 schema 不授予本地权限。 */
export class RuntimeMcpClient implements McpClientPort {
  readonly #clients = new Map<string, Client>();
  readonly #connecting = new Map<string, Promise<Client>>();
  #closed = false;
  constructor(readonly connections: Readonly<Record<string, McpConnection>>) {}

  async #client(id: string): Promise<Client> {
    if (this.#closed) throw new Error('MCP 客户端已经关闭。');
    const ready = this.#clients.get(id);
    if (ready) return ready;
    const inFlight = this.#connecting.get(id);
    if (inFlight) return inFlight;
    const connection = this.connections[id];
    if (!connection) throw new Error('MCP 服务器未注册。');
    const promise = (async () => {
      const client = new Client({ name: 'os-agent-js', version: '3.0.0' });
      let disconnected = false;
      client.onclose = () => {
        disconnected = true;
        if (this.#clients.get(id) === client) this.#clients.delete(id);
      };
      const transport = connection.transport === 'http'
        ? new StreamableHTTPClientTransport(new URL(connection.url), {
          ...(connection.headers ? { requestInit: { headers: connection.headers } } : {}),
        })
        : new StdioClientTransport({
          command: connection.command, args: [...connection.args ?? []],
          // 显式空环境，避免把模型凭据继承给第三方进程。
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...connection.env },
          ...(connection.cwd ? { cwd: connection.cwd } : {}),
          stderr: 'ignore',
        });
      try {
        // SDK 的可选 sessionId 声明与 exactOptionalPropertyTypes 尚不一致。
        await client.connect(transport as Transport, { timeout: 15_000 });
        if (this.#closed || disconnected) throw new Error('MCP 连接已关闭。');
        this.#clients.set(id, client);
        return client;
      } catch { await client.close(); throw new Error('MCP 连接失败。'); }
      finally { this.#connecting.delete(id); }
    })();
    this.#connecting.set(id, promise);
    return promise;
  }

  async callTool(request: Parameters<McpClientPort['callTool']>[0]): Promise<JsonValue> {
    request.signal.throwIfAborted();
    const client = await this.#client(request.serverId);
    const result = await client.callTool({
      name: request.toolName, arguments: request.arguments,
      _meta: { 'os-agent/idempotency-key': request.idempotencyKey },
    }, undefined, { signal: request.signal, timeout: 120_000 });
    // 远端结果逐值验证，不在此处执行远端建议的本地操作。
    const validated = jsonSchema.parse(result);
    if (result.isError === true) {
      throw new ToolExecutionError('mcp_tool_failed', 'MCP 工具报告执行失败。', validated);
    }
    return validated;
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#connecting.values()]);
    await Promise.allSettled([...this.#clients.values()].map((client) => client.close()));
    this.#clients.clear();
  }
}
