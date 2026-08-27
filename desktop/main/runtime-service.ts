import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';

import {
  AdmissionController,
  AgentPool,
  capabilityRequestKey,
  createWorkspaceCapabilityRequests,
  CURRENT_WORKSPACE_RESOURCE,
  extractInheritableRootAuthority,
  FakeModelProvider,
  registerBuiltinTools,
  TaskScheduler,
  ToolRegistry,
  TURN_SUMMARY_PROTOCOL,
  WORKSPACE_FILESYSTEM_CAPABILITIES,
  type CapabilityRequest,
  type ContextItem,
  type ProcessSandbox,
  type TaskSnapshot,
} from '../../src/index.js';
import type { TaskEvent } from '../../src/kernel/task-event.js';
import type {
  AgentEventView,
  AgentNodeView,
  ConversationRoundView,
  ConversationStatus,
  ConversationView,
  RuntimeSnapshotView,
  SubmitTaskInput,
} from '../shared/contracts.js';
import { ObservableTaskStore } from './observable-task-store.js';
import {
  createConfiguredProvider,
  type ConfiguredProvider,
} from './provider-registry.js';
import { SwitchableModelProvider } from './switchable-model-provider.js';

type ConversationRecord = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  rootTaskIds: string[];
  /** 控制平面持有的宿主目录；不进入模型或 Capability Grant。 */
  workspacePath?: string;
  /** 每轮 Root Agent 重新签发的任务树权限上限。 */
  authorityCeiling: CapabilityRequest[];
};

type RuntimeListener = (snapshot: RuntimeSnapshotView) => void;

/** RuntimeService 的可选配置。 */
export type RuntimeServiceOptions = {
  /**
   * 任务存储的 SQLite 文件路径。
   *
   * 省略或传入 `:memory:` 时使用纯内存库（开发/测试）；
   * 桌面端主进程应传入 userData 目录下的持久化文件路径。
   */
  storeLocation?: string;
  /** Enables `test.run`; must isolate the complete child process tree. */
  processSandbox?: ProcessSandbox;
};

const DEMO_USAGE = {
  inputTokens: 180,
  outputTokens: 48,
  costUsd: 0.0004,
};

const AGENT_POOL_POLICY = {
  maxDepth: 3,
  maxLiveAgents: 20,
  maxSpawnedPerRoot: 100,
} as const;

const ROOT_TASK_POLICY = {
  maxModelAttempts: 24,
  maxCostUsd: 1,
} as const;

const CONVERSATION_METADATA_KEY = 'desktop.conversations.v1';

export class RuntimeService {
  readonly #provider: SwitchableModelProvider;
  #fakeProvider: FakeModelProvider | undefined;
  readonly #store: ObservableTaskStore;
  readonly #scheduler: TaskScheduler;
  readonly #processSandboxEnabled: boolean;
  readonly #conversations = new Map<string, ConversationRecord>();
  readonly #listeners = new Set<RuntimeListener>();
  readonly #demoChildTaskIds = new Map<string, string>();
  #runPromise: Promise<void> | undefined;
  #initializePromise: Promise<void> | undefined;
  #publishQueued = false;
  #closed = false;

  constructor(config?: ConfiguredProvider, options: RuntimeServiceOptions = {}) {
    const initialProvider = config
      ? createConfiguredProvider(config)
      : this.createFakeProvider();
    this.#provider = new SwitchableModelProvider(initialProvider);
    this.#fakeProvider =
      initialProvider instanceof FakeModelProvider
        ? initialProvider
        : undefined;

    // 默认使用内存库，桌面端主进程会传入 userData 目录下的持久化文件路径。
    this.#store = new ObservableTaskStore(
      options.storeLocation ?? ':memory:',
    );

