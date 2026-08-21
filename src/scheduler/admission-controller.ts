import type { ModelRequestEstimate } from '../model/model-provider.js';

const RATE_WINDOW_MS = 60_000;

export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export type AdmissionPolicy = {
  maxConcurrentRequests: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
};

export type AdmissionDenialReason =
  | 'budget_exceeded'
  | 'concurrency_exhausted'
  | 'request_token_limit_exceeded'
  | 'request_rate_exhausted'
  | 'token_rate_exhausted';

export type AdmissionDecision =
  | {
      admitted: true;
      lease: AdmissionLease;
    }
  | {
      admitted: false;
      reasons: AdmissionDenialReason[];
      retryable: boolean;
      retryAt?: number;
    };

type TokenReservation = {
  timestamp: number;
  tokens: number;
};

export class AdmissionLease {
  #released = false;

  constructor(readonly release: () => void) {}

  close(): void {
    if (this.#released) {
      return;
    }
    this.#released = true;
    this.release();
  }
}

export class AdmissionController {
  readonly #requestTimestamps: number[] = [];
  readonly #tokenReservations: TokenReservation[] = [];
  #activeRequests = 0;
  #peakActiveRequests = 0;

  constructor(
    readonly policy: AdmissionPolicy,
    readonly clock: Clock = new SystemClock(),
  ) {
    if (
      policy.maxConcurrentRequests <= 0 ||
      policy.requestsPerMinute <= 0 ||
      policy.tokensPerMinute <= 0
    ) {
      throw new Error('All admission limits must be greater than zero.');
    }
  }

  get activeRequests(): number {
    return this.#activeRequests;
  }

  get peakActiveRequests(): number {
    return this.#peakActiveRequests;
  }

  tryAcquire(
    estimate: ModelRequestEstimate,
    remainingBudgetUsd: number,
  ): AdmissionDecision {
    const now = this.clock.now();
    this.pruneExpired(now);

    const reasons: AdmissionDenialReason[] = [];
    let retryAt: number | undefined;

    if (estimate.estimatedCostUsd > remainingBudgetUsd) {
      reasons.push('budget_exceeded');
    }
    if (this.#activeRequests >= this.policy.maxConcurrentRequests) {
      reasons.push('concurrency_exhausted');
    }
    if (this.#requestTimestamps.length >= this.policy.requestsPerMinute) {
      reasons.push('request_rate_exhausted');
      const firstRequestTimestamp = this.#requestTimestamps[0];
      if (firstRequestTimestamp !== undefined) {
        retryAt = this.earliestRetryAt(
          retryAt,
          firstRequestTimestamp + RATE_WINDOW_MS,
        );
      }
    }

    const reservedTokens = this.#tokenReservations.reduce(
      (sum, reservation) => sum + reservation.tokens,
      0,
    );
    const requestedTokens = estimate.inputTokens + estimate.maxOutputTokens;
    if (requestedTokens > this.policy.tokensPerMinute) {
      reasons.push('request_token_limit_exceeded');
    } else if (
      reservedTokens + requestedTokens >
      this.policy.tokensPerMinute
    ) {
      reasons.push('token_rate_exhausted');
      const firstReservation = this.#tokenReservations[0];
      if (firstReservation) {
        retryAt = this.earliestRetryAt(
          retryAt,
          firstReservation.timestamp + RATE_WINDOW_MS,
        );
      }
    }

    if (reasons.length > 0) {
      const retryable =
        !reasons.includes('budget_exceeded') &&
        !reasons.includes('request_token_limit_exceeded');
      return {
        admitted: false,
        reasons,
        retryable,
        ...(retryAt === undefined ? {} : { retryAt }),
      };
    }

    this.#activeRequests += 1;
    this.#peakActiveRequests = Math.max(
      this.#peakActiveRequests,
      this.#activeRequests,
    );
    this.#requestTimestamps.push(now);
    this.#tokenReservations.push({
      timestamp: now,
      tokens: requestedTokens,
    });

    return {
      admitted: true,
      lease: new AdmissionLease(() => {
        this.#activeRequests -= 1;
      }),
    };
  }

  private pruneExpired(now: number): void {
    while (
      this.#requestTimestamps[0] !== undefined &&
      this.#requestTimestamps[0] <= now - RATE_WINDOW_MS
    ) {
      this.#requestTimestamps.shift();
    }
    while (
      this.#tokenReservations[0] !== undefined &&
      this.#tokenReservations[0].timestamp <= now - RATE_WINDOW_MS
    ) {
      this.#tokenReservations.shift();
    }
  }

  private earliestRetryAt(
    current: number | undefined,
    candidate: number,
  ): number {
    return current === undefined ? candidate : Math.min(current, candidate);
  }
}
