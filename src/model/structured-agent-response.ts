import type {
  ContextItem,
  TurnSummary,
} from '../kernel/context.js';
import type {
  CapabilityRequest,
  ResourceScope,
} from '../capability/capability.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import type {
  ModelRequest,
  ModelResponse,
  ModelUsage,
  SubagentSpawnRequest,
  ToolCallRequest,
} from './model-provider.js';

export const AGENT_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: [
        'async_work',
        'final',
        'needs_parent_action',
        'request_capabilities',
        'resolve_capability_request',
        'spawn_subagents',
        'tool_calls',
        'wait_for_async_work',
      ],
    },
    output: { type: 'string' },
    children: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          goal: { type: 'string' },
          character: { type: 'string' },
          requestedCapabilities: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                capability: { type: 'string' },
                scope: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    kind: {
                      type: 'string',
                      enum: ['all', 'exact', 'subtree'],
                    },
                    resource: { type: 'string' },
                  },
                  required: ['kind'],
                },
                reason: { type: 'string' },
              },
              required: ['capability', 'scope'],
            },
          },
          maxModelAttempts: {
            type: 'integer',
            minimum: 1,
          },
          maxCostUsd: {
            type: 'number',
            minimum: 0,
          },
        },
        required: ['goal'],
      },
    },
    calls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          callId: { type: 'string' },
          toolName: { type: 'string' },
          input: {
            type: 'object',
            additionalProperties: true,
          },
        },
        required: ['callId', 'toolName', 'input'],
      },
    },
    requiredWork: { type: 'string' },
    partialOutput: { type: 'string' },
    capabilityRequests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          capability: { type: 'string' },
          scope: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: {
                type: 'string',
                enum: ['all', 'exact', 'subtree'],
              },
              resource: { type: 'string' },
            },
            required: ['kind'],
          },
          reason: { type: 'string' },
        },
        required: ['capability', 'scope'],
      },
    },
    requestRef: { type: 'string' },
    decision: {
      type: 'string',
      enum: ['approve', 'deny'],
    },
    reason: { type: 'string' },
    turnSummary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        request: { type: 'string' },
        outcome: { type: 'string' },
      },
      required: ['request', 'outcome'],
    },
  },
  required: ['action', 'turnSummary'],
} as const;

export const STRUCTURED_AGENT_INSTRUCTION = [
  'You are the model worker for OS-Agent-js.',
  'Return only one JSON object and no markdown.',
  'Select exactly one action: async_work, final, needs_parent_action, request_capabilities, resolve_capability_request, spawn_subagents, tool_calls, or wait_for_async_work.',
  'Use final when the task is complete.',
  'Use spawn_subagents only when delegation.canSpawnSubagents is true and the goal benefits from independent parallel work.',
  'Use tool_calls to invoke one or more visible tools. Use async_work to start tools and subagents in the same turn.',
  'For tool_calls include calls as {callId, toolName, input}; use only tools listed in the request and follow each inputSchema.',
  'The request capabilities list is authoritative for what you currently hold; request missing capabilities instead of assuming access.',
  'For async_work include at least one child or call.',
  'When spawning, choose character only from delegation.availableCharacters and request the narrowest required capability scopes.',
  'Use wait_for_async_work only when an async_work_update has unfinished pending work.',
  'When async_work_update.allFinished is true, synthesize its results and normally return final.',
  'Use needs_parent_action only when a child cannot proceed without parent work.',
  'Use request_capabilities when work requires capabilities you do not currently hold. Request the capabilities only; the OS chooses the approval route.',
  'Use resolve_capability_request only when async_work_update.pending contains a waiting_for_capability blocker. Approve or deny its requestRef; the OS remains the final authority.',
  'Always include turnSummary with concise request and outcome strings.',
  'For final include output. For spawn_subagents include a non-empty children array.',
  'Each child may set a character id to adopt a role; the OS rejects roles you cannot create.',
].join(' ');

