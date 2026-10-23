import type { AgentControlBlock } from '../agent-control-block/index.js';
import type { ContextPolicy } from '../agent-context/index.js';
import type { CapabilityGrant, CapabilityRequest } from '../capability/capability.js';
import type { CharacterRegistry } from '../character/character-registry.js';
import type { ModelRequester } from '../model-requester/index.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { RuntimeTokenSettings } from './tokens.js';
import type {
  ConversationMailbox, ConversationMember, ConversationMessage, ConversationPolicy, CreateConversation,
  RuntimeConversation, SendConversationMessage,
} from './conversations.js';
import type {
  ContactNote, ConversationMemoryPolicy, ConversationRead, ConversationReadResult, ConversationSearch,
  ConversationSearchResult, ConversationSummary, SetContactNote,
} from './memory.js';

export type RuntimeLimits = {
  readonly maxConcurrentRequests: number;
  readonly requestsPerMinute: number;
  readonly tokensPerMinute: number;
  readonly maxRequestTokens: number;
  readonly maxOutputTokens: number;
  /** 每个收件批次或连续工作阶段的请求上限；显式继续可追加，重试与重启不重置。 */
  readonly maxRounds: number;
  readonly maxTotalTokens: number;
  readonly maxCostUsd: number;
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly maxRetries: number;
  readonly retryBaseMs: number;
  readonly repeatedActionLimit: number;
  readonly maxAgents: number;
  readonly toolTimeoutMs: number;
};

/** root 表示用户经宿主签发的初始权限；不存在 Agent 间的授权来源或转授。 */
export type RuntimeCapabilityGrant = Omit<CapabilityGrant, 'source' | 'delegable'> & {
  readonly source: { type: 'root' } | { type: 'human'; approvalRequestId: string };
  readonly delegable: false;
};

export type RuntimeAgent = {
  readonly schemaVersion: 2;
  readonly control: AgentControlBlock;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly contextKey: string;
  readonly ceiling: readonly CapabilityRequest[];
  readonly grants: readonly RuntimeCapabilityGrant[];
  readonly status: 'active' | 'paused' | 'cancelled';
  /** 长期累计请求统计，不作为单次工作轮数限制。 */
  readonly rounds: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly lastAction: string;
  readonly repeatedActions: number;
  readonly lastError: string | null;
};

export type RuntimeInterrupt = {
  readonly id: string;
  readonly agentId: number;
  readonly batchId: string;
  readonly createdAt: number;
  readonly kind: 'network' | 'protocol' | 'permission' | 'tool' | 'budget' | 'loop' | 'cancelled' | 'internal';
  readonly message: string;
  readonly action: 'retry' | 'feedback' | 'pause' | 'stop';
  readonly resumeAt: number | null;
};

export type RuntimeEvent = {
  readonly sequence: number;
  readonly agentId: number;
  readonly createdAt: number;
  readonly type: string;
  readonly data: import('../types/json.js').JsonValue;
};

export type AgentRuntimeOptions = {
  readonly database: string;
  readonly requester: ModelRequester;
  /** 宿主预注册挂载目录，HTTP 调用方只能引用名称。 */
  readonly workspaces: Readonly<Record<string, string>>;
  readonly tools?: ToolRegistry;
  readonly characters?: CharacterRegistry;
  readonly limits?: Partial<RuntimeLimits>;
  /** 单个工具结果直接投递的字符额度，默认4000；超额结果保留原文和分页入口。 */
  readonly toolResultInlineCharacters?: number;
  /** 宿主同步检查拟发消息，返回拒绝原因时有限纠正；发送者由运行时绑定，不检查用户消息。 */
  readonly messageGuard?: (input: {
    readonly agentId: number;
    readonly conversationId: string;
    readonly content: string;
    readonly mentions: readonly number[];
  }) => string | null;
  readonly tokenSettings?: RuntimeTokenSettings;
  readonly contextPolicy?: ContextPolicy;
  readonly conversationPolicy?: Partial<ConversationPolicy>;
  readonly memoryPolicy?: Partial<ConversationMemoryPolicy>;
  readonly onEvent?: (event: RuntimeEvent) => void;
};

