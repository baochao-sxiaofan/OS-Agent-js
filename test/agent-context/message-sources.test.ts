import { expect, it } from 'vitest';
import { createContextView } from '../../src/agent-context/index.js';
import { apply, setupContext, summary } from './helpers.js';

it('已投递的会话消息可作为总结证据，未投递的其他消息仍被拒绝', () => {
  const { context } = setupContext();
  const messageId = 'host-message-id';
  context.receive([{ key: 'chat-batch', entries: [{
    id: messageId, createdAt: 1, kind: 'event', name: 'conversation_message',
    data: { content: '请统一比赛间隔为小时。' },
  }] }]);
  context.prepare();
  expect(createContextView(context.snapshot()).frames[0]?.allowedSourceRefs).toContain(messageId);
  apply(context, { type: 'idle' });
  const pending = context.beginSummaryAttempt();
  const result = { ...summary(pending.sourceRef), observations: [
    { kind: 'fact' as const, statement: '用户要求统一为小时', sourceRefs: [messageId] },
  ] };
  expect(() => context.commitSummary('wrong-source', pending.id, {
    ...result, observations: [{ ...result.observations[0]!, sourceRefs: ['undelivered-other-message'] }],
  })).toThrow('封存来源');
  context.commitSummary('received-source', pending.id, result);
  expect(context.snapshot().level1.memory.summary?.observations[0]?.sourceRefs).toEqual([messageId]);
});