/** Builds the complete system instruction for one concrete Agent. */
export function buildStructuredAgentSystemInstruction(
  request: ModelRequest,
): string {
  return [
    STRUCTURED_AGENT_INSTRUCTION,
    request.summaryProtocol.instruction,
    request.character === undefined
      ? undefined
      : [
          `Your character is ${request.character.id} (${request.character.displayName}).`,
          request.character.instructions,
          `You may request only these capabilities: ${request.character.requestableCapabilities.join(', ') || 'none'}.`,
        ].join(' '),
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');
}

/**
 * 把内核上下文投影为模型可见上下文。
 *
 * Task ID 只属于内核。旧快照中子 Agent 的 workId 可能曾直接复用 taskId，
 * 因此这里同时清除异步子任务和旧式 subagent_result 中的内部身份字段。
 */
export function serializeContextItemForModel(
  item: ContextItem,
): JsonObject {
  const serialized = structuredClone(item) as JsonObject;
  if (item.type === 'subagent_result') {
    delete serialized['childTaskId'];
    return serialized;
  }
  if (item.type !== 'async_work_update') {
    return serialized;
  }

  serialized['results'] = item.results.map((result) => {
    const visible = structuredClone(result) as JsonObject;
    if (result.kind === 'subagent') {
      delete visible['workId'];
    }
    return visible;
  });
  serialized['pending'] = item.pending.map((pending) => {
    const visible = structuredClone(pending) as JsonObject;
    if (pending.kind === 'subagent') {
      delete visible['workId'];
    }
    return visible;
  });
  return serialized;
}

export function parseStructuredAgentResponse(
  text: string,
  request: ModelRequest,
  usage: ModelUsage,
): ModelResponse {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(stripCodeFence(text)) as JsonValue;
  } catch {
    throw new Error('Model structured output was not valid JSON.');
  }

  const envelope = requireObject(parsed, 'structured output');
  const action = requireString(
    envelope['action'],
    'structured output.action',
  );
  const turnSummary = parseTurnSummary(envelope['turnSummary']);

  switch (action) {
    case 'tool_calls':
      return {
        type: 'tool_calls',
        calls: parseToolCalls(envelope['calls']),
        turnSummary,
        usage,
      };
    case 'async_work': {
      const children =
        envelope['children'] === undefined
          ? []
          : parseChildren(envelope['children']);
      const calls =
        envelope['calls'] === undefined
          ? []
          : parseToolCalls(envelope['calls']);
      if (children.length === 0 && calls.length === 0) {
        throw new Error(
          'structured output.async_work must include children or calls.',
        );
      }
      if (children.length > 0 && !request.delegation.canSpawnSubagents) {
        throw new Error(
          'Model requested subagents when delegation is disabled.',
        );
      }
      return {
        type: 'async_work',
        children,
        calls,
        turnSummary,
        usage,
      };
    }
    case 'final':
      return {
        type: 'final',
        output:
          envelope['output'] === undefined
            ? ''
            : structuredClone(envelope['output']),
        turnSummary,
        usage,
      };
    case 'needs_parent_action': {
      const partialOutput = envelope['partialOutput'];
      return {
        type: 'needs_parent_action',
        requiredWork: requireString(
          envelope['requiredWork'],
          'structured output.requiredWork',
        ),
        ...(partialOutput === undefined
          ? {}
          : { partialOutput: structuredClone(partialOutput) }),
        turnSummary,
        usage,
      };
    }
    case 'spawn_subagents':
      if (!request.delegation.canSpawnSubagents) {
        throw new Error(
          'Model requested subagents when delegation is disabled.',
        );
      }
      return {
        type: 'spawn_subagents',
        children: parseChildren(envelope['children']),
        turnSummary,
        usage,
      };
    case 'wait_for_async_work':
      if (!hasPendingAsyncWork(request)) {
        throw new Error(
          'Model requested async waiting without pending work.',
        );
      }
      if (hasAnyPendingCapabilityRequest(request)) {
        throw new Error(
          'Model must resolve pending capability requests before waiting.',
        );
      }
      return {
        type: 'wait_for_async_work',
        turnSummary,
        usage,
      };
    case 'request_capabilities':
      return {
        type: 'request_capabilities',
        requests: parseCapabilityRequests(
          envelope['capabilityRequests'],
          'structured output.capabilityRequests',
        ),
        turnSummary,
        usage,
      };
    case 'resolve_capability_request': {
      const requestRef = requireString(
        envelope['requestRef'],
        'structured output.requestRef',
      );
      if (!hasPendingCapabilityRequest(request, requestRef)) {
        throw new Error(
          'Model resolved a capability request that is not pending.',
        );
      }
      const reason = optionalString(
        envelope['reason'],
        'structured output.reason',
      );
      return {
        type: 'resolve_capability_request',
        requestRef,
        decision: parseCapabilityDecision(envelope['decision']),
        ...(reason === undefined ? {} : { reason }),
        turnSummary,
        usage,
      };
    }
    default:
      throw new Error(`Model returned unsupported action: ${action}`);
  }
}

function parseToolCalls(
  value: JsonValue | undefined,
): ToolCallRequest[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      'structured output.calls must be a non-empty array.',
    );
  }
  return value.map((call, index) => {
    const path = `structured output.calls[${index}]`;
    const object = requireObject(call, path);
    return {
      callId: requireString(object['callId'], `${path}.callId`),
      toolName: requireString(object['toolName'], `${path}.toolName`),
      input: requireObject(object['input'], `${path}.input`),
    };
  });
}

function parseTurnSummary(value: JsonValue | undefined): TurnSummary {
  const summary = requireObject(value, 'structured output.turnSummary');
  return {
    request: requireString(
      summary['request'],
      'structured output.turnSummary.request',
    ),
    outcome: requireString(
      summary['outcome'],
      'structured output.turnSummary.outcome',
    ),
  };
}

