import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import {
  createAgentControlBlock, AgentState, type ManagedAgentControlBlock,
} from '../../agent-control-block/index.js';
import {
  createAgentContextManager, restoreAgentContextManager, SqliteContextStore,
  estimateContextTokens, type AgentContextManager, type ContextEntry,
} from '../../agent-context/index.js';
import { createAgentRoundRunner, type AgentRoundRunner, type AgentWorkRound } from '../../agent-round/index.js';
import { createAgentScheduler, type AgentRun, type AgentScheduler } from '../../agent-scheduler/index.js';
import { CapabilityManager } from '../../capability/capability-manager.js';
import { normalizeCapabilityInput } from '../../capability/capability.js';
import type { CharacterRegistry } from '../../character/character-registry.js';
import { registerBuiltinTools } from '../../tools/builtin/index.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import type { JsonValue } from '../../types/json.js';
import type {
  AgentRuntime, AgentRuntimeOptions, CreateRuntimeAgent, RuntimeAgent, RuntimeCapabilityGrant, RuntimeInterrupt, RuntimeLimits,
} from '../api.js';
import { ToolExecutor } from './executor.js';
import { AdmissionWait, classifyFault, defaultLimits, RequestAdmission, RuntimeFault, trackedRequester } from './limits.js';
import { requestAction, type WorkActionResult } from './protocol.js';
import { createRuntimeAgentSchema, jsonSchema, type RuntimeAction } from './schema.js';
import { createRuntimeCharacters } from './characters.js';
import { validateRestoredAgents } from './restore.js';
import { RuntimeStore } from './store.js';
import { ConversationStore, isMember, type ConversationBatch } from './conversations.js';
import type { CreateConversation, RuntimeConversation, SendConversationMessage } from '../conversations.js';
import type { ConversationMember } from '../conversations.js';
import type { ConversationRead, ConversationSearch, SetContactNote } from '../memory.js';
import { ConversationMemoryStore, type MemoryIdentity } from './memory-store.js';
import { ConversationCompactor, noteFragment } from './memory-compactor.js';
import { composeMemory, defaultMemoryPolicy } from './memory-view.js';
import { memoryMemberSchema } from './memory-schema.js';
import { defaultTokenSettings, runtimeTokenSettingsSchema, tokenContextBudget, type RuntimeTokenSettings } from '../tokens.js';
import { finishWorkBudget, renewWorkBudget, workBudget } from './work-budget.js';
import { withNativeHistory } from './native-history.js';

type LiveAgent = {
  data: RuntimeAgent; acb: ManagedAgentControlBlock; context: AgentContextManager;
  runner: AgentRoundRunner; batchId: string; controller: AbortController | null;
};

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new Runtime(options);
}

