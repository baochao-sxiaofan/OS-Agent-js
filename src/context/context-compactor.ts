import type { ContextItem, TurnSummary } from '../kernel/context.js';
import {
  TURN_SUMMARY_PROTOCOL,
  type TurnSummaryProtocol,
  type ModelRequestEstimate,
  type ModelUsage,
} from '../model/model-provider.js';

export const SECONDARY_COMPACTION_INSTRUCTION =
  'Compress the supplied hybrid history into a self-contained structured summary. Preserve the original request, durable constraints, completed work, decisions, and unresolved work.';

export type ContextCompactionRequest = {
  taskId: string;
  goal: string;
  context: readonly ContextItem[];
  targetTokens: number;
  instruction: string;
  summaryProtocol: TurnSummaryProtocol;
};

export type ContextCompactionResult = {
  summary: TurnSummary;
  usage: ModelUsage;
};

export interface ContextCompactor {
  readonly id: string;
  readonly contextWindowTokens: number;

  estimate(request: ContextCompactionRequest): ModelRequestEstimate;

  compact(
    request: ContextCompactionRequest,
    signal: AbortSignal,
  ): Promise<ContextCompactionResult>;
}

export function createContextCompactionRequest(
  request: Omit<
    ContextCompactionRequest,
    'instruction' | 'summaryProtocol'
  >,
): ContextCompactionRequest {
  return {
    ...request,
    instruction: SECONDARY_COMPACTION_INSTRUCTION,
    summaryProtocol: TURN_SUMMARY_PROTOCOL,
  };
}
