import type {
  ModelProvider,
  ModelRequest,
  ModelRequestEstimate,
  ModelResponse,
} from '../../src/index.js';

export class SwitchableModelProvider implements ModelProvider {
  #delegate: ModelProvider;

  constructor(delegate: ModelProvider) {
    this.#delegate = delegate;
  }

  get id(): string {
    return this.#delegate.id;
  }

  get contextWindowTokens(): number {
    return this.#delegate.contextWindowTokens;
  }

  replace(delegate: ModelProvider): void {
    this.#delegate = delegate;
  }

  estimate(request: ModelRequest): ModelRequestEstimate {
    return this.#delegate.estimate(request);
  }

  async invoke(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    return await this.#delegate.invoke(request, signal);
  }
}
