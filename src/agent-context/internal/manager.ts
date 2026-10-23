import { randomUUID } from 'node:crypto';
import type { AgentContext, ContextBudget, ContextEntry } from '../api.js';
import {
  type AgentContextManager, type ContextCheckpoint, type ContextCursor, type ContextDecision,
  type ContextDelivery, type ContextManagerOptions, type ContextReceipt, type ContextStore,
} from '../management.js';
import { validateCheckpoint, validateDelivery, validatePolicy } from './checkpoint.js';
import { active, archive, assertCursor, emptyMemory, frames, replaceFrame, type Mutation } from './frames.js';
import { deliveryRef, drainInbox, sameDelivery } from './inbox.js';
import { validateRecord } from './records.js';
import { integrateSummary } from './summaries.js';
import { applyDecision } from './tasks.js';
import { integer, requireContext, strings, text, validateBudget } from './validation.js';

export function createAgentContextManager(options: ContextManagerOptions): AgentContextManager {
  validatePolicy(options.policy);
  strings(options.instructions);
  text(options.objective);
  text(options.key);
  const id = options.createId ?? randomUUID;
  const initial: ContextCheckpoint = {
    schemaVersion: 1, revision: 0, runnable: !options.initiallyIdle, pendingSummary: null, inbox: [],
    policy: options.policy,
    context: { schemaVersion: 1, level2: null, level3: null, level1: {
      id: id(), level: 1, instructions: options.instructions,
      currentTask: { id: id(), objective: options.objective },
      taskChain: { target: 2, revision: 0, phase: 'PLANNING', currentTaskId: null, tasks: [] },
      memory: emptyMemory(), budget: options.policy.budgets[1],
    } },
  };
  validateCheckpoint(initial);
  options.store.commit(options.key, null, structuredClone(initial), [], []);
  return new Manager(options.key, options.store, initial, id);
}

export function restoreAgentContextManager(options: {
  key: string; store: ContextStore; createId?: () => string;
}): AgentContextManager {
  text(options.key);
  const checkpoint = options.store.load(options.key);
  requireContext(checkpoint, '没有可恢复的上下文检查点。');
  validateCheckpoint(checkpoint);
  if (checkpoint.pendingSummary) {
    const source = options.store.read(options.key, checkpoint.pendingSummary.sourceRef);
    validateRecord(source);
    requireContext(source?.kind === 'frame' &&
      JSON.stringify(source.context) === JSON.stringify(checkpoint.context), '总结来源缺失或与封存场景不一致。');
  }
  return new Manager(options.key, options.store, checkpoint, options.createId ?? randomUUID);
}

class Manager implements AgentContextManager {
  #state: ContextCheckpoint;
  constructor(readonly key: string, readonly store: ContextStore,
    state: ContextCheckpoint, readonly id: () => string) {
    this.#state = structuredClone(state);
  }

