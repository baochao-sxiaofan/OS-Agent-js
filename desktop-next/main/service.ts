import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgentRuntime, runtimeTokenSettingsSchema, type AgentRuntime, type RuntimeConversation } from '../../src/agent-runtime/index.js';
import type { Contact, Conversation, Snapshot, Workspace, ModelCatalog } from '../shared/contracts.js';
import { DesktopModel, type SecretStorage, type EnvironmentKeys } from './model.js';
import { DesktopStore } from './store.js';

const OWNER = 'desktop-user';
const idSchema = z.number().int().positive();
const createSchema = z.object({
  name: z.string().trim().min(1).max(40), objective: z.string().trim().min(1).max(4000),
  character: z.enum(['coordinator', 'developer', 'code_auditor', 'researcher']),
  workspaceId: z.string().nullable(), access: z.enum(['none', 'read', 'write']),
}).strict();
const modelSchema = z.object({
  mode: z.enum(['demo', 'minimax', 'deepseek']), model: z.string().trim().min(1).max(100),
  apiKey: z.string().max(1024),
  tokens: runtimeTokenSettingsSchema.optional(),
}).strict();
const listModelsSchema = z.object({
  provider: z.enum(['minimax', 'deepseek']), apiKey: z.string().max(1024),
}).strict();
// IPC 在宿主边界收窄输入，作者和可访问范围仍由 Runtime 验证。
const memberSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('agent'), id: idSchema }).strict(),
]);
const sourceSchema = z.object({
  conversationId: z.string().min(1).max(200), messageId: z.string().min(1).max(200),
}).strict();
const searchSchema = z.object({
  query: z.string().trim().min(1).max(200), conversationId: z.string().min(1).optional(),
  sender: memberSchema.optional(), since: z.number().int().nonnegative().optional(),
  until: z.number().int().nonnegative().optional(), beforeSequence: idSchema.optional(),
  limit: z.number().int().min(1).max(30).optional(),
}).strict();
const readSchema = z.object({
  conversationId: z.string().min(1), messageId: z.string().min(1).optional(),
  afterSequence: z.number().int().nonnegative().optional(), throughSequence: idSchema.optional(),
  offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(30).optional(),
}).strict();
const noteSchema = z.object({
  target: memberSchema, introduction: z.string().max(200), body: z.string().max(6000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  unresolved: z.array(z.string().min(1).max(400)).max(20), sourceRefs: z.array(sourceSchema).max(50),
  expectedVersion: z.number().int().nonnegative(), idempotencyKey: z.string().min(1).max(300),
}).strict();

/** 只调用新链路公共 API，Electron 只在外层提供窗口、目录选择和安全存储。 */
export class DesktopService {
  readonly #store: DesktopStore;
  readonly #model: DesktopModel;
  #runtime: AgentRuntime | null = null;
  constructor(readonly directory: string, secrets: SecretStorage, environmentKey?: EnvironmentKeys) {
    this.#store = new DesktopStore(join(directory, 'desktop.sqlite'));
    this.#model = new DesktopModel(this.#store, secrets, environmentKey);
  }
  async initialize(): Promise<void> {
    const privateWorkspace = join(this.directory, 'unmounted');
    await mkdir(privateWorkspace, { recursive: true });
    this.#runtime = createAgentRuntime({
      database: join(this.directory, 'runtime.sqlite'), requester: this.#model.requester,
      tokenSettings: this.#model.view().tokens,
      workspaces: { unmounted: privateWorkspace, ...Object.fromEntries(this.#store.workspaces().map((w) => [w.id, w.path])) },
    });
    await this.#runtime.initialize();
    for (const agent of this.#runtime.list(OWNER)) {
      const profile = this.#store.profile(agent.control.agentId);
      if (profile) this.#runtime.setDisplayName(agent.control.agentId, OWNER, profile.name);
    }
    this.#runtime.start();
  }
  #engine(): AgentRuntime {
    if (!this.#runtime) throw new Error('桌面服务尚未就绪。');
    return this.#runtime;
  }
  #conversation(item: RuntimeConversation, inspectAgentId?: number): Conversation {
    const runtime = this.#engine();
    const members = item.members.flatMap((member) => member.kind === 'agent'
      ? [{ id: member.id, name: this.#store.profile(member.id)?.name ?? `agent-${member.id}` }] : []);
    const messages = runtime.conversationMessages(item.id, OWNER, inspectAgentId);
    const readSequence = inspectAgentId === undefined ? this.#store.readSequence(item.id) : 0;
    return { id: item.id, kind: item.kind, createdAt: item.createdAt, members,
      includesUser: item.members.some((member) => member.kind === 'user' && member.id === OWNER),
      title: item.kind === 'group' ? item.title || '群聊' : members.map((member) => member.name).join(' · '),
      participation: item.participation,
      messages: messages.map((message) => ({ id: message.id, sequence: message.sequence, createdAt: message.createdAt,
        content: message.content, sender: message.sender, replyTo: message.replyTo, mentions: message.mentions,
        senderName: message.sender.kind === 'user' ? '我'
          : this.#store.profile(message.sender.id)?.name ?? `agent-${message.sender.id}` })),
      unread: inspectAgentId === undefined
        ? messages.filter((message) => message.sequence > readSequence && message.sender.kind !== 'user').length : 0,
      mailboxes: runtime.conversationMailboxes(item.id, OWNER, inspectAgentId),
    };
  }
  snapshot(inspectValue?: unknown): Snapshot {
    const runtime = this.#engine();
    if (!runtime.isReady()) return { ready: false, contacts: [], conversations: [], inspector: null, settings: this.#model.view() };
    const inspectAgentId = inspectValue === undefined ? undefined : idSchema.parse(inspectValue);
    const workspaces = this.#store.workspaces();
    const contacts: Contact[] = runtime.list(OWNER, { includeDismissed: true }).map((agent) => {
      const id = agent.control.agentId;
      const profile = this.#store.profile(id);
      return { id, alias: agent.control.agentName, name: profile?.name ?? agent.control.agentName,
        objective: agent.control.context.level1.currentTask.objective, character: agent.control.character,
        state: agent.control.state, status: agent.status, createdAt: agent.control.createdAt,
        workspaceId: agent.workspaceId, workspace: workspaces.find((w) => w.id === agent.workspaceId)?.path ?? null,
        directConversationId: runtime.directConversation(id, OWNER).id,
        capabilities: agent.ceiling.map((c) => c.capability),
        rounds: agent.rounds, totalTokens: agent.totalTokens, error: agent.lastError,
        approvals: runtime.approvals(id, OWNER) };
    });
    return { ready: true, contacts, settings: this.#model.view(),
      conversations: runtime.conversations(OWNER).map((item) => this.#conversation(item)),
      inspector: inspectAgentId === undefined ? null : { agentId: inspectAgentId,
        conversations: runtime.agentConversations(inspectAgentId, OWNER).map((item) => this.#conversation(item, inspectAgentId)),
        legacy: runtime.legacyMessages(inspectAgentId, OWNER) },
    };
  }
  async registerWorkspace(path: string): Promise<Workspace> {
    const canonical = await realpath(path);
    const workspace = { id: `workspace-${createHash('sha256').update(canonical).digest('hex')}`, path: canonical };
    await this.#engine().registerWorkspace(workspace.id, workspace.path);
    this.#store.addWorkspace(workspace);
    return workspace;
  }
  async create(value: unknown): Promise<number> {
    const input = createSchema.parse(value);
    if (input.workspaceId && !this.#store.workspaces().some((w) => w.id === input.workspaceId)) {
      throw new Error('请选择已登记的工作区。');
    }
    if (!input.workspaceId && input.access !== 'none') throw new Error('授予文件权限前请选择工作区。');
    if (input.character === 'code_auditor' && input.access === 'write') throw new Error('代码审计员只允许只读访问。');
    const capabilities = input.access === 'none' ? [] : ['file.read', 'directory.read',
      ...(input.access === 'write' ? ['file.write', 'file.create', 'directory.create'] : [])];
    const agent = await this.#engine().createAgent({
      ownerId: OWNER, workspaceId: input.workspaceId ?? 'unmounted',
      character: input.character, objective: input.objective, startMode: 'on_message', displayName: input.name,
      instructions: ['持续协助用户，保留有用记忆，使用中文交流。按当前会话及消息指向决定是否需要发言。'],
      capabilities: capabilities.map((capability) => ({ capability, scope: { kind: 'subtree', resource: 'workspace://current/' } })),
    });
    this.#store.setProfile(agent.control.agentId, input.name, 0);
    return agent.control.agentId;
  }
  createGroup(value: unknown): string {
    const input = z.object({ title: z.string().trim().min(1).max(100),
      agentIds: z.array(idSchema).min(1).max(31), participation: z.enum(['all', 'mentioned']) }).strict().parse(value);
    const agents = input.agentIds.map((id) => this.#engine().inspect(id, OWNER));
    return this.#engine().createConversation({ ownerId: OWNER, workspaceId: agents[0]!.workspaceId,
      kind: 'group', title: input.title, participation: input.participation,
      members: [{ kind: 'user', id: OWNER }, ...input.agentIds.map((id) => ({ kind: 'agent' as const, id }))],
    }).id;
  }
  send(id: unknown, content: unknown, key: unknown, mentions: unknown = []): void {
    this.#engine().sendMessage(z.string().uuid().parse(id), OWNER, {
      content: z.string().trim().min(1).max(12000).parse(content),
      idempotencyKey: z.string().min(1).max(256).parse(key), mentions: z.array(idSchema).max(31).parse(mentions),
    });
  }
  markRead(value: unknown): void {
    const id = z.string().uuid().parse(value);
    const sequence = this.#engine().conversationMessages(id, OWNER).at(-1)?.sequence ?? 0;
    if (sequence > this.#store.readSequence(id)) this.#store.markRead(id, sequence);
  }
  memorySummary(value: unknown, inspectValue?: unknown) {
    return this.#engine().conversationSummary(z.string().min(1).parse(value), OWNER, idSchema.optional().parse(inspectValue));
  }
  searchHistory(value: unknown, inspectValue?: unknown) {
    const input = searchSchema.parse(value);
    return this.#engine().searchConversations(OWNER, {
      query: input.query,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      ...(input.sender === undefined ? {} : { sender: input.sender }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.until === undefined ? {} : { until: input.until }),
      ...(input.beforeSequence === undefined ? {} : { beforeSequence: input.beforeSequence }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }, idSchema.optional().parse(inspectValue));
  }
  readHistory(value: unknown, inspectValue?: unknown) {
    const input = readSchema.parse(value);
    return this.#engine().readConversation(OWNER, {
      conversationId: input.conversationId,
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
      ...(input.throughSequence === undefined ? {} : { throughSequence: input.throughSequence }),
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }, idSchema.optional().parse(inspectValue));
  }
  contactNotes(inspectValue?: unknown) {
    return this.#engine().contactNotes(OWNER, idSchema.optional().parse(inspectValue));
  }
  saveNote(value: unknown) {
    return this.#engine().setContactNote(OWNER, noteSchema.parse(value));
  }
  async control(value: unknown, action: unknown): Promise<void> {
    const id = idSchema.parse(value);
    const operation = z.enum(['pause', 'resume', 'cancel', 'dismiss']).parse(action);
    await this.#engine()[operation](id, OWNER);
  }
  approve(value: unknown, operation: unknown, allowed: unknown): void {
    this.#engine().approve(idSchema.parse(value), OWNER, z.string().min(1).parse(operation), z.boolean().parse(allowed));
  }
  reconcile(value: unknown, operation: unknown, outcome: unknown, result: unknown): void {
    this.#engine().reconcile(idSchema.parse(value), OWNER, z.string().min(1).parse(operation), {
      outcome: z.enum(['succeeded', 'failed']).parse(outcome), result: z.string().trim().min(1).max(4000).parse(result),
    });
  }
  listModels(value: unknown): Promise<ModelCatalog> {
    return this.#model.listModels(listModelsSchema.parse(value));
  }
  saveModel(value: unknown): void {
    if (this.#engine().list(OWNER).some((agent) => agent.status === 'active' &&
        (agent.control.state !== 'SLEEPING' || this.#engine().agentConversations(agent.control.agentId, OWNER)
          .some((conversation) => this.#engine().conversationMailboxes(conversation.id, OWNER, agent.control.agentId)
            .some((mailbox) => mailbox.agentId === agent.control.agentId && mailbox.state !== 'processed'))))) {
      throw new Error('请等待当前工作结束，或暂停运行中的 Agent 后再切换模型。');
    }
    const input = modelSchema.parse(value);
    const parsed = { mode: input.mode, model: input.model, apiKey: input.apiKey,
      ...(input.tokens === undefined ? {} : { tokens: input.tokens }) };
    const commit = this.#model.prepare(parsed);
    if (input.tokens) this.#engine().configureTokens(input.tokens);
    commit();
  }
  async close(): Promise<void> {
    await this.#runtime?.close();
    this.#store.close();
  }
}
