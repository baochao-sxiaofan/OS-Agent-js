import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  AdmissionController,
  createWorkspaceCapabilityRequests,
  InMemoryTaskStore,
  OpenAiCompatibleModelProvider,
  registerBuiltinTools,
  TaskScheduler,
  ToolRegistry,
} from '../src/index.js';

function providerResponse(content: object): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify(content),
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
  );
}

describe('real-provider shaped tool loop', () => {
  it('parses a provider tool call, writes through ToolRuntime, then completes', async () => {
    const workspace = mkdtempSync(
      join(tmpdir(), 'os-agent-provider-loop-'),
    );
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        providerResponse({
          action: 'tool_calls',
          calls: [
            {
              callId: 'write-1',
              toolName: 'file.create',
              input: {
                path: 'workspace://current/game.ts',
                content: 'export const ready = true;\n',
              },
            },
          ],
          turnSummary: {
            request: 'Create the game entrypoint.',
            outcome: 'Prepared the file write.',
          },
        }),
      )
      .mockResolvedValueOnce(
        providerResponse({
          action: 'final',
          output: 'Created game.ts.',
          turnSummary: {
            request: 'Verify the write result.',
            outcome: 'The file was created.',
          },
        }),
      );
    const provider = new OpenAiCompatibleModelProvider({
      providerId: 'test',
      apiKey: 'test-key',
      baseUrl: 'https://provider.invalid/v1',
      model: 'test-model',
      fetchImplementation,
    });
    const tools = new ToolRegistry();
    registerBuiltinTools(tools);
    const scheduler = new TaskScheduler({
      provider,
      tools,
      store: new InMemoryTaskStore(),
      admission: new AdmissionController({
        maxConcurrentRequests: 1,
        requestsPerMinute: 20,
        tokensPerMinute: 20_000,
      }),
      workspaceRootResolver: () => workspace,
    });
    const task = await scheduler.submit({
      id: 'provider-tool-root',
      goal: 'Create a game entrypoint.',
      characterId: 'coordinator',
      capabilities: createWorkspaceCapabilityRequests(),
    });

    try {
      await scheduler.runUntilIdle();

      expect(readFileSync(join(workspace, 'game.ts'), 'utf8')).toBe(
        'export const ready = true;\n',
      );
      expect(task.state).toMatchObject({
        status: 'TERMINATED',
        termination: {
          kind: 'completed',
          output: 'Created game.ts.',
        },
      });
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
      const secondRequest = JSON.parse(
        String(fetchImplementation.mock.calls[1]?.[1]?.body),
      ) as {
        messages?: Array<{ content?: string }>;
      };
      const modelInput = JSON.parse(
        secondRequest.messages?.[1]?.content ?? '{}',
      ) as {
        context?: Array<{
          type?: string;
          results?: Array<{ kind?: string; label?: string }>;
        }>;
      };
      expect(modelInput.context).toContainEqual(
        expect.objectContaining({
          type: 'async_work_update',
          results: [
            expect.objectContaining({
              kind: 'tool',
              label: 'file.create',
            }),
          ],
        }),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
