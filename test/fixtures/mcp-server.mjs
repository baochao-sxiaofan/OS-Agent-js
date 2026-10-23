import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'local-echo', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: 'text', text: String(request.params.arguments?.message) }],
}));
await server.connect(new StdioServerTransport());
