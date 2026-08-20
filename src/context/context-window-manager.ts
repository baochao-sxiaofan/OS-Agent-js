import type {
  ContextItem,
  ContextSummaryRecord,
} from '../kernel/context.js';

export type ContextWindowPolicy = {
  warningRatio: number;
  targetRatio: number;
};

export type ContextSelection = {
  context: readonly ContextItem[];
  mode: 'full' | 'hybrid';
  tokenEstimate: number;
  needsSecondaryCompaction: boolean;
};

export class ContextWindowManager {
  constructor(
    readonly contextWindowTokens: number,
    readonly policy: ContextWindowPolicy = {
      warningRatio: 0.8,
      targetRatio: 0.6,
    },
  ) {
    if (!Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0) {
      throw new Error('Context window tokens must be a positive integer.');
    }
    if (
      !Number.isFinite(policy.targetRatio) ||
      !Number.isFinite(policy.warningRatio) ||
      policy.targetRatio <= 0 ||
      policy.warningRatio >= 1 ||
      policy.targetRatio >= policy.warningRatio
    ) {
      throw new Error(
        'Context ratios must satisfy 0 < targetRatio < warningRatio < 1.',
      );
    }
  }

  get warningTokens(): number {
    return Math.floor(
      this.contextWindowTokens * this.policy.warningRatio,
    );
  }

  get targetTokens(): number {
    return Math.floor(this.contextWindowTokens * this.policy.targetRatio);
  }

  select(
    fullContext: readonly ContextItem[],
    summaries: readonly ContextSummaryRecord[],
    estimateTokens: (context: readonly ContextItem[]) => number,
  ): ContextSelection {
    const fullTokenEstimate = estimateTokens(fullContext);
    if (fullTokenEstimate <= this.warningTokens) {
      return {
        context: structuredClone(fullContext),
        mode: 'full',
        tokenEstimate: fullTokenEstimate,
        needsSecondaryCompaction: false,
      };
    }

    const selectedSummaries: ContextSummaryRecord[] = [];
    let candidate = structuredClone(fullContext);
    let tokenEstimate = fullTokenEstimate;

    for (const summary of this.replacementOrder(fullContext, summaries)) {
      selectedSummaries.push(summary);
      candidate = this.replaceRanges(fullContext, selectedSummaries);
      tokenEstimate = estimateTokens(candidate);
      if (tokenEstimate <= this.targetTokens) {
        return {
          context: candidate,
          mode: 'hybrid',
          tokenEstimate,
          needsSecondaryCompaction: false,
        };
      }
    }

    return {
      context: candidate,
      mode: 'hybrid',
      tokenEstimate,
      needsSecondaryCompaction: true,
    };
  }

  private replacementOrder(
    fullContext: readonly ContextItem[],
    summaries: readonly ContextSummaryRecord[],
  ): ContextSummaryRecord[] {
    const validSummaries = summaries.filter(
      (summary) =>
        summary.sourceStartIndex >= 0 &&
        summary.sourceEndIndex <= fullContext.length &&
        summary.sourceEndIndex > summary.sourceStartIndex,
    );
    const latestSecondary = validSummaries
      .filter(
        (summary) =>
          summary.kind === 'secondary' && summary.sourceStartIndex === 0,
      )
      .sort(
        (left, right) =>
          right.sourceEndIndex - left.sourceEndIndex ||
          right.createdAt - left.createdAt,
      )[0];
    const replacementOrder: ContextSummaryRecord[] = [];
    let coveredUntil = 0;

    if (latestSecondary) {
      replacementOrder.push(latestSecondary);
      coveredUntil = latestSecondary.sourceEndIndex;
    }

    const turnSummaries = validSummaries
      .filter(
        (summary) =>
          summary.kind === 'turn' &&
          summary.sourceStartIndex >= coveredUntil,
      )
      .sort(
        (left, right) =>
          left.sourceStartIndex - right.sourceStartIndex ||
          left.sourceEndIndex - right.sourceEndIndex,
      );
    for (const summary of turnSummaries) {
      if (summary.sourceStartIndex < coveredUntil) {
        continue;
      }
      replacementOrder.push(summary);
      coveredUntil = summary.sourceEndIndex;
    }
    return replacementOrder;
  }

  private replaceRanges(
    fullContext: readonly ContextItem[],
    summaries: readonly ContextSummaryRecord[],
  ): ContextItem[] {
    const result: ContextItem[] = [];
    let cursor = 0;

    for (const record of [...summaries].sort(
      (left, right) => left.sourceStartIndex - right.sourceStartIndex,
    )) {
      if (record.sourceStartIndex < cursor) {
        continue;
      }
      result.push(
        ...structuredClone(
          fullContext.slice(cursor, record.sourceStartIndex),
        ),
      );
      result.push({
        type: 'context_summary',
        request: record.summary.request,
        outcome: record.summary.outcome,
      });
      cursor = record.sourceEndIndex;
    }
    result.push(...structuredClone(fullContext.slice(cursor)));
    return result;
  }
}
