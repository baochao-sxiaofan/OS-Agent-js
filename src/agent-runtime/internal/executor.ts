import type { AgentContextManager, ContextEntry } from '../../agent-context/index.js';
import type { AgentWorkRound } from '../../agent-round/index.js';
import { createHash } from 'node:crypto';
import type { AgentScheduler, AsyncOperationResult } from '../../agent-scheduler/index.js';
import { CapabilityManager } from '../../capability/capability-manager.js';
import { scopeContains, type CapabilityRequest } from '../../capability/capability.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { ToolExecutionError, ToolPreconditionError } from '../../tools/tool.js';
import type { JsonValue } from '../../types/json.js';
import type { RuntimeAgent, RuntimeApproval, RuntimeCapabilityGrant, RuntimeLimits } from '../api.js';
import { RuntimeFault } from './limits.js';
import { jsonSchema } from './schema.js';
import { type ExecutionOperation, RuntimeStore } from './store.js';
import { abortable } from './abortable.js';

export class ToolExecutor {
  readonly #manager = new CapabilityManager();
  readonly #active = new Map<string, Promise<void>>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #mutationTails = new Map<string, Promise<void>>();
  readonly #mutationWork = new Map<string, Promise<JsonValue>>();
  readonly #shutdown = new AbortController();
  #stopping = false;
  constructor(readonly options: {
    store: RuntimeStore; scheduler: AgentScheduler; tools: ToolRegistry; limits: RuntimeLimits;
    inlineCharacters: number;
    workspace: (agent: RuntimeAgent) => string; agent: (id: number) => RuntimeAgent;
    update: (agent: RuntimeAgent) => void; onFault: (id: number, kind: 'permission' | 'tool', message: string) => void;
    onUnknown: (agentId: number) => void;
    onReconciled: (operation: ExecutionOperation, resultRef: string) => boolean;
    onFatal: () => void;
  }) {}

