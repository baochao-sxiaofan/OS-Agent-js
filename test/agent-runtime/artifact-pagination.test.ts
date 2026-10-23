import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAgentRuntime } from '../../src/agent-runtime/index.js';
import type { ContextEntry } from '../../src/agent-context/index.js';
import type { JsonObject } from '../../src/model-requester/index.js';
import { verifyNovelReview } from '../../examples/novel-review-guard.js';
import { nativeMessage } from '../fixtures/native-message.js';

it('只读 Agent 根据工具预览游标读到长文件尾部，不重复读取或漏页', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-pages-'));
  const path = 'workspace://current/long.md';
  const content = '山路与潮声🌊。'.repeat(1400) + '末页的关键证据。';
  const expected = JSON.stringify({ path, truncated: false, content,
    characters: content.length, chineseCharacters: 7007 });
  let reading = false;
  let artifactRef = '';
  let reconstructed = '';
  let pages = 0;
  let rejectedUnknown = false;
  const runtime = createAgentRuntime({
    database: join(directory, 'runtime.sqlite'), workspaces: { docs: directory },
    requester: { provider: 'minimax', model: 'test', async request(request) {
      const payload = JSON.parse(String(request.messages[1]?.content)) as {
        context: { frames: { memory: { recentEntries: ContextEntry[] } }[] };
        previousError: string | null;
      };
      const entries = payload.context.frames.at(-1)!.memory.recentEntries;
      let action: object;
      if (!reading) {
        reading = true;
        action = { kind: 'tools', calls: [{ name: 'file.read', arguments: { path } }] };
      } else if (!artifactRef) {
        const entry = entries.findLast((entry) => entry.kind === 'tool_result');
        if (!entry || entry.kind !== 'tool_result') throw new Error('缺少工具预览。');
        const output = entry.output as JsonObject;
        expect(output.truncated).toBe(true);
        expect(output.totalCharacters).toBe(expected.length);
        artifactRef = String(output.artifactRef);
        reconstructed = String(output.preview);
        expect(output.nextOffset).toBe(reconstructed.length);
        action = { kind: 'artifact', ref: 'r000000000000', offset: output.nextOffset };
      } else {
        if (!rejectedUnknown) {
          expect(payload.previousError).toContain('来源不属于当前动作的范围');
          rejectedUnknown = true;
        }
        const entry = entries.findLast((entry) => entry.kind === 'event' && entry.name === 'artifact_page');
        if (!entry || entry.kind !== 'event') {
          action = { kind: 'artifact', ref: artifactRef, offset: reconstructed.length };
          return { provider: 'minimax', model: 'test', finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            message: nativeMessage(action) };
        }
        const page = entry.data as {
          ref: string; offset: number; content: string; totalCharacters: number; nextOffset: number | null;
        };
        expect(page.ref).toBe(artifactRef);
        expect(page.offset).toBe(reconstructed.length);
        expect(page.totalCharacters).toBe(expected.length);
        reconstructed += page.content;
        pages++;
        action = page.nextOffset === null
          ? { kind: 'context', decision: { type: 'finish_turn' } }
          : { kind: 'artifact', ref: artifactRef, offset: page.nextOffset };
      }
      return { provider: 'minimax', model: 'test', finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        message: nativeMessage(action) };
    } },
    limits: { retryBaseMs: 1 },
  });
  try {
    await writeFile(join(directory, 'long.md'), content, 'utf8');
    await runtime.initialize();
    await runtime.createAgent({ ownerId: 'reader', workspaceId: 'docs', character: 'code_auditor',
      objective: '检查长文档末页', capabilities: [{ capability: 'file.read', scope: { kind: 'exact', resource: path } }] });
    runtime.start();
    const deadline = Date.now() + 2000;
    while (runtime.inspect(1, 'reader').control.state !== 'SLEEPING') {
      if (runtime.inspect(1, 'reader').status === 'paused' || Date.now() > deadline) throw new Error('分页未完成。');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(pages).toBeGreaterThan(1);
    expect(artifactRef).toMatch(/^r[0-9a-f]{12}$/u);
    expect(reconstructed).toBe(expected);
    expect(JSON.parse(reconstructed).content).toBe(content);
    expect(runtime.interrupts(1, 'reader').map(({ kind, action }) => ({ kind, action })))
      .toEqual([{ kind: 'protocol', action: 'retry' }]);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('已投递聊天来源误用产物工具时有限纠正，不误判为越权暂停', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'message-source-'));
  let phase = 0;
  let read = false;
  const runtime = createAgentRuntime({
    database: join(directory, 'runtime.sqlite'), workspaces: { docs: directory },
    requester: { provider: 'minimax', model: 'test', async request(request) {
      const payload = JSON.parse(String(request.messages[1]?.content)) as {
        conversation: { id: string }; currentBatch: { messageIds: string[] };
        previousError: string | null; context: { frames: { memory: { recentEntries: ContextEntry[] } }[] };
      };
      let action: object;
      if (phase++ === 0) {
        action = { kind: 'artifact', ref: payload.currentBatch.messageIds[0], offset: 0 };
      } else if (phase === 2) {
        expect(payload.previousError).toContain('聊天消息请使用conversation_read');
        action = { kind: 'conversation_read', conversationId: payload.conversation.id,
          messageId: payload.currentBatch.messageIds[0], offset: 0 };
      } else {
        expect(JSON.stringify(payload.context.frames)).toContain('请检查实际文件');
        read = true;
        action = { kind: 'context', decision: { type: 'finish_turn' } };
      }
      return { provider: 'minimax', model: 'test', finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        message: nativeMessage(action) };
    } },
    limits: { retryBaseMs: 1 }, conversationPolicy: { quietMs: 1, maxWaitMs: 1 },
  });
  try {
    await runtime.initialize();
    const agent = await runtime.createAgent({ ownerId: 'reader', workspaceId: 'docs', character: 'code_auditor',
      objective: '检查消息', startMode: 'on_message', capabilities: [] });
    const conversation = runtime.conversations('reader').find((item) =>
      item.members.some((member) => member.kind === 'agent' && member.id === agent.control.agentId))!;
    runtime.sendMessage(conversation.id, 'reader', { content: '请检查实际文件', idempotencyKey: 'task' });
    runtime.start();
    const deadline = Date.now() + 2000;
    while (!read || runtime.inspect(1, 'reader').control.state !== 'SLEEPING') {
      if (runtime.inspect(1, 'reader').status === 'paused' || Date.now() > deadline) throw new Error('纠正未完成。');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtime.interrupts(1, 'reader').map(({ kind, action }) => ({ kind, action })))
      .toEqual([{ kind: 'protocol', action: 'retry' }]);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('完整投递配合审稿护栏，拒绝未读和旧稿验收，真实读取后可发言', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chapter-inline-'));
  const outputDirectory = join(directory, '前十章_测试');
  const path = 'workspace://current/前十章_测试/第03章.md';
  const canonPath = 'workspace://current/前十章_测试/运行校对口径.md';
  const content = '渡口练习与第一轮比赛。'.repeat(500) + '\n结尾证据：明日六十四进三十二。';
  let prematureReview = false;
  let requestedRead = false;
  let reviewedBeforeCanon = false;
  let requestedCanon = false;
  let receivedEnding = false;
  const runtime = createAgentRuntime({
    database: join(directory, 'runtime.sqlite'), workspaces: { docs: directory },
    toolResultInlineCharacters: 16_000,
    messageGuard: ({ agentId, content }) => verifyNovelReview(
      join(directory, 'runtime.sqlite'), outputDirectory, agentId, content, 16_000),
    limits: { retryBaseMs: 1 },
    requester: { provider: 'minimax', model: 'test', async request(request) {
      const payload = JSON.parse(String(request.messages[1]?.content)) as {
        conversation: { id: string };
        previousError: string | null;
        context: { frames: { memory: { recentEntries: ContextEntry[] } }[] };
      };
      let action: object;
      if (!prematureReview) {
        prematureReview = true;
        action = { kind: 'send_message', conversationId: payload.conversation.id,
          content: '未读稿就声称验收通过', finish: true };
      } else if (!requestedRead) {
        expect(payload.previousError).toContain('必须先file.read最新');
        requestedRead = true;
        action = { kind: 'tools', calls: [{ name: 'file.read', arguments: { path } }] };
      } else if (!reviewedBeforeCanon) {
        reviewedBeforeCanon = true;
        action = { kind: 'send_message', conversationId: payload.conversation.id,
          content: '只读章节尚未核对权威口径', finish: true };
      } else if (!requestedCanon) {
        expect(payload.previousError).toContain(canonPath);
        requestedCanon = true;
        action = { kind: 'tools', calls: [{ name: 'file.read', arguments: { path: canonPath } }] };
      } else {
        const entry = payload.context.frames.at(-1)!.memory.recentEntries.findLast(
          (item) => item.kind === 'tool_result' &&
            (item.output as { result?: { path?: string } }).result?.path === path);
        if (!entry || entry.kind !== 'tool_result') throw new Error('缺少章节读取结果。');
        const output = entry.output as { result: { content: string } };
        expect(output.result.content).toBe(content);
        receivedEnding = output.result.content.endsWith('明日六十四进三十二。');
        action = { kind: 'send_message', conversationId: payload.conversation.id,
          content: `实际读到末尾：${output.result.content.slice(-14)}`, finish: true };
      }
      return { provider: 'minimax', model: 'test', finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        message: nativeMessage(action) };
    } },
  });
  try {
    await mkdir(outputDirectory);
    await writeFile(join(outputDirectory, '第03章.md'), content, 'utf8');
    await writeFile(join(outputDirectory, '运行校对口径.md'), '第一日128进64，科尔尚未淘汰。', 'utf8');
    await runtime.initialize();
    await runtime.createAgent({ ownerId: 'reader', workspaceId: 'docs', character: 'code_auditor',
      objective: '读完章节并核对口径后报告末尾', startMode: 'on_message',
      capabilities: [path, canonPath].map((resource) => ({ capability: 'file.read',
        scope: { kind: 'exact' as const, resource } })) });
    runtime.sendMessage(runtime.directConversation(1, 'reader').id, 'reader',
      { content: '请实读章节末尾再回复', idempotencyKey: 'read-chapter' });
    runtime.start();
    const deadline = Date.now() + 2000;
    while (!receivedEnding || runtime.inspect(1, 'reader').control.state !== 'SLEEPING') {
      if (runtime.inspect(1, 'reader').status === 'paused' || Date.now() > deadline) throw new Error('章节读取未完成。');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtime.messages(1, 'reader').at(-1)?.content).toContain('明日六十四进三十二。');
    expect(runtime.messages(1, 'reader').some((item) => item.content === '未读稿就声称验收通过')).toBe(false);
    expect(runtime.messages(1, 'reader').some((item) => item.content === '只读章节尚未核对权威口径')).toBe(false);
    expect(runtime.interrupts(1, 'reader').map(({ kind, action }) => ({ kind, action })))
      .toEqual([{ kind: 'protocol', action: 'retry' }, { kind: 'protocol', action: 'retry' }]);
    await writeFile(join(outputDirectory, '运行校对口径.md'), '第一日128进64，科尔与巴雷均为固定四强。', 'utf8');
    expect(verifyNovelReview(join(directory, 'runtime.sqlite'), outputDirectory, 1, '验收通过', 16_000))
      .toContain(canonPath);
    await writeFile(join(outputDirectory, '第03章.md'), `${content}\n作者后续修订。`, 'utf8');
    expect(verifyNovelReview(join(directory, 'runtime.sqlite'), outputDirectory, 1, '验收通过', 16_000))
      .toContain('必须先file.read最新');
    await writeFile(join(outputDirectory, '第03章.md'), '渡口练习。', 'utf8');
    expect(verifyNovelReview(join(directory, 'runtime.sqlite'), outputDirectory, 1, '验收通过', 16_000))
      .toContain('实际汉字数不足2000');
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