  snapshot(): AgentContext { return structuredClone(this.#state.context); }
  checkpoint(): ContextCheckpoint { return structuredClone(this.#state); }
  cursor(): ContextCursor {
    const frame = active(this.#state.context);
    return { frameId: frame.id, planRevision: frame.taskChain.revision };
  }
  needsRun(): boolean { return this.#state.runnable || this.#state.pendingSummary !== null; }
  read(ref: string) {
    const record = this.store.read(this.key, ref);
    if (record !== undefined) validateRecord(record);
    return record === undefined ? undefined : structuredClone(record);
  }
  roundReceipt(roundKey: string): ContextReceipt | undefined {
    return this.store.receipt(this.key, `round:${roundKey}`);
  }
  summaryReceipt(roundKey: string): ContextReceipt | undefined {
    return this.store.receipt(this.key, `round-summary:${roundKey}`);
  }

  receive(deliveries: readonly ContextDelivery[]): void {
    const fresh = this.#freshDeliveries(deliveries);
    requireContext(this.#state.inbox.length + fresh.length <= this.#state.policy.maxInbox,
      '收件箱已满，来源系统需要保留并稍后重投。', 'budget_exceeded');
    this.#receive(fresh);
  }

  receiveAvailable(deliveries: readonly ContextDelivery[]): boolean {
    const fresh = this.#freshDeliveries(deliveries);
    const available = this.#state.policy.maxInbox - this.#state.inbox.length;
    this.#receive(fresh.slice(0, available));
    return fresh.length <= available;
  }

  #freshDeliveries(deliveries: readonly ContextDelivery[]): ContextDelivery[] {
    const fresh: ContextDelivery[] = [];
    for (const delivery of deliveries) {
      validateDelivery(delivery);
      requireContext(Buffer.byteLength(JSON.stringify(delivery)) <= this.#state.policy.maxDeliveryBytes,
        '单次输入过大，请保存正文并投递引用。', 'budget_exceeded');
      const previous = this.read(deliveryRef(delivery.key));
      const duplicate = fresh.find((item) => item.key === delivery.key);
      if (previous || duplicate) {
        requireContext(duplicate ? sameDelivery(duplicate, delivery)
          : previous?.kind === 'history' && sameDelivery(previous.delivery, delivery), '投递键已绑定其他输入。');
      } else fresh.push(delivery);
    }
    return fresh;
  }

  #receive(fresh: readonly ContextDelivery[]): void {
    if (!fresh.length) return;
    this.#mutate((mutation) => {
      mutation.state.inbox = [...mutation.state.inbox, ...fresh];
      mutation.state.runnable = true;
      for (const delivery of fresh) mutation.writes.push({
        ref: deliveryRef(delivery.key), record: { kind: 'history', delivery },
      });
    });
  }

  prepare(): ContextCheckpoint {
    if (!this.#state.pendingSummary) this.#mutate(drainInbox);
    return this.checkpoint();
  }

  apply(roundKey: string, cursor: ContextCursor, decision: ContextDecision,
    entries: readonly ContextEntry[] = []): void {
    text(roundKey);
    if (this.roundReceipt(roundKey)) return;
    this.#mutate((mutation) => {
      requireContext(!mutation.state.pendingSummary, '总结完成前不能执行普通业务轮。', 'invalid_state');
      assertCursor(active(mutation.state.context), cursor);
      applyDecision(mutation, decision, entries);
      // 原始业务记录始终留在外部历史，后续压缩不会删除它们。
      archive(mutation);
    }, [`round:${roundKey}`]);
  }

  beginSummaryAttempt() {
    this.#mutate(({ state }) => {
      const pending = state.pendingSummary;
      requireContext(pending, '当前没有待总结请求。', 'invalid_state');
      requireContext(pending.attempts < state.policy.maxSummaryAttempts,
        `总结尝试已达 ${state.policy.maxSummaryAttempts} 次上限。最近原因：${pending.lastError ?? '未记录'}。请调整设置后由宿主继续，现场已保留。`,
        'retry_exhausted');
      state.pendingSummary = { ...pending, attempts: pending.attempts + 1 };
    });
    return this.checkpoint().pendingSummary!;
  }

  configureBudget(budget: ContextBudget): void {
    validateBudget(budget);
    if ([1, 2, 3].every((level) => JSON.stringify(this.#state.policy.budgets[level as 1 | 2 | 3]) === JSON.stringify(budget))) return;
    this.#mutate((mutation) => {
      const { state } = mutation;
      state.policy = { ...state.policy, budgets: { 1: budget, 2: budget, 3: budget } };
      for (const frame of frames(state.context)) state.context = replaceFrame(state.context, { ...frame, budget });
      // 已发布的原文快照保持不变；新的预算产生新的封存引用以满足恢复一致性校验。
      if (state.pendingSummary) {
        const sourceRef = archive(mutation);
        state.pendingSummary = { ...state.pendingSummary, sourceRef,
          allowedRefs: [...state.pendingSummary.allowedRefs, sourceRef] };
      }
    });
  }

  retrySummary(): void {
    requireContext(this.#state.pendingSummary, '当前没有待总结请求。', 'invalid_state');
    this.#mutate(({ state }) => {
      state.pendingSummary = { ...state.pendingSummary!, attempts: 0 };
    });
  }

  failSummary(id: string, message: string): void {
    this.#mutate(({ state }) => {
      requireContext(state.pendingSummary?.id === id, '总结凭据已失效。', 'stale_context');
      state.pendingSummary = { ...state.pendingSummary, lastError: message.slice(0, 1000) || '总结请求失败。' };
    });
  }

  commitSummaryPhase(roundKey: string, id: string, summary: Parameters<typeof integrateSummary>[2]): void {
    text(roundKey);
    text(id);
    if (this.store.receipt(this.key, `summary:${id}`)) return;
    // 阶段回执与总结同事务落盘；不能据此确认仍在可靠批次中的输入。
    this.#mutate((mutation) => integrateSummary(mutation, id, structuredClone(summary)), [
      `summary:${id}`, ...(this.summaryReceipt(roundKey) ? [] : [`round-summary:${roundKey}`]),
    ]);
  }

  acknowledgeRound(roundKey: string): void {
    text(roundKey);
    if (this.roundReceipt(roundKey)) return;
    requireContext(this.summaryReceipt(roundKey), '批次尚未提交总结阶段。', 'invalid_state');
    this.#mutate(() => {}, [`round:${roundKey}`]);
  }

  commitSummary(roundKey: string, id: string, summary: Parameters<typeof integrateSummary>[2]): void {
    text(roundKey);
    if (this.roundReceipt(roundKey)) return;
    this.#mutate((mutation) => integrateSummary(mutation, id, structuredClone(summary)), [`round:${roundKey}`]);
  }

  #mutate(change: (mutation: Mutation) => void, receiptKeys: readonly string[] = []): void {
    const mutation: Mutation = { state: structuredClone(this.#state), writes: [], id: this.id };
    change(mutation);
    mutation.state.revision += 1;
    integer(mutation.state.revision);
    validateCheckpoint(mutation.state);
    const receipts: ContextReceipt[] = receiptKeys.map((key) => ({
      key, intent: mutation.state.runnable ? 'continue' : 'idle',
    }));
    this.store.commit(this.key, this.#state.revision, structuredClone(mutation.state),
      structuredClone(mutation.writes), receipts);
    // 持久化成功才发布内存状态，失败时调用方仍看到完整旧场景。
    this.#state = structuredClone(mutation.state);
  }
}
