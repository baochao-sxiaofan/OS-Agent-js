import { AgentContextError, createContextView, type ContextDelivery } from '../agent-context/index.js';
import type { AgentRun } from '../agent-scheduler/index.js';
import type { ModelCompletionRequest } from '../model-requester/index.js';
import type { AgentRoundOptions, AgentRoundRunner } from './api.js';
import { checkRequestBudget, parseSummary, summaryRequest } from './requests.js';

export function createAgentRoundRunner(options: AgentRoundOptions): AgentRoundRunner {
  for (const value of [options.agentId, options.maxRequestTokens, options.maxOutputTokens]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new AgentContextError('invalid_input', '轮次参数必须为正安全整数。');
  }
  let busy = false;
  return {
    async execute(run: AgentRun, signal?: AbortSignal) {
      if (busy || run.agentId !== options.agentId ||
          options.scheduler.inspect(run.agentId).running?.runId !== run.runId) {
        throw new AgentContextError('invalid_state', '需要该 Agent 的有效独占运行凭据。');
      }
      busy = true;
      const { context, scheduler } = options;
      try {
        signal?.throwIfAborted();
        const receipt = context.roundReceipt(run.batch.batchId);
        if (receipt) {
          scheduler.finishRun(run, context.needsRun() ? 'continue' : receipt.intent);
          return 'replayed';
        }
        const deliveries: ContextDelivery[] = [];
        for (const event of run.batch.events) deliveries.push({
          ...await options.resolveEvent(event), key: `event:${event.eventId}`,
        });
        for (const result of run.batch.results) deliveries.push({
          ...await options.resolveResult(result), key: `operation:${result.operation.operationId}`,
        });
        let checkpoint = context.prepare();
        let inputsReceived = context.receiveAvailable(deliveries);
        checkpoint = context.prepare();
        // 可排空时按容量分段接收；封存总结或无法排空时保留尚未接收的原批次。
        while (!inputsReceived && !checkpoint.pendingSummary &&
            checkpoint.inbox.length < checkpoint.policy.maxInbox) {
          inputsReceived = context.receiveAvailable(deliveries);
          checkpoint = context.prepare();
        }
        if (inputsReceived) options.inputsReceived?.(run);
        if (inputsReceived && context.summaryReceipt(run.batch.batchId)) {
          context.acknowledgeRound(run.batch.batchId);
          scheduler.finishRun(run, context.needsRun() ? 'continue' : 'idle');
          return 'replayed';
        }
        if (!inputsReceived && !checkpoint.pendingSummary) {
          throw new AgentContextError('budget_exceeded', '收件箱无法继续接收，未接收输入仍保留在原调度批次中。');
        }
        let requested = false;
        const request = async (input: ModelCompletionRequest, beforeSend: () => void = () => {}) => {
          if (requested) throw new AgentContextError('invalid_state', '每张运行凭据只能发送一次模型请求。');
          signal?.throwIfAborted();
          const bounded = { ...input, maxOutputTokens: input.maxOutputTokens ?? options.maxOutputTokens };
          checkRequestBudget(bounded, options.maxRequestTokens, options.maxOutputTokens);
          requested = true;
          let sending = false;
          const start = () => {
            if (sending) throw new AgentContextError('invalid_state', '请求发送钩子只能调用一次。');
            signal?.throwIfAborted();
            beforeSend();
            sending = true;
          };
          if (options.dispatchRequest) return options.dispatchRequest(bounded, signal, start);
          start();
          return options.requester.request(bounded, signal);
        };
        if (checkpoint.pendingSummary) {
          let pending = checkpoint.pendingSummary;
          let attempted = false;
          try {
            const completion = await request(summaryRequest(checkpoint, options.maxOutputTokens), () => {
              // 准入后才计数，落盘成功后宿主才可发送；缓存重放不增加尝试次数。
              pending = context.beginSummaryAttempt();
              attempted = true;
            });
            signal?.throwIfAborted();
            const restored = parseSummary(completion, pending.allowedRefs, pending.sourceRef);
            context.commitSummaryPhase(run.batch.batchId, pending.id, restored);
          } catch (error) {
            if (attempted) context.failSummary(pending.id,
              options.formatError?.(error) ?? (error instanceof Error ? error.message : '总结失败。'));
            throw error;
          }
          if (inputsReceived) {
            context.acknowledgeRound(run.batch.batchId);
            scheduler.finishRun(run, context.needsRun() ? 'continue' : 'idle');
          } else {
            // 总结已提交，但批次输入未全部入箱；只释放凭据，不能消费可靠输入。
            scheduler.returnRun(run);
          }
          return 'summary';
        }
        const cursor = context.cursor();
        const result = await options.work({
          view: createContextView(checkpoint.context), idempotencyKey: run.batch.batchId, run, signal, request,
        });
        signal?.throwIfAborted();
        const pendingOperations = scheduler.inspect(run.agentId).pendingOperations.length;
        if (['complete', 'idle', 'finish_turn'].includes(result.decision.type) && pendingOperations > 0) {
          throw new AgentContextError('invalid_state', '仍有在途操作，不能结束当前目标。');
        }
        if (result.decision.type === 'wait' && pendingOperations === 0 && !options.waitSatisfied?.(run)) {
          throw new AgentContextError('invalid_state', '等待必须有在途操作提供唤醒路径。');
        }
        context.apply(run.batch.batchId, cursor, result.decision, result.entries);
        scheduler.finishRun(run, context.needsRun() ? 'continue' : 'idle');
        return 'work';
      } catch (error) {
        if (scheduler.inspect(run.agentId).running?.runId === run.runId) {
          scheduler.returnRun(run);
          options.failureReturned?.(run, error);
        }
        throw error;
      } finally {
        busy = false;
      }
    },
  };
}
