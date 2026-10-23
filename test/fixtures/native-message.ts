import { randomUUID } from 'node:crypto';
import type { ModelAssistantMessage } from '../../src/model-requester/index.js';
import type { JsonObject } from '../../src/types/json.js';

/** 场景仍以可读动作描述编排，模拟模型只返回原生具名调用。 */
export function nativeMessage(value: object): ModelAssistantMessage {
  const action = JSON.parse(JSON.stringify(value)) as JsonObject;
  const { kind, ...args } = action;
  if (kind === 'tools') return { role: 'assistant', content: '', toolCalls:
    (action.calls as { name: string; arguments: JsonObject }[]).map((call) => ({ id: randomUUID(), ...call })) };
  if (kind === 'context') {
    const { type, ...parameters } = action.decision as JsonObject;
    return { role: 'assistant', content: '', toolCalls: [{ id: randomUUID(), name: `context_${type}`, arguments: parameters }] };
  }
  const name = kind === undefined ? 'overview' in action ? 'submit_conversation_summary' : 'submit_summary'
    : kind === 'send_message' ? 'message_send'
    : typeof kind === 'string' && (kind.startsWith('conversation_') || kind.startsWith('contact_note_')) ? kind : `agent_${kind}`;
  return { role: 'assistant', content: '', toolCalls: [{ id: randomUUID(), name, arguments: args }] };
}
