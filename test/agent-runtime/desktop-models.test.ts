import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopModel } from '../../desktop-next/main/model.js';
import { DesktopStore } from '../../desktop-next/main/store.js';
import { DesktopService } from '../../desktop-next/main/service.js';
import { defaultTokenSettings } from '../../src/agent-runtime/index.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const encrypted = {
  available: () => true,
  encrypt: (value: string) => Buffer.from(value).toString('base64'),
  decrypt: (value: string) => Buffer.from(value, 'base64').toString(),
};
const session = { available: () => false, encrypt: () => { throw new Error('不可用'); }, decrypt: () => '' };
function store(): DesktopStore {
  const result = new DesktopStore(':memory:');
  cleanup.push(() => result.close());
  return result;
}

it('供应商凭据独立，切换与重建后各自恢复型号，演示模式不覆盖连接', async () => {
  const database = store();
  const fetcher: typeof fetch = async (url, init) => {
    const provider = String(url).includes('deepseek') ? 'deepseek' : 'minimax';
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${provider}-test-key` });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '测试回复' } }] });
  };
  let model = new DesktopModel(database, encrypted, '', fetcher);
  model.save({ mode: 'minimax', model: 'custom-minimax', apiKey: 'minimax-test-key' });
  expect(() => model.save({ mode: 'deepseek', model: 'new-deepseek', apiKey: '' })).toThrow('DeepSeek API Key');
  model.save({ mode: 'deepseek', model: 'new-deepseek', apiKey: 'deepseek-test-key' });
  await expect(model.requester.request({ messages: [{ role: 'user', content: '测试' }] })).resolves.toMatchObject({ provider: 'deepseek' });
  model.save({ mode: 'demo', model: 'demo', apiKey: '' });
  model = new DesktopModel(database, encrypted, '', fetcher);
  expect(model.view()).toMatchObject({ mode: 'demo', hasKey: false, connections: {
    minimax: { model: 'custom-minimax', hasKey: true, keyStorage: 'encrypted' },
    deepseek: { model: 'new-deepseek', hasKey: true, keyStorage: 'encrypted' },
  } });
  model.save({ mode: 'minimax', model: model.view().connections.minimax.model, apiKey: '' });
  expect(model.requester.provider).toBe('minimax');
  expect(model.requester.model).toBe('custom-minimax');
  await expect(model.requester.request({ messages: [{ role: 'user', content: '测试' }] })).resolves.toMatchObject({ provider: 'minimax' });
  expect(JSON.stringify(model.view())).not.toContain('test-key');
  expect(JSON.stringify(database.model())).not.toContain('test-key');
});

it('发现型号可使用临时 Key，不更改保存连接，也不能借用其他供应商的 Key', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.headers).toMatchObject({ authorization: 'Bearer temporary-key' });
    return Response.json({ object: 'list', data: [{ id: 'dynamic-model' }] });
  });
  const database = store();
  const model = new DesktopModel(database, encrypted, { minimax: 'minimax-env-key' }, fetcher);
  const before = database.model();
  await expect(model.listModels({ provider: 'deepseek', apiKey: '' })).rejects.toMatchObject({ code: 'invalid_request' });
  expect(fetcher).not.toHaveBeenCalled();
  await expect(model.listModels({ provider: 'deepseek', apiKey: 'temporary-key' })).resolves.toMatchObject({
    models: [{ id: 'dynamic-model' }],
  });
  expect(database.model()).toEqual(before);
  expect(model.view().connections.deepseek.hasKey).toBe(false);
});

it('保存过的 DeepSeek Key 可用于刷新列表，解密失败不借用 MiniMax 环境变量', async () => {
  const database = store();
  new DesktopModel(database, encrypted).save({ mode: 'deepseek', model: 'selected', apiKey: 'deepseek-test-key' });
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.headers).toMatchObject({ authorization: 'Bearer deepseek-test-key' });
    return Response.json({ object: 'list', data: [{ id: 'selected' }] });
  });
  await new DesktopModel(database, encrypted, '', fetcher).listModels({ provider: 'deepseek', apiKey: '' });
  expect(fetcher).toHaveBeenCalledOnce();
  const broken = new DesktopModel(database, { ...encrypted, decrypt: () => { throw new Error('解密失败'); } },
    'minimax-only');
  expect(broken.view().connections.deepseek.hasKey).toBe(false);
  expect(() => broken.requester.request({ messages: [{ role: 'user', content: '测试' }] })).toThrow('API Key');
  broken.save({ mode: 'demo', model: 'demo', apiKey: '' });
  expect(database.model().connections.deepseek.encryptedKey).toBe(encrypted.encrypt('deepseek-test-key'));
});

it('无安全存储时仅会话内保存 Key，环境变量按供应商读取', () => {
  const database = store();
  const model = new DesktopModel(database, session, { deepseek: 'deepseek-env-key' });
  expect(model.view().connections.deepseek.keyStorage).toBe('environment');
  expect(model.view().connections.minimax.hasKey).toBe(false);
  model.save({ mode: 'minimax', model: 'MiniMax-M2.5', apiKey: 'session-key' });
  model.save({ mode: 'deepseek', model: 'selected', apiKey: '' });
  expect(model.view().connections.minimax.keyStorage).toBe('session');
  expect(model.view().connections.deepseek.keyStorage).toBe('environment');
  expect(JSON.stringify(database.model())).not.toContain('key');
  const restarted = new DesktopModel(database, session);
  expect(restarted.view().connections.minimax.hasKey).toBe(false);
  expect(restarted.view().connections.deepseek.hasKey).toBe(false);
});

it('旧版单连接配置迁移保留密文、型号、容量和联系人', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-model-migrate-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'desktop.sqlite');
  const initial = new DesktopStore(path);
  initial.setProfile(1, '原联系人', 5);
  initial.close();
  const db = new DatabaseSync(path);
  const tokens = { ...defaultTokenSettings, maxTotalTokens: 99_000_000 };
  db.prepare("INSERT INTO settings VALUES ('model',?)").run(JSON.stringify({
    mode: 'minimax', model: 'legacy-model', encryptedKey: encrypted.encrypt('legacy-test-key'), tokens,
  }));
  db.close();
  const migrated = new DesktopStore(path);
  cleanup.push(() => migrated.close());
  const model = new DesktopModel(migrated, encrypted);
  expect(model.view()).toMatchObject({ mode: 'minimax', model: 'legacy-model', hasKey: true, tokens });
  expect(model.view().connections.deepseek).toMatchObject({ hasKey: false, model: '' });
  model.save({ mode: 'deepseek', model: 'new-model', apiKey: 'deepseek-key' });
  expect(migrated.model()).toMatchObject({ version: 2, tokens,
    connections: { minimax: { model: 'legacy-model', encryptedKey: encrypted.encrypt('legacy-test-key') } } });
  expect(migrated.profile(1)).toEqual({ name: '原联系人', readCount: 5 });
});

it('IPC 型号发现拒绝外部地址和未知供应商，不触发模型执行', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-catalog-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const desktop = new DesktopService(directory, session);
  cleanup.push(() => desktop.close());
  await desktop.initialize();
  expect(() => desktop.listModels({ provider: 'deepseek', apiKey: '', baseUrl: 'https://untrusted.example' })).toThrow();
  expect(() => desktop.listModels({ provider: 'unknown', apiKey: '' })).toThrow();
  await expect(desktop.listModels({ provider: 'minimax', apiKey: '' })).resolves.toMatchObject({ source: 'builtin' });
  expect(desktop.snapshot().contacts).toEqual([]);
  expect(desktop.snapshot().settings.mode).toBe('demo');
});
