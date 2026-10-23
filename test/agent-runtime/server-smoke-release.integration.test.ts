import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('服务器冒烟通过当前原生消息协议，第二批处理确认后才结束', async () => {
  const result = await promisify(execFile)(process.execPath, [
    '--import', 'tsx', '--import', './test/fixtures/server-smoke-fetch.mjs', 'examples/server-live-smoke.ts',
  ], {
    cwd: process.cwd(), timeout: 10_000,
    env: { PATH: process.env.PATH ?? '', MINIMAX_API_KEY: 'offline-smoke-only' },
  });
  expect(result.stdout).toContain('"passed":true');
  expect(result.stdout).toContain('"state":"SLEEPING"');
  expect(result.stderr).not.toContain('再次唤醒后没有');
});
