import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import type { JsonObject } from '../types/json.js';
import type { ToolExecutionContext } from './tool.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Persist intent before writing, then reconcile the resulting bytes after a crash. */
export async function replaceTextFileOnce(
  path: string, input: JsonObject, context: ToolExecutionContext,
  transform: (original: string) => string,
): Promise<JsonObject> {
  const key = `file-edit:${context.idempotencyKey}`;
  const fingerprint = hash(JSON.stringify({ path, input }));
  const prior = context.operationStore?.get(key);
  if (prior && prior['fingerprint'] !== fingerprint) throw new Error('File operation key was reused with different parameters.');
  if (prior?.['state'] === 'completed') return { path: String(input['path']), replaced: true, bytesWritten: Number(prior['bytesWritten']) };
  context.signal.throwIfAborted();
  const original = await readFile(path, { encoding: 'utf8', signal: context.signal });
  if (prior && hash(original) === prior['afterHash']) {
    context.operationStore?.set(key, { ...prior, state: 'completed' });
    return { path: String(input['path']), replaced: true, bytesWritten: Number(prior['bytesWritten']) };
  }
  if (prior && hash(original) !== prior['beforeHash']) throw new Error('File changed after an interrupted edit; refusing to apply the patch again.');
  const updated = transform(original);
  const record = { fingerprint, beforeHash: hash(original), afterHash: hash(updated), bytesWritten: Buffer.byteLength(updated), state: 'prepared' };
  context.operationStore?.set(key, record);
  const temporary = `${path}.os-agent-${randomUUID()}.tmp`;
  try {
    const metadata = await stat(path);
    await writeFile(temporary, updated, { encoding: 'utf8', flag: 'wx', mode: metadata.mode, signal: context.signal });
    context.signal.throwIfAborted();
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
  context.operationStore?.set(key, { ...record, state: 'completed' });
  return { path: String(input['path']), replaced: true, bytesWritten: record.bytesWritten };
}
