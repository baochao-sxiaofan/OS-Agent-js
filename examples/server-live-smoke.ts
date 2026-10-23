import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRuntime } from '../src/agent-runtime/index.js';
import { createModelRequester } from '../src/model-requester/index.js';

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) throw new Error('需要通过本地环境提供 MINIMAX_API_KEY。');
const directory = await mkdtemp(join(tmpdir(), 'os-agent-live-'));
const baseRequester = createModelRequester({
  provider: 'minimax', model: process.env.MINIMAX_MODEL ?? 'MiniMax-M2.7', apiKey,
  ...(process.env.MINIMAX_BASE_URL ? { baseUrl: process.env.MINIMAX_BASE_URL } : {}),
  timeoutMs: 90_000,
});
const runtime = createAgentRuntime({
  database: join(directory, 'runtime.sqlite'), workspaces: { test: directory },
  requester: {
    provider: baseRequester.provider, model: baseRequester.model,
    async request(input, signal) {
      const completion = await baseRequester.request(input, signal);
      if (process.env.OS_AGENT_SMOKE_DEBUG === '1' &&
          String(input.messages[0]?.content).includes('独立总结轮')) {
        // 本地模拟资料的语义响应，仅用于诊断；不保存凭据或私有推理。
        console.log(JSON.stringify({ summaryResponse: completion.message.content }));
      }
      return completion;
    },
  },
  limits: { maxRounds: 40, maxTotalTokens: 400_000, requestsPerMinute: 60,
    tokensPerMinute: 300_000, maxOutputTokens: 4096, maxRetries: 2 },
  onEvent: (event) => console.log(JSON.stringify({
    type: event.type, agentId: event.agentId, sequence: event.sequence,
    ...(event.type === 'action' || event.type === 'interrupt' ? { data: event.data } : {}),
  })),
});
try {
  await writeFile(join(directory, 'input.txt'), '项目甲已交付。项目乙仍在测试。下次需要跟进项目乙。\n');
  await runtime.initialize();
  const agent = await runtime.createAgent({
    ownerId: 'local-test', workspaceId: 'test', character: 'developer',
    objective: [
      '请读取 workspace://current/input.txt，生成 workspace://current/report.md。',
      '明确已交付项、进行中项和下一步。先在 L1 plan 一个任务并 advance，',
      '再在 L2 plan 一个任务并 advance，到 L3 执行读写。L3 可以不安装步骤计划。',
      '报告文件创建成功后 L3 complete、L2 complete；回到L1通过message_send向当前会话发送交付结果，finish:true结束。',
    ].join(''),
    capabilities: [
      { capability: 'file.read', scope: { kind: 'exact', resource: 'workspace://current/input.txt' } },
      { capability: 'file.create', scope: { kind: 'exact', resource: 'workspace://current/report.md' } },
    ],
  });
  runtime.start();
  const id = agent.control.agentId;
  async function waitForSleep(throughSequence?: number): Promise<void> {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const current = runtime.inspect(id, 'local-test');
      if (current.status === 'paused') throw new Error(
        `运行暂停：${JSON.stringify(runtime.interrupts(id, 'local-test').map(({ kind, message }) => ({ kind, message })))}`);
      const processed = throughSequence === undefined || runtime.conversationMailboxes(
        runtime.directConversation(id, 'local-test').id, 'local-test',
      ).every((mailbox) => mailbox.processedSequence >= throughSequence && mailbox.state === 'processed');
      if (current.control.state === 'SLEEPING' && processed) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('真实模型冒烟超时。');
  }
  await waitForSleep();
  const report = await readFile(join(directory, 'report.md'), 'utf8');
  if (!report.includes('项目甲') || !report.includes('项目乙')) throw new Error('报告缺少资料内容。');
  const current = runtime.inspect(id, 'local-test');
  if (current.control.context.level2 || current.control.context.level3) throw new Error('子层未正常总结释放。');
  const conversation = runtime.directConversation(id, 'local-test');
  const delivered = runtime.conversationMessages(conversation.id, 'local-test').filter((message) => message.sender.kind === 'agent');
  if (!delivered.length) throw new Error('第一次任务没有交付会话消息。');
  const wake = runtime.sendMessage(conversation.id, 'local-test', {
    content: '请用message_send向当前会话发送「已收到后续任务」，finish:true结束；无需文件工具或新计划。',
    idempotencyKey: 'wake-again',
  });
  await waitForSleep(wake.sequence);
  if (!runtime.conversationMessages(conversation.id, 'local-test').some((message) =>
    message.sender.kind === 'agent' && message.sequence > wake.sequence && message.content.includes('已收到后续任务'))) {
    throw new Error('再次唤醒后没有交付本批会话消息。');
  }
  console.log(JSON.stringify({ passed: true, state: 'SLEEPING',
    rounds: runtime.inspect(id, 'local-test').rounds, reportBytes: Buffer.byteLength(report) }));
} catch (error) {
  console.error(error instanceof Error ? error.message : '本地测试失败。');
  process.exitCode = 1;
} finally {
  await runtime.close();
  await rm(directory, { recursive: true, force: true });
}
