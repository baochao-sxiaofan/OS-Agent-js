import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { RuntimeMcpClient } from '../../src/integrations/index.js';
import { ToolExecutionError } from '../../src/tools/tool.js';

const connection = {
  transport: 'stdio' as const, command: process.execPath,
  args: [fileURLToPath(new URL('../fixtures/mcp-release-server.mjs', import.meta.url))],
};
const input = (toolName: string) => ({
  serverId: 'fixture', toolName, arguments: {},
  idempotencyKey: `release:${toolName}`, signal: new AbortController().signal,
});

it('真实 stdio MCP 业务错误转为明确工具错误，保留远端结果', async () => {
  const client = new RuntimeMcpClient({ fixture: connection });
  try {
    const error = await client.callTool(input('failure')).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(error).toMatchObject({ code: 'mcp_tool_failed',
      result: { isError: true, content: [{ type: 'text', text: '读取失败' }] } });
  } finally { await client.close(); }
});

it('真实 MCP 进程退出后新操作重新握手，宿主关闭后拒绝新连接', async () => {
  const client = new RuntimeMcpClient({ fixture: connection });
  try {
    const first = await client.callTool(input('disconnect'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = await client.callTool(input('echo'));
    expect(first).not.toEqual(second);
    await client.close();
    await expect(client.callTool(input('echo'))).rejects.toThrow('已经关闭');
  } finally { await client.close(); }
});
