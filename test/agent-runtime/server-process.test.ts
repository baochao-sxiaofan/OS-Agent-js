import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('服务器入口收到 SIGTERM 后退出，释放持久数据库并允许再次启动', async () => {
  const path = await mkdtemp(join(tmpdir(), 'server-process-'));
  const config = join(path, 'server.config.json');
  await writeFile(config, JSON.stringify({
    database: join(path, 'runtime.sqlite'), host: '127.0.0.1', port: 0,
    workspaces: { work: path }, profiles: {},
  }));
  async function startAndStop(): Promise<void> {
    // 无业务请求，不调用模型服务；这里的环境值仅用于通过启动边界校验。
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, OS_AGENT_CONFIG: config,
        MINIMAX_API_KEY: 'unused-local-test-value', OS_AGENT_TOKEN: 'server-process-test-token' },
    });
    const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    try {
      const deadline = Date.now() + 3000;
      while (!output.includes('"type":"listening"')) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error('服务器未正常启动。');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const address = JSON.parse(output.trim()) as { port: number };
      expect((await fetch(`http://127.0.0.1:${address.port}/readyz`)).status).toBe(200);
      child.kill('SIGTERM');
      expect(await exit).toBe(0);
    } finally { child.kill('SIGKILL'); }
  }
  try { await startAndStop(); await startAndStop(); }
  finally { await rm(path, { recursive: true, force: true }); }
});
