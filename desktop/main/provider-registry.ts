import {
  AnthropicModelProvider,
  GeminiModelProvider,
  MiniMaxModelProvider,
  OpenAiCompatibleModelProvider,
  type JsonObject,
  type JsonValue,
  type ModelProvider,
} from '../../src/index.js';
import {
  PROVIDER_CATALOG,
  type ModelDescriptor,
  type ProviderDescriptor,
  type ProviderId,
} from '../shared/contracts.js';

export type ProviderCredentials = {
  providerId: ProviderId;
  apiKey: string;
  workspaceId?: string;
};

export type ConfiguredProvider = ProviderCredentials & {
  modelId: string;
};

type ProviderEndpoint = {
  baseUrl: string;
  apiKeyHeader: 'api-key' | 'authorization';
  maxTokensField: 'max_completion_tokens' | 'max_tokens';
};

const MINIMAX_MIN_OUTPUT_TOKENS = 4_096;

export async function discoverProviderModels(
  credentials: ProviderCredentials,
): Promise<ModelDescriptor[]> {
  const descriptor = requireProviderDescriptor(credentials.providerId);
  if (descriptor.catalogMode === 'manual') {
    return [];
  }

  const response = await fetchCatalog(credentials);
  const body = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(formatCatalogError(response.status, body));
  }
  const models = parseCatalogResponse(credentials.providerId, body);
  if (models.length === 0) {
    throw new Error('厂商未返回可用于文本生成的模型。');
  }
  return models;
}

export function createConfiguredProvider(
  config: ConfiguredProvider,
  maxOutputTokens = 640,
): ModelProvider {
  switch (config.providerId) {
    case 'gemini':
      return new GeminiModelProvider({
        apiKey: config.apiKey,
        model: config.modelId,
        maxOutputTokens,
      });
    case 'anthropic':
      return new AnthropicModelProvider({
        apiKey: config.apiKey,
        model: config.modelId,
        maxOutputTokens,
      });
    case 'minimax':
      return new MiniMaxModelProvider({
        apiKey: config.apiKey,
        model: config.modelId,
        maxOutputTokens: Math.max(
          maxOutputTokens,
          MINIMAX_MIN_OUTPUT_TOKENS,
        ),
      });
    default: {
      const endpoint = providerEndpoint(config);
      return new OpenAiCompatibleModelProvider({
        providerId: config.providerId,
        apiKey: config.apiKey,
        baseUrl: endpoint.baseUrl,
        model: config.modelId,
        apiKeyHeader: endpoint.apiKeyHeader,
        maxTokensField: endpoint.maxTokensField,
        maxOutputTokens,
      });
    }
  }
}

export function requireProviderDescriptor(
  providerId: ProviderId,
): ProviderDescriptor {
  const descriptor = PROVIDER_CATALOG.find(
    (candidate) => candidate.id === providerId,
  );
  if (!descriptor) {
    throw new Error(`不支持的模型厂商：${providerId}`);
  }
  return descriptor;
}

async function fetchCatalog(
  credentials: ProviderCredentials,
): Promise<Response> {
  const signal = AbortSignal.timeout(20_000);
  switch (credentials.providerId) {
    case 'gemini':
      return await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
        {
          headers: {
            'x-goog-api-key': credentials.apiKey,
          },
          signal,
        },
      );
    case 'anthropic':
      return await fetch('https://api.anthropic.com/v1/models?limit=1000', {
        headers: {
          'anthropic-version': '2023-06-01',
          'x-api-key': credentials.apiKey,
        },
        signal,
      });
    case 'qwen': {
      const workspaceId = credentials.workspaceId?.trim();
      if (!workspaceId || !/^[a-zA-Z0-9_-]+$/u.test(workspaceId)) {
        throw new Error('请填写有效的百炼 Workspace ID。');
      }
      return await fetch(
        `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/models/permissions?authorization_scope=AUTHORIZED&action=INFERENCE&page_no=1&page_size=200`,
        {
          headers: {
            authorization: `Bearer ${credentials.apiKey}`,
          },
          signal,
        },
      );
    }
    default: {
      const endpoint = providerEndpoint(credentials);
      const headers: Record<string, string> = {};
      if (endpoint.apiKeyHeader === 'api-key') {
        headers['api-key'] = credentials.apiKey;
      } else {
        headers['authorization'] = `Bearer ${credentials.apiKey}`;
      }
      return await fetch(`${endpoint.baseUrl}/models`, {
        headers,
        signal,
      });
    }
  }
}

