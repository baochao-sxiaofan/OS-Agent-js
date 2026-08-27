import { describe, expect, it } from 'vitest';

import { TURN_SUMMARY_PROTOCOL, type ModelRequest } from '../src/index.js';
import {
  AGENT_RESPONSE_JSON_SCHEMA,
  parseStructuredAgentResponse,
  serializeContextItemForModel,
} from '../src/model/structured-agent-response.js';

const request: ModelRequest = {
  taskId: 'internal-parent-id',
  goal: 'Delegate one isolated task.',
  context: [],
  tools: [],
  attempt: 1,
  summaryProtocol: TURN_SUMMARY_PROTOCOL,
  delegation: {
    canSpawnSubagents: true,
  },
};

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.001,
};

describe('structured agent protocol', () => {
  it('does not expose taskId as an allowed child field', () => {
    expect(
      AGENT_RESPONSE_JSON_SCHEMA.properties.children.items.properties,
    ).not.toHaveProperty('taskId');
  });

  it('ignores a model-supplied child taskId at the parsing boundary', () => {
    const response = parseStructuredAgentResponse(
      JSON.stringify({
        action: 'spawn_subagents',
        children: [
          {
            taskId: 'model-controlled-id',
            goal: 'Complete the isolated task.',
          },
        ],
        turnSummary: {
          request: 'Delegate one isolated task.',
          outcome: 'Prepared one child task.',
        },
      }),
      request,
      usage,
    );

    expect(response).toMatchObject({
      type: 'spawn_subagents',
      children: [
        {
          goal: 'Complete the isolated task.',
        },
      ],
    });
    if (response.type !== 'spawn_subagents') {
      return;
    }
    expect(response.children[0]).not.toHaveProperty('taskId');
  });

  it('redacts internal child task IDs from model-visible context', () => {
    const update = serializeContextItemForModel({
      type: 'async_work_update',
      generationId: 'generation-1',
      results: [
        {
          workId: 'internal-child-task-id',
          kind: 'subagent',
          label: 'Research',
          status: 'completed',
          completedAt: 10,
          termination: {
            kind: 'completed',
            output: 'done',
          },
        },
        {
          workId: 'tool-call-1',
          kind: 'tool',
          label: 'search',
          status: 'completed',
          completedAt: 11,
          output: 'result',
        },
      ],
      pending: [
        {
          workId: 'internal-pending-child-id',
          kind: 'subagent',
          label: 'Verify',
          startedAt: 12,
        },
      ],
      allFinished: false,
    });
    const legacyResult = serializeContextItemForModel({
      type: 'subagent_result',
      childTaskId: 'legacy-child-task-id',
      result: {
        kind: 'completed',
        output: 'legacy result',
      },
    });

    expect(update).toMatchObject({
      results: [
        {
          kind: 'subagent',
          label: 'Research',
        },
        {
          kind: 'tool',
          workId: 'tool-call-1',
        },
      ],
      pending: [
        {
          kind: 'subagent',
          label: 'Verify',
        },
      ],
    });
    expect(
      (update['results'] as Array<Record<string, unknown>>)[0],
    ).not.toHaveProperty('workId');
    expect(
      (update['pending'] as Array<Record<string, unknown>>)[0],
    ).not.toHaveProperty('workId');
    expect(legacyResult).not.toHaveProperty('childTaskId');
  });

  it('parses capability requests without exposing an approval route', () => {
    const response = parseStructuredAgentResponse(
      JSON.stringify({
        action: 'request_capabilities',
        capabilityRequests: [
          {
            capability: 'file.write',
            scope: {
              kind: 'exact',
              resource: 'file:///repo/src/auth.ts',
            },
            reason: 'The assigned change requires this file.',
          },
        ],
        turnSummary: {
          request: 'Modify the authentication implementation.',
          outcome: 'Identified the missing file permission.',
        },
      }),
      request,
      usage,
    );

    expect(response).toMatchObject({
      type: 'request_capabilities',
      requests: [
        {
          capability: 'file.write',
          scope: {
            kind: 'exact',
            resource: 'file:///repo/src/auth.ts',
          },
        },
      ],
    });
    expect(response).not.toHaveProperty('route');
  });

  it('parses a parent decision without letting the model issue grants', () => {
    const response = parseStructuredAgentResponse(
      JSON.stringify({
        action: 'resolve_capability_request',
        requestRef: 'capability-request-1',
        decision: 'approve',
        turnSummary: {
          request: 'Review a child capability request.',
          outcome: 'Approved the requested scope.',
        },
      }),
      {
        ...request,
        context: [
          {
            type: 'async_work_update',
            generationId: 'generation-1',
            results: [],
            pending: [
              {
                workId: 'internal-child-id',
                kind: 'subagent',
                label: 'Implement the change.',
                startedAt: 1,
                status: 'waiting_for_capability',
                blocker: {
                  type: 'capability_request',
                  requestRef: 'capability-request-1',
                  requests: [
                    {
                      capability: 'file.write',
                      scope: { kind: 'all' },
                    },
                  ],
                  blockedAt: 2,
                },
              },
            ],
            allFinished: false,
          },
        ],
      },
      usage,
    );

    expect(response).toEqual({
      type: 'resolve_capability_request',
      requestRef: 'capability-request-1',
      decision: 'approve',
      turnSummary: {
        request: 'Review a child capability request.',
        outcome: 'Approved the requested scope.',
      },
      usage,
    });
    expect(response).not.toHaveProperty('grants');
  });

  it('does not allow waiting while a capability blocker needs a decision', () => {
    expect(() =>
      parseStructuredAgentResponse(
        JSON.stringify({
          action: 'wait_for_async_work',
          turnSummary: {
            request: 'Review pending work.',
            outcome: 'Deferred the decision.',
          },
        }),
        {
          ...request,
          context: [
            {
              type: 'async_work_update',
              generationId: 'generation-1',
              results: [],
              pending: [
                {
                  workId: 'internal-child-id',
                  kind: 'subagent',
                  label: 'Implement the change.',
                  startedAt: 1,
                  status: 'waiting_for_capability',
                  blocker: {
                    type: 'capability_request',
                    requestRef: 'capability-request-1',
                    requests: [
                      {
                        capability: 'file.write',
                        scope: { kind: 'all' },
                      },
                    ],
                    blockedAt: 2,
                  },
                },
              ],
              allFinished: false,
            },
          ],
        },
        usage,
      ),
    ).toThrow('must resolve pending capability requests');
  });
});
