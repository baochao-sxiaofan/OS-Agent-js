import type { ModelCompletion, ModelCompletionRequest, ModelToolCall } from '../../model-requester/index.js';
import { actionSchema, jsonSchema } from './schema.js';

/** 只在恢复升级前已落盘的回复时转换；新模型响应永远不经过文本动作解析。 */
export function migrateSavedCompletion(saved: ModelCompletion, request?: ModelCompletionRequest): ModelCompletion {
  if (saved.message.toolCalls.length === 1 && saved.message.toolCalls[0]?.name === 'agent_action' &&
      ['stop', 'tool_calls'].includes(saved.finishReason)) {
    return migrateSavedCompletion({ ...saved, finishReason: 'stop', message: {
      ...saved.message, toolCalls: [], content: JSON.stringify(saved.message.toolCalls[0].arguments),
    } }, request);
  }
  if (saved.message.toolCalls.length || saved.finishReason !== 'stop') return saved;
  let value: unknown;
  try { value = JSON.parse(saved.message.content); } catch { return saved; }
  const summary = request?.tools?.find((tool) => tool.name === 'submit_summary' || tool.name === 'submit_conversation_summary');
  let calls: ModelToolCall[];
  if (summary && value && typeof value === 'object' && !Array.isArray(value)) {
    calls = [{ id: 'migrated-summary', name: summary.name, arguments: jsonSchema.parse(value) as import('../../types/json.js').JsonObject }];
  } else {
    const parsed = actionSchema.safeParse(value);
    if (!parsed.success) return saved;
    const action = parsed.data;
    if (action.kind === 'tools') calls = action.calls.map((call, index) => ({ id: `migrated-${index}`, ...call }));
    else if (action.kind === 'context') {
      const { type, ...args } = action.decision;
      calls = [{ id: 'migrated-control', name: `context_${type}`, arguments: args }];
    } else {
      const { kind, ...args } = action;
      calls = [{ id: 'migrated-control', name: kind === 'send_message' ? 'message_send'
        : kind.startsWith('conversation_') || kind.startsWith('contact_note_') ? kind : `agent_${kind}`,
      arguments: jsonSchema.parse(JSON.parse(JSON.stringify(args))) as import('../../types/json.js').JsonObject }];
    }
  }
  return { ...saved, finishReason: 'tool_calls', message: { ...saved.message, toolCalls: calls } };
}
