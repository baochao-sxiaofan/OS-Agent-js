import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

// 只读核对持久事实，不触发模型、不写章节、不修改运行数据库。
const runDirectory = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('请指定耐久测试运行目录。');
const status = z.object({
  stopReason: z.string(), complete: z.boolean(), elapsedSeconds: z.number(),
  agents: z.array(z.object({ id: z.number(), rounds: z.number(), tokens: z.number(),
    state: z.string(), error: z.string().nullable(),
    interrupts: z.array(z.object({ kind: z.string(), action: z.string(), message: z.string() })) })),
}).parse(JSON.parse(await readFile(join(runDirectory, 'status.json'), 'utf8')));
const messages = z.array(z.object({
  sender: z.object({ kind: z.enum(['user', 'agent']), id: z.union([z.string(), z.number()]) }),
  content: z.string(), createdAt: z.number(),
})).parse(JSON.parse(await readFile(join(runDirectory, 'messages.json'), 'utf8')));
const operationSchema = z.object({
  agentId: z.number(), toolName: z.string(), state: z.string(),
  arguments: z.object({ path: z.string().optional() }).passthrough(),
  result: z.unknown(),
  schedulerOperation: z.object({ startedAt: z.number() }).optional(),
});
const database = new DatabaseSync(join(runDirectory, 'runtime.sqlite'), { readOnly: true });
const operations = database.prepare('SELECT body FROM runtime_operations').all().map((row) =>
  operationSchema.parse(JSON.parse(String(row.body))));
const completions = database.prepare('SELECT body FROM runtime_completions').all().map((row) =>
  z.object({ message: z.object({ toolCalls: z.array(z.object({ name: z.string() })) }) }).parse(JSON.parse(String(row.body))));
const eventCounts = database.prepare('SELECT type, count(*) AS count FROM runtime_events GROUP BY type').all();
database.close();
const authorId = status.agents[0]!.id;
const editorId = status.agents[1]!.id;
const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const isWrite = (item: z.infer<typeof operationSchema>) =>
  ['file.create', 'file.write', 'file.apply_patch'].includes(item.toolName);
const readResult = z.object({ content: z.string(), truncated: z.boolean().optional() });
const readMatches = (item: z.infer<typeof operationSchema>, digest: string) => {
  const result = readResult.safeParse(item.result);
  return result.success && !result.data.truncated && sha256(result.data.content) === digest;
};
const chapters = [];
for (let index = 1; index <= 10; index++) {
  const number = String(index).padStart(2, '0');
  const name = `第${number}章.md`;
  const path = `workspace://current/交付/${name}`;
  let content: string;
  try { content = await readFile(join(runDirectory, 'workspace/交付', name), 'utf8'); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    chapters.push({ name, chineseCharacters: 0, hasRecord: false, sha256: '',
      authorWrites: 0, authorReads: 0, editorReads: 0, initialReadBeforeRevision: false,
      authorFinalRead: false, finalHashRead: false, confirmedAfterFinalRead: false });
    continue;
  }
  const digest = sha256(content);
  const chapterOperations = operations.filter((item) => item.arguments.path === path && item.state === 'succeeded');
  const writes = chapterOperations.filter((item) => item.agentId === authorId && isWrite(item));
  const firstWriteAt = Math.min(Infinity, ...writes.map((item) => item.schedulerOperation?.startedAt ?? Infinity));
  const lastWriteAt = Math.max(0, ...writes.map((item) => item.schedulerOperation?.startedAt ?? 0));
  const authorReads = chapterOperations.filter((item) => item.agentId === authorId && item.toolName === 'file.read');
  const reads = chapterOperations.filter((item) => item.agentId === editorId && item.toolName === 'file.read');
  const verifiedReads = reads.filter((item) => readMatches(item, digest) &&
    (item.schedulerOperation?.startedAt ?? 0) >= lastWriteAt);
  const readInitial = (item: z.infer<typeof operationSchema>) => {
    const result = readResult.safeParse(item.result);
    const at = item.schedulerOperation?.startedAt ?? 0;
    return result.success && !result.data.truncated && sha256(result.data.content) !== digest &&
      at > firstWriteAt && at < lastWriteAt;
  };
  // 编辑可能使用“已复查通过，确认”表达同一结果，保留原消息供核验。
  const confirmation = messages.findLast((message) => message.sender.kind === 'agent' && message.sender.id === editorId &&
    new RegExp(`(?:已确认|已复查通过[，,]\\s*确认)[：:]\\s*第0?${index}章`, 'u').test(message.content));
  chapters.push({ name, chineseCharacters: (content.match(/\p{Script=Han}/gu) ?? []).length,
    hasRecord: content.includes('本章记录'), sha256: digest,
    authorWrites: writes.length, authorReads: authorReads.length, editorReads: reads.length,
    initialReadBeforeRevision: authorReads.some(readInitial) && reads.some(readInitial),
    authorFinalRead: authorReads.some((item) => readMatches(item, digest) &&
      (item.schedulerOperation?.startedAt ?? 0) >= lastWriteAt),
    finalHashRead: verifiedReads.length > 0,
    confirmation: confirmation ? { content: confirmation.content, createdAt: confirmation.createdAt } : null,
    confirmedAfterFinalRead: !!confirmation && verifiedReads.some((item) =>
      (item.schedulerOperation?.startedAt ?? Infinity) <= confirmation.createdAt) });
}
const tools: Record<string, number> = {};
for (const completion of completions) for (const call of completion.message.toolCalls) tools[call.name] = (tools[call.name] ?? 0) + 1;
const userMessages = messages.filter((message) => message.sender.kind === 'user').length;
const rounds = status.agents.reduce((sum, agent) => sum + agent.rounds, 0);
let manifestContent = '';
try { manifestContent = await readFile(join(runDirectory, 'workspace/交付/交付清单.md'), 'utf8'); }
catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
const manifest = {
  exists: manifestContent.length > 0,
  listsEveryChapter: chapters.every((chapter) => manifestContent.includes(chapter.name)),
  authorWrote: operations.some((item) => item.agentId === authorId && item.state === 'succeeded' &&
    item.arguments.path === 'workspace://current/交付/交付清单.md' && isWrite(item)),
};
const interrupts = status.agents.flatMap((agent) => agent.interrupts);
const interventionRequired = interrupts.some((item) => item.action !== 'retry');
const allSleeping = status.agents.length === 2 && status.agents.every((agent) =>
  agent.state === 'SLEEPING' && agent.error === null);