export type CreateRuntimeAgent = {
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly character: string;
  readonly objective: string;
  readonly instructions?: readonly string[];
  readonly capabilities: readonly CapabilityRequest[];
  readonly startMode?: 'immediate' | 'on_message';
  readonly displayName?: string;
};

/** 用户对话保留在 Runtime 中，不依赖桌面窗口或上下文压缩后的内容。 */
export type RuntimeMessage = {
  readonly id: string;
  readonly agentId: number;
  readonly createdAt: number;
  readonly role: 'user' | 'assistant' | 'agent';
  readonly sender: string | null;
  readonly content: string;
};

export interface AgentRuntime {
  initialize(): Promise<void>;
  start(): void;
  isReady(): boolean;
  tokenSettings(): RuntimeTokenSettings;
  /** 可信宿主设置容量；只能在所有 Agent 休眠或暂停且没有模型请求时调用。 */
  configureTokens(settings: RuntimeTokenSettings): void;
  /** 仅可信宿主可登记目录；已登记的名称不能重新指向另一目录。 */
  registerWorkspace(id: string, path: string): Promise<void>;
  /** 仅供用户控制面创建长期 Agent，不向模型或工具暴露此管理入口。 */
  createAgent(input: CreateRuntimeAgent): Promise<RuntimeAgent>;
  setDisplayName(agentId: number, ownerId: string, name: string): void;
  createConversation(input: CreateConversation): RuntimeConversation;
  directConversation(agentId: number, ownerId: string): RuntimeConversation;
  conversations(ownerId: string): readonly RuntimeConversation[];
  agentConversations(agentId: number, ownerId: string): readonly RuntimeConversation[];
  conversationMessages(conversationId: string, ownerId: string, inspectAgentId?: number): readonly ConversationMessage[];
  conversationMailboxes(conversationId: string, ownerId: string, inspectAgentId?: number): readonly ConversationMailbox[];
  sendMessage(conversationId: string, ownerId: string, input: SendConversationMessage): ConversationMessage;
  conversationSummary(conversationId: string, ownerId: string, inspectAgentId?: number): ConversationSummary | null;
  searchConversations(ownerId: string, input: ConversationSearch, inspectAgentId?: number): ConversationSearchResult;
  readConversation(ownerId: string, input: ConversationRead, inspectAgentId?: number): ConversationReadResult;
  contactNote(ownerId: string, target: ConversationMember, inspectAgentId?: number): ContactNote | null;
  contactNotes(ownerId: string, inspectAgentId?: number): readonly ContactNote[];
  /** 只写当前用户自己的备注；Agent 写入仅从绑定身份的模型动作进入。 */
  setContactNote(ownerId: string, input: SetContactNote): ContactNote;
  legacyMessages(agentId: number, ownerId: string): readonly RuntimeMessage[];
  submit(agentId: number, ownerId: string, content: string, idempotencyKey: string): void;
  /** 可信宿主向当前执行层投递现场纠错；不冒充聊天、跳过邮箱或改变任务状态。 */
  provideFeedback(agentId: number, ownerId: string, content: string, idempotencyKey: string): void;
  inspect(agentId: number, ownerId: string): RuntimeAgent;
  list(ownerId: string): readonly RuntimeAgent[];
  events(agentId: number, ownerId: string, after?: number): readonly RuntimeEvent[];
  messages(agentId: number, ownerId: string): readonly RuntimeMessage[];
  interrupts(agentId: number, ownerId: string): readonly RuntimeInterrupt[];
  approvals(agentId: number, ownerId: string): readonly RuntimeApproval[];
  approve(agentId: number, ownerId: string, operationId: string, allowed: boolean): void;
  reconcile(agentId: number, ownerId: string, operationId: string,
    resolution: { outcome: 'succeeded' | 'failed'; result: import('../types/json.js').JsonValue }): void;
  pause(agentId: number, ownerId: string): Promise<void>;
  resume(agentId: number, ownerId: string): void;
  cancel(agentId: number, ownerId: string): Promise<void>;
  close(): Promise<void>;
}

export type RuntimeApproval = {
  readonly operationId: string;
  readonly agentId: number;
  readonly toolName: string;
  readonly arguments: import('../types/json.js').JsonObject;
  readonly requirements: readonly CapabilityRequest[];
  readonly state: 'approval' | 'unknown';
};