function parseCatalogResponse(
  providerId: ProviderId,
  body: JsonValue,
): ModelDescriptor[] {
  if (providerId === 'gemini') {
    const object = requireObject(body, 'response');
    const models = requireArray(object['models'], 'models');
    return uniqueModels(
      models.flatMap((value): ModelDescriptor[] => {
        const model = requireObject(value, 'models[]');
        const methods = Array.isArray(model['supportedGenerationMethods'])
          ? model['supportedGenerationMethods']
          : [];
        if (!methods.includes('generateContent')) {
          return [];
        }
        const rawName = requireString(model['name'], 'models[].name');
        const id = rawName.replace(/^models\//u, '');
        const inputTokenLimit = optionalNumber(
          model['inputTokenLimit'],
        );
        const outputTokenLimit = optionalNumber(
          model['outputTokenLimit'],
        );
        return [
          {
            id,
            displayName:
              optionalString(model['displayName']) ?? id,
            providerId,
            ...(inputTokenLimit === undefined
              ? {}
              : { inputTokenLimit }),
            ...(outputTokenLimit === undefined
              ? {}
              : { outputTokenLimit }),
          },
        ];
      }),
    );
  }

  if (providerId === 'qwen') {
    const object = requireObject(body, 'response');
    const output = requireObject(object['output'], 'output');
    const permissions = requireArray(
      output['permissions'],
      'output.permissions',
    );
    return uniqueModels(
      permissions.flatMap((value): ModelDescriptor[] => {
        const permission = requireObject(value, 'permissions[]');
        const capability = permission['permissions'];
        if (
          isObject(capability) &&
          capability['inference'] === false
        ) {
          return [];
        }
        const id = requireString(
          permission['model'],
          'permissions[].model',
        );
        return [
          {
            id,
            displayName: optionalString(permission['name']) ?? id,
            providerId,
          },
        ];
      }),
    );
  }

  const object = requireObject(body, 'response');
  const data = requireArray(object['data'], 'data');
  return uniqueModels(
    data.flatMap((value): ModelDescriptor[] => {
      const model = requireObject(value, 'data[]');
      const id = requireString(model['id'], 'data[].id');
      if (!isLikelyTextModel(id)) {
        return [];
      }
      return [
        {
          id,
          displayName:
            optionalString(model['display_name']) ?? id,
          providerId,
        },
      ];
    }),
  );
}

function providerEndpoint(
  credentials: Pick<ProviderCredentials, 'providerId' | 'workspaceId'>,
): ProviderEndpoint {
  switch (credentials.providerId) {
    case 'openai':
      return {
        baseUrl: 'https://api.openai.com/v1',
        apiKeyHeader: 'authorization',
        maxTokensField: 'max_completion_tokens',
      };
    case 'moonshot':
      return {
        baseUrl: 'https://api.moonshot.cn/v1',
        apiKeyHeader: 'authorization',
        maxTokensField: 'max_tokens',
      };
    case 'xai':
      return {
        baseUrl: 'https://api.x.ai/v1',
        apiKeyHeader: 'authorization',
        maxTokensField: 'max_tokens',
      };
    case 'minimax':
      return {
        baseUrl: 'https://api.minimaxi.com/v1',
        apiKeyHeader: 'authorization',
        maxTokensField: 'max_tokens',
      };
    case 'zhipu':
      return {
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKeyHeader: 'authorization',
        maxTokensField: 'max_tokens',
      };
    case 'deepseek':
      return {
        baseUrl: 'https://api.deepseek.com',
        apiKeyHeader: 'authorization',
        maxTokensField: 'max_tokens',
      };
    case 'qwen': {
      const workspaceId = credentials.workspaceId?.trim();
      if (!workspaceId || !/^[a-zA-Z0-9_-]+$/u.test(workspaceId)) {
        throw new Error('请填写有效的百炼 Workspace ID。');
      }
      return {
        baseUrl: `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`,
        apiKeyHeader: 'authorization',
        maxTokensField: 'max_tokens',
      };
    }
    case 'doubao':
      return {
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKeyHeader: 'authorization',
        maxTokensField: 'max_tokens',
      };
    case 'mimo':
      return {
        baseUrl: 'https://api.xiaomimimo.com/v1',
        apiKeyHeader: 'api-key',
        maxTokensField: 'max_completion_tokens',
      };
    case 'anthropic':
    case 'gemini':
      throw new Error(
        `${credentials.providerId} does not use OpenAI-compatible routing.`,
      );
  }
}

async function parseResponseBody(response: Response): Promise<JsonValue> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new Error(
      `模型目录返回了非 JSON 内容（HTTP ${response.status}）。`,
    );
  }
}

function formatCatalogError(status: number, body: JsonValue): string {
  if (isObject(body) && isObject(body['error'])) {
    const message = body['error']['message'];
    if (typeof message === 'string') {
      return `获取模型列表失败（HTTP ${status}）：${message}`;
    }
  }
  const message =
    isObject(body) && typeof body['message'] === 'string'
      ? body['message']
      : undefined;
  return message
    ? `获取模型列表失败（HTTP ${status}）：${message}`
    : `获取模型列表失败（HTTP ${status}）。`;
}

function uniqueModels(models: ModelDescriptor[]): ModelDescriptor[] {
  const unique = new Map<string, ModelDescriptor>();
  for (const model of models) {
    unique.set(model.id, model);
  }
  return [...unique.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

function isLikelyTextModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return ![
    'audio',
    'dall-e',
    'embedding',
    'image',
    'moderation',
    'realtime',
    'speech',
    'tts',
    'veo',
    'video',
    'whisper',
  ].some((fragment) => id.includes(fragment));
}

function requireObject(
  value: JsonValue | undefined,
  path: string,
): JsonObject {
  if (!isObject(value)) {
    throw new Error(`${path} must be a JSON object.`);
  }
  return value;
}

function requireArray(
  value: JsonValue | undefined,
  path: string,
): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
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

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}