    const tools = new ToolRegistry();
    registerBuiltinTools(tools, {
      ...(options.processSandbox === undefined
        ? {}
        : { processSandbox: options.processSandbox }),
    });
    this.#processSandboxEnabled = options.processSandbox !== undefined;
    this.#scheduler = new TaskScheduler({
      provider: this.#provider,
      tools,
      store: this.#store,
      admission: new AdmissionController({
        maxConcurrentRequests: 2,
        requestsPerMinute: 30,
        tokensPerMinute: 40_000,
      }),
      agentPool: new AgentPool(AGENT_POOL_POLICY),
      asyncWorkPolicy: {
        batchWindowMs: 1_200,
      },
      workspaceRootResolver: (task) =>
        this.#workspaceRootForRootTask(task.rootTaskId),
      taskIdGenerator: (request, origin) => {
        if (origin.kind === 'child') {
          const key = this.#demoTaskKey(origin.parent.id, request.goal);
          const configuredId = this.#demoChildTaskIds.get(key);
          if (configuredId) {
            this.#demoChildTaskIds.delete(key);
            return configuredId;
          }
        }
        return randomUUID();
      },
    });

    this.#store.setChangeListener(() => {
      this.#touchConversationForLatestTasks();
      this.#queuePublish();
    });
  }

  /**
   * 从本地任务库恢复所有历史任务，并把未完成任务重新接回调度器。
   */
  async initialize(): Promise<void> {
    this.#initializePromise ??= this.#restorePersistedTasks();
    await this.#initializePromise;
  }

  close(): void {
    this.#closed = true;
    this.#store.close();
  }

  subscribe(listener: RuntimeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get isBusy(): boolean {
    return (
      this.#scheduler.liveAgentCount > 0 ||
      this.#scheduler.activeOperationCount > 0
    );
  }

  async verifyAndConfigureModel(
    config: ConfiguredProvider,
  ): Promise<{ latencyMs: number; response: string }> {
    if (this.isBusy) {
      throw new Error('有 Agent 正在运行，请等待当前任务结束后切换模型。');
    }
    const provider = createConfiguredProvider(config, 192);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('模型协议验证超时。')),
      30_000,
    );
    const startedAt = Date.now();
    try {
      const response = await provider.invoke(
        {
          taskId: 'settings-protocol-check',
          goal: 'Return final output exactly "pong".',
          context: [
            {
              type: 'user',
              content: 'Reply with exactly pong.',
            },
          ],
          tools: [],
          attempt: 1,
          summaryProtocol: TURN_SUMMARY_PROTOCOL,
          delegation: {
            canSpawnSubagents: false,
          },
        },
        controller.signal,
      );
      if (response.type !== 'final') {
        throw new Error(`模型协议验证返回意外动作：${response.type}`);
      }
      this.#provider.replace(createConfiguredProvider(config));
      this.#fakeProvider = undefined;
      this.#queuePublish();
      return {
        latencyMs: Date.now() - startedAt,
        response: this.stringifyValue(response.output),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  getSnapshot(): RuntimeSnapshotView {
    const tasks = this.#store.list();
    const schedulerMetrics = this.#scheduler.metrics;
    return {
      providerId: this.#provider.id,
      isDemoMode: this.#fakeProvider !== undefined,
      platform: process.platform,
      metrics: {
        ...schedulerMetrics,
        activeOperations: this.#scheduler.activeOperationCount,
        liveAgents: {
          ...schedulerMetrics.liveAgents,
          available:
            AGENT_POOL_POLICY.maxLiveAgents -
            schedulerMetrics.liveAgents.current,
          limit: AGENT_POOL_POLICY.maxLiveAgents,
        },
      },
      conversations: [...this.#conversations.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((conversation) =>
          this.toConversationView(conversation, tasks),
        ),
    };
  }

  createConversation(): RuntimeSnapshotView {
    const conversation = this.createConversationRecord();
    this.#conversations.set(conversation.id, conversation);
    this.persistConversationRecords();
    this.#queuePublish();
    return this.getSnapshot();
  }

  async setConversationWorkspace(
    conversationId: string,
    workspacePath: string,
  ): Promise<RuntimeSnapshotView> {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    const currentRootTaskId = conversation.rootTaskIds.at(-1);
    const currentRoot = currentRootTaskId
      ? this.#store
          .list()
          .find((snapshot) => snapshot.id === currentRootTaskId)
      : undefined;
    if (currentRoot && currentRoot.state.status !== 'TERMINATED') {
      throw new Error('当前 Conversation 正在执行，不能更换 Workspace。');
    }

    conversation.workspacePath =
      await this.requireWorkspaceDirectory(workspacePath);
    conversation.authorityCeiling = this.mergeCapabilityRequests(
      conversation.authorityCeiling.filter(
        (request) => !isWorkspaceFilesystemRequest(request),
      ),
      this.initialWorkspaceAuthority(),
    );
    conversation.updatedAt = Date.now();
    this.persistConversationRecords();
    this.#queuePublish();
    return this.getSnapshot();
  }

  async submitTask(input: SubmitTaskInput): Promise<RuntimeSnapshotView> {
    const conversation = this.#conversations.get(input.conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${input.conversationId}`);
    }
    const previousRootTaskId = conversation.rootTaskIds.at(-1);
    const previousRoot = previousRootTaskId
      ? this.#store
          .list()
          .find((snapshot) => snapshot.id === previousRootTaskId)
      : undefined;
    if (
      previousRootTaskId &&
      previousRoot?.state.status !== 'TERMINATED'
    ) {
      throw new Error('当前 Conversation 仍有任务正在执行。');
    }

    const task = input.task.trim();
    if (task.length === 0) {
      throw new Error('任务内容不能为空。');
    }
    if (task.length > 4_000) {
      throw new Error('任务内容不能超过 4000 个字符。');
    }

    const rootTaskId = randomUUID();
    conversation.rootTaskIds.push(rootTaskId);
    if (conversation.rootTaskIds.length === 1) {
      conversation.title = this.createConversationTitle(task);
    }
    conversation.updatedAt = Date.now();

    if (this.#fakeProvider) {
      this.configureDemoScenario(rootTaskId, task);
    }

    const authorityCeiling = this.inheritedRootAuthority(
      conversation,
      previousRoot,
    );
    try {
      await this.#scheduler.submit({
        id: rootTaskId,
        goal: task,
        characterId: 'coordinator',
        capabilities: authorityCeiling,
        context: this.buildRootContext(
          conversation,
          rootTaskId,
          task,
        ),
        maxModelAttempts: ROOT_TASK_POLICY.maxModelAttempts,
        budget: { maxCostUsd: ROOT_TASK_POLICY.maxCostUsd },
      });
      conversation.authorityCeiling =
        structuredClone(authorityCeiling);
      this.persistConversationRecords();
    } catch (error) {
      conversation.rootTaskIds.pop();
      this.persistConversationRecords();
      throw error;
    }
    this.#ensureSchedulerRunning();
    this.#queuePublish();
    return this.getSnapshot();
  }

  async cancelTask(taskId: string): Promise<RuntimeSnapshotView> {
    await this.#scheduler.cancel(taskId, '用户从桌面控制台取消任务。');
    this.#queuePublish();
    return this.getSnapshot();
  }

  private createConversationRecord(): ConversationRecord {
    const now = Date.now();
    return {
      id: randomUUID(),
      title: '新对话',
      createdAt: now,
      updatedAt: now,
      rootTaskIds: [],
      authorityCeiling: [],
    };
  }

  private buildRootContext(
    conversation: ConversationRecord,
    currentRootTaskId: string,
    currentTask: string,
  ): ContextItem[] {
    const snapshots = this.#store.list();
    const context: ContextItem[] =
      conversation.workspacePath === undefined
        ? []
        : [
            {
              type: 'system',
              content: [
                `The conversation workspace is mounted at ${CURRENT_WORKSPACE_RESOURCE}`,
                'Use paths under this semantic mount for all workspace file operations.',
                'The host filesystem path is intentionally not exposed to Agents.',
              ].join(' '),
            },
          ];
    for (const rootTaskId of conversation.rootTaskIds) {
      if (rootTaskId === currentRootTaskId) {
        continue;
      }
      const root = snapshots.find(
        (snapshot) => snapshot.id === rootTaskId,
      );
      if (!root) {
        continue;
      }
      context.push({ type: 'user', content: root.goal });
      if (root.state.status !== 'TERMINATED') {
        continue;
      }
      const termination = root.state.termination;
      switch (termination.kind) {
        case 'completed':
          context.push({
            type: 'assistant',
            content: this.stringifyValue(termination.output),
          });
          break;
        case 'failed':
          context.push({
            type: 'assistant',
            content: `Previous round failed: ${termination.error}`,
          });
          break;
        case 'cancelled':
          context.push({
            type: 'assistant',
            content: `Previous round was cancelled: ${termination.reason}`,
          });
          break;
        case 'needs_parent_action':
          context.push({
            type: 'assistant',
            content: `Previous round required additional work: ${termination.requiredWork}`,
          });
          break;
      }
    }
    context.push({ type: 'user', content: currentTask });
    return context;
  }

  private initialWorkspaceAuthority(): CapabilityRequest[] {
    return createWorkspaceCapabilityRequests({
      includeTestRun: this.#processSandboxEnabled,
    });
  }

  async #restorePersistedTasks(): Promise<void> {
    const snapshots = this.#store.list();
    const roots = snapshots
      .filter((snapshot) => snapshot.parentTaskId === undefined)
      .sort((left, right) => left.createdAt - right.createdAt);
    this.#conversations.clear();
    const persistedConversations =
      this.readPersistedConversationRecords();
    if (persistedConversations.length > 0) {
      const rootIds = new Set(roots.map((root) => root.id));
      for (const persisted of persistedConversations) {
        const rootTaskIds = persisted.rootTaskIds.filter((rootTaskId) =>
          rootIds.has(rootTaskId),
        );
        this.#conversations.set(persisted.id, {
          ...persisted,
          rootTaskIds,
        });
      }
    }

    const assignedRootIds = new Set(
      [...this.#conversations.values()].flatMap(
        (conversation) => conversation.rootTaskIds,
      ),
    );
    for (const root of roots) {
      if (assignedRootIds.has(root.id)) {
        continue;
      }
      const treeUpdatedAt = Math.max(
        root.updatedAt,
        ...snapshots
          .filter((snapshot) => snapshot.rootTaskId === root.id)
          .map((snapshot) => snapshot.updatedAt),
      );
      const authorityCeiling = this.rootGrantRequests(root);
      const conversation: ConversationRecord = {
        id: randomUUID(),
        title: this.createConversationTitle(root.goal),
        createdAt: root.createdAt,
        updatedAt: treeUpdatedAt,
        rootTaskIds: [root.id],
        authorityCeiling,
      };
      this.#conversations.set(conversation.id, conversation);
    }
    if (this.#conversations.size === 0) {
      const conversation = this.createConversationRecord();
      this.#conversations.set(conversation.id, conversation);
    }
    this.persistConversationRecords();

    if (snapshots.length === 0) {
      this.#queuePublish();
      return;
    }

    await this.#scheduler.restoreMany(
      snapshots.map((snapshot) => snapshot.id),
      { cancelOrphans: true },
    );
    this.#touchConversationForLatestTasks();
    if (
      this.#scheduler.readyQueueSize > 0 ||
      this.#scheduler.activeOperationCount > 0
    ) {
      this.#ensureSchedulerRunning();
    }
    this.#queuePublish();
  }

  private async requireWorkspaceDirectory(
    workspacePath: string,
  ): Promise<string> {
    const requestedPath = workspacePath.trim();
    if (!requestedPath) {
      throw new Error('Workspace 目录不能为空。');
    }
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(requestedPath);
    } catch {
      throw new Error(`Workspace 目录不存在：${requestedPath}`);
    }
    const metadata = await stat(canonicalPath);
    if (!metadata.isDirectory()) {
      throw new Error(`Workspace 必须是目录：${canonicalPath}`);
    }
    return canonicalPath;
  }

  /**
   * 下一轮继承上一轮由宿主签发的 Root Authority Ceiling。
   *
   * `human` 来源的 Grant 可能是单次批准，不能跨轮复制；父级来源不可能出现在
   * Root 上。Conversation 自身保存的 ceiling 同时作为首轮和恢复兜底。
   */
  private inheritedRootAuthority(
    conversation: ConversationRecord,
    previousRoot: TaskSnapshot | undefined,
  ): CapabilityRequest[] {
    return this.mergeCapabilityRequests(
      conversation.authorityCeiling,
      ...(previousRoot === undefined
        ? []
        : [this.rootGrantRequests(previousRoot)]),
    );
  }

  private rootGrantRequests(root: TaskSnapshot): CapabilityRequest[] {
    if (root.capabilityGrants) {
      return extractInheritableRootAuthority(root.capabilityGrants);
    }
    return (root.capabilities ?? []).map((capability) => ({
      capability,
      scope: { kind: 'all' },
    }));
  }

  private mergeCapabilityRequests(
    ...groups: readonly CapabilityRequest[][]
  ): CapabilityRequest[] {
    const requests = new Map<string, CapabilityRequest>();
    for (const request of groups.flat()) {
      requests.set(
        capabilityRequestKey(request),
        structuredClone(request),
      );
    }
    return [...requests.values()];
  }

  private readPersistedConversationRecords(): ConversationRecord[] {
    const body = this.#store.readRuntimeMetadata(
      CONVERSATION_METADATA_KEY,
    );
    if (!body) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }

    const conversations: ConversationRecord[] = [];
    for (const candidate of parsed) {
      if (
        !isRecord(candidate) ||
        typeof candidate['id'] !== 'string' ||
        typeof candidate['title'] !== 'string' ||
        typeof candidate['createdAt'] !== 'number' ||
        typeof candidate['updatedAt'] !== 'number' ||
        !Array.isArray(candidate['rootTaskIds']) ||
        !candidate['rootTaskIds'].every(
          (rootTaskId) => typeof rootTaskId === 'string',
        )
      ) {
        continue;
      }
      const workspacePath =
        typeof candidate['workspacePath'] === 'string'
          ? candidate['workspacePath']
          : undefined;
      const authorityCeiling = parseCapabilityRequests(
        candidate['authorityCeiling'],
      );
      conversations.push({
        id: candidate['id'],
        title: candidate['title'],
        createdAt: candidate['createdAt'],
        updatedAt: candidate['updatedAt'],
        rootTaskIds: [...candidate['rootTaskIds']],
        ...(workspacePath === undefined ? {} : { workspacePath }),
        authorityCeiling:
          authorityCeiling.length > 0
            ? authorityCeiling
            : workspacePath === undefined
              ? []
              : this.initialWorkspaceAuthority(),
      });
    }
    return conversations;
  }

  private persistConversationRecords(): void {
    const records = [...this.#conversations.values()].map(
      (conversation) => ({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        rootTaskIds: [...conversation.rootTaskIds],
        ...(conversation.workspacePath === undefined
          ? {}
          : { workspacePath: conversation.workspacePath }),
        authorityCeiling: structuredClone(
          conversation.authorityCeiling,
        ),
      }),
    );
    this.#store.writeRuntimeMetadata(
      CONVERSATION_METADATA_KEY,
      JSON.stringify(records),
    );
  }

  private configureDemoScenario(rootTaskId: string, task: string): void {
    const fakeProvider = this.#fakeProvider;
    if (!fakeProvider) {
      return;
    }

    const plannerId = randomUUID();
    const executorId = randomUUID();
    const verifierId = randomUUID();
    const plannerGoal = '拆解任务目标，明确约束和执行步骤';
    const executorGoal = '根据任务目标形成可交付的执行结果';
    const verifierGoal = '检查执行依据、边界条件与潜在风险';
    this.#demoChildTaskIds.set(
      this.#demoTaskKey(rootTaskId, plannerGoal),
      plannerId,
    );
    this.#demoChildTaskIds.set(
      this.#demoTaskKey(rootTaskId, executorGoal),
      executorId,
    );
    this.#demoChildTaskIds.set(
      this.#demoTaskKey(plannerId, verifierGoal),
      verifierId,
    );

    fakeProvider.setResponses(rootTaskId, [
      {
        type: 'spawn_subagents',
        children: [
          {
            goal: plannerGoal,
            character: 'coordinator',
            maxModelAttempts: 3,
          },
          {
            goal: executorGoal,
            character: 'developer',
            maxModelAttempts: 2,
          },
        ],
        turnSummary: {
          request: '分析用户任务并规划执行。',
          outcome: '创建规划与执行两个子 Agent。',
        },
        usage: DEMO_USAGE,
      },
      {
        type: 'final',
        output: [
          `当前任务已完成：${task}`,
          '',
          '规划、执行和结果校验三个阶段均已结束。',
          '当前展示的是本地运行时模拟结果，配置 GEMINI_API_KEY 后可切换为真实模型执行。',
        ].join('\n'),
        turnSummary: {
          request: '整合全部子 Agent 结果。',
          outcome: '任务执行完成并生成最终回复。',
        },
        usage: {
          inputTokens: 320,
          outputTokens: 96,
          costUsd: 0.0008,
        },
      },
    ]);
    fakeProvider.setResponses(plannerId, [
      {
        type: 'spawn_subagents',
        children: [
          {
            goal: verifierGoal,
            character: 'code_auditor',
            maxModelAttempts: 1,
          },
        ],
        turnSummary: {
          request: '拆解任务并识别需要校验的内容。',
          outcome: '完成任务拆解并创建校验 Agent。',
        },
        usage: DEMO_USAGE,
      },
      {
        type: 'final',
        output: '任务结构和执行顺序已经整理完成。',
        turnSummary: {
          request: '吸收校验结果并完成规划。',
          outcome: '输出经过校验的任务规划。',
        },
        usage: DEMO_USAGE,
      },
    ]);
    fakeProvider.setResponses(executorId, [
      {
        type: 'final',
        output: '已根据目标完成主体执行内容。',
        turnSummary: {
          request: '执行用户任务。',
          outcome: '主体执行内容已经完成。',
        },
        usage: DEMO_USAGE,
      },
    ]);
    fakeProvider.setResponses(verifierId, [
      {
        type: 'final',
        output: '已完成边界条件和风险检查。',
        turnSummary: {
          request: '检查执行依据和风险。',
          outcome: '校验完成，未发现阻断问题。',
        },
        usage: DEMO_USAGE,
      },
    ]);
  }

  #demoTaskKey(parentTaskId: string, goal: string): string {
    return `${parentTaskId}\u0000${goal}`;
  }

  #ensureSchedulerRunning(): void {
    if (this.#runPromise) {
      return;
    }

    this.#runPromise = this.#scheduler
      .run()
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error('Runtime scheduler failed:', error);
      })
      .finally(() => {
        this.#runPromise = undefined;
        this.#queuePublish();
        if (
          this.#scheduler.readyQueueSize > 0 ||
          this.#scheduler.activeOperationCount > 0
        ) {
          this.#ensureSchedulerRunning();
        }
      });
  }

  /**
   * 把某个根任务解析为它所属 Conversation 的宿主工作区目录。
   *
   * 供调度器的 ToolRuntime 解析 `workspace://current/`；无挂载工作区时返回
   * undefined，涉及文件系统的工具会据此拒绝执行。
   */
  #workspaceRootForRootTask(rootTaskId: string): string | undefined {
    for (const conversation of this.#conversations.values()) {
      if (conversation.rootTaskIds.includes(rootTaskId)) {
        return conversation.workspacePath;
      }
    }
    return undefined;
  }

  #touchConversationForLatestTasks(): void {
    const newestByRoot = new Map<string, number>();
    for (const task of this.#store.list()) {
      newestByRoot.set(
        task.rootTaskId,
        Math.max(newestByRoot.get(task.rootTaskId) ?? 0, task.updatedAt),
      );
    }
    for (const conversation of this.#conversations.values()) {
      if (conversation.rootTaskIds.length === 0) {
        continue;
      }
      conversation.updatedAt = Math.max(
        conversation.updatedAt,
        ...conversation.rootTaskIds.map(
          (rootTaskId) => newestByRoot.get(rootTaskId) ?? 0,
        ),
      );
    }
  }

  #queuePublish(): void {
    if (this.#closed || this.#publishQueued) {
      return;
    }
    this.#publishQueued = true;
    queueMicrotask(() => {
      this.#publishQueued = false;
      if (this.#closed) {
        return;
      }
      const snapshot = this.getSnapshot();
      for (const listener of this.#listeners) {
        listener(snapshot);
      }
    });
  }

  private toConversationView(
    conversation: ConversationRecord,
    tasks: readonly TaskSnapshot[],
  ): ConversationView {
    const rootTaskId = conversation.rootTaskIds.at(-1);
    const conversationTasks =
      rootTaskId === undefined
        ? []
        : tasks
            .filter(
              (task) => task.rootTaskId === rootTaskId,
            )
            .sort(
              (left, right) =>
                left.depth - right.depth ||
                left.createdAt - right.createdAt,
            );
    const root = conversationTasks.find(
      (task) => task.id === rootTaskId,
    );
    const rounds = conversation.rootTaskIds.flatMap(
      (roundRootTaskId): ConversationRoundView[] => {
        const roundRoot = tasks.find(
          (task) => task.id === roundRootTaskId,
        );
        return roundRoot
          ? [this.toConversationRoundView(roundRoot, tasks)]
          : [];
      },
    );
    const base = {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      ...(conversation.workspacePath === undefined
        ? {}
        : { workspacePath: conversation.workspacePath }),
      status: this.conversationStatus(root),
      agents: conversationTasks.map((task) => this.toAgentView(task)),
      rounds,
      totalAgentCount: rounds.reduce(
        (total, round) => total + round.agentCount,
        0,
      ),
    };
    return rootTaskId === undefined
      ? base
      : { ...base, rootTaskId };
  }

  private toConversationRoundView(
    root: TaskSnapshot,
    tasks: readonly TaskSnapshot[],
  ): ConversationRoundView {
    const rootView = this.toAgentView(root);
    const roundAgents = tasks
      .filter((task) => task.rootTaskId === root.id)
      .sort(
        (left, right) =>
          left.depth - right.depth ||
          left.createdAt - right.createdAt,
      )
      .map((task) => this.toAgentView(task));
    const base: ConversationRoundView = {
      rootTaskId: root.id,
      goal: root.goal,
      status: this.conversationStatus(root),
      stateLabel: rootView.stateLabel,
      agentCount: roundAgents.length,
      inputTokens: rootView.inputTokens,
      outputTokens: rootView.outputTokens,
      createdAt: root.createdAt,
      updatedAt: root.updatedAt,
      agents: roundAgents,
    };
    return {
      ...base,
      ...(rootView.stateDetail === undefined
        ? {}
        : { stateDetail: rootView.stateDetail }),
      ...(rootView.result === undefined
        ? {}
        : { result: rootView.result }),
    };
  }

  private toAgentView(task: TaskSnapshot): AgentNodeView {
    const usageEvents = task.events.filter(
      (event) => event.type === 'model_response_recorded',
    );
    const inputTokens = usageEvents.reduce(
      (sum, event) => sum + event.usage.inputTokens,
      0,
    );
    const outputTokens = usageEvents.reduce(
      (sum, event) => sum + event.usage.outputTokens,
      0,
    );
    const state = this.describeState(task);
    const base: AgentNodeView = {
      id: task.id,
      rootTaskId: task.rootTaskId,
      depth: task.depth,
      goal: task.goal,
      ...(task.characterId === undefined
        ? {}
        : { characterId: task.characterId }),
      status: task.state.status,
      stateLabel: state.label,
      capabilities: [
        ...new Set(
          task.capabilityGrants?.map((grant) => grant.capability) ??
            task.capabilities ??
            [],
        ),
      ],
      modelAttempts: task.modelAttempts,
      maxModelAttempts: task.maxModelAttempts,
      spentCostUsd: task.budget.spentCostUsd,
      maxCostUsd: task.budget.maxCostUsd,
      inputTokens,
      outputTokens,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      events: task.events.map((event) => this.toEventView(event)),
    };
    return {
      ...base,
      ...(task.parentTaskId === undefined
        ? {}
        : { parentTaskId: task.parentTaskId }),
      ...(task.state.status === 'TERMINATED'
        ? { terminationKind: task.state.termination.kind }
        : {}),
      ...(state.detail === undefined ? {} : { stateDetail: state.detail }),
      ...(state.result === undefined ? {} : { result: state.result }),
    };
  }

  private describeState(task: TaskSnapshot): {
    label: string;
    detail?: string;
    result?: string;
  } {
    switch (task.state.status) {
      case 'READY':
        return {
          label: '等待调度',
          detail: task.state.reason,
        };
      case 'RUNNING':
        return {
          label:
            task.state.operation === 'context_compaction'
              ? '压缩上下文'
              : '正在工作',
          detail: `${task.state.providerId} · 第 ${task.state.requestAttempt} 轮`,
        };
      case 'BLOCKED':
        return {
          label: '等待结果',
          detail: `${task.state.reason} · ${task.state.waitingFor.length} 项未完成`,
        };
      case 'TERMINATED': {
        switch (task.state.termination.kind) {
          case 'completed':
            return {
              label: '已完成',
              result: this.stringifyValue(task.state.termination.output),
            };
          case 'failed':
            return {
              label: '执行失败',
              detail: task.state.termination.error,
            };
          case 'cancelled':
            return {
              label: '已取消',
              detail: task.state.termination.reason,
            };
          case 'needs_parent_action':
            return {
              label: '需要父任务处理',
              detail: task.state.termination.requiredWork,
              ...(task.state.termination.partialOutput === undefined
                ? {}
                : {
                    result: this.stringifyValue(
                      task.state.termination.partialOutput,
                    ),
                  }),
            };
        }
      }
    }
  }

  private toEventView(event: TaskEvent): AgentEventView {
    const base = {
      id: event.eventId,
      type: event.type,
      occurredAt: event.occurredAt,
      sequence: event.sequence,
    };
    switch (event.type) {
      case 'task_created':
        return { ...base, label: 'Agent 已创建', detail: event.goal };
      case 'state_transitioned':
        return {
          ...base,
          label: `${event.from} → ${event.to.status}`,
          detail: event.reason,
        };
      case 'capacity_wait_recorded':
        return {
          ...base,
          label: '等待运行资源',
          detail: event.reasons.join('、'),
        };
      case 'capability_granted':
        return {
          ...base,
          label: `获得权限 ${event.capability}`,
          detail: event.scope.kind,
        };
      case 'capability_grant_consumed':
        return {
          ...base,
          label: `使用权限 ${event.capability}`,
          detail: `剩余 ${event.remainingUses} 次`,
        };
      case 'capability_delegation_advanced':
        return {
          ...base,
          label: '权限委派已推进',
          detail: `第 ${event.grantedHopIndex + 1} 跳`,
        };
      case 'capability_request_created':
        return {
          ...base,
          label: '已申请权限',
          detail: `${event.route} · ${event.requests
            .map((request) => request.capability)
            .join('、')}`,
        };
      case 'capability_request_resolved':
        return {
          ...base,
          label: `权限申请${event.status === 'granted' ? '已批准' : '已拒绝'}`,
          ...(event.reason === undefined
            ? {}
            : { detail: event.reason }),
        };
      case 'model_response_recorded':
        return {
          ...base,
          label: `模型返回 ${event.responseType}`,
          detail: `${event.usage.inputTokens} in / ${event.usage.outputTokens} out`,
        };
      case 'async_work_registered':
        return {
          ...base,
          label: `登记 ${event.work.length} 项异步工作`,
          detail: event.work.map((work) => work.kind).join('、'),
        };
      case 'async_work_capability_blocked':
        return {
          ...base,
          label: '子 Agent 等待权限',
          detail: event.requests
            .map((request) => request.capability)
            .join('、'),
        };
      case 'async_work_capability_unblocked':
        return {
          ...base,
          label: '子 Agent 权限等待已解除',
          detail: event.requestRef,
        };
      case 'async_work_terminal':
        return {
          ...base,
          label: `异步工作 ${event.status}`,
          detail: event.workId,
        };
      case 'async_work_delivered':
        return {
          ...base,
          label: '异步结果已投递',
          detail: `${event.workIds.length} 项 · ${
            event.allFinished ? '全部完成' : '部分完成'
          }`,
        };
      case 'context_summary_recorded':
        return {
          ...base,
          label: '上下文摘要已记录',
          detail: event.summary.outcome,
        };
      case 'context_compaction_recorded':
        return {
          ...base,
          label: '上下文已压缩',
          detail: `${event.usage.inputTokens + event.usage.outputTokens} tokens`,
        };
      case 'tool_call_recorded':
        return {
          ...base,
          label: `调用工具 ${event.toolName}`,
          detail: event.callId,
        };
      case 'tool_result_recorded':
        return {
          ...base,
          label: `工具 ${event.toolName} 已返回`,
          detail: this.stringifyValue(event.output),
        };
      case 'task_terminated':
        return {
          ...base,
          label: `Agent ${event.termination.kind}`,
        };
      case 'subagent_spawned':
        return {
          ...base,
          label: '创建子 Agent',
          detail: `Depth ${event.childDepth} · ${event.childTaskId}`,
        };
      case 'subagent_result_recorded':
        return {
          ...base,
          label: '收到子 Agent 结果',
          detail: event.childTaskId,
        };
    }
  }

  private conversationStatus(
    root: TaskSnapshot | undefined,
  ): ConversationStatus {
    if (!root) {
      return 'empty';
    }
    if (root.state.status !== 'TERMINATED') {
      return 'active';
    }
    return root.state.termination.kind === 'completed'
      ? 'completed'
      : 'failed';
  }

  private createConversationTitle(task: string): string {
    const firstLine = task.split(/\r?\n/u)[0]?.trim() ?? task;
    return firstLine.length > 24
      ? `${firstLine.slice(0, 24)}…`
      : firstLine;
  }

  private stringifyValue(value: unknown): string {
    return typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2);
  }

  private createFakeProvider(): FakeModelProvider {
    return new FakeModelProvider({
      id: 'local-topology-demo',
      latencyMs: 900,
    });
  }

}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWorkspaceFilesystemRequest(
  request: CapabilityRequest,
): boolean {
  return (
    WORKSPACE_FILESYSTEM_CAPABILITIES.some(
      (capability) => capability === request.capability,
    ) &&
    request.scope.kind !== 'all' &&
    request.scope.resource.startsWith(CURRENT_WORKSPACE_RESOURCE)
  );
}

function parseCapabilityRequests(value: unknown): CapabilityRequest[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate): CapabilityRequest[] => {
    if (
      !isRecord(candidate) ||
      typeof candidate['capability'] !== 'string' ||
      !isRecord(candidate['scope'])
    ) {
      return [];
    }
    const kind = candidate['scope']['kind'];
    if (kind === 'all') {
      return [
        {
          capability: candidate['capability'],
          scope: { kind: 'all' },
        },
      ];
    }
    const resource = candidate['scope']['resource'];
    if (
      (kind !== 'exact' && kind !== 'subtree') ||
      typeof resource !== 'string'
    ) {
      return [];
    }
    return [
      {
        capability: candidate['capability'],
        scope: { kind, resource },
      },
    ];
  });
}
