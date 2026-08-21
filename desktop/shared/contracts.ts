export const IPC_CHANNELS = {
  cancelTask: 'runtime:cancel-task',
  createConversation: 'runtime:create-conversation',
  discoverModels: 'runtime:discover-models',
  getModelSettings: 'runtime:get-model-settings',
  getSnapshot: 'runtime:get-snapshot',
  saveModelSettings: 'runtime:save-model-settings',
  snapshotChanged: 'runtime:snapshot-changed',
  submitTask: 'runtime:submit-task',
} as const;

export type ProviderId =
  | 'anthropic'
  | 'deepseek'
  | 'doubao'
  | 'gemini'
  | 'mimo'
  | 'minimax'
  | 'moonshot'
  | 'openai'
  | 'qwen'
  | 'xai'
  | 'zhipu';

export type ProviderProtocol =
  | 'anthropic'
  | 'gemini'
  | 'openai-compatible';

export type ProviderDescriptor = {
  id: ProviderId;
  label: string;
  brand: string;
  protocol: ProviderProtocol;
  catalogMode: 'api' | 'manual';
  credentialLabel: string;
  requiresWorkspaceId: boolean;
  note?: string;
};

export const PROVIDER_CATALOG: readonly ProviderDescriptor[] = [
  {
    id: 'openai',
    label: 'ChatGPT / OpenAI',
    brand: 'OpenAI',
    protocol: 'openai-compatible',
    catalogMode: 'api',
    credentialLabel: 'OpenAI API Key',
    requiresWorkspaceId: false,
  },
  {
    id: 'anthropic',
    label: 'Claude',
    brand: 'Anthropic',
    protocol: 'anthropic',
    catalogMode: 'api',
    credentialLabel: 'Anthropic API Key',
    requiresWorkspaceId: false,
  },
  {
    id: 'gemini',
    label: 'Gemini',
    brand: 'Google',
    protocol: 'gemini',
    catalogMode: 'api',
    credentialLabel: 'Gemini API Key',
    requiresWorkspaceId: false,
  },
  {
    id: 'moonshot',
    label: 'Kimi',
    brand: 'Moonshot AI',
    protocol: 'openai-compatible',
    catalogMode: 'api',
    credentialLabel: 'Moonshot API Key',
    requiresWorkspaceId: false,
  },
  {
    id: 'xai',
    label: 'Grok',
    brand: 'xAI',
    protocol: 'openai-compatible',
    catalogMode: 'api',
    credentialLabel: 'xAI API Key',
    requiresWorkspaceId: false,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    brand: 'MiniMax',
    protocol: 'openai-compatible',
    catalogMode: 'api',
    credentialLabel: 'MiniMax API Key',
    requiresWorkspaceId: false,
  },
  {
    id: 'zhipu',
    label: 'GLM',
    brand: '智谱',
    protocol: 'openai-compatible',
    catalogMode: 'manual',
    credentialLabel: '智谱 API Key',
    requiresWorkspaceId: false,
    note: '当前使用官方模型目录选择模型 ID。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    brand: 'DeepSeek',
    protocol: 'openai-compatible',
    catalogMode: 'api',
    credentialLabel: 'DeepSeek API Key',
    requiresWorkspaceId: false,
  },
  {
    id: 'qwen',
    label: 'Qwen',
    brand: '阿里云百炼',
    protocol: 'openai-compatible',
    catalogMode: 'api',
    credentialLabel: '百炼 API Key',
    requiresWorkspaceId: true,
    note: '当前接入华北 2（北京）业务空间。',
  },
  {
    id: 'doubao',
    label: '豆包',
    brand: '火山方舟',
    protocol: 'openai-compatible',
    catalogMode: 'manual',
    credentialLabel: '方舟 API Key',
    requiresWorkspaceId: false,
    note: '请填写已开通模型 ID 或推理接入点 ID。',
  },
  {
    id: 'mimo',
    label: 'MiMo',
    brand: 'Xiaomi',
    protocol: 'openai-compatible',
    catalogMode: 'api',
    credentialLabel: 'MiMo API Key',
    requiresWorkspaceId: false,
  },
] as const;

export type ModelDescriptor = {
  id: string;
  displayName: string;
  providerId: ProviderId;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
};

export type ModelSettingsView = {
  providerId?: ProviderId;
  modelId?: string;
  hasApiKey: boolean;
  secureStorageAvailable: boolean;
  runtimeBusy: boolean;
};

export type DiscoverModelsInput = {
  providerId: ProviderId;
  apiKey?: string;
  workspaceId?: string;
};

export type DiscoverModelsResult = {
  providerId: ProviderId;
  models: ModelDescriptor[];
  usedStoredCredential: boolean;
};

export type SaveModelSettingsInput = {
  providerId: ProviderId;
  modelId: string;
  apiKey?: string;
  workspaceId?: string;
};

export type SaveModelSettingsResult = {
  settings: ModelSettingsView;
  verification: {
    latencyMs: number;
    response: string;
  };
  snapshot: RuntimeSnapshotView;
};

export type AgentStatus = 'BLOCKED' | 'READY' | 'RUNNING' | 'TERMINATED';

export type AgentTerminationKind =
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'needs_parent_action';

export type ConversationStatus =
  | 'active'
  | 'completed'
  | 'empty'
  | 'failed';

export type RuntimeMetricsView = {
  activeOperations: number;
  liveAgents: {
    available: number;
    current: number;
    limit: number;
    peak: number;
  };
  providerRequests: {
    active: number;
    peakActive: number;
  };
  readyQueue: {
    current: number;
    peak: number;
  };
};

export type AgentEventView = {
  id: string;
  type: string;
  label: string;
  detail?: string;
  occurredAt: number;
  sequence: number;
};

export type AgentNodeView = {
  id: string;
  rootTaskId: string;
  parentTaskId?: string;
  depth: number;
  goal: string;
  status: AgentStatus;
  terminationKind?: AgentTerminationKind;
  stateLabel: string;
  stateDetail?: string;
  result?: string;
  priority: number;
  capabilities: string[];
  modelAttempts: number;
  maxModelAttempts: number;
  spentCostUsd: number;
  maxCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
  updatedAt: number;
  events: AgentEventView[];
};

export type ConversationRoundView = {
  rootTaskId: string;
  goal: string;
  status: ConversationStatus;
  stateLabel: string;
  stateDetail?: string;
  result?: string;
  agentCount: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
  updatedAt: number;
  agents: AgentNodeView[];
};

export type ConversationView = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: ConversationStatus;
  rootTaskId?: string;
  agents: AgentNodeView[];
  rounds: ConversationRoundView[];
  totalAgentCount: number;
};

export type RuntimeSnapshotView = {
  providerId: string;
  isDemoMode: boolean;
  platform: string;
  metrics: RuntimeMetricsView;
  conversations: ConversationView[];
};

export type SubmitTaskInput = {
  conversationId: string;
  task: string;
};

export type DesktopApi = {
  getSnapshot(): Promise<RuntimeSnapshotView>;
  getModelSettings(): Promise<ModelSettingsView>;
  discoverModels(
    input: DiscoverModelsInput,
  ): Promise<DiscoverModelsResult>;
  createConversation(): Promise<RuntimeSnapshotView>;
  saveModelSettings(
    input: SaveModelSettingsInput,
  ): Promise<SaveModelSettingsResult>;
  submitTask(input: SubmitTaskInput): Promise<RuntimeSnapshotView>;
  cancelTask(taskId: string): Promise<RuntimeSnapshotView>;
  onSnapshotChanged(
    listener: (snapshot: RuntimeSnapshotView) => void,
  ): () => void;
};
