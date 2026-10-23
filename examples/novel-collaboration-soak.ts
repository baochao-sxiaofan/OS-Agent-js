import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createAgentRuntime } from '../src/agent-runtime/index.js';
import { CharacterRegistry } from '../src/character/character-registry.js';
import { createModelRequester } from '../src/model-requester/index.js';

// 仅供人工显式启动的付费耐久测试；普通单测不会执行此入口。
const runDirectory = resolve(process.argv[2] ?? join('.tmp', `novel-soak-${Date.now()}`));
const workspace = join(runDirectory, 'workspace');
const outputDirectory = join(workspace, '交付');
const owner = 'novel-soak-owner';
const apiKey = process.env.DEEPSEEK_API_KEY ??
  (process.env.DEEPSEEK_KEY_FILE ? (await readFile(process.env.DEEPSEEK_KEY_FILE, 'utf8')).trim() : '');
if (!apiKey) throw new Error('请提供 DEEPSEEK_API_KEY 或 DEEPSEEK_KEY_FILE。');
await mkdir(outputDirectory, { recursive: true });

const characters = new CharacterRegistry([
  { id: 'soak_author', displayName: '作者小白', promptFragment: '你是小说作者小白，与已有的编辑小黑合作交付文件。',
    visibleToolIds: ['file.read', 'directory.list', 'workspace.search', 'file.create', 'file.write', 'file.apply_patch'],
    capabilityCeiling: ['file.read', 'directory.read', 'file.create', 'file.write'],
    requestableCapabilities: [], allowedChildCharacters: [] },
  { id: 'soak_editor', displayName: '编辑小黑', promptFragment: '你是只读编辑小黑，实际读取小白交付的文件并通过消息协作。',
    visibleToolIds: ['file.read', 'directory.list', 'workspace.search'],
    capabilityCeiling: ['file.read', 'directory.read'], requestableCapabilities: [], allowedChildCharacters: [] },
]);
let eventCount = 0;
const startedAt = Date.now();
const runtime = createAgentRuntime({
  database: join(runDirectory, 'runtime.sqlite'), workspaces: { novel: workspace }, characters,
  requester: createModelRequester({ provider: 'deepseek', model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
    apiKey, timeoutMs: 240_000 }),
  // 单次工作沿用桌面128轮上限；全程总额度有限且可观察。
  limits: { requestsPerMinute: 30, maxConcurrentRequests: 2, maxTotalTokens: 30_000_000 },
  tokenSettings: { maxRequestTokens: 500_000, maxOutputTokens: 32_768, tokensPerMinute: 2_000_000,
    maxTotalTokens: 30_000_000, contextMaxTokens: 140_000, contextCompactAtTokens: 100_000, contextTargetTokens: 50_000 },
  toolResultInlineCharacters: 16_000,
  conversationPolicy: { maxAutomaticMessages: 160 },
  onEvent() {
    eventCount++;
  },
});
await runtime.initialize();
let agents = runtime.list(owner);
let conversation = runtime.conversations(owner).find((item) => item.kind === 'group');
if (!agents.length) {
  const source = process.env.NOVEL_SOURCE_DIR;
  if (source) {
    for (const name of ['故事大纲_校对稿.md', '大纲审读与待确认.md']) {
      try { await copyFile(join(source, name), join(workspace, name)); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
  }
  for (const [character, name, writable] of [['soak_author', '作者小白', true], ['soak_editor', '编辑小黑', false]] as const) {
    await runtime.createAgent({
      ownerId: owner, workspaceId: 'novel', character, displayName: name, startMode: 'on_message',
      objective: writable ? '与编辑小黑逐章合作，写入并修订小说前十章文件，然后向用户交付。'
        : '只读检查小白的十章文件，每章提出一次简单补写要求，复读后确认交付；不评判文学质量。',
      instructions: [
        '本次唯一任务见 workspace://current/协作任务书.md，先读取并遵循。',
        '发给同伴的工作消息使用协作群的 conversationId，并通过 mentions 点名其数字编号。',
        '交接阶段时调用 message_send 并设置 finish:true；等待回复时结束当前轮，不轮询消息。',
        '文件工具返回成功后才能声称已写入。编辑须实际读取对应文件，再提出意见或确认。',
      ],
      capabilities: [
        ...['file.read', 'directory.read'].map((capability) => ({ capability,
          scope: { kind: 'subtree' as const, resource: 'workspace://current/' } })),
        ...(writable ? ['file.create', 'file.write'].map((capability) => ({ capability,
          scope: { kind: 'subtree' as const, resource: 'workspace://current/交付/' } })) : []),
      ],
    });
  }
  agents = runtime.list(owner);
  conversation = runtime.createConversation({
    ownerId: owner, workspaceId: 'novel', kind: 'group', title: '前十章多轮协作耐久测试', participation: 'mentioned',
    members: [{ kind: 'user', id: owner }, ...agents.map((agent) => ({ kind: 'agent' as const, id: agent.control.agentId }))],
  });
  const author = agents[0]!.control.agentId;
  const editor = agents[1]!.control.agentId;
  const task = `# 前十章协作任务书

作者小白编号 ${author}，编辑小黑编号 ${editor}。
本次群 conversationId：${conversation.id}。群内交接务必用 mentions 点名对方。
这是协作运行测试，只检查真实文件和工作交接，不评判情节、人物、设定或文风。
如工作区中存在大纲，可简略参考开篇，自行解决矛盾，无需请用户作决定。

## 十章逐章执行

1. 小白先写第01章，依次推进到第10章。每章为完整小说正文，建议1500至2500汉字，有章名、动作和对话。不得用空文件或大纲替代。
2. 固定路径为 workspace://current/交付/第01章.md 至 第10章.md。写好初稿后实际读回，然后发群告知路径，点名小黑并 finish:true。
3. 小黑读完整章文件，只检查能否读到正文。每章初稿提出一次简单补写要求：在章末追加一个“本章记录”小节，用一两句记下本章发生的一件事。不提文学质量要求，不无限审稿。
4. 小白收到要求后，实际修改该文件、读回核对，再发群请小黑复查，点名小黑并 finish:true。
5. 小黑重新读取修改后的文件，看到“本章记录”小节后发“已确认：第NN章”，点名小白。每章只要求这一次补写；确认后不反复修改。
6. 小白收到本章确认后立即写下一章，重复以上步骤。等待同伴时结束本轮，让消息唤醒自己。
7. 第10章确认后，小白写 workspace://current/交付/交付清单.md，列十章文件名，群内发送“前十章已交付”并结束。

所有写入由小白调用文件工具完成；小黑只有读取权限。不要让用户逐章授权或提醒推进。
本次任务已由用户一次性授权。无需复核剧情质量，也不用相互礼貌确认。
`;
  await writeFile(join(workspace, '协作任务书.md'), task);
  runtime.sendMessage(conversation.id, owner, {
    content: `请执行 workspace://current/协作任务书.md，合作完成前十章。小白（${author}）先开始写第01章；小黑（${editor}）读取任务后等待小白交稿，后续按任务书读稿、要求一次补写并复读确认。`,
    mentions: [author, editor], idempotencyKey: 'initial-soak-task',
  });
}
if (!conversation || agents.length !== 2) throw new Error('测试现场必须包含两名长期 Agent 和协作群。');
const chat = conversation;
let stopping = false;
let stopReason = 'running';
process.once('SIGTERM', () => { stopping = true; stopReason = 'interrupted'; });
process.once('SIGINT', () => { stopping = true; stopReason = 'interrupted'; });
let previousProgress = '';
let lastProgressAt = Date.now();
const maximumMs = Number(process.env.NOVEL_SOAK_TIMEOUT_MS ?? 7_200_000);
runtime.start();
async function snapshot() {
  const messages = runtime.conversationMessages(chat.id, owner);
  const files = [];
  for (const name of (await readdir(outputDirectory)).filter((name) => /^第\d{2}章\.md$/u.test(name)).sort()) {
    const content = await readFile(join(outputDirectory, name), 'utf8');
    files.push({ name, bytes: Buffer.byteLength(content), chineseCharacters: (content.match(/\p{Script=Han}/gu) ?? []).length,
      hasRecord: content.includes('本章记录'), sha256: createHash('sha256').update(content).digest('hex') });
  }
  const states = runtime.list(owner).map((agent) => ({
    id: agent.control.agentId, name: agent.control.agentName, status: agent.status, state: agent.control.state,
    rounds: agent.rounds, tokens: agent.totalTokens, error: agent.lastError,
    interrupts: runtime.interrupts(agent.control.agentId, owner),
  }));
  const last = messages.at(-1);
  const complete = files.length === 10 && files.every((file) => file.chineseCharacters >= 500 && file.hasRecord) &&
    messages.some((message) => message.sender.kind === 'agent' && message.sender.id === agents[0]!.control.agentId &&
      message.content.includes('前十章已交付')) && states.every((agent) => agent.state === 'SLEEPING');
  const status = { at: new Date().toISOString(), startedAt, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    pid: process.pid, runDirectory, outputDirectory, conversationId: chat.id, ready: runtime.isReady(), stopReason, complete,
    eventCount, messageCount: messages.length, files, agents: states, lastMessage: last,
    mailboxes: runtime.conversationMailboxes(chat.id, owner) };
  await writeFile(join(runDirectory, 'status.json'), JSON.stringify(status, null, 2));
  await writeFile(join(runDirectory, 'messages.json'), JSON.stringify(messages, null, 2));
  await writeFile(join(runDirectory, 'events.json'), JSON.stringify(agents.flatMap((agent) =>
    runtime.events(agent.control.agentId, owner)), null, 2));
  const progress = JSON.stringify([files, states.map((agent) => agent.rounds), messages.length, eventCount]);
  if (progress !== previousProgress) { previousProgress = progress; lastProgressAt = Date.now(); }
  return { states, complete, idle: states.every((agent) => agent.state === 'SLEEPING') };
}
try {
  while (!stopping) {
    const result = await snapshot();
    if (result.complete) { stopReason = 'completed'; break; }
    if (!runtime.isReady()) { stopReason = 'runtime_failed'; break; }
    if (result.states.some((agent) => agent.status === 'paused')) { stopReason = 'paused'; break; }
    if (result.idle && Date.now() - lastProgressAt > 30_000) { stopReason = 'stalled'; break; }
    if (Date.now() - startedAt > maximumMs) { stopReason = 'timeout'; break; }
    await setTimeout(3000);
  }
} finally {
  await snapshot();
  await runtime.close();
  process.stdout.write(JSON.stringify({ stopReason, runDirectory, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000) }) + '\n');
  process.exitCode = stopReason === 'completed' ? 0 : 1;
}
