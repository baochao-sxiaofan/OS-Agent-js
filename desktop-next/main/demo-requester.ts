import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import type { ModelCompletion, ModelCompletionRequest, ModelRequester } from '../../src/model-requester/index.js';

const receivedSchema = z.object({ id: z.string(), content: z.string(), mentions: z.array(z.number()),
  sender: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('user'), id: z.string() }),
    z.object({ kind: z.literal('agent'), id: z.number() }),
  ]) });
const viewSchema = z.object({
  self: z.object({ id: z.number(), name: z.string() }),
  conversation: z.object({ id: z.string(), kind: z.string() }).nullable(),
  currentBatch: z.object({ messageIds: z.array(z.string()) }).nullable(),
  destinations: z.array(z.object({ id: z.string(), title: z.string() })),
  context: z.object({ frames: z.array(z.object({
  objective: z.string(),
  memory: z.object({ recentEntries: z.array(z.object({
    kind: z.string(), name: z.string().optional(), data: z.unknown().optional(),
  }).passthrough()) }).passthrough(),
}).passthrough()) }).passthrough() }).passthrough();

/** 离线演示走显式发件与静默处理；业务总结仍复用独立总结轮。 */
export class DemoRequester implements ModelRequester {
  readonly provider = 'minimax';
  readonly model = 'local-demo';
  async request(request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    await setTimeout(240, undefined, { signal });
    const summaryRound = request.tools?.some((tool) => tool.name === 'submit_summary');
    const payload: unknown = JSON.parse(String(request.messages[1]?.content));
    let content: string;
    if (request.tools?.some((tool) => tool.name === 'submit_conversation_summary')) {
      const input = z.object({ conversationId: z.string(),
        messages: z.array(z.object({ id: z.string(), content: z.string() })).min(1),
      }).parse(payload);
      const recent = input.messages.slice(-3);
      content = JSON.stringify({
        overview: recent.map((message) => message.content.slice(0, 70)).join('；'),
        unresolved: [], quotations: recent.slice(-1).map((message) => ({
          text: message.content.slice(0, 120), sourceRef: { conversationId: input.conversationId, messageId: message.id },
        })),
        sourceRefs: recent.map((message) => ({ conversationId: input.conversationId, messageId: message.id })),
      });
    } else if (summaryRound) {
      const { sourceRef } = z.object({ sourceRef: z.string() }).passthrough().parse(payload);
      content = JSON.stringify({
        outcome: '完成本轮本地演示，保留对话并等待下一条消息。',
        observations: [], decisions: [], artifactRefs: [], unresolved: [],
        nextResponsibilities: [], lessonCandidates: [], sourceRefs: [sourceRef],
      });
    } else {
      const view = viewSchema.parse(payload);
      const frame = view.context.frames[0]!;
      const received = frame.memory.recentEntries
        .filter((entry) => entry.kind === 'event' && entry.name === 'conversation_message')
        .map((entry) => receivedSchema.parse(entry.data))
        .filter((message) => view.currentBatch?.messageIds.includes(message.id) &&
          !(message.sender.kind === 'agent' && message.sender.id === view.self.id));
      const latest = received.at(-1);
      const groupSilent = view.conversation?.kind === 'group' && !received.some((message) => message.mentions.includes(view.self.id));
      const silent = !latest || /不用回复|无需回复|保持沉默/u.test(latest.content) || groupSilent ||
        latest.sender.kind === 'agent' && !/[?？]/u.test(latest.content);
      const peer = latest?.sender.kind === 'user' && /聊聊|协作/u.test(latest.content)
        ? view.destinations.find((item) => item.id.startsWith('peer:') && latest.content.includes(item.title)) : undefined;
      content = JSON.stringify(silent || !view.conversation ? { kind: 'context', decision: { type: 'finish_turn' } } : {
        kind: 'send_message', conversationId: peer?.id ?? view.conversation.id, finish: true,
        ...(peer ? {} : { replyTo: latest.id }),
        content: peer ? `我是${view.self.name}，你负责什么？（本地演示）` : latest.sender.kind === 'agent'
          ? `我是${view.self.name}，职责是${frame.objective}。（本地演示）`
          : [`收到${received.length > 1 ? `这 ${received.length} 条消息` : ''}：「${latest.content.slice(0, 180)}」。`,
            `我的长期职责是：${frame.objective}`,
            '这是本地演示回复，未调用真实模型，也未执行文件操作。',
          ].join('\n\n'),
      });
    }
    const value = z.record(z.unknown()).parse(JSON.parse(content));
    let name: string;
    let args: object;
    if (summaryRound) { name = 'submit_summary'; args = value; }
    else if (request.tools?.some((tool) => tool.name === 'submit_conversation_summary')) {
      name = 'submit_conversation_summary'; args = value;
    } else if (value.kind === 'context') { name = 'context_finish_turn'; args = {}; }
    else { name = 'message_send'; const { kind: _kind, ...parameters } = value; args = parameters; }
    return { provider: this.provider, model: this.model, finishReason: 'tool_calls',
      message: { role: 'assistant', content: '', toolCalls: [{ id: 'demo-call', name,
        arguments: args as import('../../src/types/json.js').JsonObject }] },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }
}
