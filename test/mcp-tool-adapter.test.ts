import { describe, expect, it, vi } from 'vitest';

import {
  createMcpToolAdapter,
  type McpClientPort,
} from '../src/index.js';

describe('MCP tool adapter', () => {
  it('keeps capability policy local while delegating execution to MCP', async () => {
    const callTool = vi.fn<McpClientPort['callTool']>().mockResolvedValue({
      content: 'hello',
    });
    const tool = createMcpToolAdapter(
      { callTool },
      {
        name: 'file.read',
        description: 'Read a workspace file.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        effect: 'read_only',
        serverId: 'filesystem',
        remoteToolName: 'read_text_file',
        requiredCapabilities: (input) => [
          {
            capability: 'file.read',
            scope: {
              kind: 'exact',
              resource: String(input['path']),
            },
          },
        ],
      },
    );
    const input = { path: 'workspace://current/README.md' };

    expect(tool.requiredCapabilities?.(input)).toEqual([
      {
        capability: 'file.read',
        scope: {
          kind: 'exact',
          resource: 'workspace://current/README.md',
        },
      },
    ]);
    await expect(
      tool.execute(input, {
        taskId: 'task-1',
        signal: new AbortController().signal,
        idempotencyKey: 'task-1:call-1',
      }),
    ).resolves.toEqual({ content: 'hello' });
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'filesystem',
        toolName: 'read_text_file',
        arguments: input,
      }),
    );
  });
});
