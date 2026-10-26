import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { createAgentRuntime } from '../src/agent-runtime/index.js';
import { CharacterRegistry } from '../src/character/character-registry.js';
import { createModelRequester, type JsonValue, type ModelRequesterOptions } from '../src/model-requester/index.js';
import { verifyNovelReview } from './novel-review-guard.js';

// 手动真实联调入口：每次新建两名角色，普通单测不会连接付费模型。
const authorPrompt = '你是一名兔女郎，现在你当上了我们的写手，你现在的工作是在编辑小黑的帮助下，完成我们的小说。小说的目录，大纲，设定都已经在工作目录下，如果有你认为不清楚怎么处理的情节，前后矛盾的设定，可以询问编辑小黑或者问我，不要自己随便处理。';
const editorPrompt = '你是一名猫娘，现在你来当上了我们的编辑，你需要和写手小白一起完成我们的小说。小说的目录，背景，大纲都已经在工作目录中，作为编辑，你不能自己进行修改，只可以检查小白写的内容，就不合理或处理的不好的地方提出意见，由他进行修改。';
if (!process.argv[2]) throw new Error('请指定小说工作区目录。');
const workspace = resolve(process.argv[2]);
const runDirectory = resolve(process.argv[3] ?? join('.tmp', `novel-live-${Date.now()}`));
const outputName = `前十章_${basename(runDirectory)}`;
const outputDirectory = join(workspace, outputName);
const ownerId = 'local-novel-validation';
const provider = process.env.NOVEL_PROVIDER ?? 'minimax';
if (provider !== 'deepseek' && provider !== 'minimax') throw new Error('NOVEL_PROVIDER 必须是 deepseek 或 minimax。');
const keyFile = process.env.NOVEL_KEY_FILE;
const apiKey = keyFile ? (await readFile(keyFile, 'utf8')).trim()
  : provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : process.env.MINIMAX_API_KEY;
if (!apiKey) throw new Error('请通过 NOVEL_KEY_FILE 或对应供应商环境变量提供密钥。');
const thinking = provider === 'minimax' ? process.env.MINIMAX_THINKING : undefined;
if (thinking !== undefined && thinking !== 'adaptive' && thinking !== 'disabled') {
  throw new Error('MINIMAX_THINKING 必须是 adaptive 或 disabled。');
}
const authorThinking = provider === 'minimax' ? process.env.MINIMAX_AUTHOR_THINKING : undefined;
if (authorThinking !== undefined && authorThinking !== 'adaptive' && authorThinking !== 'disabled') {
  throw new Error('MINIMAX_AUTHOR_THINKING 必须是 adaptive 或 disabled。');
}
await mkdir(runDirectory, { recursive: true });
await mkdir(outputDirectory, { recursive: true });
const readonlyCapabilities = ['file.read', 'directory.read'];
const characters = new CharacterRegistry([
  { id: 'novel_author', displayName: '作者小白', promptFragment: authorPrompt, allowPlanning: false,
    visibleToolIds: ['file.read', 'directory.list', 'workspace.search', 'file.create', 'file.write', 'file.apply_patch'],
    capabilityCeiling: [...readonlyCapabilities, 'file.create', 'file.write'], requestableCapabilities: [],
    allowedChildCharacters: [] },
  { id: 'novel_editor', displayName: '编辑小黑', promptFragment: editorPrompt, allowPlanning: false,
    visibleToolIds: ['file.read', 'directory.list', 'workspace.search'],
    capabilityCeiling: readonlyCapabilities, requestableCapabilities: [], allowedChildCharacters: [] },
]);
const modelOptions: ModelRequesterOptions = provider === 'deepseek' ? {
  provider, model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', apiKey,
  timeoutMs: Number(process.env.DEEPSEEK_TIMEOUT_MS ?? 360_000), thinking: 'enabled', reasoningEffort: 'high',
} : {
  provider, model: process.env.MINIMAX_MODEL ?? 'MiniMax-M3', apiKey,
  timeoutMs: Number(process.env.MINIMAX_TIMEOUT_MS ?? 360_000),
  ...(process.env.MINIMAX_BASE_URL ? { baseUrl: process.env.MINIMAX_BASE_URL } : {}),
  ...(thinking ? { thinking } : {}),
};
const requester = createModelRequester(modelOptions);
const authorRequester = authorThinking && modelOptions.provider === 'minimax'
  ? createModelRequester({ ...modelOptions, thinking: authorThinking }) : requester;
