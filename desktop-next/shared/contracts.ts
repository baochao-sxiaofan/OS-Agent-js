import type {
  ContactNote, ConversationRead, ConversationReadResult, ConversationSearch, ConversationSearchResult,
  ConversationSummary, SetContactNote,
} from './memory.js';
import type { TokenSettings } from './tokens.js';
export type {
  ContactNote, ConversationMember, ConversationRead, ConversationReadResult, ConversationSearch, ConversationSearchResult,
  ConversationSummary, HistoryExcerpt, MemorySource, SetContactNote,
} from './memory.js';

export const CHANNEL = 'os-agent-next:command';
export const CHANGED = 'os-agent-next:changed';
export const roles = [
  { id: 'coordinator', name: '协作助手', description: '整理问题、规划工作，与已有 Agent 协作' },
  { id: 'developer', name: '开发工程师', description: '理解代码，在授权工作区内开发' },
  { id: 'code_auditor', name: '代码审计员', description: '只读检查代码，提供有依据的建议' },
  { id: 'researcher', name: '研究员', description: '阅读资料，整理知识和研究结论' },
] as const;
export type Role = typeof roles[number]['id'];
export type Workspace = { id: string; path: string };
/** IPC 只发布界面需要的数据，不把核心实现或完整上下文带入渲染进程。 */
export type ChatMessage = {
  id: string; sequence: number; createdAt: number; content: string;
  sender: { kind: 'user'; id: string } | { kind: 'agent'; id: number };
  senderName: string; mentions: readonly number[]; replyTo: string | null;
};
export type Conversation = {
  id: string; title: string; kind: 'direct' | 'group'; createdAt: number;
  members: readonly { id: number; name: string }[]; includesUser: boolean;
  participation: 'all' | 'mentioned'; messages: readonly ChatMessage[]; unread: number;
  mailboxes: readonly { agentId: number; state: 'processed' | 'aggregating' | 'processing' | 'dismissed'; processedSequence: number }[];
};
export type LegacyMessage = {
  id: string; createdAt: number; role: 'user' | 'assistant' | 'agent'; sender: string | null; content: string;
};
export type AgentInspector = {
  agentId: number; conversations: readonly Conversation[]; legacy: readonly LegacyMessage[];
};
export type Approval = {
  operationId: string; toolName: string; arguments: object; state: 'approval' | 'unknown';
};
export type Contact = {
  id: number; alias: string; name: string; objective: string; character: string;
  state: 'READY' | 'RUNNING' | 'BLOCKED' | 'SLEEPING';
  status: 'active' | 'paused' | 'cancelled' | 'dismissed';
  createdAt: number; workspaceId: string; workspace: string | null; capabilities: readonly string[];
  directConversationId: string;
  rounds: number; totalTokens: number; error: string | null;
  approvals: readonly Approval[];
};
export type ModelProvider = 'minimax' | 'deepseek';
export type ModelConnection = {
  model: string; hasKey: boolean;
  keyStorage: 'encrypted' | 'session' | 'environment' | 'none';
};
export type ModelCatalog = {
  provider: ModelProvider; source: 'api' | 'builtin';
  models: readonly { id: string; label: string }[];
};
export type ModelSettings = ModelConnection & {
  mode: 'demo' | ModelProvider;
  connections: Record<ModelProvider, ModelConnection>;
  tokens: TokenSettings;
};
export type Snapshot = {
  contacts: readonly Contact[]; settings: ModelSettings; ready: boolean;
  conversations: readonly Conversation[]; inspector: AgentInspector | null;
};
export type CreateContact = {
  name: string; objective: string; character: Role;
  workspaceId: string | null; access: 'none' | 'read' | 'write';
};
export type SaveModel = { mode: 'demo' | ModelProvider; model: string; apiKey: string; tokens?: TokenSettings };
export type ListModels = { provider: ModelProvider; apiKey: string };
export type CreateGroup = { title: string; agentIds: readonly number[]; participation: 'all' | 'mentioned' };
export interface DesktopApi {
  snapshot(inspectAgentId?: number): Promise<Snapshot>;
  create(input: CreateContact): Promise<number>;
  createGroup(input: CreateGroup): Promise<string>;
  chooseWorkspace(): Promise<Workspace | null>;
  send(conversationId: string, content: string, key: string, mentions?: readonly number[]): Promise<void>;
  markRead(conversationId: string): Promise<void>;
  control(id: number, action: 'pause' | 'resume' | 'cancel' | 'dismiss'): Promise<void>;
  approve(id: number, operationId: string, allowed: boolean): Promise<void>;
  reconcile(id: number, operationId: string, outcome: 'succeeded' | 'failed', result: string): Promise<void>;
  saveModel(input: SaveModel): Promise<void>;
  listModels(input: ListModels): Promise<ModelCatalog>;
  memorySummary(conversationId: string, inspectAgentId?: number): Promise<ConversationSummary | null>;
  searchHistory(input: ConversationSearch, inspectAgentId?: number): Promise<ConversationSearchResult>;
  readHistory(input: ConversationRead, inspectAgentId?: number): Promise<ConversationReadResult>;
  contactNotes(inspectAgentId?: number): Promise<readonly ContactNote[]>;
  saveNote(input: SetContactNote): Promise<ContactNote>;
  subscribe(listener: () => void): () => void;
}
