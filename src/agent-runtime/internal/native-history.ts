import { createHash } from 'node:crypto';
import { estimateContextTokens } from '../../agent-context/index.js';
import type { ModelCompletionRequest, ModelMessage } from '../../model-requester/index.js';
import type { JsonValue } from '../../types/json.js';
import type { RuntimeStore } from './store.js';

/** 原生续接记录只保存在宿主日志，不进入语义 Context 或跨会话记忆。 */
export function withNativeHistory(options: {
  store: RuntimeStore; key: string; scope: string; request: ModelCompletionRequest; maxInput: number;
  receipt: (key: string) => boolean;
  result: (key: string, index: number) => JsonValue | undefined;
}): ModelCompletionRequest {
  const { store, key, request } = options;
  const marker = `native-history:${createHash('sha256').update(options.scope).digest('hex')}`;
  const rounds = store.metadata<string[]>(marker) ?? [];
  const groups: ModelMessage[][] = [];
  let available = Math.min(12_000, Math.max(0, options.maxInput - estimateContextTokens(request) - 64));
  for (const round of rounds.filter((id) => id !== key).reverse()) {
    if (!options.receipt(round)) continue;
    const completion = store.completion(round);
    if (!completion?.message.toolCalls.length) continue;
    const results = completion.message.toolCalls.map((_, index) => options.result(round, index));
    // 未完成的一组调用整体省略，绝不发送悬空 tool 消息或伪造成功回执。
    if (results.some((result) => result === undefined)) continue;
    const group: ModelMessage[] = [completion.message, ...completion.message.toolCalls.map((call, index) => ({
      role: 'tool' as const, callId: call.id, content: results[index]!,
    }))];
    const size = estimateContextTokens(group);
    if (size > available) break;
    available -= size;
    groups.unshift(group);
  }
  store.putMetadata(marker, [...rounds.filter((id) => id !== key), key].slice(-8));
  return groups.length ? { ...request, messages: [
    ...request.messages, ...groups.flat(),
    { role: 'user', content: '以上为已执行调用及真实回执。按本次上下文快照、可用函数和错误反馈继续，不要重复执行已完成操作。' },
  ] } : request;
}
