import { z } from 'zod';
import { ModelRequesterError, type ModelCatalog, type ModelCatalogOptions } from '../api.js';
import { DeepSeekTransport } from './deepseek-transport.js';

const catalogSchema = z.object({
  object: z.literal('list'),
  data: z.array(z.object({ id: z.string().trim().min(1).max(100) })).max(1000),
});

/** MiniMax 尚未提供可核实的型号发现接口；预置列表不表示账户已通过验证。 */
export async function listAvailableModels(options: ModelCatalogOptions, signal?: AbortSignal): Promise<ModelCatalog> {
  if (options.provider === 'minimax') return {
    provider: 'minimax', source: 'builtin',
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed']
      .map((id) => ({ id, label: id })),
  };
  const transport = new DeepSeekTransport({ apiKey: options.apiKey ?? '', timeoutMs: options.timeoutMs ?? 15_000,
    ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}) });
  const result = catalogSchema.safeParse(await transport.json('/models', undefined, signal));
  if (!result.success) throw new ModelRequesterError('DeepSeek 返回的型号列表格式无效，请重试。', {
    provider: 'deepseek', code: 'invalid_response',
  });
  return { provider: 'deepseek', source: 'api',
    models: [...new Set(result.data.data.map((model) => model.id))].sort().map((id) => ({ id, label: id })) };
}
