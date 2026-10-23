import { createModelRequester, listAvailableModels, ModelRequesterError, type ModelRequester } from '../../src/model-requester/index.js';
import type { ListModels, ModelCatalog, ModelConnection, ModelProvider, ModelSettings, SaveModel } from '../shared/contracts.js';
import { DemoRequester } from './demo-requester.js';
import type { DesktopStore, StoredModel } from './store.js';
import type { TokenSettings } from '../shared/tokens.js';

export type SecretStorage = {
  available(): boolean; encrypt(value: string): string; decrypt(value: string): string;
};
export type EnvironmentKeys = string | Partial<Record<ModelProvider, string>>;
type Connection = ModelConnection & { key: string };

export class DesktopModel {
  #requester: ModelRequester | null = null;
  #saved: StoredModel;
  #connections: Record<ModelProvider, Connection>;
  #mode: ModelSettings['mode'];
  #tokens: TokenSettings;
  readonly requester: ModelRequester;
  constructor(readonly store: DesktopStore, readonly secrets: SecretStorage, environmentKeys: EnvironmentKeys = '',
    readonly fetchImplementation: typeof fetch = globalThis.fetch) {
    const saved = store.model();
    this.#saved = saved;
    this.#mode = saved.mode;
    this.#tokens = saved.tokens;
    const keys = typeof environmentKeys === 'string' ? { minimax: environmentKeys } : environmentKeys;
    const load = (provider: ModelProvider): Connection => {
      const connection = saved.connections[provider];
      let key = '';
      let keyStorage: ModelConnection['keyStorage'] = 'none';
      if (connection.encryptedKey && secrets.available()) {
        try { key = secrets.decrypt(connection.encryptedKey); if (key) keyStorage = 'encrypted'; }
        catch { /* 解密失败保留原密文，等待用户重新配置。 */ }
      }
      if (!key && keys[provider]?.trim()) { key = keys[provider]!.trim(); keyStorage = 'environment'; }
      return { model: connection.model, key, hasKey: !!key, keyStorage };
    };
    this.#connections = { minimax: load('minimax'), deepseek: load('deepseek') };
    this.#requester = this.#mode === 'demo' ? new DemoRequester()
      : this.#build(this.#mode, this.#connections[this.#mode].model, this.#connections[this.#mode].key);
    const host = this;
    this.requester = {
      get provider() { return host.#requester?.provider ?? (host.#mode === 'demo' ? 'minimax' : host.#mode); },
      get model() { return host.#requester?.model ?? host.view().model; },
      request: (request, signal) => {
        if (!this.#requester) throw new ModelRequesterError('请在模型设置中配置所选供应商的 API Key 和型号。', {
          provider: this.#mode === 'demo' ? 'minimax' : this.#mode, code: 'invalid_request',
        });
        return this.#requester.request(request, signal);
      },
    };
  }
  #build(mode: SaveModel['mode'], model: string, key: string): ModelRequester | null {
    return mode === 'demo' ? new DemoRequester() : key && model ? createModelRequester({
      provider: mode, model, apiKey: key, fetchImplementation: this.fetchImplementation,
    }) : null;
  }
  view(): ModelSettings {
    const view = ({ model, hasKey, keyStorage }: Connection): ModelConnection => ({ model, hasKey, keyStorage });
    const connections = { minimax: view(this.#connections.minimax), deepseek: view(this.#connections.deepseek) };
    return { mode: this.#mode, ...(this.#mode === 'demo'
      ? { model: 'demo', hasKey: false, keyStorage: 'none' as const } : connections[this.#mode]),
    connections, tokens: { ...this.#tokens } };
  }
  listModels(input: ListModels): Promise<ModelCatalog> {
    return listAvailableModels({ provider: input.provider,
      apiKey: input.apiKey.trim() || this.#connections[input.provider].key,
      fetchImplementation: this.fetchImplementation });
  }
  save(input: SaveModel): void {
    this.prepare(input)();
  }
  /** 先验证凭据和构造 requester，避免无效模型设置先改变 Runtime 容量。 */
  prepare(input: SaveModel): () => void {
    const previous = input.mode === 'demo' ? null : this.#connections[input.mode];
    const key = input.apiKey.trim() || previous?.key || '';
    const model = input.mode === 'demo' ? 'demo' : input.model.trim();
    if (input.mode !== 'demo' && !key) throw new Error(`请填写 ${input.mode === 'deepseek' ? 'DeepSeek' : 'MiniMax'} API Key。`);
    if (input.mode !== 'demo' && !model) throw new Error('请选择具体型号。');
    const next = this.#build(input.mode, model, key);
    const encryptedKey = input.mode !== 'demo' && key && this.secrets.available() ? this.secrets.encrypt(key) : null;
    const tokens = input.tokens ?? this.#tokens;
    const saved: StoredModel = { ...this.#saved, mode: input.mode, tokens: { ...tokens },
      connections: { ...this.#saved.connections,
        ...(input.mode === 'demo' ? {} : { [input.mode]: { model, encryptedKey } }) } };
    return () => {
      this.store.saveModel(saved);
      this.#saved = saved; this.#requester = next; this.#mode = input.mode;
      this.#tokens = { ...tokens };
      if (input.mode !== 'demo') this.#connections[input.mode] = {
        model, key, hasKey: !!key, keyStorage: encryptedKey ? 'encrypted'
          : key === previous?.key && previous.keyStorage === 'environment' ? 'environment' : 'session',
      };
    };
  }
}