  requirements(operation: ExecutionOperation): CapabilityRequest[] {
    const tool = this.options.tools.get(operation.toolName);
    return this.#manager.normalizeRequests(tool.requiredCapabilities?.(operation.arguments) ??
      (tool.requiredCapability ? [tool.requiredCapability] : []));
  }

  stage(round: AgentWorkRound, context: AgentContextManager,
    calls: readonly { name: string; arguments: import('../../types/json.js').JsonObject }[]): void {
    for (const [index, call] of calls.entries()) {
      const id = `${round.idempotencyKey}:tool:${index}`;
      const previous = this.options.store.operation(id);
      if (previous) {
        if (previous.toolName !== call.name || JSON.stringify(previous.arguments) !== JSON.stringify(call.arguments)) {
          throw new RuntimeFault('tool', '原批次已有不同参数的执行记录，停止重放并保留现场。');
        }
        if (!previous.schedulerOperation) {
          const handle = this.options.scheduler.registerOperations(round.run, [{
            operationId: id, timeoutMs: this.options.limits.toolTimeoutMs,
          }])[0]!;
          previous.schedulerOperation = handle.operation;
          this.options.store.putOperation(previous);
        }
        if (previous.state === 'registered' || previous.state === 'running') this.launch(previous);
        if (previous.state === 'succeeded' || previous.state === 'failed') this.deliver(previous);
        if (previous.state === 'unknown') { this.options.onUnknown(previous.agentId); this.deliver(previous); }
        continue;
      }
      const agent = this.options.agent(round.run.agentId);
      let effect: ExecutionOperation['effect'] = 'read_only';
      const operation: ExecutionOperation = {
        id, agentId: agent.control.agentId, batchId: round.idempotencyKey, target: context.cursor(),
        toolName: call.name, arguments: call.arguments, state: 'registered', effect,
        schedulerOperation: null, result: null,
      };
      let rejection: string | undefined;
      try {
        const tool = this.options.tools.get(call.name);
        effect = tool.effect;
        operation.effect = effect;
        if (!agent.control.skills.includes(call.name)) rejection = '工具对当前角色不可见。';
        else if (Object.values(call.arguments).some((value) => typeof value === 'string' &&
          value.startsWith('workspace://') && value.split('/').includes('..'))) rejection = '工作区路径不能包含上级目录。';
        else {
          const validation = tool.validateInput(call.arguments);
          if (!validation.valid) rejection = '工具参数校验失败。';
          const requirements = this.requirements(operation);
          if (!requirements.length || requirements.some((requirement) => !agent.ceiling.some((allowed) =>
            allowed.capability === requirement.capability && scopeContains(allowed.scope, requirement.scope)))) {
            rejection = '操作超出宿主授予的权限范围。';
          } else if (!rejection && !this.#manager.check(agent.grants, requirements, Date.now(), id).allowed) {
            operation.state = 'approval';
          }
        }
      } catch { rejection = '工具未注册或参数无效。'; }
      if (rejection) {
        operation.state = 'failed';
        operation.result = { error: 'permission_or_input_denied', message: rejection };
        this.options.onFault(operation.agentId, 'permission', rejection);
      }
      this.options.store.putOperation(operation);
      // 持久记录先于调度登记和实际副作用；崩溃时可用原 ID 重新对账。
      const handle = this.options.scheduler.registerOperations(round.run, [{
        operationId: id, timeoutMs: this.options.limits.toolTimeoutMs,
      }])[0]!;
      operation.schedulerOperation = handle.operation;
      this.options.store.putOperation(operation);
      if (rejection) this.deliver(operation);
      else if (operation.state !== 'approval') this.launch(operation);
    }
  }

  approvals(agentId: number): RuntimeApproval[] {
    return this.options.store.operations(agentId).filter((operation) =>
      operation.state === 'approval' || operation.state === 'unknown').map((operation) => ({
      operationId: operation.id, agentId, toolName: operation.toolName, arguments: operation.arguments,
      requirements: this.requirements(operation), state: operation.state as 'approval' | 'unknown',
    }));
  }

  approve(id: string, allowed: boolean): void {
    const operation = this.options.store.operation(id);
    if (!operation || operation.state !== 'approval') throw new Error('没有待处理的审批操作。');
    if (!this.#pending(operation)) {
      this.#expire(operation);
      throw new Error('审批已经超时或取消，不能执行。');
    }
    if (this.options.agent(operation.agentId).status !== 'active') throw new Error('Agent 已暂停或取消。');
    if (!allowed) {
      operation.state = 'failed'; operation.result = { error: 'approval_denied' };
      this.options.store.putOperation(operation); this.deliver(operation); return;
    }
    const agent = this.options.agent(operation.agentId);
    const grants = this.#manager.grantByHuman(`agent:${operation.agentId}`, id, this.requirements(operation), Date.now())
      .map((grant): RuntimeCapabilityGrant => ({ ...grant, source: { type: 'human', approvalRequestId: id },
        delegable: false, remainingUses: 0, consumedBy: id }));
    this.options.update({ ...agent, grants: [...agent.grants, ...grants] });
    operation.state = 'registered';
    this.options.store.putOperation(operation);
    this.launch(operation);
  }

  reconcile(id: string, resolution: { outcome: 'succeeded' | 'failed'; result: JsonValue }): void {
    const operation = this.options.store.operation(id);
    if (!operation || operation.state !== 'unknown') throw new Error('操作不是结果未知状态。');
    if (this.#mutationWork.has(id)) throw new Error('底层副作用仍在执行，须等待实际停止后再对账。');
    jsonSchema.parse(resolution.result);
    operation.state = resolution.outcome; operation.result = resolution.result;
    this.options.store.putReconciliation(operation);
    this.#deliverReconciliation(operation);
    this.deliver(operation);
  }

  isolateRestoredOperations(): void {
    for (const operation of this.options.store.allOperations()) {
      if (operation.state !== 'running') continue;
      operation.state = operation.effect === 'read_only' ? 'registered' : 'unknown';
      this.options.store.putOperation(operation);
    }
  }

  async recover(agentId: number): Promise<void> {
    for (const operation of this.options.store.operations(agentId)) {
      if (operation.state === 'registered' && operation.schedulerOperation) this.launch(operation);
      if (operation.state === 'succeeded' || operation.state === 'failed') this.deliver(operation);
      if (operation.state === 'unknown') { this.options.onUnknown(agentId); this.deliver(operation); }
      this.#deliverReconciliation(operation);
    }
  }
  notifyReconciliations(agentId: number): void {
    for (const operation of this.options.store.operations(agentId)) this.#deliverReconciliation(operation);
  }

  entries(resultRef: string): readonly ContextEntry[] {
    const operation = this.options.store.metadata<ExecutionOperation>(`result:${resultRef}`);
    if (!operation) throw new RuntimeFault('tool', '工具结果记录缺失。');
    const artifactRef = this.options.store.artifact(operation.agentId, operation.result, `artifact://${resultRef}`);
    // 失败写入的完整参数独立保留，压缩后也能找回已生成正文，避免凭摘要重新生成。
    const inputArtifactRef = operation.state === 'failed' && operation.effect !== 'read_only'
      ? this.options.store.artifact(operation.agentId, operation.arguments, `artifact://${resultRef}/input`)
      : undefined;
    const attachments = inputArtifactRef ? [artifactRef, inputArtifactRef] : [artifactRef];
    const text = JSON.stringify(operation.result);
    const previewCharacters = Math.min(3000, this.options.inlineCharacters);
    const createdAt = operation.schedulerOperation?.startedAt ?? 0;
    return [
      { id: `${resultRef}:result`, createdAt, kind: 'tool_result',
        callId: operation.id, toolName: operation.toolName,
        output: text.length > this.options.inlineCharacters ? { artifactRef, ...(inputArtifactRef ? { inputArtifactRef } : {}),
          preview: text.slice(0, previewCharacters), truncated: true, totalCharacters: text.length, nextOffset: previewCharacters }
          : { artifactRef, ...(inputArtifactRef ? { inputArtifactRef } : {}), result: operation.result } },
      { id: `${resultRef}:source`, createdAt, kind: 'message', role: 'assistant',
        content: `工具 ${operation.toolName} 结果状态：${operation.state}${inputArtifactRef ? '；inputArtifactRef可分页读取原调用参数，不必从摘要重新生成。' : ''}`,
        attachmentRefs: attachments },
    ];
  }

  nativeResult(operation: ExecutionOperation): JsonValue | undefined {
    if (operation.state !== 'succeeded' && operation.state !== 'failed') return undefined;
    const entry = this.entries(this.#snapshot(operation))[0];
    return entry?.kind === 'tool_result' ? { state: operation.state, ...entry.output as object } : undefined;
  }

  async settle(): Promise<void> { await Promise.all([...this.#active.values()]); }
  resume(agentId: number): void {
    for (const operation of this.options.store.operations(agentId)) {
      if (operation.state === 'registered') this.launch(operation);
    }
  }
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#shutdown.abort(new Error('服务停机。'));
    for (const controller of this.#controllers.values()) controller.abort(new Error('服务停机。'));
    await this.settle();
  }

  launch(operation: ExecutionOperation): void {
    if (this.#stopping || this.#active.has(operation.id)) return;
    const workspace = this.options.workspace(this.options.agent(operation.agentId));
    const previous = operation.effect === 'read_only' ? Promise.resolve() : this.#mutationTails.get(workspace) ?? Promise.resolve();
    const promise = abortable(() => previous, this.#shutdown.signal).then(() => {
      if (!this.#stopping) return this.#execute(operation);
    }).catch(() => {
      if (!this.#stopping) this.options.onFatal();
    }).finally(() => {
      this.#active.delete(operation.id); this.#controllers.delete(operation.id);
    });
    this.#active.set(operation.id, promise);
    if (operation.effect !== 'read_only') this.#mutationTails.set(workspace, promise.then(async () => {
      const executing = this.#mutationWork.get(operation.id);
      if (executing) await executing.catch(() => {});
      this.#mutationWork.delete(operation.id);
    }));
  }

  async #execute(operation: ExecutionOperation): Promise<void> {
    const handle = this.#pending(operation);
    if (!handle) { this.#expire(operation); return; }
    if (this.options.agent(operation.agentId).status !== 'active') return;
    const controller = new AbortController();
    this.#controllers.set(operation.id, controller);
    const signal = AbortSignal.any([handle.signal, controller.signal]);
    const tool = this.options.tools.get(operation.toolName);
    const agent = this.options.agent(operation.agentId);
    if (tool.effect !== operation.effect || !agent.control.skills.includes(operation.toolName) ||
        !this.#manager.check(agent.grants, this.requirements(operation), Date.now(), operation.id).allowed) {
      operation.state = 'failed'; operation.result = { error: 'permission_denied' };
      this.options.store.putOperation(operation); this.deliver(operation); return;
    }
    operation.state = 'running';
    this.options.store.putOperation(operation);
    const workspace = this.options.workspace(agent);
    if (operation.effect !== 'read_only' && this.options.store.hasUnknownMutation(workspace,
      (id) => this.options.workspace(this.options.agent(id)))) {
      operation.state = 'failed';
      operation.result = { error: 'workspace_unreconciled', message: '同一工作区有未确认副作用，请先对账。' };
      this.options.store.putOperation(operation); this.deliver(operation); return;
    }
    const executing = Promise.resolve().then(() => tool.execute(operation.arguments, {
      taskId: `agent:${operation.agentId}`, signal,
      idempotencyKey: operation.id, workspaceRoot: workspace,
    }));
    if (operation.effect !== 'read_only') {
      // 宿主超时结束等待不表示底层已停止；写锁须覆盖真实执行生命周期。
      this.#mutationWork.set(operation.id, executing);
    }
    try {
      const result = await abortable(() => executing, signal);
      jsonSchema.parse(result);
      operation.result = result;
      operation.state = signal.aborted && operation.effect !== 'read_only' ? 'unknown' : 'succeeded';
    } catch (error) {
      // 只信任工具在执行副作用前的显式证明；取消或普通执行异常仍保留未知状态。
      const precondition = !signal.aborted && error instanceof ToolPreconditionError;
      operation.state = operation.effect === 'read_only' || precondition ? 'failed' : 'unknown';
      operation.result = precondition
        ? { error: error.code, message: error.message }
        : error instanceof ToolExecutionError ? { error: error.code, message: error.message, detail: error.result }
        : { error: 'tool_failed', message: '工具执行失败；副作用结果需对账。' };
      this.options.onFault(operation.agentId, 'tool', precondition ? error.message : '工具执行失败。');
    }
    this.options.store.putOperation(operation);
    if (operation.state === 'unknown') this.options.onUnknown(operation.agentId);
    this.deliver(operation);
  }

  deliver(operation: ExecutionOperation): void {
    if (!operation.schedulerOperation) return;
    this.options.scheduler.completeOperation(operation.schedulerOperation, {
      type: 'succeeded', resultRef: this.#snapshot(operation),
    });
  }

  resolveWait(operation: ExecutionOperation, result: AsyncOperationResult): string {
    const key = `wait-result:${result.operation.operationId}:${result.completedAt}`;
    const previous = this.options.store.metadata<string>(key);
    if (previous) return previous;
    if (result.outcome.type === 'timed_out' || result.outcome.type === 'cancelled') {
      if (operation.state === 'running') {
        operation.state = operation.effect === 'read_only' ? 'failed' : 'unknown';
        operation.result = { error: result.outcome.type };
        this.options.store.putOperation(operation);
        if (operation.state === 'unknown') this.options.onUnknown(operation.agentId);
      } else if (operation.state === 'registered' || operation.state === 'approval') this.#expire(operation);
    }
    const ref = result.outcome.type === 'succeeded' ? result.outcome.resultRef : this.#snapshot(operation);
    this.options.store.putMetadata(key, ref);
    return ref;
  }

  #pending(operation: ExecutionOperation) {
    const handle = operation.schedulerOperation && this.options.scheduler.operationHandle(operation.schedulerOperation);
    return handle && !handle.signal.aborted && handle.operation.deadline > Date.now() ? handle : undefined;
  }

  #expire(operation: ExecutionOperation): void {
    if (operation.state !== 'registered' && operation.state !== 'approval') return;
    operation.state = 'failed'; operation.result = { error: 'operation_expired_or_cancelled' };
    this.options.store.putOperation(operation); this.deliver(operation);
  }

  #snapshot(operation: ExecutionOperation): string {
    const version = createHash('sha256').update(JSON.stringify([operation.state, operation.result])).digest('hex');
    const ref = `operation/${operation.id}/${version}`;
    this.options.store.putMetadata(`result:${ref}`, operation as unknown as JsonValue);
    return ref;
  }

  #deliverReconciliation(operation: ExecutionOperation): void {
    if (!this.options.store.reconciliationPending(operation.id)) return;
    if (this.options.onReconciled(operation, this.#snapshot(operation))) {
      this.options.store.acknowledgeReconciliation(operation.id);
    }
  }
}