function parseChildren(
  value: JsonValue | undefined,
): SubagentSpawnRequest[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      'structured output.children must be a non-empty array.',
    );
  }
  return value.map((child, index) => {
    const path = `structured output.children[${index}]`;
    const object = requireObject(child, path);
    const character = optionalString(
      object['character'],
      `${path}.character`,
    );
    const capabilities = optionalStringArray(
      object['capabilities'],
      `${path}.capabilities`,
    );
    const requestedCapabilities =
      object['requestedCapabilities'] === undefined
        ? undefined
        : parseCapabilityRequests(
            object['requestedCapabilities'],
            `${path}.requestedCapabilities`,
          );
    const maxModelAttempts = optionalPositiveInteger(
      object['maxModelAttempts'],
      `${path}.maxModelAttempts`,
    );
    const maxCostUsd = optionalNonNegativeNumber(
      object['maxCostUsd'],
      `${path}.maxCostUsd`,
    );
    return {
      goal: requireString(object['goal'], `${path}.goal`),
      ...(character === undefined ? {} : { character }),
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(requestedCapabilities === undefined
        ? {}
        : { requestedCapabilities }),
      ...(maxModelAttempts === undefined
        ? {}
        : { maxModelAttempts }),
      ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    };
  });
}

function parseCapabilityRequests(
  value: JsonValue | undefined,
  path: string,
): CapabilityRequest[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array.`);
  }
  return value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const request = requireObject(item, itemPath);
    const reason = optionalString(request['reason'], `${itemPath}.reason`);
    return {
      capability: requireString(
        request['capability'],
        `${itemPath}.capability`,
      ),
      scope: parseResourceScope(
        request['scope'],
        `${itemPath}.scope`,
      ),
      ...(reason === undefined ? {} : { reason }),
    };
  });
}

function parseResourceScope(
  value: JsonValue | undefined,
  path: string,
): ResourceScope {
  const scope = requireObject(value, path);
  const kind = requireString(scope['kind'], `${path}.kind`);
  if (kind === 'all') {
    return { kind };
  }
  if (kind === 'exact' || kind === 'subtree') {
    return {
      kind,
      resource: requireString(scope['resource'], `${path}.resource`),
    };
  }
  throw new Error(`${path}.kind is not supported: ${kind}`);
}

function parseCapabilityDecision(
  value: JsonValue | undefined,
): 'approve' | 'deny' {
  const decision = requireString(
    value,
    'structured output.decision',
  );
  if (decision !== 'approve' && decision !== 'deny') {
    throw new Error(
      `structured output.decision is not supported: ${decision}`,
    );
  }
  return decision;
}

function hasPendingAsyncWork(request: ModelRequest): boolean {
  const latest = request.context.findLast(
    (item) => item.type === 'async_work_update',
  );
  return (
    latest !== undefined &&
    !latest.allFinished &&
    latest.pending.length > 0
  );
}

function hasPendingCapabilityRequest(
  request: ModelRequest,
  requestRef: string,
): boolean {
  return (
    request.context.findLast(
      (item) => item.type === 'async_work_update',
    )?.pending.some(
      (pending) =>
        pending.status === 'waiting_for_capability' &&
        pending.blocker?.requestRef === requestRef,
    ) ?? false
  );
}

function hasAnyPendingCapabilityRequest(request: ModelRequest): boolean {
  return (
    request.context.findLast(
      (item) => item.type === 'async_work_update',
    )?.pending.some(
      (pending) =>
        pending.status === 'waiting_for_capability' &&
        pending.blocker !== undefined,
    ) ?? false
  );
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function requireObject(
  value: JsonValue | undefined,
  path: string,
): JsonObject {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${path} must be a JSON object.`);
  }
  return value;
}

function requireString(
  value: JsonValue | undefined,
  path: string,
): string {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string.`);
  }
  return value;
}

function optionalString(
  value: JsonValue | undefined,
  path: string,
): string | undefined {
  return value === undefined ? undefined : requireString(value, path);
}

function optionalStringArray(
  value: JsonValue | undefined,
  path: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new Error(`${path} must be an array of strings.`);
  }
  return [...value] as string[];
}

function optionalInteger(
  value: JsonValue | undefined,
  path: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${path} must be an integer.`);
  }
  return value;
}

function optionalPositiveInteger(
  value: JsonValue | undefined,
  path: string,
): number | undefined {
  const parsed = optionalInteger(value, path);
  if (parsed !== undefined && parsed <= 0) {
    throw new Error(`${path} must be greater than zero.`);
  }
  return parsed;
}

function optionalNonNegativeNumber(
  value: JsonValue | undefined,
  path: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || value < 0) {
    throw new Error(`${path} must be a non-negative number.`);
  }
  return value;
}
