import type {
  ModelProvider,
  ModelRequest,
  ModelRequestEstimate,
  ModelResponse,
} from '../../src/index.js';

export class SwitchableModelProvider implements ModelProvider {
  // 桌面运行时不再用固定输入 token 预算提前压缩上下文。
  // Provider/API 自身仍可能拒绝超过真实上下文窗口的请求。
  readonly contextWindowTokens = Number.MAX_SAFE_INTEGER;
  #delegate: ModelProvider;

  constructor(delegate: ModelProvider) {
    this.#delegate = delegate;
  }

  get id(): string {
    return this.#delegate.id;
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
