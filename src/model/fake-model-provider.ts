import type {
  ModelProvider,
  ModelRequest,
  ModelRequestEstimate,
  ModelResponse,
} from './model-provider.js';

export type FakeModelProviderOptions = {
  id?: string;
  contextWindowTokens?: number;
  estimate?:
    | ModelRequestEstimate
    | ((request: ModelRequest) => ModelRequestEstimate);
  latencyMs?: number;
};

export class FakeModelProvider implements ModelProvider {
  readonly id: string;
  readonly contextWindowTokens: number;
  readonly #estimate:
    | ModelRequestEstimate
    | ((request: ModelRequest) => ModelRequestEstimate);
  readonly #latencyMs: number;
  readonly #responses = new Map<string, ModelResponse[]>();
  readonly #requests: ModelRequest[] = [];

  constructor(options: FakeModelProviderOptions = {}) {
    this.id = options.id ?? 'fake-model';
    this.contextWindowTokens = options.contextWindowTokens ?? 128_000;
    this.#estimate = options.estimate ?? {
      inputTokens: 100,
      maxOutputTokens: 100,
      estimatedCostUsd: 0.001,
    };
    this.#latencyMs = options.latencyMs ?? 0;
  }

  get requests(): readonly ModelRequest[] {
    return this.#requests;
  }

  setResponses(taskId: string, responses: readonly ModelResponse[]): void {
    this.#responses.set(taskId, structuredClone([...responses]));
  }

  estimate(request: ModelRequest): ModelRequestEstimate {
    return typeof this.#estimate === 'function'
      ? this.#estimate(request)
      : { ...this.#estimate };
  }

  async invoke(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    signal.throwIfAborted();
    this.#requests.push(structuredClone(request));

    if (this.#latencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, this.#latencyMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }

    const responses = this.#responses.get(request.taskId);
    const response = responses?.shift();
    if (!response) {
      throw new Error(`No fake model response configured for ${request.taskId}`);
    }
    return structuredClone(response);
  }
}
