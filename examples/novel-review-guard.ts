import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

// 只校验诊断所需的持久事实字段，示例不绑定 Runtime 内部 TypeScript 类型。
const operationSchema = z.object({
  id: z.string(), toolName: z.string(), state: z.string(),
  arguments: z.object({ path: z.string().optional() }).passthrough(),
  schedulerOperation: z.object({ startedAt: z.number() }).nullable(),
  result: z.unknown(),
});

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 只核实真实读稿证据，不生成审稿意见，也不替编辑发言。 */
export function verifyNovelReview(
  database: string, directory: string, editorId: number, content: string, inlineCharacters: number,
): string | null {
  const names = readdirSync(directory);
  const files = names.filter((name) => /^第\d{2}章\.md$/u.test(name)).sort();
  if (!files.length) return null;
  const finalReview = content.includes('前十章终审通过');
  if (finalReview && files.length !== 10) return '前十章尚未全部落盘，不能发出终审通过。';
  const targets = finalReview ? files : files.slice(-1);
  const readAfter = finalReview ? statSync(join(directory, files.at(-1)!)).mtimeMs : 0;
  const canon = '运行校对口径.md';
  const reviewFiles = names.includes(canon) ? [...targets, canon] : targets;
  const connection = new DatabaseSync(database, { readOnly: true });
  try {
    const operations = connection.prepare(
      'SELECT body FROM runtime_operations WHERE agent_id = ? ORDER BY rowid DESC',
    ).all(editorId).map((row) => operationSchema.parse(JSON.parse(String(row.body))));
    const inline = new Set<string>();
    const pages = new Map<string, [number, number | null][]>();
    function visit(value: unknown): void {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== 'object') return;
      const entry = value as Record<string, unknown>;
      if (entry.kind === 'tool_result' && entry.output && typeof entry.output === 'object' &&
          'result' in entry.output && typeof entry.callId === 'string') inline.add(entry.callId);
      if (entry.name === 'artifact_page' && entry.data && typeof entry.data === 'object') {
        const page = entry.data as { ref: string; offset: number; nextOffset: number | null };
        const ranges = pages.get(page.ref) ?? [];
        ranges.push([page.offset, page.nextOffset]); pages.set(page.ref, ranges);
      }
      Object.values(entry).forEach(visit);
    }
    for (const table of ['agent_context_states', 'agent_context_records']) {
      for (const row of connection.prepare(`SELECT body FROM ${table} WHERE agent_key LIKE ?`).all(`agent:${editorId}:%`)) {
        visit(JSON.parse(String(row.body)));
      }
    }
    for (const name of reviewFiles) {
      const manuscript = readFileSync(join(directory, name), 'utf8');
      if (targets.includes(name) && (finalReview || content.includes('验收通过')) &&
          (manuscript.match(/\p{Script=Han}/gu) ?? []).length < 2000) {
        return `${name}实际汉字数不足2000，不能验收通过；请提出修改意见，作者补足后重新实读。`;
      }
      const hash = digest(manuscript);
      const path = `workspace://current/${basename(directory)}/${name}`;
      // Unchanged reference material stays valid; changed files still require a matching full read.
      const threshold = name === canon ? 0 : readAfter;
      const operation = operations.find((item) => {
        if (item.toolName !== 'file.read' || item.state !== 'succeeded' || item.arguments.path !== path ||
            (item.schedulerOperation?.startedAt ?? 0) < threshold) return false;
        const result = item.result as { content?: string; truncated?: boolean } | null;
        return result?.truncated === false && typeof result.content === 'string' && digest(result.content) === hash;
      });
      if (!operation) return `本次message_send未发送：缺少最新稿件的完整读稿证据。下一步先实际调用file.read({"path":"${path}"})，读完后再发送审稿消息；作者可能在你上次读取后改稿，旧工具回执和摘要不代表当前版本。`;
      if (inline.has(operation.id)) continue;
      const text = JSON.stringify(operation.result);
      const version = digest(JSON.stringify([operation.state, operation.result]));
      const ref = `artifact://operation/${operation.id}/${version}`;
      let covered = Math.min(3000, inlineCharacters, text.length);
      for (const [start, end] of (pages.get(ref) ?? []).sort((left, right) => left[0] - right[0])) {
        if (start <= covered) covered = Math.max(covered, end ?? text.length);
      }
      if (covered < text.length) return `审稿发送前必须读完 ${path} 的全部artifact分页；请从工具结果nextOffset继续，不将preview当成全文。`;
    }
    return null;
  } finally { connection.close(); }
}