class Runtime implements AgentRuntime {
  readonly #store: RuntimeStore;
  readonly #contexts: SqliteContextStore;
  readonly #conversations: ConversationStore;
  readonly #memory: ConversationMemoryStore;
  #compactor: ConversationCompactor;
  readonly #scheduler: AgentScheduler;
  readonly #tools: ToolRegistry;
  readonly #characters: CharacterRegistry;
  readonly #capabilities = new CapabilityManager();
  readonly #agents = new Map<number, LiveAgent>();
  readonly #workspaces = new Map<string, string>();
  #limits: RuntimeLimits;
  #tokens: RuntimeTokenSettings;
  readonly #hasTokenSettings: boolean;
  readonly #admission: RequestAdmission;
  readonly #executor: ToolExecutor;
  readonly #abort = new AbortController();
  readonly #jobs = new Map<number, Promise<void>>();
  #initialized = false;
  #fatal: string | null = null;
  #closed = false;
  #loop: Promise<void> | null = null;
  #mailTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly options: AgentRuntimeOptions) {
    if (options.database === ':memory:') {
      throw new Error('Runtime 不支持 :memory: 数据库，请提供 SQLite 文件路径。');
    }
    this.#limits = { ...defaultLimits, ...options.limits };
    for (const [key, value] of Object.entries(this.#limits)) {
      if (!(key in defaultLimits) || !Number.isFinite(value) || value < 0 ||
          (!key.includes('Usd') && (!Number.isSafeInteger(value) || key !== 'maxRetries' && value < 1))) {
        throw new Error(`非法 Runtime 限制：${key}`);
      }
    }
    const inlineCharacters = options.toolResultInlineCharacters ?? 4000;
    if (!Number.isSafeInteger(inlineCharacters) || inlineCharacters < 1) {
      throw new Error('非法工具结果字符额度。');
    }
    this.#store = new RuntimeStore(options.database);
    const savedTokens = this.#store.metadata<RuntimeTokenSettings>('token-settings');
    const explicitTokens = options.tokenSettings ?? savedTokens;
    this.#hasTokenSettings = explicitTokens !== undefined;
    this.#tokens = explicitTokens ? runtimeTokenSettingsSchema.parse(explicitTokens) : {
      ...defaultTokenSettings,
      maxRequestTokens: this.#limits.maxRequestTokens, maxOutputTokens: this.#limits.maxOutputTokens,
      tokensPerMinute: this.#limits.tokensPerMinute, maxTotalTokens: this.#limits.maxTotalTokens,
    };
    if (explicitTokens) this.#limits = { ...this.#limits, ...this.#tokenLimits(this.#tokens) };
    this.#contexts = new SqliteContextStore(options.database);
    this.#conversations = new ConversationStore(options.database, options.conversationPolicy);
    const memoryPolicy = { ...defaultMemoryPolicy, ...options.memoryPolicy };
    for (const [key, value] of Object.entries(memoryPolicy)) {
      if (!(key in defaultMemoryPolicy) || !Number.isSafeInteger(value) || value < 1) throw new Error(`非法记忆限制：${key}`);
    }
    if (memoryPolicy.recentMessages > 100 || memoryPolicy.recentConversations > 50) throw new Error('近期记忆范围超过上限。');
    this.#memory = new ConversationMemoryStore(options.database, this.#conversations);
    this.#compactor = new ConversationCompactor(this.#memory, memoryPolicy,
      this.#limits.maxRequestTokens, this.#limits.maxOutputTokens);
    this.#scheduler = createAgentScheduler({
      maxConcurrentRuns: this.#limits.maxConcurrentRequests, batchWindowMs: 1000,
      operationTimeoutMs: this.#limits.toolTimeoutMs,
    }, this.#store);
    this.#tools = options.tools ?? new ToolRegistry();
    if (!options.tools) registerBuiltinTools(this.#tools);
    this.#characters = options.characters ?? createRuntimeCharacters();
    this.#admission = new RequestAdmission(this.#limits, this.#store);
    this.#executor = new ToolExecutor({
      store: this.#store, scheduler: this.#scheduler, tools: this.#tools, limits: this.#limits,
      inlineCharacters,
      workspace: (agent) => this.#workspaces.get(agent.workspaceId)!,
      agent: (id) => this.#live(id).data, update: (agent) => this.#update(agent),
      onFault: (id, kind, message) => this.#interrupt(id, '', kind, message, 'feedback', null),
      onUnknown: (id) => this.#pauseUnknown(id),
      onReconciled: (operation, ref) => {
        // 可靠调度事件处理收件箱背压；确认标记仅在 Context 已持久接收后清除。
        const eventRef = `reconciliation-event:${operation.id}`;
        this.#store.putMetadata(eventRef, { resultRef: ref, target: operation.target,
          operationId: operation.id, agentId: operation.agentId });
        this.#notify(operation.agentId, eventRef);
        return false;
      },
      onFatal: () => this.#failStop(),
    });
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    for (const [id, path] of Object.entries(this.options.workspaces)) {
      await this.registerWorkspace(id, path);
    }
    const restored = this.#store.agents();
    validateRestoredAgents(restored, this.#characters, this.#tools, this.#limits);
    if (this.#hasTokenSettings) {
      this.#store.putMetadata('token-settings', { ...this.#tokens });
      this.#configureContextBudgets(this.#tokens);
    }
    for (const data of restored) this.#attach(data);
    // 在启动任何可重试操作前，全局隔离旧写入，避免逐 Agent 恢复的时序空隙。
    this.#executor.isolateRestoredOperations();
    for (const [id, live] of this.#agents) {
      await this.#executor.recover(id);
      for (const input of this.#store.inputs(id)) this.#notify(id, input.id);
      if (live.data.status !== 'active') {
        this.#scheduler.suspend(id, { reason: live.data.status, resumeAt: null });
      }
    }
    this.#initialized = true;
    this.#refreshMail();
  }

  start(): void {
    if (!this.#initialized || this.#closed) throw new Error('Runtime 尚未初始化或已经关闭。');
    this.#loop ??= this.#pump().catch(() => this.#failStop());
  }

  isReady(): boolean { return this.#initialized && !this.#closed && !this.#fatal; }

  tokenSettings(): RuntimeTokenSettings { return structuredClone(this.#tokens); }

  configureTokens(value: RuntimeTokenSettings): void {
    this.#checkOpen();
    const settings = runtimeTokenSettingsSchema.parse(value);
    if (this.#jobs.size || [...this.#agents.values()].some((live) =>
      this.#scheduler.inspect(live.data.control.agentId).running ||
      live.data.status === 'active' && (live.context.needsRun() || live.acb.getState() !== AgentState.SLEEPING ||
        this.agentConversations(live.data.control.agentId, live.data.ownerId).some((conversation) =>
          this.conversationMailboxes(conversation.id, live.data.ownerId, live.data.control.agentId)
            .some((mailbox) => mailbox.agentId === live.data.control.agentId && mailbox.state !== 'processed'))))) {
      throw new Error('请等待当前工作结束，或暂停运行中的 Agent 后再调整容量。');
    }
    this.#validateContextBudgets(settings);
    // 设置先写为恢复目标；中途存储失败时停止执行，重启按目标完成剩余上下文更新。
    try {
      this.#store.putMetadata('token-settings', { ...settings });
      this.#configureContextBudgets(settings);
      this.#tokens = settings;
      this.#limits = { ...this.#limits, ...this.#tokenLimits(settings) };
      this.#admission.limits = this.#limits;
      this.#compactor = new ConversationCompactor(this.#memory, this.#compactor.policy,
        settings.maxRequestTokens, settings.maxOutputTokens);
      for (const live of this.#agents.values()) {
        live.context = restoreAgentContextManager({ key: live.data.contextKey, store: this.#contexts });
        this.#bindRunner(live);
        this.#update({ ...live.data, control: live.acb.snapshot() });
      }
    } catch (error) { this.#failStop(); throw error; }
  }

  #tokenLimits(settings: RuntimeTokenSettings): Pick<RuntimeLimits,
    'maxRequestTokens' | 'maxOutputTokens' | 'tokensPerMinute' | 'maxTotalTokens'> {
    const { maxRequestTokens, maxOutputTokens, tokensPerMinute, maxTotalTokens } = settings;
    return { maxRequestTokens, maxOutputTokens, tokensPerMinute, maxTotalTokens };
  }

  #validateContextBudgets(settings: RuntimeTokenSettings): void {
    for (const key of this.#contexts.keys()) {
      const state = this.#contexts.load(key)!;
      for (const frame of [state.context.level1, state.context.level2, state.context.level3]) {
        if (frame && estimateContextTokens({ ...frame, budget: tokenContextBudget(settings, frame.budget.maxTasks) }) >
            settings.contextMaxTokens) {
          throw new Error('新的层级硬上限无法容纳已有现场，请先压缩或提高容量。');
        }
      }
    }
  }

  #configureContextBudgets(settings: RuntimeTokenSettings): void {
    this.#validateContextBudgets(settings);
    for (const key of this.#contexts.keys()) {
      const context = restoreAgentContextManager({ key, store: this.#contexts });
      const state = context.checkpoint();
      const budget = tokenContextBudget(settings, Math.max(...Object.values(state.policy.budgets).map((item) => item.maxTasks)));
      if (Object.values(state.policy.budgets).every((item) => JSON.stringify(item) === JSON.stringify(budget))) continue;
      const id = Number(key.split(':')[1]);
      const queued = this.#store.load(id)?.queuedBatch;
      if (state.pendingSummary && queued && this.#store.agent(id)?.contextKey === key) {
        this.#store.repairRequest(`summary:${state.pendingSummary.id}`);
      }
      context.configureBudget(budget);
    }
  }

  async registerWorkspace(id: string, path: string): Promise<void> {
    if (this.#closed || this.#fatal || !id.trim()) throw new Error('工作区登记不可用。');
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error('工作区必须是目录。');
    // 异步检查结束后再比较，避免并发登记同名目录绕过不可变约束。
    const previous = this.#workspaces.get(id);
    if (this.#closed || previous !== undefined && previous !== canonical) {
      throw new Error('已登记的工作区不能更换目录。');
    }
    this.#workspaces.set(id, canonical);
  }

  async createAgent(input: CreateRuntimeAgent): Promise<RuntimeAgent> {
    this.#checkOpen();
    const parsed = createRuntimeAgentSchema.parse(input);
    if (!this.#workspaces.has(input.workspaceId) || !input.ownerId.trim() || !input.objective.trim()) {
      throw new Error('宿主、工作区或目标无效。');
    }
    if (this.#agents.size >= this.#limits.maxAgents) throw new Error('Agent 数量超过上限。');
    const character = this.#characters.get(input.character);
    const ceiling = parsed.capabilities.map(normalizeCapabilityInput);
    if (this.#characters.capabilityOutsideCeiling(character.id, ceiling)) throw new Error('能力超过角色上限。');
    for (const request of ceiling) {
      if ((request.capability.startsWith('file.') || request.capability.startsWith('directory.')) &&
          (request.scope.kind === 'all' || !request.scope.resource.startsWith('workspace://current/'))) {
        throw new Error('文件权限只能授予工作区语义路径。');
      }
    }
    const id = this.#store.reserveAgent();
    const contextKey = `agent:${id}`;
    const budget = tokenContextBudget(this.#tokens);
    const context = createAgentContextManager({
      key: contextKey, store: this.#contexts, objective: input.objective,
      initiallyIdle: parsed.startMode === 'on_message',
      instructions: input.instructions ?? ['完成用户委托，使用已有证据汇报结果。'],
      policy: this.options.contextPolicy ?? { budgets: { 1: budget, 2: budget, 3: budget },
        maxSummaryAttempts: 4, maxInbox: 256, maxDeliveryBytes: 20_000 },
    });
    const grants = this.#capabilities.issueRootGrants(contextKey, ceiling, Date.now())
      .map((grant): RuntimeCapabilityGrant => ({ ...grant, source: { type: 'root' }, delegable: false }));
    const data: RuntimeAgent = {
      schemaVersion: 2,
      control: { agentId: id, character: input.character, agentName: `agent-${id}`, state: AgentState.READY,
        capacity: ceiling.map(({ capability, scope }) => ({ capability, scope })),
        skills: character.visibleToolIds.filter((name) => this.#tools.descriptors().some((tool) => tool.name === name)),
        context: context.snapshot(), createdAt: Date.now(), modelConfigId: 'server-default' },
      ownerId: input.ownerId, workspaceId: input.workspaceId, contextKey,
      ceiling, grants, status: 'active', rounds: 0, totalTokens: 0, costUsd: 0,
      lastAction: '', repeatedActions: 0, lastError: null,
    };
    this.#store.saveAgent(data);
    if (parsed.displayName) this.#store.putMetadata(`name:${id}`, parsed.displayName);
    this.#attach(data, context);
    this.directConversation(id, input.ownerId);
    this.#event(id, 'agent_created', { character: input.character, createdBy: 'user' });
    return this.inspect(id, input.ownerId);
  }

  #attach(data: RuntimeAgent, existing?: AgentContextManager): void {
    if (!this.#workspaces.has(data.workspaceId) || !this.#characters.has(data.control.character)) {
      throw new Error('恢复时缺少工作区或角色配置。');
    }
    if (data.contextKey !== `agent:${data.control.agentId}`) {
      const conversation = this.#conversations.get(data.contextKey.split(':conversation:')[1]!);
      if (conversation.ownerId !== data.ownerId || conversation.workspaceId !== data.workspaceId ||
          !isMember(conversation, { kind: 'agent', id: data.control.agentId })) {
        throw new Error('恢复会话与 Agent 身份不一致。');
      }
    }
    const context = existing ?? restoreAgentContextManager({ key: data.contextKey, store: this.#contexts });
    const saved = this.#store.load(data.control.agentId);
    const acb = createAgentControlBlock({ ...data.control, context: context.snapshot(),
      state: saved?.queuedBatch || saved?.running || saved?.pendingOperations.length ||
        saved?.completedResults.length || saved?.pendingEvents.length || context.needsRun() || saved?.suspension
        ? AgentState.READY : AgentState.SLEEPING }, { snapshot: () => live.context.snapshot() });
    const live: LiveAgent = { data, acb, context, batchId: '', controller: null,
      runner: null as unknown as AgentRoundRunner };
    this.#agents.set(data.control.agentId, live);
    this.#scheduler.register(acb);
    this.#bindRunner(live);
  }

  #bindRunner(live: LiveAgent): void {
    const { data, context } = live;
    const requester = trackedRequester({
      requester: this.options.requester, admission: this.#admission, store: this.#store, limits: () => this.#limits,
      agent: () => live.data, update: (agent) => this.#update(agent),
      batch: () => this.#requestKey(live, live.batchId),
      workBatch: () => this.#conversations.active(data.control.agentId)?.id,
      prepare: (input) => {
        if (input.tools?.some((tool) => tool.name.startsWith('submit_'))) {
          return live.data.lastError ? { ...input, messages: input.messages.map((message, index) =>
            index === 0 && message.role === 'system'
              ? { ...message, content: `${message.content}\n本次纠错反馈：${live.data.lastError}` } : message) } : input;
        }
        const id = data.control.agentId;
        const budget = workBudget(this.#store, id, this.#conversations.active(id)?.id);
        return withNativeHistory({
          store: this.#store, key: live.batchId, request: input,
          scope: JSON.stringify([id, live.data.contextKey, budget.key, live.context.cursor(),
            this.options.requester.provider, this.options.requester.model]),
          maxInput: this.#limits.maxRequestTokens - (input.maxOutputTokens ?? this.#limits.maxOutputTokens),
          receipt: (key) => !!live.context.roundReceipt(key),
          result: (key, index) => {
            const operation = this.#store.operation(`${key}:tool:${index}`);
            if (operation) return operation.agentId === id ? this.#executor.nativeResult(operation) : undefined;
            return this.#store.metadata<JsonValue>(`native-result:${key}`);
          },
        });
      },
    });
    live.runner = createAgentRoundRunner({
      agentId: data.control.agentId, context, scheduler: this.#scheduler, requester,
      dispatchRequest: (input, signal, beforeSend) => requester.dispatchRequest(input, signal, beforeSend),
      formatError: (error) => classifyFault(error).message,
      maxRequestTokens: this.#limits.maxRequestTokens, maxOutputTokens: this.#limits.maxOutputTokens,
      resolveEvent: async (event) => {
        if (event.eventRef.startsWith('reconciliation-event:')) {
          const record = this.#store.metadata<{
            operationId: string; agentId: number; resultRef: string; target: import('../../agent-context/index.js').ContextCursor;
          }>(event.eventRef);
          if (!record || record.agentId !== data.control.agentId) throw new Error('对账事件引用无效。');
          return { target: record.target, entries: this.#executor.entries(record.resultRef) };
        }
        // 反馈正文已按目标层幂等入箱，此事件仅提供调度唤醒，不重复投递。
        if (event.eventRef.startsWith(`host-feedback:${data.control.agentId}:`) &&
          this.#store.metadata(event.eventRef)) return { entries: [{
            id: `${event.eventId}:received`, createdAt: 0, kind: 'event', name: 'host_feedback_received',
            data: { feedbackId: event.eventRef },
          }] };
        const batch = this.#conversations.batch(event.eventRef);
        if (batch) {
          if (batch.agentId !== data.control.agentId ||
              data.contextKey !== this.#conversationContextKey(batch.agentId, batch.conversationId)) {
            throw new Error('投递批次与当前会话不一致。');
          }
          return { entries: batch.messages.map((message): ContextEntry => ({
            id: message.id, createdAt: message.createdAt, kind: 'event', name: 'conversation_message',
            data: { ...message, mentions: [...message.mentions],
              senderName: message.sender.kind === 'agent' ? this.#displayName(message.sender.id) : '用户',
            },
          })) };
        }
        const input = this.#store.input(event.eventRef);
        if (!input || input.agentId !== data.control.agentId) throw new Error('消息引用缺失。');
        return { entries: [{ id: event.eventId, createdAt: input.createdAt ?? data.control.createdAt, kind: 'message',
          role: 'user', content: input.sender ? `来自 ${input.sender}：${input.content}` : input.content }],
          ...(input.target ? { target: input.target } : {}) };
      },
      resolveResult: async (result) => {
        const operation = this.#store.operations(data.control.agentId).find((item) =>
          item.schedulerOperation?.operationId === result.operation.operationId);
        if (!operation) return { entries: [{ id: result.operation.operationId, createdAt: result.completedAt,
          kind: 'event', name: 'async_operation_finished', data: result.outcome }] };
        const ref = this.#executor.resolveWait(operation, result);
        return { target: operation.target, entries: this.#executor.entries(ref) };
      },
      inputsReceived: (run) => run.batch.events.forEach((event) => {
        if (event.eventRef.startsWith('reconciliation-event:')) {
          const operationId = event.eventRef.slice('reconciliation-event:'.length);
          const record = this.#store.metadata<{ resultRef: string }>(event.eventRef);
          if (this.#store.reconciliationPending(operationId)) {
            this.#store.acknowledgeReconciliation(operationId);
            this.#event(data.control.agentId, 'operation_reconciled', { operationId, resultRef: record?.resultRef ?? '' });
          }
        } else if (this.#conversations.batch(event.eventRef)) this.#conversations.delivered(event.eventRef);
        else this.#store.acknowledgeInput(event.eventRef);
      }),
      waitSatisfied: () => this.#scheduler.inspect(data.control.agentId).completedResults.length > 0,
      failureReturned: (run, error) => this.#failure(live, run, error),
      work: (round) => this.#work(live, round),
    });
  }

  submit(agentId: number, ownerId: string, content: string, idempotencyKey: string): void {
    this.sendMessage(this.directConversation(agentId, ownerId).id, ownerId, { content, idempotencyKey });
  }
  provideFeedback(agentId: number, ownerId: string, content: string, idempotencyKey: string): void {
    const live = this.#owned(agentId, ownerId);
    if (!content.trim() || Buffer.byteLength(content) > 12_000 || !idempotencyKey.trim() ||
      idempotencyKey.length > 200 || live.data.status === 'cancelled') throw new Error('宿主反馈无效。');
    const key = `host-feedback:${agentId}:${idempotencyKey}`;
    const hash = createHash('sha256').update(content).digest('hex');
    const previous = this.#store.metadata<{ contentHash: string; createdAt: number;
      target: import('../../agent-context/index.js').ContextCursor }>(key);
    if (previous && previous.contentHash !== hash) throw new Error('宿主反馈幂等键已用于不同内容。');
    const delivery = previous ?? { contentHash: hash, createdAt: Date.now(), target: live.context.cursor() };
    this.#store.putMetadata(key, delivery);
    live.context.receive([{ key, target: delivery.target, entries: [{
      id: key, createdAt: delivery.createdAt, kind: 'message', role: 'user',
      content: `宿主现场反馈：${content}`,
    }] }]);
    this.#notify(agentId, key);
    this.#event(agentId, 'host_feedback', { id: key, contentHash: hash });
  }
  setDisplayName(id: number, owner: string, name: string): void {
    this.#owned(id, owner);
    const parsed = createRuntimeAgentSchema.shape.displayName.unwrap().parse(name);
    this.#store.putMetadata(`name:${id}`, parsed);
  }
  createConversation(input: CreateConversation): RuntimeConversation {
    this.#checkOpen();
    if (!this.#workspaces.has(input.workspaceId) ||
        !input.members.some((member) => member.kind === 'user' && member.id === input.ownerId)) {
      throw new Error('用户创建的会话需要包含本人和有效工作区。');
    }
    for (const member of input.members) {
      if (member.kind === 'user') {
        if (member.id !== input.ownerId) throw new Error('当前宿主不支持加入其他用户。');
      } else {
        const agent = this.#owned(member.id, input.ownerId).data;
        if (agent.workspaceId !== input.workspaceId || agent.status === 'cancelled') throw new Error('成员工作区或状态无效。');
      }
    }
    return this.#conversations.create(input);
  }
  directConversation(agentId: number, ownerId: string): RuntimeConversation {
    const agent = this.#owned(agentId, ownerId).data;
    return this.#conversations.create({ ownerId, workspaceId: agent.workspaceId, kind: 'direct',
      title: this.#displayName(agentId), members: [{ kind: 'user', id: ownerId }, { kind: 'agent', id: agentId }] });
  }
  conversations(owner: string) {
    this.#checkOpen();
    return this.#conversations.list(owner, { kind: 'user', id: owner });
  }
  agentConversations(id: number, owner: string) {
    this.#owned(id, owner);
    return this.#conversations.list(owner, { kind: 'agent', id });
  }
  #readConversation(id: string, owner: string, inspectAgentId?: number): RuntimeConversation {
    this.#checkOpen();
    const conversation = this.#conversations.get(id);
    if (inspectAgentId !== undefined) this.#owned(inspectAgentId, owner);
    if (conversation.ownerId !== owner || !isMember(conversation, inspectAgentId === undefined
      ? { kind: 'user', id: owner } : { kind: 'agent', id: inspectAgentId })) throw new Error('无权读取此会话。');
    return conversation;
  }
  conversationMessages(id: string, owner: string, inspectAgentId?: number) {
    this.#readConversation(id, owner, inspectAgentId);
    return this.#conversations.messages(id);
  }
  conversationMailboxes(id: string, owner: string, inspectAgentId?: number) {
    this.#readConversation(id, owner, inspectAgentId);
    return this.#conversations.mailboxes(id);
  }
  sendMessage(id: string, owner: string, input: SendConversationMessage) {
    const conversation = this.#readConversation(id, owner);
    for (const member of conversation.members) if (member.kind === 'agent' &&
        this.#live(member.id).data.status === 'cancelled') throw new Error('会话包含已取消的 Agent，需恢复后再发送。');
    const message = this.#conversations.send(id, { kind: 'user', id: owner }, input, undefined, this.#deliveryLimit(conversation));
    this.#refreshMail();
    return message;
  }
  #memoryIdentity(ownerId: string, inspectAgentId?: number): MemoryIdentity {
    this.#checkOpen();
    if (inspectAgentId !== undefined) this.#owned(inspectAgentId, ownerId);
    return { ownerId, member: inspectAgentId === undefined ? { kind: 'user', id: ownerId } : { kind: 'agent', id: inspectAgentId } };
  }
  #noteTarget(identity: MemoryIdentity, input: ConversationMember): ConversationMember {
    const target = memoryMemberSchema.parse(input);
    if (target.kind === 'user') {
      if (target.id !== identity.ownerId) throw new RuntimeFault('permission', '当前宿主不支持其他用户身份。');
    } else {
      const targetAgent = this.#agents.get(target.id)?.data;
      if (!targetAgent || targetAgent.ownerId !== identity.ownerId ||
          identity.member.kind === 'agent' && targetAgent.workspaceId !== this.#live(identity.member.id).data.workspaceId) {
        throw new RuntimeFault('permission', '备注对象不属于当前通讯范围。');
      }
    }
    return target;
  }
  conversationSummary(id: string, ownerId: string, inspectAgentId?: number) {
    return this.#memory.summary(this.#memoryIdentity(ownerId, inspectAgentId), id);
  }
  searchConversations(ownerId: string, input: ConversationSearch, inspectAgentId?: number) {
    return this.#memory.search(this.#memoryIdentity(ownerId, inspectAgentId), input);
  }
  readConversation(ownerId: string, input: ConversationRead, inspectAgentId?: number) {
    return this.#memory.read(this.#memoryIdentity(ownerId, inspectAgentId), input);
  }
  contactNote(ownerId: string, target: ConversationMember, inspectAgentId?: number) {
    const identity = this.#memoryIdentity(ownerId, inspectAgentId);
    return this.#memory.note(identity, this.#noteTarget(identity, target));
  }
  contactNotes(ownerId: string, inspectAgentId?: number) {
    return this.#memory.notes(this.#memoryIdentity(ownerId, inspectAgentId));
  }
  setContactNote(ownerId: string, input: SetContactNote) {
    const identity = this.#memoryIdentity(ownerId);
    this.#noteTarget(identity, input.target);
    return this.#memory.setNote(identity, input);
  }
  #notify(agentId: number, id: string): void {
    try { this.#scheduler.notify(agentId, { eventId: id, eventRef: id }); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'capacity_exceeded') throw error;
    }
  }
  inspect(agentId: number, ownerId: string): RuntimeAgent {
    const live = this.#owned(agentId, ownerId);
    return structuredClone({ ...live.data, control: live.acb.snapshot() });
  }
  list(ownerId: string): RuntimeAgent[] {
    return [...this.#agents.values()].filter((item) => item.data.ownerId === ownerId)
      .map((item) => this.inspect(item.data.control.agentId, ownerId));
  }
  events(id: number, owner: string, after = 0) { this.#owned(id, owner); return this.#store.events(id, after); }
  messages(id: number, owner: string) {
    return this.conversationMessages(this.directConversation(id, owner).id, owner).map((message) => ({
      id: message.id, agentId: id, createdAt: message.createdAt, content: message.content,
      role: message.sender.kind === 'user' ? 'user' as const : 'assistant' as const,
      sender: message.sender.kind === 'agent' ? `agent-${message.sender.id}` : null,
    }));
  }
  legacyMessages(id: number, owner: string) {
    const live = this.#owned(id, owner);
    return this.#store.messages(id, live.data.control.createdAt);
  }
  interrupts(id: number, owner: string) { this.#owned(id, owner); return this.#store.interrupts(id); }
  approvals(id: number, owner: string) { this.#owned(id, owner); return this.#executor.approvals(id); }
  approve(id: number, owner: string, operationId: string, allowed: boolean): void {
    this.#owned(id, owner); this.#assertOperation(id, operationId); this.#executor.approve(operationId, allowed);
  }
  reconcile(id: number, owner: string, operationId: string, resolution: { outcome: 'succeeded' | 'failed'; result: JsonValue }): void {
    this.#owned(id, owner); this.#assertOperation(id, operationId); this.#executor.reconcile(operationId, resolution);
  }
  #assertOperation(id: number, operationId: string): void {
    if (this.#store.operation(operationId)?.agentId !== id) throw new Error('操作不属于该 Agent。');
  }
  async pause(id: number, owner: string): Promise<void> {
    const live = this.#owned(id, owner);
    this.#update({ ...live.data, status: 'paused' });
    this.#scheduler.suspend(id, { reason: '宿主暂停', resumeAt: null });
    live.controller?.abort(new Error('宿主暂停。'));
    await this.#jobs.get(id);
    this.#scheduler.suspend(id, { reason: '宿主暂停', resumeAt: null });
  }
  resume(id: number, owner: string): void {
    const live = this.#owned(id, owner);
    if (this.#executor.approvals(id).some((item) => item.state === 'unknown')) {
      throw new Error('仍有副作用结果未知的操作，必须先对账。');
    }
    if (live.data.status !== 'active' && this.#jobs.has(id)) throw new Error('上一轮正在退出，请稍后继续。');
    if (live.data.status === 'paused') renewWorkBudget(this.#store, id, this.#limits.maxRounds);
    const pending = live.context.checkpoint().pendingSummary;
    const queued = this.#scheduler.inspect(id).queuedBatch;
    const lastInterrupt = this.#store.interrupts(id).at(-1);
    const failedProtocol = lastInterrupt?.kind === 'protocol' && lastInterrupt.action === 'pause' &&
      lastInterrupt.batchId === queued?.batchId;
    const failedLoop = lastInterrupt?.kind === 'loop' && lastInterrupt.action === 'pause' &&
      lastInterrupt.batchId === queued?.batchId && queued &&
      !live.context.roundReceipt(queued.batchId) && !this.#store.metadata<boolean>(`action:${queued.batchId}`);
    if (live.data.status === 'paused' && failedLoop && queued && lastInterrupt) {
      // 被循环检查拒绝的动作尚未执行；归档证据后只重开一个有界动作窗口。
      this.#store.repairRequest(queued.batchId);
      this.#store.putMetadata(`retries:${queued.batchId}`, 0);
      this.#update({ ...live.data, lastAction: '', repeatedActions: 0 });
      this.#event(id, 'loop_retry_requested', { batchId: queued.batchId,
        previousError: lastInterrupt.message, repeatedActionLimit: this.#limits.repeatedActionLimit });
    }
    if (live.data.status === 'paused' && (pending?.lastError || failedProtocol)) {
      if (queued) {
        // 显式继续重开有限尝试；归档失败回复，避免新预算仍重放旧的截断响应。
        this.#store.repairRequest(this.#requestKey(live, queued.batchId));
        this.#store.putMetadata(`retries:${queued.batchId}`, 0);
      }
      if (pending?.lastError) {
        live.context.retrySummary();
        this.#event(id, 'summary_retry_requested', { sourceRef: pending.sourceRef, previousAttempts: pending.attempts });
      } else {
        this.#event(id, 'protocol_retry_requested', { previousError: lastInterrupt?.message ?? '' });
      }
    }
    this.#update({ ...live.data, status: 'active', lastError: failedLoop ? lastInterrupt?.message ?? live.data.lastError : null });
    this.#executor.resume(id);
    this.#scheduler.resume(id);
    this.#refreshMail();
  }
  async cancel(id: number, owner: string): Promise<void> {
    await this.pause(id, owner);
    this.#scheduler.cancelOperations(id, '宿主取消。');
    const live = this.#live(id);
    this.#update({ ...live.data, status: 'cancelled' });
    this.#interrupt(id, '', 'cancelled', '宿主取消自动执行。', 'stop', null);
  }

  async #work(live: LiveAgent, round: AgentWorkRound): Promise<WorkActionResult> {
    const result = await this.#performWork(live, round);
    // 先保存候选回执；只有 Context 原子提交成功后，续接读取器才允许重放。
    this.#store.putMetadata(`native-result:${round.idempotencyKey}`, jsonSchema.parse({
      decision: result.decision, entries: result.entries ?? [],
    }));
    return result;
  }

  async #performWork(live: LiveAgent, round: AgentWorkRound): Promise<WorkActionResult> {
    const id = live.data.control.agentId;
    const identity: MemoryIdentity = { ownerId: live.data.ownerId, member: { kind: 'agent', id } };
    const batch = this.#conversations.active(id);
    if (await this.#compactor.run(round, identity, batch?.id, this.#store.request(round.idempotencyKey) !== undefined)) {
      return { decision: { type: 'continue' } };
    }
    const action = await requestAction(round, {
      character: this.#characters.get(live.data.control.character),
      tools: this.#tools.descriptors().filter((tool) => live.data.control.skills.includes(tool.name)).map((tool) => ({
        name: tool.name, description: tool.description, parameters: tool.inputSchema ?? { type: 'object' },
      })),
      peers: [...this.#agents.values()].filter((item) => this.#canMessage(live.data, item.data))
        .map((item) => item.data.control.agentName),
      self: { id, name: this.#displayName(id) },
      ...this.#conversationPrompt(live),
      memory: (tokens) => composeMemory(this.#memory, identity, batch?.conversationId, this.#compactor.policy, tokens),
      maxInputTokens: this.#limits.maxRequestTokens - this.#limits.maxOutputTokens,
      previousError: live.data.lastError,
      capabilities: live.data.ceiling,
      repairAttempt: this.#store.metadata<number>(`retries:${round.idempotencyKey}`) ?? 0,
    });
    const hash = createHash('sha256').update(JSON.stringify(action)).digest('hex');
    const marker = `action:${round.idempotencyKey}`;
    if (!this.#store.metadata<boolean>(marker)) {
      const repeated = hash === live.data.lastAction || action.kind === 'context' &&
        ['continue', 'replan', 'compact'].includes(action.decision.type)
        ? live.data.repeatedActions + 1 : 1;
      if (repeated >= this.#limits.repeatedActionLimit) throw new RuntimeFault('loop', '重复动作超过限制，暂停自动执行。');
      this.#update({ ...live.data, lastAction: hash, repeatedActions: repeated, lastError: null });
      this.#store.putMetadata(marker, true);
    }
    this.#event(id, 'action', { kind: action.kind,
      ...(action.kind === 'context' ? { decision: action.decision.type } : {}),
      level: live.context.snapshot().level3?.level ?? live.context.snapshot().level2?.level ?? 1 });
    switch (action.kind) {
      case 'conversation_search':
      case 'conversation_read':
      case 'contact_note_get':
      case 'contact_note_set':
        return this.#memoryAction(identity, action, round.idempotencyKey);
      case 'context': return { decision: action.decision };
      case 'tools': {
        this.#executor.stage(round, live.context, action.calls);
        const entries: ContextEntry[] = action.calls.map((call, index) => ({
          id: `${round.idempotencyKey}:call:${index}`, createdAt: Date.now(), kind: 'tool_call',
          callId: `${round.idempotencyKey}:tool:${index}`, toolName: call.name, input: call.arguments,
        }));
        return { decision: { type: 'wait' }, entries };
      }
      case 'output': {
        const frame = live.context.snapshot().level3 ?? live.context.snapshot().level2 ?? live.context.snapshot().level1;
        if (frame.taskChain.tasks.some((task) => task.state === 'RUNNING' || task.state === 'WAITING')) {
          throw new RuntimeFault('protocol', '最终交付前必须完成当前任务链。', true);
        }
        const key = `output:${round.idempotencyKey}`;
        if (!this.#store.metadata<boolean>(key)) {
          this.#event(id, 'output', { id: key, content: action.content, level: frame.level });
          this.#store.putMetadata(key, true);
        }
        return { decision: { type: frame.level === 1 ? 'idle' : 'complete' }, entries: [{
          id: key, createdAt: Date.now(), kind: 'message', role: 'assistant', content: action.content,
        }] };
      }
      case 'artifact': {
        const value = this.#store.readArtifact(id, action.ref) ?? live.context.read(action.ref);
        if (value === undefined) {
          // 来源可用于事实引用，不代表能用产物工具读取；已授权来源的工具误用允许有限纠正。
          if (round.view.frames.some((frame) => frame.allowedSourceRefs.includes(action.ref))) {
            throw new RuntimeFault('protocol',
              '该来源不是可读取的历史产物。聊天消息请使用conversation_read并指定conversationId、messageId和offset；历史产物请选择artifactRef或historyRef。', true);
          }
          throw new RuntimeFault('permission', '该历史引用不属于当前 Agent。');
        }
        const text = JSON.stringify(value);
        const end = Math.min(text.length, action.offset + 4000);
        return { decision: { type: 'continue' }, entries: [{
          id: `${round.idempotencyKey}:artifact`, createdAt: Date.now(), kind: 'event', name: 'artifact_page',
          data: { ref: action.ref, offset: action.offset,
            content: text.slice(action.offset, end), totalCharacters: text.length,
            nextOffset: end < text.length ? end : null },
        }] };
      }
      case 'message':
      case 'send_message': {
        if (action.kind === 'send_message' && action.finish) this.#assertCanFinish(live);
        const destination = action.kind === 'message' ? `peer:${action.recipient}` : action.conversationId;
        const conversation = this.#messageDestination(live, destination);
        const rejection = this.options.messageGuard?.({
          agentId: id, conversationId: conversation.id, content: action.content,
          mentions: action.kind === 'send_message' ? [...action.mentions ?? []] : [],
        });
        if (rejection) throw new RuntimeFault('protocol', rejection, true);
        const batch = this.#conversations.active(id);
        const message = this.#conversations.send(conversation.id, { kind: 'agent', id }, {
          content: action.content, idempotencyKey: round.idempotencyKey,
          ...(action.kind === 'send_message' && action.replyTo ? { replyTo: action.replyTo } : {}),
          ...(action.kind === 'send_message' && action.mentions ? { mentions: action.mentions } : {}),
        }, batch?.phaseId ?? `legacy:${id}`, this.#deliveryLimit(conversation));
        this.#refreshMail();
        return { decision: { type: action.kind === 'send_message' && action.finish ? 'finish_turn' : 'continue' },
          entries: [{ id: `sent:${message.id}`, createdAt: message.createdAt, kind: 'event', name: 'message_sent',
            data: { messageId: message.id, conversationId: message.conversationId, content: message.content,
              replyTo: message.replyTo } }] };
      }
    }
  }

  #memoryAction(identity: MemoryIdentity, action: Extract<RuntimeAction, {
    kind: 'conversation_search' | 'conversation_read' | 'contact_note_get' | 'contact_note_set';
  }>, key: string): WorkActionResult {
    let result: object;
    try {
      if (action.kind === 'conversation_search') {
        result = this.#memory.search(identity, {
          query: action.query,
          ...(action.conversationId !== undefined ? { conversationId: action.conversationId } : {}),
          ...(action.sender !== undefined ? { sender: action.sender } : {}),
          ...(action.since !== undefined ? { since: action.since } : {}),
          ...(action.until !== undefined ? { until: action.until } : {}),
          ...(action.beforeSequence !== undefined ? { beforeSequence: action.beforeSequence } : {}),
          ...(action.limit !== undefined ? { limit: action.limit } : {}),
        });
      } else if (action.kind === 'conversation_read') {
        result = this.#memory.read(identity, {
          conversationId: action.conversationId,
          ...(action.messageId !== undefined ? { messageId: action.messageId } : {}),
          ...(action.afterSequence !== undefined ? { afterSequence: action.afterSequence } : {}),
          ...(action.throughSequence !== undefined ? { throughSequence: action.throughSequence } : {}),
          ...(action.offset !== undefined ? { offset: action.offset } : {}),
          ...(action.limit !== undefined ? { limit: action.limit } : {}),
        });
      } else if (action.kind === 'contact_note_get') {
        result = noteFragment(this.#memory.note(identity, this.#noteTarget(identity, action.target)), action.offset);
      } else {
        const { kind: _kind, ...input } = action;
        this.#noteTarget(identity, input.target);
        const note = this.#memory.setNote(identity, { ...input, idempotencyKey: key });
        result = { target: note.target, version: note.version, updatedAt: note.updatedAt };
      }
    } catch (error) {
      if (!(error instanceof RuntimeFault) || !['protocol', 'permission'].includes(error.kind)) throw error;
      result = { error: error.message };
    }
    return { decision: { type: 'continue' }, entries: [{
      id: `${key}:memory`, kind: 'event', name: action.kind, createdAt: Date.now(), data: jsonSchema.parse(result),
    }] };
  }

  #displayName(id: number): string {
    return this.#store.metadata<string>(`name:${id}`) ?? this.#live(id).data.control.agentName;
  }
  #deliveryLimit(conversation: RuntimeConversation): number {
    return Math.min(...conversation.members.flatMap((member) => member.kind === 'agent'
      ? [this.#live(member.id).context.checkpoint().policy.maxDeliveryBytes] : []));
  }
  #conversationPrompt(live: LiveAgent) {
    const id = live.data.control.agentId;
    const batch = this.#conversations.active(id);
    const destinations = this.#conversations.list(live.data.ownerId, { kind: 'agent', id })
      .map(({ id, kind, title, members }) => ({ id, kind, title, members }));
    for (const peer of this.#agents.values()) if (this.#canMessage(live.data, peer.data)) {
      destinations.push({ id: `peer:${peer.data.control.agentName}`, kind: 'direct', title: this.#displayName(peer.data.control.agentId),
        members: [{ kind: 'agent', id }, { kind: 'agent', id: peer.data.control.agentId }] });
    }
    return { destinations, ...(batch ? { conversation: this.#conversations.get(batch.conversationId),
      currentBatch: { id: batch.id, messageIds: batch.messages.map((message) => message.id) } } : {}) };
  }
  #messageDestination(live: LiveAgent, destination: string): RuntimeConversation {
    if (destination.startsWith('peer:')) {
        const alias = destination.slice(5);
        const recipient = [...this.#agents.values()].find((item) => item.data.control.agentName === alias);
        if (!recipient || !this.#canMessage(live.data, recipient.data)) {
          throw new RuntimeFault('permission', '通信目标必须是同一用户、同一工作区内另一个未取消的长期 Agent。');
        }
        return this.#conversations.create({ ownerId: live.data.ownerId, workspaceId: live.data.workspaceId, kind: 'direct',
          title: `${this.#displayName(live.data.control.agentId)} · ${this.#displayName(recipient.data.control.agentId)}`,
          members: [{ kind: 'agent', id: live.data.control.agentId }, { kind: 'agent', id: recipient.data.control.agentId }] });
    }
    let conversation: RuntimeConversation;
    try { conversation = this.#conversations.get(destination); }
    catch { throw new RuntimeFault('permission', '目标会话不存在或不可访问。'); }
    if (conversation.ownerId !== live.data.ownerId || conversation.workspaceId !== live.data.workspaceId ||
        !isMember(conversation, { kind: 'agent', id: live.data.control.agentId }) ||
        conversation.members.some((member) => member.kind === 'agent' && this.#live(member.id).data.status === 'cancelled')) {
      throw new RuntimeFault('permission', '不能向非成员或已取消成员的会话发送消息。');
    }
    return conversation;
  }
  #assertCanFinish(live: LiveAgent): void {
    const context = live.context.snapshot();
    const schedule = this.#scheduler.inspect(live.data.control.agentId);
    if (context.level2 || context.level3) {
      throw new RuntimeFault('protocol',
        '结束本轮前必须回到L1。当前L2/L3请用context_complete({})收尾，不能发送finish=true；不要为收尾安装新计划。', true);
    }
    if (context.level1.taskChain.tasks.some((task) => task.state === 'RUNNING' || task.state === 'WAITING')) {
      throw new RuntimeFault('protocol', '结束本轮前必须完成现有L1任务链，请advance处理等待项，完成后再finish=true。', true);
    }
    if (schedule.pendingOperations.length) {
      throw new RuntimeFault('protocol', '结束本轮前必须等待在途操作完成。', true);
    }
  }
  #conversationContextKey(id: number, conversationId: string): string {
    return `agent:${id}:conversation:${conversationId}`;
  }
  #switchConversation(live: LiveAgent, batch: ConversationBatch): void {
    const key = this.#conversationContextKey(batch.agentId, batch.conversationId);
    if (live.data.contextKey !== key) {
      const root = this.#contexts.load(`agent:${batch.agentId}`)!;
      live.context = this.#contexts.load(key) ? restoreAgentContextManager({ key, store: this.#contexts })
        : createAgentContextManager({ key, store: this.#contexts, initiallyIdle: true,
          objective: root.context.level1.currentTask.objective,
          instructions: root.context.level1.instructions.filter((instruction) => instruction !==
            '完成用户消息的工作时，在 L1 调用 agent_output 交付面向用户的回复。内部层的结果不直接展示给用户。'),
          policy: root.policy });
      this.#update({ ...live.data, contextKey: key, control: live.acb.snapshot() });
      this.#bindRunner(live);
    }
    const marker = `chat-started:${batch.id}`;
    if (!this.#store.metadata<boolean>(marker)) {
      this.#update({ ...live.data, lastAction: '', repeatedActions: 0 });
      this.#store.putMetadata(marker, true);
    }
  }
  #refreshMail(): void {
    if (this.#mailTimer) clearTimeout(this.#mailTimer);
    this.#mailTimer = null;
    if (this.#closed || this.#fatal || !this.#initialized) return;
    let next = Infinity;
    for (const [id, live] of this.#agents) {
      if (live.data.status !== 'active' || this.#jobs.has(id)) continue;
      this.#executor.notifyReconciliations(id);
      const schedule = this.#scheduler.inspect(id);
      if (schedule.running || schedule.queuedBatch || schedule.pendingEvents.length ||
          schedule.pendingOperations.length || schedule.completedResults.length || schedule.suspension) continue;
      let batch = this.#conversations.active(id);
      if (batch?.status === 'delivered' && !live.context.needsRun()) {
        this.#conversations.acknowledge(batch.id);
        batch = undefined;
      }
      if (live.context.needsRun()) continue;
      // 调度结果、事件与队列全部消费且会话批次确认后，才结束连续工作预算。
      if (!batch) finishWorkBudget(this.#store, id);
      batch ??= this.#conversations.seal(id, live.context.checkpoint().policy.maxDeliveryBytes);
      if (batch) {
        this.#switchConversation(live, batch);
        this.#notify(id, batch.id);
      } else {
        const due = this.#conversations.due(id);
        if (due !== undefined) next = Math.min(next, due);
      }
    }
    if (Number.isFinite(next)) {
      this.#mailTimer = setTimeout(() => {
        try { this.#refreshMail(); } catch { this.#failStop(); }
      }, Math.max(1, next - Date.now()));
    }
  }

  async #pump(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      const run = this.#scheduler.takeNextRun();
      if (!run) {
        try { await this.#scheduler.waitForReady(this.#abort.signal); }
        catch { if (!this.#abort.signal.aborted) throw new Error('调度等待失败。'); }
        continue;
      }
      const live = this.#live(run.agentId);
      // 调度完成先于 Runtime 后处理；下一轮必须等上一轮宿主作业完全退出。
      const prior = this.#jobs.get(run.agentId);
      if (prior) await prior;
      if (this.#abort.signal.aborted) {
        this.#scheduler.returnRun(run);
        break;
      }
      if (live.data.status !== 'active') {
        this.#scheduler.returnRun(run);
        this.#scheduler.suspend(run.agentId, { reason: live.data.status, resumeAt: null });
        continue;
      }
      live.batchId = run.batch.batchId;
      live.controller = new AbortController();
      const job = this.#execute(live, run).catch(() => this.#failStop()).finally(() => {
        live.controller = null; this.#jobs.delete(run.agentId);
        this.#refreshMail();
      });
      this.#jobs.set(run.agentId, job);
    }
  }

  async #execute(live: LiveAgent, run: AgentRun): Promise<void> {
    try {
      await live.runner.execute(run, live.controller!.signal);
    } catch (error) {
      const expectedAbort = live.controller?.signal.aborted && (this.#closed || live.data.status !== 'active');
      if (!expectedAbort && classifyFault(error).kind === 'internal') this.#failStop();
      return;
    }
    this.#update({ ...live.data, control: live.acb.snapshot() });
    for (const input of this.#store.inputs(run.agentId)) this.#notify(run.agentId, input.id);
  }

  #failure(live: LiveAgent, run: AgentRun, error: unknown): void {
      if (this.#closed || live.data.status !== 'active') {
        this.#scheduler.suspend(run.agentId, { reason: '运行停止', resumeAt: null });
        return;
      }
      const fault = classifyFault(error);
      if (fault.kind === 'internal') {
        this.#failStop();
        return;
      }
      const key = `retries:${run.batch.batchId}`;
      const retries = (this.#store.metadata<number>(key) ?? 0) + 1;
      if (!(error instanceof AdmissionWait)) this.#store.putMetadata(key, retries);
      const retry = error instanceof AdmissionWait || fault.retry && retries <= this.#limits.maxRetries;
      if (retry && (fault.kind === 'protocol' || error instanceof RuntimeFault && error.kind === 'protocol')) {
        this.#store.repairRequest(this.#requestKey(live, run.batch.batchId));
      }
      const resumeAt = retry ? Math.max(fault.delayUntil ?? 0,
        Date.now() + this.#limits.retryBaseMs * 2 ** Math.min(retries - 1, 6)) : null;
      this.#update({ ...live.data, lastError: fault.message, status: retry ? 'active' : 'paused' });
      this.#interrupt(run.agentId, run.batch.batchId, fault.kind, fault.message, retry ? 'retry' : 'pause', resumeAt);
      // 失败后的同一批次仍在 READY，通用暂停避免立即反复请求。
      this.#scheduler.suspend(run.agentId, { reason: fault.message, resumeAt });
  }

  #canMessage(sender: RuntimeAgent, recipient: RuntimeAgent): boolean {
    return sender.control.agentId !== recipient.control.agentId &&
      sender.ownerId === recipient.ownerId && sender.workspaceId === recipient.workspaceId &&
      recipient.status !== 'cancelled';
  }
  #requestKey(live: LiveAgent, batchId: string): string {
    const pending = live.context.checkpoint().pendingSummary;
    return pending ? `summary:${pending.id}` : batchId;
  }
  #update(agent: RuntimeAgent): void {
    this.#store.saveAgent(agent);
    this.#live(agent.control.agentId).data = structuredClone(agent);
  }
  #event(id: number, type: string, data: JsonValue): void {
    const event = this.#store.event(id, type, data);
    try { this.options.onEvent?.(event); } catch { /* 观测失败不能破坏执行事务。 */ }
  }
  #interrupt(id: number, batchId: string, kind: RuntimeInterrupt['kind'], message: string,
    action: RuntimeInterrupt['action'], resumeAt: number | null): void {
    const record: RuntimeInterrupt = { id: randomUUID(), agentId: id, batchId, createdAt: Date.now(),
      kind, message, action, resumeAt };
    this.#store.putInterrupt(record);
    this.#event(id, 'interrupt', { kind, action, message, resumeAt });
  }
  #live(id: number): LiveAgent {
    const live = this.#agents.get(id);
    if (!live) throw new Error('Agent 不存在。');
    return live;
  }
  #owned(id: number, owner: string): LiveAgent {
    this.#checkOpen();
    const live = this.#live(id);
    if (live.data.ownerId !== owner) throw new Error('Agent 不属于当前宿主。');
    return live;
  }
  #checkOpen(): void {
    if (this.#closed || !this.#initialized || this.#fatal) throw new Error('Runtime 未就绪。');
  }
  #pauseUnknown(id: number): void {
    const live = this.#live(id);
    if (live.data.status === 'cancelled') return;
    this.#update({ ...live.data, status: 'paused', lastError: '操作副作用未知，等待宿主对账。' });
    this.#scheduler.suspend(id, { reason: '操作副作用未知，等待宿主对账。', resumeAt: null });
    live.controller?.abort(new Error('副作用结果未知。'));
    this.#interrupt(id, '', 'tool', '操作副作用未知，等待宿主对账。', 'pause', null);
  }
  #failStop(): void {
    if (this.#fatal) return;
    this.#fatal = '运行记录或调度失败，保留现场等待服务重启。';
    this.#abort.abort();
    for (const live of this.#agents.values()) live.controller?.abort();
    void this.#executor.stop().catch(() => {});
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#mailTimer) clearTimeout(this.#mailTimer);
    this.#abort.abort();
    for (const live of this.#agents.values()) live.controller?.abort(new Error('服务停机。'));
    await this.#loop;
    await Promise.all([...this.#jobs.values()]);
    await this.#executor.stop();
    // 在途工具保留持久状态，下一进程按结果是否未知恢复。
    this.#scheduler.close();
    this.#contexts.close(); this.#memory.close(); this.#conversations.close(); this.#store.close();
  }
}
