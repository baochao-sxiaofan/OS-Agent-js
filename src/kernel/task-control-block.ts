import { randomUUID } from 'node:crypto';

import type {
  CapabilityDelegationHop,
  CapabilityGrant,
  CapabilityInput,
  CapabilityRequest,
  CapabilityRequestRecord,
} from '../capability/capability.js';
import { CapabilityManager } from '../capability/capability-manager.js';
import type { ModelUsage } from '../model/model-provider.js';
import type { JsonValue } from '../types/json.js';
import type {
  AsyncWorkGeneration,
  AsyncWorkRecord,
  AsyncWorkRegistration,
  AsyncWorkTerminalStatus,
} from './async-work.js';
import { isAsyncWorkTerminalStatus } from './async-work.js';
import type {
  AsyncWorkUpdateContextItem,
  ContextItem,
  ContextSummaryKind,
  ContextSummaryRecord,
  TurnSummary,
} from './context.js';
import { assertTaskTransition } from './state-machine.js';
import type { TaskEvent } from './task-event.js';
import type { TaskState, Termination } from './task-state.js';

/** 内核允许的最大 Agent 委派深度。 */
export const MAX_AGENT_DEPTH = 3;

/**
 * 从 TaskEvent 判别联合中移除由 `recordEvent` 统一生成的事件信封字段。
 *
 * 条件类型会分发到每一种事件上，因此调用方仍需提供与 `type` 对应的业务字段，
 * 但不需要自行维护事件 ID、任务 ID、发生时间和任务内序号。
 */
type TaskEventPayload<TEvent extends TaskEvent = TaskEvent> =
  TEvent extends TaskEvent
    ? Omit<TEvent, 'eventId' | 'occurredAt' | 'sequence' | 'taskId'>
    : never;

/** 单个任务的模型调用费用预算。 */
export type TaskBudget = {
  /** 该任务允许消耗的最高美元金额。 */
  maxCostUsd: number;
  /** 已由模型请求和上下文压缩消耗的美元金额。 */
  spentCostUsd: number;
};

/**
 * Agent 向内核提交的统一创建请求。
 *
 * 请求只包含任务自身的业务配置。`depth`、`createdAt`、`rootTaskId`、
 * `parentTaskId` 和初始状态均由内核创建入口推导，调用方不能自行指定。
 */
export type CreateAgentRequest = {
  /** 可选的根任务 ID，仅供宿主或测试注入；子任务 ID 始终由内核生成。 */
  id?: string;
  /** Agent 需要完成的任务目标。 */
  goal: string;
  /**
   * 该任务扮演的 Character 标识。
   *
   * 省略时任务不受角色约束（兼容宿主直接创建的根任务与旧测试）。声明后，
   * 工具可见性、能力上限和可创建子角色都由内核按该角色强制约束。
   */
  characterId?: string;
  /**
   * 宿主授予根任务或父 Agent 请求转授给子任务的能力。
   *
   * 字符串是兼容旧调用方的全局范围简写；资源敏感的新调用应使用结构化输入。
   */
  capabilities?: readonly CapabilityInput[];
  /** 任务启动时携带的完整上下文。 */
  context?: readonly ContextItem[];
  /** 模型请求最多允许尝试的次数；默认值为 3。 */
  maxModelAttempts?: number;
  /** 任务级费用预算。 */
  budget?: {
    /** 该任务允许消耗的最高美元金额。 */
    maxCostUsd: number;
  };
};

/**
 * 子 Agent 可提交的业务配置。
 *
 * 子任务 ID 由内核生成，调用方不能通过创建请求指定。
 */
export type CreateChildAgentRequest = Omit<CreateAgentRequest, 'id'>;

/**
 * Agent 创建来源。
 *
 * 判别联合让统一工厂在类型层面区分根任务与子任务。子任务只提交父 TCB，
 * 其根任务 ID、父任务 ID 和深度全部由内核计算。
 */
export type AgentCreationOrigin =
  | {
      kind: 'root';
    }
  | {
      kind: 'child';
      parent: TaskControlBlock;
    };

/**
 * TaskControlBlock 的可序列化快照。
 *
 * 快照包含恢复任务所需的完整权威状态，不包含 Promise、Timer、AbortController
 * 等进程内对象，可由 TaskStore 持久化后重新构造 TCB。
 */
export type TaskSnapshot = {
  /** 当前任务的唯一 ID。 */
  id: string;
  /** 当前任务所属任务树的根任务 ID。 */
  rootTaskId: string;
  /** 父任务 ID；根任务不存在该字段。 */
  parentTaskId?: string;
  /** 委派深度；根任务从 1 开始。 */
  depth: number;
  /** 当前任务需要完成的目标。 */
  goal: string;
  /** 当前任务扮演的 Character 标识；无角色约束时省略。 */
  characterId?: string;
  /** CapabilityManager 已签发给当前任务的授权事实。 */
  capabilityGrants?: CapabilityGrant[];
  /** 兼容 1.2.1 及更早快照的旧能力字符串。 */
  capabilities?: string[];
  /** 当前任务发起过的 capability 请求及其处理状态。 */
  capabilityRequests?: CapabilityRequestRecord[];
  /** 不经压缩销毁的完整上下文历史。 */
  context: ContextItem[];
  /** 持久化的异步工作批次和 Work Table。 */
  asyncWorkGenerations?: AsyncWorkGeneration[];
  /** 与完整上下文分通道保存的摘要记录。 */
  contextSummaries?: ContextSummaryRecord[];
  /** 下一轮摘要尚未覆盖的完整上下文起始索引。 */
  nextContextSummaryStartIndex?: number;
  /** 当前状态机状态及其进入原因。 */
  state: TaskState;
  /** 任务预算上限和累计支出。 */
  budget: TaskBudget;
  /** 已经启动的模型请求尝试次数。 */
  modelAttempts: number;
  /** 模型请求允许尝试的次数上限。 */
  maxModelAttempts: number;
  /** 任务创建时的 Unix 毫秒时间戳。 */
  createdAt: number;
  /** 最近一次状态、上下文或事件变化的时间。 */
  updatedAt: number;
  /** 用于审计和恢复诊断的只追加事件历史。 */
  events: TaskEvent[];
};

