import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { createModelRequester } from '../model-requester/index.js';
import { createAgentRuntime, runtimeTokenSettingsSchema, runtimeCapabilitySchema } from '../agent-runtime/index.js';
import { registerBuiltinTools } from '../tools/builtin/index.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { DockerProcessSandbox } from '../integrations/index.js';
import { createAgentServer } from './index.js';

const configSchema = z.object({
  database: z.string().default('.server-runtime/runtime.sqlite'),
  host: z.string().default('127.0.0.1'), port: z.number().int().nonnegative().default(8787),
  workspaces: z.record(z.string()),
  profiles: z.record(z.object({
    workspaceId: z.string(), character: z.string(), capabilities: z.array(runtimeCapabilitySchema),
    instructions: z.array(z.string()).optional(),
  }).strict()),
  limits: z.record(z.number().finite().nonnegative()).optional(),
  tokenSettings: runtimeTokenSettingsSchema.optional(),
  dockerImage: z.string().optional(),
}).strict();

async function main(): Promise<void> {
  const configPath = process.env.OS_AGENT_CONFIG ?? 'server.config.json';
  const config = configSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  const key = process.env.MINIMAX_API_KEY;
  const token = process.env.OS_AGENT_TOKEN;
  if (!key || !token) throw new Error('缺少 MINIMAX_API_KEY 或 OS_AGENT_TOKEN 环境变量。');
  const database = resolve(config.database);
  await mkdir(dirname(database), { recursive: true, mode: 0o700 });
  const tools = new ToolRegistry();
  registerBuiltinTools(tools, config.dockerImage ? { processSandbox: new DockerProcessSandbox({ image: config.dockerImage }) } : {});
  const runtime = createAgentRuntime({
    database, workspaces: config.workspaces, tools,
    requester: createModelRequester({ provider: 'minimax', model: process.env.MINIMAX_MODEL ?? 'MiniMax-M2.7',
      apiKey: key, ...(process.env.MINIMAX_BASE_URL ? { baseUrl: process.env.MINIMAX_BASE_URL } : {}) }),
    ...(config.limits ? { limits: config.limits } : {}),
    ...(config.tokenSettings ? { tokenSettings: config.tokenSettings } : {}),
    onEvent: (event) => console.log(JSON.stringify({
      at: event.createdAt, agentId: event.agentId, type: event.type, sequence: event.sequence,
    })),
  });
  const profiles = Object.fromEntries(Object.entries(config.profiles).map(([id, profile]) => [id, {
    workspaceId: profile.workspaceId, character: profile.character, capabilities: profile.capabilities,
    ...(profile.instructions ? { instructions: profile.instructions } : {}),
  }]));
  const server = createAgentServer({
    runtime, profiles, host: config.host, port: config.port,
    principals: [{ token, ownerId: 'local-owner', profiles: Object.keys(profiles) }],
  });
  const address = await server.listen();
  console.log(JSON.stringify({ type: 'listening', ...address }));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.close().then(() => { process.exitCode = 0; }, () => {
      console.error('服务关闭失败。'); process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

void main().catch(() => {
  // 启动异常不输出配置或原始响应，避免凭据进入日志。
  console.error('启动失败，请检查配置、持久目录和模型环境变量。');
  process.exitCode = 1;
});
