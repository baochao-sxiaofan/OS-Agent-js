import type {
  ContextCompactionRequest,
  ContextCompactionResult,
  ContextCompactor,
} from './context-compactor.js';
import type { ModelRequestEstimate } from '../model/model-provider.js';

export type FakeContextCompactorOptions = {
  id?: string;
  contextWindowTokens?: number;
  estimate?:
    | ModelRequestEstimate
    | ((request: ContextCompactionRequest) => ModelRequestEstimate);
};

export class FakeContextCompactor implements ContextCompactor {
  readonly id: string;
  readonly contextWindowTokens: number;
  readonly #estimate:
    | ModelRequestEstimate
    | ((request: ContextCompactionRequest) => ModelRequestEstimate);
  readonly #requests: ContextCompactionRequest[] = [];
  readonly #results = new Map<string, ContextCompactionResult[]>();

  constructor(options: FakeContextCompactorOptions = {}) {
    this.id = options.id ?? 'fake-context-compactor';
    this.contextWindowTokens = options.contextWindowTokens ?? 128_000;
    this.#estimate = options.estimate ?? {
      inputTokens: 100,
      maxOutputTokens: 100,
      estimatedCostUsd: 0.001,
    };
  }

  get requests(): readonly ContextCompactionRequest[] {
    return this.#requests;
  }

  setResults(
    taskId: string,
    results: readonly ContextCompactionResult[],
  ): void {
    this.#results.set(taskId, structuredClone([...results]));
  }

  estimate(request: ContextCompactionRequest): ModelRequestEstimate {
    return typeof this.#estimate === 'function'
      ? this.#estimate(request)
      : { ...this.#estimate };
  }

  async compact(
    request: ContextCompactionRequest,
    signal: AbortSignal,
  ): Promise<ContextCompactionResult> {
    signal.throwIfAborted();
    this.#requests.push(structuredClone(request));
    const result = this.#results.get(request.taskId)?.shift();
    if (!result) {
      throw new Error(
        `No fake context compaction result configured for ${request.taskId}`,
      );
    }
    return structuredClone(result);
  }
}