/**
 * 任务控制块（Task Control Block，TCB）。
 *
 * 它类似操作系统中的进程控制块，是单个 Agent 任务的权威内核状态容器：
 * 保存任务身份、状态机、上下文、预算、异步 Work Table 和事件历史。
 * 调度器负责决定何时运行任务，TCB 负责校验并记录运行结果。
 */
export class TaskControlBlock {
  /** 当前任务的唯一 ID。 */
  readonly id: string;
  /** 当前任务所属任务树的根任务 ID。 */
  readonly rootTaskId: string;
  /** 父任务 ID；根任务为 undefined。 */
  readonly parentTaskId: string | undefined;
  /** 当前任务在委派树中的深度，根任务为 1。 */
  readonly depth: number;
  /** 当前 Agent 的任务目标。 */
  readonly goal: string;
  /** 当前 Agent 扮演的 Character 标识；无角色约束时为 undefined。 */
  readonly characterId: string | undefined;
  /** 任务创建时的 Unix 毫秒时间戳。 */
  readonly createdAt: number;

  /** CapabilityManager 签发并由任务快照持久化的授权事实。 */
  #capabilityGrants: CapabilityGrant[];
  /** 当前任务发起过的 capability 请求。 */
  #capabilityRequests: CapabilityRequestRecord[];
  /** 始终保留的完整上下文历史。 */
  #context: ContextItem[];
  /** 按 generation 分组的持久化异步 Work Table。 */
  #asyncWorkGenerations: AsyncWorkGeneration[];
  /** 与完整上下文分开保存的摘要通道。 */
  #contextSummaries: ContextSummaryRecord[];
  /** 下一条单轮摘要应覆盖的完整上下文起始位置。 */
  #nextContextSummaryStartIndex: number;
  /** 当前任务状态机状态。 */
  #state: TaskState;
  /** 当前任务的费用上限和累计支出。 */
  #budget: TaskBudget;
  /** 已经启动的模型请求尝试次数。 */
  #modelAttempts: number;
  /** 模型请求允许尝试的次数上限。 */
  #maxModelAttempts: number;
  /** 最近一次可观测修改的时间。 */
  #updatedAt: number;
  /** 只追加的任务事件历史。 */
  #events: TaskEvent[];

