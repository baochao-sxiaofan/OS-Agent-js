import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAgentRuntime, type AgentRuntime } from '../../src/agent-runtime/index.js';
import { summary } from '../agent-context/helpers.js';
import type { ModelCompletionRequest } from '../../src/model-requester/index.js';
import { nativeMessage } from '../fixtures/native-message.js';

it('可信宿主反馈进入当前子层，幂等投递且不消费普通消息或伪造聊天', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-feedback-'));
  let runtime: AgentRuntime;
  let calls = 0;
  let sawFeedback = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requests: ModelCompletionRequest[] = [];
  runtime = createAgentRuntime({
    database: join(directory, 'runtime.sqlite'), workspaces: { work: directory },
    requester: { provider: 'minimax', model: 'test', async request(request) {
      requests.push(request);
      const payload = JSON.parse(String(request.messages[1]?.content)) as {
        purpose?: string; sourceRef?: string; context?: { frames: { level: number }[] };
      };
      let action: object;
      if (payload.purpose) action = summary(payload.sourceRef!);
      else if (calls++ === 0) action = { kind: 'context', decision: { type: 'plan', objectives: ['当前任务'] } };
      else if (calls === 2) action = { kind: 'context', decision: { type: 'advance' } };
      else if (calls === 3) {
        await gate;
        action = { kind: 'context', decision: { type: 'continue' } };
      } else if (payload.context?.frames.at(-1)?.level === 2) {
        sawFeedback = String(request.messages[1]?.content).includes('现在检查已生成文件');
        action = { kind: 'context', decision: { type: 'complete' } };
      } else action = { kind: 'context', decision: { type: 'finish_turn' } };
      return { provider: 'minimax', model: 'test', finishReason: 'stop',
        message: nativeMessage(action),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    } },
  });
  try {
    await runtime.initialize();
    await runtime.createAgent({ ownerId: 'owner', workspaceId: 'work', character: 'coordinator',
      objective: '长期任务', capabilities: [] });
    runtime.start();
    const until = Date.now() + 2000;
    while (calls < 3) {
      if (Date.now() > until) throw new Error('未进入子层。');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(() => runtime.provideFeedback(1, 'other', '越权', 'bad')).toThrow('宿主');
    runtime.provideFeedback(1, 'owner', '现在检查已生成文件', 'correction');
    runtime.provideFeedback(1, 'owner', '现在检查已生成文件', 'correction');
    expect(() => runtime.provideFeedback(1, 'owner', '不同正文', 'correction')).toThrow('幂等键');
    release();
    while (runtime.inspect(1, 'owner').control.state !== 'SLEEPING') {
      if (Date.now() > until || runtime.inspect(1, 'owner').status === 'paused') {
        throw new Error(`反馈未处理：${JSON.stringify(runtime.interrupts(1, 'owner'))}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(sawFeedback).toBe(true);
    expect(requests.filter((request) => String(request.messages[1]?.content).includes('宿主现场反馈：现在检查已生成文件'))
      .every((request) => String(request.messages[1]?.content).split('宿主现场反馈：现在检查已生成文件').length === 2)).toBe(true);
    expect(runtime.messages(1, 'owner')).toEqual([]);
    expect(runtime.conversationMailboxes(runtime.directConversation(1, 'owner').id, 'owner')[0]?.processedSequence).toBe(0);
    expect(runtime.interrupts(1, 'owner')).toEqual([]);
  } finally {
    release();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
