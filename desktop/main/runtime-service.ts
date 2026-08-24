import { randomUUID } from 'node:crypto';

import {
  AdmissionController,
  AgentPool,
  FakeModelProvider,
  TaskScheduler,
  ToolRegistry,
  TURN_SUMMARY_PROTOCOL,
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
};

type RuntimeListener = (snapshot: RuntimeSnapshotView) => void;

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

export class RuntimeService {
  readonly #provider: SwitchableModelProvider;
  #fakeProvider: FakeModelProvider | undefined;
  readonly #store = new ObservableTaskStore();
  readonly #scheduler: TaskScheduler;
  readonly #conversations = new Map<string, ConversationRecord>();
  readonly #listeners = new Set<RuntimeListener>();
  #runPromise: Promise<void> | undefined;
  #publishQueued = false;

  constructor(config?: ConfiguredProvider) {
    const initialProvider = config
      ? createConfiguredProvider(config)
      : this.createFakeProvider();
    this.#provider = new SwitchableModelProvider(initialProvider);
    this.#fakeProvider =
      initialProvider instanceof FakeModelProvider
        ? initialProvider
        : undefined;

    this.#scheduler = new TaskScheduler({
      provider: this.#provider,
      tools: new ToolRegistry(),
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
    });

    this.#store.setChangeListener(() => {
      this.#touchConversationForLatestTasks();
      this.#queuePublish();
    });
    this.createConversationRecord();
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
    this.createConversationRecord();
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

    try {
      await this.#scheduler.submit({
        id: rootTaskId,
        goal: task,
        context: [{ type: 'user', content: task }],
        maxModelAttempts: 4,
        budget: { maxCostUsd: 0.05 },
      });
    } catch (error) {
      conversation.rootTaskIds.pop();
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
    const conversation: ConversationRecord = {
      id: randomUUID(),
      title: '新对话',
      createdAt: now,
      updatedAt: now,
      rootTaskIds: [],
    };
    this.#conversations.set(conversation.id, conversation);
    return conversation;
  }

  private configureDemoScenario(rootTaskId: string, task: string): void {
    const fakeProvider = this.#fakeProvider;
    if (!fakeProvider) {
      return;
    }

    const plannerId = randomUUID();
    const executorId = randomUUID();
    const verifierId = randomUUID();

    fakeProvider.setResponses(rootTaskId, [
      {
        type: 'spawn_subagents',
        children: [
          {
            taskId: plannerId,
            goal: '拆解任务目标，明确约束和执行步骤',
            maxModelAttempts: 3,
          },
          {
            taskId: executorId,
            goal: '根据任务目标形成可交付的执行结果',
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
            taskId: verifierId,
            goal: '检查执行依据、边界条件与潜在风险',
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
    if (this.#publishQueued) {
      return;
    }
    this.#publishQueued = true;
    queueMicrotask(() => {
      this.#publishQueued = false;
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
      status: task.state.status,
      stateLabel: state.label,
      capabilities: [...task.capabilities],
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
