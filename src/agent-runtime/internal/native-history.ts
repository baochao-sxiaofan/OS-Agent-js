import { createHash } from 'node:crypto';
import { estimateContextTokens } from '../../agent-context/index.js';
import type { ModelCompletionRequest, ModelMessage } from '../../model-requester/index.js';
import type { JsonValue } from '../../types/json.js';
import { readRuntimeRequest, requestChanges } from '../request-view.js';
import type { RuntimeStore } from './store.js';

/** Retain complete persisted requests, then append the real response, receipts and current delta. */
export function withNativeHistory(options: {
  store: RuntimeStore; key: string; scope: string; request: ModelCompletionRequest; maxInput: number;
  receipt: (key: string) => boolean;
  result: (key: string, index: number) => JsonValue | undefined;
}): ModelCompletionRequest {
  const { store, key, request } = options;
  const marker = `native-history:v3:${createHash('sha256').update(options.scope).digest('hex')}`;
  const rounds = store.metadata<string[]>(marker) ?? [];
  const boundary = request.messages.findIndex((message) => message.role === 'user' &&
    typeof message.content === 'string' && message.content.startsWith('{"kind":"runtime_update"'));
  let selected = request;
  for (const previousKey of rounds.filter((id) => id !== key).reverse()) {
    if (!options.receipt(previousKey)) continue;
    const previous = store.request(previousKey);
    const completion = store.completion(previousKey);
    if (!previous || !completion?.message.toolCalls.length) continue;
    // A role/configuration, layer summary or plan change starts a new stable prefix.
    if (boundary < 0 || JSON.stringify(previous.tools) !== JSON.stringify(request.tools) ||
        JSON.stringify(previous.messages.slice(0, boundary)) !== JSON.stringify(request.messages.slice(0, boundary))) break;
    const results = completion.message.toolCalls.map((_, index) => options.result(previousKey, index));
    if (results.some((result) => result === undefined)) continue;
    const current = readRuntimeRequest(request);
    const before = readRuntimeRequest(previous);
    const messages: ModelMessage[] = [...previous.messages, completion.message,
      ...completion.message.toolCalls.map((call, index): ModelMessage => ({
        role: 'tool', callId: call.id, content: results[index]!,
      })),
      { role: 'user', content: JSON.stringify({ kind: 'runtime_update', changes: requestChanges(before, current) }) },
      ...request.messages.slice(boundary + 1),
    ];
    const candidate = { ...request, messages };
    // Rebase at a capacity boundary instead of evicting the beginning on every round.
    if (estimateContextTokens(candidate) + 64 <= options.maxInput) selected = candidate;
    break;
  }
  store.putMetadata(marker, [...rounds.filter((id) => id !== key), key].slice(-16));
  return selected;
}
