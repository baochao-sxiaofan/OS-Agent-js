import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'release-echo', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'failure') {
    return { isError: true, content: [{ type: 'text', text: '读取失败' }] };
  }
  if (request.params.name === 'disconnect') {
    // 完成当前回执后退出，后续新操作应建立新连接，不自动重发旧操作。
    setTimeout(() => { void server.close().then(() => process.exit(0)); }, 20);
  }
  return { content: [{ type: 'text', text: String(process.pid) }] };
});
await server.connect(new StdioServerTransport());