let authorId = 0;
let editorId = 0;
let groupId = '';
const runtime = createAgentRuntime({
  database: join(runDirectory, 'runtime.sqlite'), workspaces: { novel: workspace }, characters,
  requester: {
    provider: requester.provider, model: requester.model,
    request(request, signal) {
      const target = request.tools?.some((tool) => tool.name === 'file.create') ? authorRequester : requester;
      // Send exactly the Runtime request; source updates arrive through real file reads and feedback.
      return target.request(request, signal);
    },
  },
  // 十章真实审改使用独立且有限的总额度，普通运行与单测默认值不变。
  limits: { maxRounds: 768, maxRetries: 4, maxConcurrentRequests: 2,
    requestsPerMinute: Number(process.env.NOVEL_REQUESTS_PER_MINUTE ?? 30), maxTotalTokens: 30_000_000 },
  // 几千字章节完整投递，较长资料继续使用分页，不让读取成功被误当成已读全文。
  toolResultInlineCharacters: 16_000,
  messageGuard: ({ agentId, conversationId, content, mentions }) => {
    const peerId = agentId === authorId ? editorId : authorId;
    if (conversationId === groupId && !mentions.includes(peerId)) {
      return `本次协作群按点名唤醒；请用message_send并设置mentions:[${peerId}]，否则对方无法收到工作阶段。正文中写@姓名不能代替mentions。`;
    }
    return agentId === editorId
      ? verifyNovelReview(join(runDirectory, 'runtime.sqlite'), outputDirectory, editorId, content, 16_000) : null;
  },
  conversationPolicy: { maxAutomaticMessages: 240 },
});
await runtime.initialize();
let agents = runtime.list(ownerId);
let group = runtime.conversations(ownerId).find((conversation) => conversation.kind === 'group');
if (!agents.length) {
  for (const [character, displayName, prompt, writable] of [
    ['novel_author', '作者小白', authorPrompt, true],
    ['novel_editor', '编辑小黑', editorPrompt, false],
  ] as const) {
    await runtime.createAgent({
      ownerId, workspaceId: 'novel', character, displayName, startMode: 'on_message', objective: prompt,
      instructions: [
        prompt,
        `请遵循 workspace://current/${outputName}/协作任务书.md。`,
        `校对依据在 workspace://current/${outputName}/运行校对口径.md，首次工作及审稿时实际读取；疑点先向编辑确认。`,
        '每次只处理当前来信需要的阶段；需要对方回应时先结束自己本轮，使新来信可被投递。',
        '本次联调从根层直接执行文件工具与消息，不安装 plan/replan/advance 或 L3 步骤计划。章节方案写在文件里即可。',
        '每轮一项交付：读资料后写方案；读方案后发裁定；写一章后发路径；读一章后发具体意见；改一章后请复查。',
        '文件成功写入后立刻发送消息并设置 finish=true；编辑实际读取全文后回复意见并 finish=true。',
        '不要为已完成的文件读取、检查消息或发消息再建立任务，不为等待新消息调用工具；直接finish_turn休眠。',
        '遇到工具或格式错误只按反馈纠正当前动作，不重新规划整项工作。',
        '发送审稿或答复后，结束根层本轮。不要反复查找尚未到来的新消息、continue 或重复确认。',
        '人物扮演仅用于工作对话，正文不带编辑或作者的身份设定。',
      ],
      capabilities: [
        ...readonlyCapabilities.map((capability) => ({ capability,
          scope: { kind: 'subtree' as const, resource: 'workspace://current/' } })),
        ...(writable ? ['file.create', 'file.write'].map((capability) => ({ capability,
          scope: { kind: 'subtree' as const, resource: `workspace://current/${outputName}/` } })) : []),
      ],
    });
  }
  agents = runtime.list(ownerId);
  group = runtime.createConversation({
    ownerId, workspaceId: 'novel', kind: 'group', title: '作者小白与编辑小黑：前十章联调',
    participation: 'mentioned',
    members: [{ kind: 'user', id: ownerId }, ...agents.map((agent) => ({ kind: 'agent' as const, id: agent.control.agentId }))],
  });
  const [author, editor] = agents;
  if (!author || !editor) throw new Error('两名 Agent 创建失败。');
  const task = `# 前十章协作任务书

本次是作者小白与编辑小黑的真实协作。作者编号 ${author.control.agentId}，编辑编号 ${editor.control.agentId}。
共同工作群 conversationId：${group.id}。工作沟通在此群中通过 message_send，mentions 点名对方；无需礼貌确认。
原始资料保留不改：故事大纲.txt；使用故事大纲_校对稿.md和大纲审读与待确认.md辅助核对。
输出目录：workspace://current/${outputName}/（宿主已创建）。

先读校对稿中第一部开篇和审读清单，提出十章方案和最小命名，写入章节方案与新增设定.md，交编辑确认。
前十章只推进到新生赛狂武觉醒、虚弱导致半决赛落败、传承塔首次异常、伊蕾娜委托及潮汐咏叹。
可建议章节节奏，但不得把后续两年、第二卷、血统与太阳王真相、欧米伽或结局提前写进来。
凯恩/莱恩暂按审读清单处理；原稿未定的家庭、城名、主角和六皇子姓名只做最小新增并列明，不自定核心身份。
新生赛128人单败：1至4轮后剩8人；第五轮八进四对六皇子；第六轮半决赛对伊蕾娜，注意休息间隔和狂武代价。

正文固定文件名：第01章.md 至 第10章.md，一级标题内写章名。每章约2800至3300中文字符，十章总计约30000字；不是逐字卡上下限。
写章节是主要任务，方案控制在1500中文字符以内，使用表格与简短设定，不反复列问答。
小白、小黑本轮直接在根层用文件工具处理实际工作，群里提交后finish=true休眠；不要为单次工作创建三级计划。
初稿连续性护栏：伊蕾娜不给具体等级，不得超过“六皇子唯一一级巅峰”；前四轮较轻松获胜。
赛程统一小时，第五日上午至第六日下午约28小时；狂武虚弱超过一日，不设24小时不能再开等精确条文。
六皇子在八进四出局，不在四强入塔名单。狂武因主角濒败情绪激动触发，不新增攻击场外观众。
开篇主角可用江澈，小城可用临水镇，父母为普通码头/渡口工作者，不确定核心血统。
用第三人称有限视角，具体行动、对话和因果推动；不以梗概代替正文，不堆设定，不用谜语和旁白宣告强大。
每次提交一章完整正文，成功写入后发送文件路径、内容要点和待检查点，点名编辑，不在群里粘整章。
编辑必须实际读取章节正文，检查大纲、人物、因果、比赛日程、能力代价及文风，提出具体问题。
编辑没有写文件权限，意见直接发群点名作者。作者依照意见修改文件，发送修改说明并请编辑复查。
通过时编辑明确发送“验收通过：第01章”（对应章节编号）及理由，不把有待修改的稿件标记为通过。
作者收到通过后才开始下一章；需要等待编辑时先结束本轮，使来信可以被处理。
全部通过后，作者保存人物与时间一致性表.md和修改说明.md，编辑实际通读十章做终审。
编辑最后发送“前十章终审通过”及保留的问题。若未通过则继续指出问题并复查。
宿主会把真实群消息自动保存到审稿记录.md，编辑不需要为此写文件。
`;
  await writeFile(join(outputDirectory, '协作任务书.md'), task, 'utf8');
  runtime.sendMessage(group.id, ownerId, {
    content: `任务已派发。请两位读取 workspace://current/${outputName}/协作任务书.md 和大纲校对稿、审读清单。小白先拟十章章节方案和最小新增命名并写文件，提交小黑审议；小黑先读资料，等方案到达再审。请按真实文件逐章写、审、改，完成前十章。群ID ${group.id}，小白ID ${author.control.agentId}，小黑ID ${editor.control.agentId}。`,
    mentions: [author.control.agentId, editor.control.agentId], idempotencyKey: 'initial-task',
  });
}
if (!group || agents.length !== 2) throw new Error('恢复现场不是两名小说 Agent。');
authorId = agents[0]!.control.agentId;
editorId = agents[1]!.control.agentId;
const conversation = group;
groupId = conversation.id;
let shuttingDown = false;
let snapshotInFlight = false;
async function snapshot(): Promise<void> {
  if (snapshotInFlight || shuttingDown) return;
  snapshotInFlight = true;
  try {
    const messages = runtime.conversationMessages(conversation.id, ownerId);
    const completed = runtime.list(ownerId).flatMap((agent) => runtime.events(agent.control.agentId, ownerId))
      .filter((event) => event.type === 'model_completed').sort((a, b) => a.sequence - b.sequence);
    const usage = completed.map((event) => event.data).filter((data): data is Record<string, JsonValue> =>
      data !== null && typeof data === 'object' && !Array.isArray(data));
    const sum = (key: string) => usage.reduce((total, data) => total + (typeof data[key] === 'number' ? data[key] : 0), 0);
    const inputTokens = sum('inputTokens');
    const measured = usage.filter((data) => typeof data.cacheHitTokens === 'number');
    const measuredInputTokens = measured.reduce((total, data) => total + (typeof data.inputTokens === 'number' ? data.inputTokens : 0), 0);
    const cache = { requests: completed.length, measuredRequests: measured.length, measuredInputTokens,
      inputTokens, outputTokens: sum('outputTokens'), hitTokens: sum('cacheHitTokens'), missTokens: sum('cacheMissTokens'),
      hitRate: measuredInputTokens ? sum('cacheHitTokens') / measuredInputTokens : null, recent: completed.slice(-4) };
    // 通过管理读取保存两人的私聊证据，不加入用户群聊或修改收件游标。
    const privateChats = runtime.agentConversations(agents[0]!.control.agentId, ownerId)
      .filter((chat) => chat.id !== conversation.id &&
        chat.members.every((member) => member.kind === 'agent') &&
        chat.members.some((member) => member.id === agents[1]!.control.agentId))
      .map((chat) => ({
        conversation: chat,
        messages: runtime.conversationMessages(chat.id, ownerId, agents[0]!.control.agentId),
      }));
    const files = [];
    for (const name of (await readdir(outputDirectory)).filter((name) => /^第\d{2}章\.md$/u.test(name)).sort()) {
      const content = await readFile(join(outputDirectory, name), 'utf8');
      files.push({ name, chineseCharacters: (content.match(/\p{Script=Han}/gu) ?? []).length,
        characters: content.length, sha256: createHash('sha256').update(content).digest('hex') });
    }
    const status = {
      at: new Date().toISOString(), ready: runtime.isReady(), runDirectory, outputDirectory,
      conversationId: conversation.id, provider: requester.provider, model: requester.model, cache, files, messageCount: messages.length,
      agents: runtime.list(ownerId).map((agent) => ({
        id: agent.control.agentId, name: agent.control.agentName, status: agent.status, state: agent.control.state,
        rounds: agent.rounds, tokens: agent.totalTokens, lastError: agent.lastError,
        contextKey: agent.contextKey, layers: [agent.control.context.level1, agent.control.context.level2, agent.control.context.level3]
          .filter((frame) => frame != null).map((frame) => ({ level: frame.level, phase: frame.taskChain.phase,
            currentTask: frame.currentTask, tasks: frame.taskChain.tasks.map((task) => ({ objective: task.objective, state: task.state })) })),
        interrupts: runtime.interrupts(agent.control.agentId, ownerId).slice(-5),
        approvals: runtime.approvals(agent.control.agentId, ownerId).map((operation) => ({
          operationId: operation.operationId, toolName: operation.toolName, state: operation.state,
          path: operation.arguments.path,
        })),
      })),
      mailboxes: runtime.conversationMailboxes(conversation.id, ownerId),
      recentMessages: messages.slice(-8).map(({ sequence, sender, content }) => ({ sequence, sender, content })),
      privateConversations: privateChats.map(({ conversation: chat, messages: chatMessages }) => ({
        id: chat.id, title: chat.title, messageCount: chatMessages.length,
        recentMessages: chatMessages.slice(-6).map(({ sequence, sender, content }) => ({ sequence, sender, content })),
      })),
    };
    await writeFile(join(runDirectory, 'status.json'), JSON.stringify(status, null, 2), 'utf8');
    await writeFile(join(runDirectory, 'messages.json'), JSON.stringify(messages, null, 2), 'utf8');
    await writeFile(join(runDirectory, 'private-messages.json'), JSON.stringify(privateChats, null, 2), 'utf8');
    await writeFile(join(outputDirectory, '审稿记录_私聊.md'), '# 两名 Agent 的真实私聊审稿记录\n\n' +
      privateChats.map(({ conversation: chat, messages: chatMessages }) =>
        `## 会话 ${chat.id}\n\n` + chatMessages.map((message) => {
          const name = message.sender.id === agents[0]!.control.agentId ? '作者小白' : '编辑小黑';
          return `### ${message.sequence} · ${name} · ${new Date(message.createdAt).toISOString()}\n\n${message.content}\n`;
        }).join('\n')).join('\n'), 'utf8');
    await writeFile(join(outputDirectory, '审稿记录.md'), '# 真实协作与审稿记录\n\n' + messages.map((message) => {
      const name = message.sender.kind === 'user' ? '宿主' : message.sender.id === agents[0]!.control.agentId ? '作者小白' : '编辑小黑';
      return `## ${message.sequence} · ${name} · ${new Date(message.createdAt).toISOString()}\n\n${message.content}\n`;
    }).join('\n'), 'utf8');
  } finally { snapshotInFlight = false; }
}
const control = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/status') {
      await snapshot();
      response.setHeader('content-type', 'application/json');
      response.end(await readFile(join(runDirectory, 'status.json'), 'utf8'));
      return;
    }
    if (request.method !== 'POST') { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk as Buffer);
      if (bytes > 32_000) throw new Error('控制请求过大。');
      chunks.push(Buffer.from(chunk as Buffer));
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object') throw new Error('控制参数无效。');
    if (request.url === '/message' && 'content' in body && typeof body.content === 'string') {
      const mentions = 'mentions' in body && Array.isArray(body.mentions) ? body.mentions as number[] : [];
      if (!mentions.every((id) => Number.isSafeInteger(id) && id > 0)) throw new Error('点名编号无效。');
      runtime.sendMessage(conversation.id, ownerId, { content: body.content, mentions, idempotencyKey: `host-${randomUUID()}` });
    } else if (request.url === '/feedback' && 'agentId' in body && typeof body.agentId === 'number' &&
      'content' in body && typeof body.content === 'string') {
      runtime.provideFeedback(body.agentId, ownerId, body.content, `monitor-${randomUUID()}`);
    } else if ((request.url === '/pause' || request.url === '/resume') && 'agentId' in body && typeof body.agentId === 'number') {
      if (request.url === '/pause') await runtime.pause(body.agentId, ownerId);
      else runtime.resume(body.agentId, ownerId);
    } else if (request.url === '/reconcile' && 'agentId' in body && typeof body.agentId === 'number' &&
      'operationId' in body && typeof body.operationId === 'string' && 'resolution' in body) {
      // 对账由可信宿主检查现场后显式提交，禁止自动推定副作用成功。
      const resolution = body.resolution;
      if (!resolution || typeof resolution !== 'object' || !('outcome' in resolution) ||
        !['succeeded', 'failed'].includes(String(resolution.outcome)) || !('result' in resolution)) {
        throw new Error('对账结果无效。');
      }
      if (resolution.outcome !== 'succeeded' && resolution.outcome !== 'failed') throw new Error('对账状态无效。');
      runtime.reconcile(body.agentId, ownerId, body.operationId, {
        outcome: resolution.outcome, result: resolution.result as JsonValue,
      });
    } else { throw new Error('未知控制请求。'); }
    await snapshot();
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
  } catch (error) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : '控制失败。' }));
  }
});
await new Promise<void>((done) => control.listen(0, '127.0.0.1', done));
const address = control.address();
if (!address || typeof address === 'string') throw new Error('控制端口不可用。');
await writeFile(join(runDirectory, 'control.json'), JSON.stringify({ url: `http://127.0.0.1:${address.port}`,
  pid: process.pid, runDirectory, outputDirectory, agents: agents.map((agent) => agent.control.agentId) }, null, 2), 'utf8');
runtime.start();
await snapshot();
const timer = setInterval(() => {
  void snapshot().catch(() => {});
}, 10_000);
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  clearInterval(timer);
  await snapshot();
  shuttingDown = true;
  control.close();
  await runtime.close();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