const editorWriteCount = operations.filter((item) => item.agentId === editorId && isWrite(item)).length;
const delivered = messages.some((message) => message.sender.kind === 'agent' &&
  message.sender.id === authorId && message.content.includes('前十章已交付'));
const passed = status.complete && status.stopReason === 'completed' && userMessages === 1 && rounds >= 60 &&
  allSleeping && !interventionRequired && editorWriteCount === 0 && delivered &&
  manifest.exists && manifest.listsEveryChapter && manifest.authorWrote &&
  chapters.every((chapter) => chapter.chineseCharacters >= 500 && chapter.hasRecord &&
    chapter.authorWrites >= 2 && chapter.editorReads >= 2 && chapter.initialReadBeforeRevision && chapter.authorFinalRead &&
    chapter.finalHashRead && chapter.confirmedAfterFinalRead);
const report = { passed, userMessages, rounds, elapsedSeconds: status.elapsedSeconds,
  agentMessages: messages.filter((message) => message.sender.kind === 'agent').length,
  allSleeping, interventionRequired, editorWriteCount, delivered, manifest,
  agents: status.agents, chapters, tools, eventCounts };
await writeFile(join(runDirectory, 'verification.json'), JSON.stringify(report, null, 2));
await writeFile(join(runDirectory, '验证报告.md'), `# 前十章协作运行验证

- 结果：${passed ? '通过' : '未通过，请检查 verification.json'}
- 初始用户消息：${userMessages}条；Agent 消息：${report.agentMessages}条。
- 累计模型请求：${rounds}次；运行用时：${status.elapsedSeconds}秒。
- 模型用量：${status.agents.reduce((sum, agent) => sum + agent.tokens, 0)} Tokens（Runtime 计量）。
- 核验方式：作者实际写入记录、编辑读取内容的 SHA256、最终确认时间、真实消息与休眠状态。
- 初稿阶段：双方均在修改前读到旧稿；修订阶段：双方均读到最终文件哈希。
- 交付清单：${manifest.exists && manifest.listsEveryChapter && manifest.authorWrote ? '作者实际写入且列全十章' : '未通过'}。
- 最终均休眠：${allSleeping ? '是' : '否'}；需人工处置的中断：${interventionRequired ? '有' : '无'}；编辑写操作：${editorWriteCount}次。
- 本报告不评价小说内容质量。

| 章节 | 汉字数 | 作者写入次数 | 编辑读取次数 | 最终文件哈希已读 | 复读后确认 |
| --- | ---: | ---: | ---: | --- | --- |
${chapters.map((chapter) => `| ${chapter.name} | ${chapter.chineseCharacters} | ${chapter.authorWrites} | ${chapter.editorReads} | ${chapter.finalHashRead ? '是' : '否'} | ${chapter.confirmedAfterFinalRead ? '是' : '否'} |`).join('\n')}

详细来源见同目录的 \`verification.json\`、\`messages.json\`、\`events.json\` 和 \`runtime.sqlite\`。
`);
process.stdout.write(JSON.stringify({ passed, rounds, agentMessages: report.agentMessages, elapsedSeconds: report.elapsedSeconds }) + '\n');
process.exitCode = passed ? 0 : 1;
