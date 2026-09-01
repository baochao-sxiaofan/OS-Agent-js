import { describe, expect, it } from 'vitest';

import {
  AdmissionController,
  CharacterRegistry,
  FakeModelProvider,
  InMemoryTaskStore,
  TaskScheduler,
  ToolRegistry,
  registerBuiltinTools,
  type ProcessSandbox,
  type SubagentSpawnRejectedContextItem,
} from '../src/index.js';

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.001,
};

function createRuntime(
  taskIds: readonly string[] = [],
  processSandbox?: ProcessSandbox,
) {
  const provider = new FakeModelProvider();
  const tools = new ToolRegistry();
  registerBuiltinTools(tools, {
    ...(processSandbox === undefined ? {} : { processSandbox }),
  });
  const store = new InMemoryTaskStore();
  const admission = new AdmissionController({
    maxConcurrentRequests: 2,
    requestsPerMinute: 50,
    tokensPerMinute: 50_000,
  });
  const pending = [...taskIds];
  const scheduler = new TaskScheduler({
    provider,
    tools,
    store,
    admission,
    characterRegistry: new CharacterRegistry(),
    ...(taskIds.length === 0
      ? {}
      : {
          taskIdGenerator: () => {
            const next = pending.shift();
            if (!next) {
              throw new Error('Test task ID sequence exhausted.');
            }
            return next;
          },
        }),
  });
  return { provider, scheduler, tools };
}

