import type { TurnSummary } from '../kernel/context.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import type {
  ModelRequest,
  ModelResponse,
  ModelUsage,
  SubagentSpawnRequest,
} from './model-provider.js';

export const AGENT_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: [
        'final',
        'needs_parent_action',
        'spawn_subagents',
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
          taskId: { type: 'string' },
          goal: { type: 'string' },
          capabilities: {
            type: 'array',
            items: { type: 'string' },
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
    requiredWork: { type: 'string' },
    partialOutput: { type: 'string' },
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
  'Select exactly one action: final, needs_parent_action, spawn_subagents, or wait_for_async_work.',
  'Use final when the task is complete.',
  'Use spawn_subagents only when delegation.canSpawnSubagents is true and the goal benefits from independent parallel work.',
  'Use wait_for_async_work only when an async_work_update has unfinished pending work.',
  'When async_work_update.allFinished is true, synthesize its results and normally return final.',
  'Use needs_parent_action only when a child cannot proceed without parent work.',
  'Always include turnSummary with concise request and outcome strings.',
  'For final include output. For spawn_subagents include a non-empty children array.',
].join(' ');

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
      return {
        type: 'wait_for_async_work',
        turnSummary,
        usage,
      };
    default:
      throw new Error(`Model returned unsupported action: ${action}`);
  }
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
    const taskId = optionalString(object['taskId'], `${path}.taskId`);
    const capabilities = optionalStringArray(
      object['capabilities'],
      `${path}.capabilities`,
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
      ...(taskId === undefined ? {} : { taskId }),
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(maxModelAttempts === undefined
        ? {}
        : { maxModelAttempts }),
      ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    };
  });
}

function hasPendingAsyncWork(request: ModelRequest): boolean {
  return request.context.some(
    (item) =>
      item.type === 'async_work_update' &&
      !item.allFinished &&
      item.pending.length > 0,
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