  /**
   * 从完整快照构造 TCB。
   *
   * 构造函数保持私有，确保新任务只能通过 `createAgent` 建立，
   * 持久化任务只能通过 `restore` 恢复。可变数据会被复制，避免与快照共享引用。
   */
  private constructor(snapshot: TaskSnapshot) {
    if (
      !Number.isInteger(snapshot.depth) ||
      snapshot.depth < 1 ||
      snapshot.depth > MAX_AGENT_DEPTH
    ) {
      throw new Error(
        `Task depth must be an integer between 1 and ${MAX_AGENT_DEPTH}.`,
      );
    }
    if (
      (snapshot.depth === 1 && snapshot.parentTaskId !== undefined) ||
      (snapshot.depth > 1 && snapshot.parentTaskId === undefined)
    ) {
      throw new Error('Task depth does not match its parent relationship.');
    }
    this.id = snapshot.id;
    this.rootTaskId = snapshot.rootTaskId;
    this.parentTaskId = snapshot.parentTaskId;
    this.depth = snapshot.depth;
    this.goal = snapshot.goal;
    this.characterId = snapshot.characterId;
    this.createdAt = snapshot.createdAt;
    this.#capabilityGrants = structuredClone(
      snapshot.capabilityGrants ??
        restoreLegacyCapabilityGrants(snapshot),
    );
    if (
      this.#capabilityGrants.some(
        (grant) => grant.subjectTaskId !== snapshot.id,
      )
    ) {
      throw new Error('Capability grant subject does not match its task.');
    }
    if (
      new Set(this.#capabilityGrants.map((grant) => grant.grantId)).size !==
      this.#capabilityGrants.length
    ) {
      throw new Error('Capability grant IDs must be unique within a task.');
    }
    this.#capabilityRequests = structuredClone(
      snapshot.capabilityRequests ?? [],
    );
    this.#context = structuredClone(snapshot.context);
    this.#asyncWorkGenerations = structuredClone(
      snapshot.asyncWorkGenerations ?? [],
    );
    this.#contextSummaries = structuredClone(
      snapshot.contextSummaries ?? [],
    );
    this.#nextContextSummaryStartIndex =
      snapshot.nextContextSummaryStartIndex ?? 0;
    this.#state = structuredClone(snapshot.state);
    this.#budget = { ...snapshot.budget };
    this.#modelAttempts = snapshot.modelAttempts;
    this.#maxModelAttempts = snapshot.maxModelAttempts;
    this.#updatedAt = snapshot.updatedAt;
    this.#events = structuredClone(snapshot.events);
  }

  /**
   * 通过内核统一入口创建根任务或子任务。
   *
   * 根任务固定为深度 1；子任务深度固定为 `parent.depth + 1`，并自动继承
   * 父任务的 rootTaskId。调用方无法伪造层级或血缘信息。所有任务初始状态
   * 均为 READY，并写入序号为 1 的 `task_created` 事件。
   */
  static createAgent(
    request: CreateAgentRequest,
    origin: AgentCreationOrigin,
    createdAt = Date.now(),
    capabilityGrants?: readonly CapabilityGrant[],
  ): TaskControlBlock {
    const parent = origin.kind === 'child' ? origin.parent : undefined;
    const depth = parent === undefined ? 1 : parent.depth + 1;
    if (depth > MAX_AGENT_DEPTH) {
      throw new Error(
        `Cannot create an Agent deeper than ${MAX_AGENT_DEPTH} levels.`,
      );
    }
    const initialState: TaskState = {
      status: 'READY',
      enteredAt: createdAt,
      reason: 'submitted',
    };
    const taskId = request.id ?? randomUUID();
    const grants =
      capabilityGrants ??
      createCompatibilityGrants(
        taskId,
        request.capabilities ?? [],
        parent,
        createdAt,
      );
    const createdEvent: TaskEvent = {
      type: 'task_created',
      eventId: randomUUID(),
      taskId,
      occurredAt: createdAt,
      sequence: 1,
      goal: request.goal,
      initialState,
    };
    const grantEvents: TaskEvent[] = grants.map((grant, index) => ({
      type: 'capability_granted',
      eventId: randomUUID(),
      taskId,
      occurredAt: createdAt,
      sequence: index + 2,
      grantId: grant.grantId,
      capability: grant.capability,
      scope: structuredClone(grant.scope),
      sourceType: grant.source.type,
    }));

    return new TaskControlBlock({
      id: taskId,
      rootTaskId: parent?.rootTaskId ?? taskId,
      ...(parent === undefined ? {} : { parentTaskId: parent.id }),
      depth,
      goal: request.goal,
      ...(request.characterId === undefined
        ? {}
        : { characterId: request.characterId }),
      capabilityGrants: [...structuredClone(grants)],
      capabilityRequests: [],
      context: [...(request.context ?? [])],
      asyncWorkGenerations: [],
      contextSummaries: [],
      nextContextSummaryStartIndex: 0,
      state: initialState,
      budget: {
        maxCostUsd: request.budget?.maxCostUsd ?? Number.MAX_VALUE,
        spentCostUsd: 0,
      },
      modelAttempts: 0,
      maxModelAttempts: request.maxModelAttempts ?? 3,
      createdAt,
      updatedAt: createdAt,
      events: [createdEvent, ...grantEvents],
    });
  }

  /** 从持久化快照恢复一个任务，不额外生成创建事件。 */
  static restore(snapshot: TaskSnapshot): TaskControlBlock {
    return new TaskControlBlock(snapshot);
  }

  /** 获取当前任务状态的只读视图。 */
  get state(): Readonly<TaskState> {
    return this.#state;
  }

  /** 获取完整上下文历史的只读数组视图。 */
  get context(): readonly ContextItem[] {
    return this.#context;
  }

  /** 获取全部异步工作批次的副本，防止外部直接修改 Work Table。 */
  get asyncWorkGenerations(): readonly AsyncWorkGeneration[] {
    return structuredClone(this.#asyncWorkGenerations);
  }

  /**
   * 获取当前尚未关闭的异步工作批次。
   *
   * 正常情况下每个任务最多只有一个开放 generation；返回副本以保护内部状态。
   */
  get activeAsyncWorkGeneration(): AsyncWorkGeneration | undefined {
    const generation = this.#asyncWorkGenerations.findLast(
      (candidate) => candidate.closedAt === undefined,
    );
    return generation ? structuredClone(generation) : undefined;
  }

  /** 获取已经生成的上下文摘要记录。 */
  get contextSummaries(): readonly ContextSummaryRecord[] {
    return this.#contextSummaries;
  }

  /** 获取当前任务持有的 Grant 副本。 */
  get capabilityGrants(): readonly CapabilityGrant[] {
    return structuredClone(this.#capabilityGrants);
  }

  /** 获取当前任务发起过的 capability 请求副本。 */
  get capabilityRequests(): readonly CapabilityRequestRecord[] {
    return structuredClone(this.#capabilityRequests);
  }

  /** 获取能力名称数组；仅用于旧 UI 和调用方兼容。 */
  get capabilities(): readonly string[] {
    return [...new Set(this.#capabilityGrants.map((grant) => grant.capability))];
  }

  /** 获取当前任务预算的只读视图。 */
  get budget(): Readonly<TaskBudget> {
    return this.#budget;
  }

  /** 获取已经启动的模型请求尝试次数。 */
  get modelAttempts(): number {
    return this.#modelAttempts;
  }

  /** 获取模型请求允许尝试的次数上限。 */
  get maxModelAttempts(): number {
    return this.#maxModelAttempts;
  }

  /** 获取任务最近一次更新的时间。 */
  get updatedAt(): number {
    return this.#updatedAt;
  }

  /** 获取只追加事件历史的只读视图。 */
  get events(): readonly TaskEvent[] {
    return this.#events;
  }

  /** 判断当前任务是否持有指定名称的未过期能力。 */
  hasCapability(capability: string): boolean {
    const now = Date.now();
    return this.#capabilityGrants.some(
      (grant) =>
        grant.capability === capability &&
        (grant.expiresAt === undefined || grant.expiresAt > now) &&
        (grant.remainingUses === undefined || grant.remainingUses > 0),
    );
  }

  /** 消耗一次有限 Grant；无限 Grant 不需要修改。 */
  consumeCapabilityGrant(grantId: string, operationId: string): void {
    const grant = this.#capabilityGrants.find(
      (candidate) => candidate.grantId === grantId,
    );
    if (!grant) {
      throw new Error(`Capability grant is not registered: ${grantId}`);
    }
    if (grant.remainingUses === undefined) {
      return;
    }
    if (grant.consumedBy === operationId) {
      return;
    }
    if (grant.remainingUses <= 0) {
      throw new Error(`Capability grant is exhausted: ${grantId}`);
    }
    grant.remainingUses -= 1;
    grant.consumedBy = operationId;
    this.recordEvent({
      type: 'capability_grant_consumed',
      grantId,
      capability: grant.capability,
      remainingUses: grant.remainingUses,
      operationId,
    });
  }

  /** 追加由 CapabilityManager 签发的 Grant。 */
  addCapabilityGrants(grants: readonly CapabilityGrant[]): void {
    for (const grant of grants) {
      if (grant.subjectTaskId !== this.id) {
        throw new Error('Capability grant subject does not match this task.');
      }
      if (
        this.#capabilityGrants.some(
          (existing) => existing.grantId === grant.grantId,
        )
      ) {
        continue;
      }
      this.#capabilityGrants.push(structuredClone(grant));
      this.recordEvent({
        type: 'capability_granted',
        grantId: grant.grantId,
        capability: grant.capability,
        scope: structuredClone(grant.scope),
        sourceType: grant.source.type,
      });
    }
  }

  /** 登记一项由 CapabilityManager 完成路由的授权申请。 */
  registerCapabilityRequest(request: CapabilityRequestRecord): void {
    if (
      this.#capabilityRequests.some(
        (existing) =>
          existing.status === 'pending' ||
          existing.requestId === request.requestId,
      )
    ) {
      throw new Error(
        'Task already has a pending or duplicate capability request.',
      );
    }
    this.#capabilityRequests.push(structuredClone(request));
    this.recordEvent({
      type: 'capability_request_created',
      requestId: request.requestId,
      route: request.route,
      requests: structuredClone(request.requests),
      ...(request.delegationPath === undefined
        ? {}
        : {
            delegationPath: structuredClone(
              request.delegationPath,
            ),
          }),
    });
  }

  currentCapabilityDelegationHop(
    requestId: string,
  ): CapabilityDelegationHop | undefined {
    const request = this.#capabilityRequests.find(
      (candidate) => candidate.requestId === requestId,
    );
    if (
      !request?.delegationPath ||
      request.currentHopIndex === undefined
    ) {
      return undefined;
    }
    const hop = request.delegationPath[request.currentHopIndex];
    return hop ? structuredClone(hop) : undefined;
  }

  advanceCapabilityDelegation(
    requestId: string,
  ): CapabilityDelegationHop | undefined {
    const request = this.#capabilityRequests.find(
      (candidate) => candidate.requestId === requestId,
    );
    if (
      !request ||
      request.status !== 'pending' ||
      !request.delegationPath ||
      request.currentHopIndex === undefined
    ) {
      throw new Error(
        `Capability delegation is not active: ${requestId}`,
      );
    }
    const grantedHopIndex = request.currentHopIndex;
    const current = request.delegationPath[grantedHopIndex];
    if (!current || current.status !== 'pending') {
      throw new Error(
        `Capability delegation hop is not pending: ${requestId}`,
      );
    }
    current.status = 'granted';
    const nextHopIndex = grantedHopIndex + 1;
    const next = request.delegationPath[nextHopIndex];
    if (next) {
      next.status = 'pending';
      request.currentHopIndex = nextHopIndex;
    } else {
      delete request.currentHopIndex;
    }
    this.recordEvent({
      type: 'capability_delegation_advanced',
      requestId,
      grantedHopIndex,
      ...(next === undefined ? {} : { nextHopIndex }),
    });
    return next ? structuredClone(next) : undefined;
  }

  /** 完成待处理授权申请，并在允许时安装内核签发的 Grant。 */
  resolveCapabilityRequest(
    requestId: string,
    status: 'denied' | 'granted',
    grants: readonly CapabilityGrant[],
    reason: string | undefined,
    resolvedAt: number,
  ): CapabilityRequestRecord {
    const request = this.#capabilityRequests.find(
      (candidate) => candidate.requestId === requestId,
    );
    if (!request) {
      throw new Error(`Capability request is not registered: ${requestId}`);
    }
    if (request.status !== 'pending') {
      throw new Error(`Capability request is already resolved: ${requestId}`);
    }
    if (status === 'granted') {
      this.addCapabilityGrants(grants);
    } else if (grants.length > 0) {
      throw new Error('Denied capability request cannot install grants.');
    }
    request.status = status;
    request.resolvedAt = resolvedAt;
    if (reason === undefined) {
      delete request.resolutionReason;
    } else {
      request.resolutionReason = reason;
    }
    this.recordEvent({
      type: 'capability_request_resolved',
      requestId,
      status,
      ...(reason === undefined ? {} : { reason }),
    });
    return structuredClone(request);
  }

  /** 任务终止时关闭全部待处理请求，避免恢复后留下无主审批。 */
  denyPendingCapabilityRequests(reason: string, resolvedAt: number): void {
    for (const request of this.#capabilityRequests) {
      if (request.status !== 'pending') {
        continue;
      }
      request.status = 'denied';
      request.resolvedAt = resolvedAt;
      request.resolutionReason = reason;
      this.recordEvent({
        type: 'capability_request_resolved',
        requestId: request.requestId,
        status: 'denied',
        reason,
      });
    }
  }

  /**
   * 执行一次显式状态转换。
   *
   * 状态机先校验转换是否合法，再替换当前状态并记录 `state_transitioned` 事件。
   * `reason` 用于解释本次转换的业务原因，不替代 `next` 中的强类型状态原因。
   */
  transition(next: TaskState, reason: string): void {
    assertTaskTransition(this.#state, next);
    const previousStatus = this.#state.status;
    this.#state = structuredClone(next);
    this.#updatedAt = next.enteredAt;
    this.recordEvent({
      type: 'state_transitioned',
      from: previousStatus,
      to: next,
      reason,
    });
  }

  /**
   * 向完整上下文追加一项记录。
   *
   * 写入前进行深拷贝，避免调用方之后修改原对象而污染任务历史。
   */
  appendContext(item: ContextItem): void {
    this.#context.push(structuredClone(item));
    this.#updatedAt = Date.now();
  }

  /**
   * 将一组工具调用或子 Agent 注册为持久化异步工作。
   *
   * 同一任务中的 workId 全局不可重复。若当前存在开放 generation，则工作并入
   * 该批次；否则创建新批次。所有新工作以 `running` 状态进入 Work Table。
   *
   * @returns 工作所属的 generation ID。
   */
  registerAsyncWork(
    registrations: readonly AsyncWorkRegistration[],
    now: number,
  ): string {
    if (registrations.length === 0) {
      throw new Error('At least one asynchronous work item is required.');
    }
    const registrationIds = registrations.map(
      (registration) => registration.workId,
    );
    if (new Set(registrationIds).size !== registrationIds.length) {
      throw new Error('Asynchronous work IDs must be unique.');
    }
    // workId 在任务整个生命周期内只允许使用一次，防止恢复或重试后结果串线。
    const usedWorkIds = new Set(
      this.#asyncWorkGenerations.flatMap((generation) =>
        generation.work.map((work) => work.workId),
      ),
    );
    const reusedWorkId = registrationIds.find((workId) =>
      usedWorkIds.has(workId),
    );
    if (reusedWorkId !== undefined) {
      throw new Error(`Asynchronous work ID has already been used: ${reusedWorkId}`);
    }

    // 一轮模型决策产生的异步工作共享同一个开放 generation。
    let generation = this.#asyncWorkGenerations.findLast(
      (candidate) => candidate.closedAt === undefined,
    );
    if (!generation) {
      generation = {
        generationId: randomUUID(),
        createdAt: now,
        work: [],
      };
      this.#asyncWorkGenerations.push(generation);
    }
    generation.work.push(
      ...registrations.map(
        (registration): AsyncWorkRecord => ({
          ...structuredClone(registration),
          status: 'running',
          startedAt: now,
        }),
      ),
    );
    this.recordEvent({
      type: 'async_work_registered',
      generationId: generation.generationId,
      work: registrations.map(({ workId, kind }) => ({ workId, kind })),
    });
    return generation.generationId;
  }

  /** 将工具工作标记为完成并保存 JSON 输出，但暂不投递给模型。 */
  completeToolWork(
    workId: string,
    output: JsonValue,
    now: number,
  ): void {
    this.completeAsyncWork(
      workId,
      'completed',
      now,
      { output: structuredClone(output) },
    );
  }

  /** 将工具工作标记为失败并保存错误信息。 */
  failToolWork(workId: string, error: string, now: number): void {
    this.completeAsyncWork(workId, 'failed', now, { error });
  }

  /**
   * 根据子任务终止结果完成对应异步工作。
   *
   * `failed` 和 `cancelled` 保留对应终态；正常完成及
   * `needs_parent_action` 都表示子任务已退出，因此映射为 `completed`。
   */
  completeSubagentWork(
    workId: string,
    termination: Termination,
    now: number,
  ): void {
    const status: AsyncWorkTerminalStatus =
      termination.kind === 'failed'
        ? 'failed'
        : termination.kind === 'cancelled'
          ? 'cancelled'
          : 'completed';
    this.completeAsyncWork(workId, status, now, {
      termination: structuredClone(termination),
    });
  }

  /**
   * 在父任务的 Work Table 中记录直接子 Agent 正在等待 capability。
   *
   * 该更新是非终态进展；工作仍然存活，并通过现有 Completion Mailbox 批量投递。
   */
  markSubagentWaitingForCapability(
    childTaskId: string,
    requestRef: string,
    requests: readonly CapabilityRequest[],
    now: number,
  ): void {
    const generation = this.requireOpenGenerationForSubagent(childTaskId);
    const work = generation.work.find(
      (candidate) =>
        candidate.kind === 'subagent' &&
        candidate.childTaskId === childTaskId,
    );
    if (
      !work ||
      (work.status !== 'running' &&
        work.status !== 'waiting_for_capability')
    ) {
      throw new Error(`Subagent work is not running: ${childTaskId}`);
    }
    if (work.blocker !== undefined) {
      throw new Error(
        `Subagent work already has a capability blocker: ${childTaskId}`,
      );
    }
    work.blocker = {
      type: 'capability_request',
      requestRef,
      requests: [...structuredClone(requests)],
      blockedAt: now,
    };
    work.status = 'waiting_for_capability';
    this.recordEvent({
      type: 'async_work_capability_blocked',
      generationId: generation.generationId,
      workId: work.workId,
      requestRef,
      requests: [...structuredClone(requests)],
    });
  }

  /** 清除父任务 Work Table 中已经处理完毕的 capability blocker。 */
  clearSubagentCapabilityBlocker(
    childTaskId: string,
    requestRef: string,
  ): void {
    const generation = this.requireOpenGenerationForSubagent(childTaskId);
    const work = generation.work.find(
      (candidate) =>
        candidate.kind === 'subagent' &&
        candidate.childTaskId === childTaskId,
    );
    if (
      !work ||
      work.status !== 'waiting_for_capability' ||
      work.blocker?.requestRef !== requestRef
    ) {
      throw new Error(
        `Subagent capability blocker is not active: ${requestRef}`,
      );
    }
    work.status = 'running';
    delete work.blocker;
    this.recordEvent({
      type: 'async_work_capability_unblocked',
      generationId: generation.generationId,
      workId: work.workId,
      requestRef,
    });
  }

  /** 返回当前开放 generation 中仍在运行的 workId。 */
  activeAsyncWorkPendingIds(): string[] {
    return (
      this.activeAsyncWorkGeneration?.work
        .filter((work) => !isAsyncWorkTerminalStatus(work.status))
        .map((work) => work.workId) ?? []
    );
  }

  hasActiveCapabilityBlockers(): boolean {
    return (
      this.activeAsyncWorkGeneration?.work.some(
        (work) =>
          work.status === 'waiting_for_capability' &&
          work.blocker !== undefined,
      ) ?? false
    );
  }

  /**
   * 将尚未处理但已投递过的 blocker 重新放回 Completion Mailbox。
   *
   * 父 Agent 一轮只能处理一个授权决定时，其余 blocker 会重新走统一批处理窗口。
   */
  requeueActiveCapabilityBlockers(): number {
    const generation = this.#asyncWorkGenerations.findLast(
      (candidate) => candidate.closedAt === undefined,
    );
    if (!generation) {
      return 0;
    }
    let count = 0;
    for (const work of generation.work) {
      if (
        work.status === 'waiting_for_capability' &&
        work.blocker?.deliveredAt !== undefined
      ) {
        delete work.blocker.deliveredAt;
        count += 1;
      }
    }
    return count;
  }

  /** 判断当前批次是否存在尚未注入父 Agent 上下文的结果或阻塞进展。 */
  hasUndeliveredAsyncWorkResults(): boolean {
    return (
      this.activeAsyncWorkGeneration?.work.some(
        (work) =>
          (isAsyncWorkTerminalStatus(work.status) &&
            work.deliveredAt === undefined) ||
          (work.status === 'waiting_for_capability' &&
            work.blocker !== undefined &&
            work.blocker.deliveredAt === undefined),
      ) ?? false
    );
  }

  /** 判断当前开放 generation 是否存在且全部工作都已进入终态。 */
  isActiveAsyncWorkComplete(): boolean {
    const generation = this.activeAsyncWorkGeneration;
    return (
      generation !== undefined &&
      generation.work.length > 0 &&
      generation.work.every((work) =>
        isAsyncWorkTerminalStatus(work.status),
      )
    );
  }

  /**
   * 设置或清除当前异步批次的部分结果投递截止时间。
   *
   * 这里只持久化 timer 的逻辑期限；真正的一次性 Timer 由调度器负责创建。
   */
  setAsyncWorkBatchDueAt(
    generationId: string,
    dueAt: number | undefined,
  ): void {
    const generation = this.requireOpenAsyncWorkGeneration(generationId);
    if (dueAt === undefined) {
      delete generation.batchDueAt;
    } else {
      generation.batchDueAt = dueAt;
    }
    this.#updatedAt = Date.now();
  }

  /**
   * 原子领取当前批次尚未投递的终态结果，并生成 Completion Mailbox 更新。
   *
   * 方法会把新结果和仍在运行的工作共同组装成 `async_work_update`，随后：
   * 1. 为已领取结果写入 deliveredAt，防止恢复后重复注入；
   * 2. 清除批处理期限；
   * 3. 在全部工作完成时关闭 generation；
   * 4. 将更新追加到父 Agent 的完整上下文并记录投递事件。
   *
   * 没有开放批次或没有新增终态结果时返回 undefined。
   */
  claimAsyncWorkUpdate(now: number): AsyncWorkUpdateContextItem | undefined {
    const generation = this.#asyncWorkGenerations.findLast(
      (candidate) => candidate.closedAt === undefined,
    );
    if (!generation) {
      return undefined;
    }
    const terminal = generation.work.filter(
      (work) =>
        isAsyncWorkTerminalStatus(work.status) &&
        work.deliveredAt === undefined,
    );
    const blocked = generation.work.filter(
      (work) =>
        work.status === 'waiting_for_capability' &&
        work.blocker !== undefined &&
        work.blocker.deliveredAt === undefined,
    );
    if (terminal.length === 0 && blocked.length === 0) {
      return undefined;
    }
    // 全部完成时走立即唤醒路径；存在 pending 时则是一次部分结果批量投递。
    const allFinished = generation.work.every(
      (work) => isAsyncWorkTerminalStatus(work.status),
    );
    const update: AsyncWorkUpdateContextItem = {
      type: 'async_work_update',
      generationId: generation.generationId,
      results: terminal.map((work) => ({
        workId: work.workId,
        kind: work.kind,
        label: work.label,
        status: work.status as AsyncWorkTerminalStatus,
        completedAt: work.completedAt ?? now,
        ...(work.output === undefined
          ? {}
          : { output: structuredClone(work.output) }),
        ...(work.termination === undefined
          ? {}
          : { termination: structuredClone(work.termination) }),
        ...(work.error === undefined ? {} : { error: work.error }),
      })),
      pending: generation.work
        .filter((work) => !isAsyncWorkTerminalStatus(work.status))
        .map((work) => ({
          workId: work.workId,
          kind: work.kind,
          label: work.label,
          startedAt: work.startedAt,
          status:
            work.status === 'waiting_for_capability'
              ? 'waiting_for_capability'
              : 'running',
          ...(work.blocker === undefined
            ? {}
            : {
                blocker: {
                  type: work.blocker.type,
                  requestRef: work.blocker.requestRef,
                  requests: structuredClone(work.blocker.requests),
                  blockedAt: work.blocker.blockedAt,
                },
              }),
        })),
      allFinished,
    };
    // 先持久化投递标记，再由后续快照保证恢复时不会重复注入同一结果。
    for (const work of terminal) {
      work.deliveredAt = now;
    }
    for (const work of blocked) {
      if (work.blocker) {
        work.blocker.deliveredAt = now;
      }
    }
    delete generation.batchDueAt;
    if (allFinished) {
      generation.closedAt = now;
    }
    this.#context.push(structuredClone(update));
    this.recordEvent({
      type: 'async_work_delivered',
      generationId: generation.generationId,
      workIds: [...terminal, ...blocked].map((work) => work.workId),
      allFinished,
    });
    return update;
  }

  /**
   * 标记一轮模型决策处理完毕，并可选保存该轮搭载摘要。
   *
   * 摘要覆盖区间为 `[nextContextSummaryStartIndex, context.length)`。
   * 无论模型是否提供摘要，游标都会前移，避免后续摘要错误覆盖多轮上下文。
   */
  completeModelTurn(summary?: TurnSummary): void {
    const sourceStartIndex = this.#nextContextSummaryStartIndex;
    const sourceEndIndex = this.#context.length;
    if (summary !== undefined) {
      this.addContextSummary(
        'turn',
        sourceStartIndex,
        sourceEndIndex,
        summary,
      );
    }
    this.#nextContextSummaryStartIndex = sourceEndIndex;
  }

  /**
   * 保存 ContextCompactor 生成的二次摘要。
   *
   * 二次摘要覆盖完整上下文前缀 `[0, sourceEndIndex)`；压缩请求本身也属于
   * 模型资源消耗，因此会累计费用并记录独立的压缩事件。
   */
  recordSecondaryContextSummary(
    summary: TurnSummary,
    sourceEndIndex: number,
    usage: ModelUsage,
  ): void {
    if (sourceEndIndex < 0 || sourceEndIndex > this.#context.length) {
      throw new Error('Secondary context summary range is invalid.');
    }
    this.#budget.spentCostUsd += usage.costUsd;
    this.recordEvent({
      type: 'context_compaction_recorded',
      usage,
    });
    this.addContextSummary(
      'secondary',
      0,
      sourceEndIndex,
      summary,
    );
  }

  /** 开始一次模型请求尝试，并返回递增后的尝试序号。 */
  startModelAttempt(): number {
    this.#modelAttempts += 1;
    return this.#modelAttempts;
  }

  /** 判断当前失败后是否仍有剩余模型重试次数。 */
  canRetryModel(): boolean {
    return this.#modelAttempts < this.#maxModelAttempts;
  }

  /**
   * 记录任务因 RPM、TPM、并发或预算等准入条件而等待。
   *
   * 该方法只追加诊断事件；READY 状态和重新入队由调度器维护。
   */
  recordCapacityWait(reasons: string[], retryAt?: number): void {
    this.recordEvent({
      type: 'capacity_wait_recorded',
      reasons: [...reasons],
      ...(retryAt === undefined ? {} : { retryAt }),
    });
  }

  /**
   * 记录一次已成功解析的模型响应，并累计本次调用费用。
   *
   * `responseType` 描述模型选择的下一步动作，供审计和运行指标使用。
   */
  recordModelResponse(
    responseType:
      | 'async_work'
      | 'final'
      | 'needs_parent_action'
      | 'request_capabilities'
      | 'resolve_capability_request'
      | 'spawn_subagents'
      | 'tool_calls'
      | 'wait_for_async_work',
    usage: ModelUsage,
  ) {
    this.#budget.spentCostUsd += usage.costUsd;
    this.recordEvent({
      type: 'model_response_recorded',
      responseType,
      usage,
    });
  }

  /** 记录工具调用已发起；工具执行和上下文写入由其他组件负责。 */
  recordToolCall(callId: string, toolName: string): void {
    this.recordEvent({
      type: 'tool_call_recorded',
      callId,
      toolName,
    });
  }

  /** 记录工具调用结果，保留调用 ID 以便与请求关联。 */
  recordToolResult(
    callId: string,
    toolName: string,
    output: JsonValue,
  ): void {
    this.recordEvent({
      type: 'tool_result_recorded',
      callId,
      toolName,
      output,
    });
  }

  /**
   * 记录任务终止事实。
   *
   * 该方法不执行状态转换；调用方应先通过 `transition` 进入 TERMINATED。
   */
  recordTermination(termination: Termination): void {
    this.recordEvent({
      type: 'task_terminated',
      termination,
    });
  }

  /** 记录父任务已经成功创建一个指定深度的子任务。 */
  recordSubagentSpawned(childTaskId: string, childDepth: number): void {
    this.recordEvent({
      type: 'subagent_spawned',
      childTaskId,
      childDepth,
    });
  }

  /** 记录父任务已经接收到子任务的结构化终止结果。 */
  recordSubagentResult(childTaskId: string, result: Termination): void {
    this.recordEvent({
      type: 'subagent_result_recorded',
      childTaskId,
      result,
    });
  }

  /**
   * 生成可持久化的完整任务快照。
   *
   * 所有可变集合和结构化值都会复制，避免 TaskStore 持有 TCB 内部引用。
   */
  snapshot(): TaskSnapshot {
    return {
      id: this.id,
      rootTaskId: this.rootTaskId,
      ...(this.parentTaskId === undefined
        ? {}
        : { parentTaskId: this.parentTaskId }),
      depth: this.depth,
      goal: this.goal,
      ...(this.characterId === undefined
        ? {}
        : { characterId: this.characterId }),
      capabilityGrants: structuredClone(this.#capabilityGrants),
      capabilityRequests: structuredClone(this.#capabilityRequests),
      context: structuredClone(this.#context),
      asyncWorkGenerations: structuredClone(this.#asyncWorkGenerations),
      contextSummaries: structuredClone(this.#contextSummaries),
      nextContextSummaryStartIndex: this.#nextContextSummaryStartIndex,
      state: structuredClone(this.#state),
      budget: { ...this.#budget },
      modelAttempts: this.#modelAttempts,
      maxModelAttempts: this.#maxModelAttempts,
      createdAt: this.createdAt,
      updatedAt: this.#updatedAt,
      events: structuredClone(this.#events),
    };
  }

  /**
   * 将指定异步工作从 `running` 推进到终态。
   *
   * 只允许完成开放 generation 中仍在运行的工作；重复完成会抛错，从而保证
   * Work Record 的终态不可逆。该方法只写 Work Table，结果投递由
   * `claimAsyncWorkUpdate` 单独完成。
   */
  private completeAsyncWork(
    workId: string,
    status: AsyncWorkTerminalStatus,
    now: number,
    result: {
      output?: JsonValue;
      termination?: Termination;
      error?: string;
    },
  ): void {
    const generation = this.#asyncWorkGenerations.findLast(
      (candidate) =>
        candidate.closedAt === undefined &&
        candidate.work.some((work) => work.workId === workId),
    );
    if (!generation) {
      throw new Error(`Asynchronous work is not active: ${workId}`);
    }
    const work = generation.work.find(
      (candidate) => candidate.workId === workId,
    );
    if (!work || isAsyncWorkTerminalStatus(work.status)) {
      throw new Error(`Asynchronous work is already terminal: ${workId}`);
    }
    work.status = status;
    delete work.blocker;
    work.completedAt = now;
    if (result.output !== undefined) {
      work.output = structuredClone(result.output);
    }
    if (result.termination !== undefined) {
      work.termination = structuredClone(result.termination);
    }
    if (result.error !== undefined) {
      work.error = result.error;
    }
    this.recordEvent({
      type: 'async_work_terminal',
      generationId: generation.generationId,
      workId,
      status,
    });
  }

  /** 查找指定且尚未关闭的 generation，不存在时抛出明确错误。 */
  private requireOpenAsyncWorkGeneration(
    generationId: string,
  ): AsyncWorkGeneration {
    const generation = this.#asyncWorkGenerations.find(
      (candidate) =>
        candidate.generationId === generationId &&
        candidate.closedAt === undefined,
    );
    if (!generation) {
      throw new Error(
        `Asynchronous work generation is not active: ${generationId}`,
      );
    }
    return generation;
  }

  private requireOpenGenerationForSubagent(
    childTaskId: string,
  ): AsyncWorkGeneration {
    const generation = this.#asyncWorkGenerations.findLast(
      (candidate) =>
        candidate.closedAt === undefined &&
        candidate.work.some(
          (work) =>
            work.kind === 'subagent' &&
            work.childTaskId === childTaskId,
        ),
    );
    if (!generation) {
      throw new Error(
        `Subagent work is not active for child: ${childTaskId}`,
      );
    }
    return generation;
  }

  /**
   * 向独立摘要通道追加一条记录，并写入对应审计事件。
   *
   * 原始完整上下文不会在此删除；ContextWindowManager 仅在构造模型输入时
   * 使用摘要替换其覆盖区间。
   */
  private addContextSummary(
    kind: ContextSummaryKind,
    sourceStartIndex: number,
    sourceEndIndex: number,
    summary: TurnSummary,
  ): void {
    const createdAt = Date.now();
    const record: ContextSummaryRecord = {
      id: randomUUID(),
      kind,
      sourceStartIndex,
      sourceEndIndex,
      summary: structuredClone(summary),
      createdAt,
    };
    this.#contextSummaries.push(record);
    this.recordEvent({
      type: 'context_summary_recorded',
      kind,
      sourceStartIndex,
      sourceEndIndex,
      summary: structuredClone(summary),
    });
  }

  /**
   * 为业务事件补齐统一信封并追加到事件历史。
   *
   * sequence 在单个任务内单调递增；任何事件写入也会刷新 updatedAt。
   */
  private recordEvent(
    event: TaskEventPayload,
  ): void {
    const occurredAt = Date.now();
    const taskEvent = {
      ...event,
      eventId: randomUUID(),
      taskId: this.id,
      occurredAt,
      sequence: this.#events.length + 1,
    } as TaskEvent;
    this.#events.push(taskEvent);
    this.#updatedAt = occurredAt;
  }
}

/**
 * 仅用于直接调用 TCB 工厂和恢复旧测试的兼容路径。
 *
 * 生产调度器始终显式传入 CapabilityManager 签发的 grants。子任务在此路径下
 * 仍会检查父任务持有并允许转授对应的全局能力，避免工厂成为越权入口。
 */
function createCompatibilityGrants(
  taskId: string,
  inputs: readonly CapabilityInput[],
  parent: TaskControlBlock | undefined,
  issuedAt: number,
): CapabilityGrant[] {
  const manager = new CapabilityManager();
  return parent === undefined
    ? manager.issueRootGrants(taskId, inputs, issuedAt)
    : manager.delegate(
        parent.id,
        parent.capabilityGrants,
        taskId,
        inputs,
        issuedAt,
      );
}

function restoreLegacyCapabilityGrants(
  snapshot: TaskSnapshot,
): CapabilityGrant[] {
  const grants = new CapabilityManager().issueRootGrants(
    snapshot.id,
    snapshot.capabilities ?? [],
    snapshot.createdAt,
  );
  return grants.map((grant, index) => ({
    ...grant,
    grantId: `legacy:${snapshot.id}:${index}`,
  }));
}