describe('TaskScheduler character enforcement', () => {
  it('shows only the character-visible tools to the model', async () => {
    const { provider, scheduler } = createRuntime();
    const task = await scheduler.submit({
      id: 'auditor-root',
      goal: 'Audit the workspace.',
      characterId: 'code_auditor',
    });
    provider.setResponses(task.id, [
      { type: 'final', output: 'audit done', usage },
    ]);

    await scheduler.runUntilIdle();

    const toolNames = (provider.requests[0]?.tools ?? []).map(
      (tool) => tool.name,
    );
    expect(toolNames).toContain('file.read');
    expect(toolNames).toContain('directory.list');
    expect(toolNames).toContain('workspace.search');
    // 审计角色看不到写入工具；当前测试运行时未注入 ProcessSandbox，
    // 因此全局目录中也不存在 test.run。
    expect(toolNames).not.toContain('file.write');
    expect(toolNames).not.toContain('file.apply_patch');
    expect(toolNames).not.toContain('test.run');
    expect(provider.requests[0]?.character).toMatchObject({
      id: 'code_auditor',
      displayName: '代码审计员',
    });
    expect(
      provider.requests[0]?.character?.instructions,
    ).toContain('read-only');
    expect(
      provider.requests[0]?.delegation.availableCharacters,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'developer' }),
        expect.objectContaining({ id: 'code_auditor' }),
        expect.objectContaining({ id: 'researcher' }),
      ]),
    );
  });

  it('gives a coordinator the registered child-character catalog', async () => {
    const { provider, scheduler } = createRuntime();
    const task = await scheduler.submit({
      id: 'coordinator-root',
      goal: 'Coordinate the work.',
      characterId: 'coordinator',
    });
    provider.setResponses(task.id, [
      { type: 'final', output: 'done', usage },
    ]);

    await scheduler.runUntilIdle();

    expect(
      provider.requests[0]?.delegation.availableCharacters?.map(
        (character) => character.id,
      ),
    ).toEqual([
      'developer',
      'code_auditor',
      'researcher',
      'tester',
    ]);
  });

  it('shows test.run to an auditor only when a sandbox backend exists', async () => {
    const { provider, scheduler } = createRuntime([], {
      run: async () => ({ exitCode: 0 }),
    });
    const task = await scheduler.submit({
      id: 'auditor-with-sandbox',
      goal: 'Run verification without modifying source files.',
      characterId: 'code_auditor',
      capabilities: ['test.run'],
    });
    provider.setResponses(task.id, [
      { type: 'final', output: 'verified', usage },
    ]);

    await scheduler.runUntilIdle();

    const toolNames = provider.requests[0]?.tools.map(({ name }) => name);
    expect(toolNames).toContain('test.run');
    expect(toolNames).not.toContain('file.write');
  });

  it('rejects runtime capability requests outside the character policy', async () => {
    const { provider, scheduler } = createRuntime();
    const task = await scheduler.submit({
      id: 'auditor-request',
      goal: 'Try to modify a file.',
      characterId: 'code_auditor',
    });
    provider.setResponses(task.id, [
      {
        type: 'request_capabilities',
        requests: [
          {
            capability: 'file.write',
            scope: {
              kind: 'exact',
              resource: 'workspace://current/src/index.ts',
            },
          },
        ],
        usage,
      },
      { type: 'final', output: 'request denied', usage },
    ]);

    await scheduler.runUntilIdle();

    expect(task.context).toContainEqual(
      expect.objectContaining({
        type: 'capability_request_result',
        status: 'denied',
        reason:
          'Character code_auditor cannot request capability file.write.',
      }),
    );
  });

  it('rejects coordinator as a child of every character', async () => {
    const { provider, scheduler } = createRuntime();
    const root = await scheduler.submit({
      id: 'auditor-parent',
      goal: 'Try to create a coordinator.',
      characterId: 'code_auditor',
    });
    provider.setResponses(root.id, [
      {
        type: 'spawn_subagents',
        children: [
          {
            goal: 'Coordinate more work.',
            character: 'coordinator',
          },
        ],
        usage,
      },
      { type: 'final', output: 'root done', usage },
    ]);

    await scheduler.runUntilIdle();

    const rejection = root.context.find(
      (item): item is SubagentSpawnRejectedContextItem =>
        item.type === 'subagent_spawn_rejected',
    );
    expect(rejection?.reason).toBe('capability_escalation');
    expect(rejection?.message).toContain('coordinator');
  });

  it('rejects delegating a capability outside the child character ceiling', async () => {
    const { provider, scheduler } = createRuntime(['research-child']);
    const root = await scheduler.submit({
      id: 'root-with-authority',
      goal: 'Delegate research with too much power.',
      capabilities: [
        {
          capability: 'file.delete',
          scope: { kind: 'subtree', resource: 'workspace://current/' },
        },
      ],
    });
    provider.setResponses(root.id, [
      {
        type: 'spawn_subagents',
        children: [
          {
            goal: 'Research and delete files.',
            character: 'researcher',
            requestedCapabilities: [
              {
                capability: 'file.delete',
                scope: {
                  kind: 'subtree',
                  resource: 'workspace://current/',
                },
              },
            ],
          },
        ],
        usage,
      },
      { type: 'final', output: 'root done', usage },
    ]);

    await scheduler.runUntilIdle();

    const rejection = root.context.find(
      (item): item is SubagentSpawnRejectedContextItem =>
        item.type === 'subagent_spawn_rejected',
    );
    expect(rejection?.reason).toBe('capability_escalation');
    expect(rejection?.message).toContain('file.delete');
    expect(scheduler.getTask('research-child')).toBeUndefined();
  });

  it('allows a permitted child character within its ceiling', async () => {
    const parentRole = {
      id: 'tech_lead',
      displayName: 'Tech Lead',
      promptFragment: 'Coordinate developers.',
      visibleToolIds: ['directory.list'],
      capabilityCeiling: ['*'],
      requestableCapabilities: [],
      allowedChildCharacters: ['developer'],
    };
    const provider = new FakeModelProvider();
    const tools = new ToolRegistry();
    registerBuiltinTools(tools);
    const scheduler = new TaskScheduler({
      provider,
      tools,
      store: new InMemoryTaskStore(),
      admission: new AdmissionController({
        maxConcurrentRequests: 2,
        requestsPerMinute: 50,
        tokensPerMinute: 50_000,
      }),
      characterRegistry: new CharacterRegistry([
        parentRole,
        {
          id: 'developer',
          displayName: 'Developer',
          promptFragment: 'Write code.',
          visibleToolIds: ['file.read', 'file.write'],
          capabilityCeiling: ['file.read', 'file.write'],
          requestableCapabilities: ['file.read', 'file.write'],
          allowedChildCharacters: [],
        },
      ]),
      taskIdGenerator: () => 'dev-child',
    });
    const root = await scheduler.submit({
      id: 'lead-root',
      goal: 'Lead the work.',
      characterId: 'tech_lead',
      capabilities: [
        {
          capability: 'file.write',
          scope: { kind: 'subtree', resource: 'workspace://current/' },
        },
      ],
    });
    provider.setResponses(root.id, [
      {
        type: 'spawn_subagents',
        children: [
          {
            goal: 'Implement a feature.',
            character: 'developer',
            requestedCapabilities: [
              {
                capability: 'file.write',
                scope: {
                  kind: 'subtree',
                  resource: 'workspace://current/src',
                },
              },
            ],
          },
        ],
        usage,
      },
      { type: 'final', output: 'root done', usage },
    ]);
    provider.setResponses('dev-child', [
      { type: 'final', output: 'feature done', usage },
    ]);

    await scheduler.runUntilIdle();

    const child = scheduler.getTask('dev-child');
    expect(child).toBeDefined();
    expect(child?.characterId).toBe('developer');
    expect(
      root.context.some((item) => item.type === 'subagent_spawn_rejected'),
    ).toBe(false);
  });
});
