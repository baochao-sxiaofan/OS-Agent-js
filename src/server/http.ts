import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { jsonSchema } from '../types/json-schema.js';
import {
  conversationMemberSchema as memoryMemberSchema, conversationReadSchema as readSchema,
  conversationSearchSchema as searchSchema, setContactNoteSchema,
} from '../agent-runtime/index.js';
import type { AgentServer, AgentServerOptions } from './api.js';

const createSchema = z.object({
  profile: z.string().min(1), objective: z.string().min(1).max(12_000),
}).strict();
const messageSchema = z.object({
  content: z.string().min(1).max(12_000), idempotencyKey: z.string().min(1).max(256),
}).strict();
const chatMessageSchema = messageSchema.extend({
  replyTo: z.string().min(1).optional(), mentions: z.array(z.number().int().positive()).max(32).optional(),
}).strict();
const conversationSchema = z.object({
  workspaceId: z.string().min(1), kind: z.enum(['direct', 'group']),
  title: z.string().max(100).optional(), agentIds: z.array(z.number().int().positive()).min(1).max(31),
  participation: z.enum(['all', 'mentioned']).optional(),
}).strict();

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > 64 * 1024) throw new Error('请求体超过限制。');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
}
function reply(response: ServerResponse, status: number, value: object): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}

export function createAgentServer(options: AgentServerOptions): AgentServer {
  if (!options.principals.length || options.principals.some((item) => item.token.length < 16)) {
    throw new Error('服务必须配置至少一个足够长的认证令牌。');
  }
  let closing = false;
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) reply(response, 400, { error: '请求无效、资源不可用或不属于当前身份。' });
      else response.end();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 64;
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      reply(response, 200, { healthy: true }); return;
    }
    if (request.method === 'GET' && url.pathname === '/readyz') {
      const ready = !closing && options.runtime.isReady();
      reply(response, ready ? 200 : 503, { ready }); return;
    }
    if (closing || !options.runtime.isReady()) { reply(response, 503, { error: '服务未就绪或正在停止。' }); return; }
    const auth = request.headers.authorization ?? '';
    const token = createHash('sha256').update(auth.startsWith('Bearer ') ? auth.slice(7) : '').digest();
    const principal = options.principals.find((item) => timingSafeEqual(token,
      createHash('sha256').update(item.token).digest()));
    if (!principal) { reply(response, 401, { error: '需要有效认证。' }); return; }
    if (url.pathname === '/v1/agents' && request.method === 'GET') {
      reply(response, 200, { agents: options.runtime.list(principal.ownerId) }); return;
    }
    if (url.pathname === '/v1/agents' && request.method === 'POST') {
      const input = createSchema.parse(await body(request));
      const profile = options.profiles[input.profile];
      if (!profile || !principal.profiles.includes(input.profile)) throw new Error('配置不可用。');
      const agent = await options.runtime.createAgent({ ...profile, ownerId: principal.ownerId, objective: input.objective });
      reply(response, 201, { agent }); return;
    }
    if (url.pathname === '/v1/conversations' && request.method === 'GET') {
      reply(response, 200, { conversations: options.runtime.conversations(principal.ownerId) }); return;
    }
    if (url.pathname === '/v1/conversations' && request.method === 'POST') {
      const input = conversationSchema.parse(await body(request));
      const conversation = options.runtime.createConversation({
        ownerId: principal.ownerId, workspaceId: input.workspaceId, kind: input.kind,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.participation ? { participation: input.participation } : {}),
        members: [{ kind: 'user', id: principal.ownerId }, ...input.agentIds.map((id) => ({ kind: 'agent' as const, id }))],
      });
      reply(response, 201, { conversation }); return;
    }
    const memory = /^\/v1\/memory\/(search|read|notes)$/u.exec(url.pathname);
    if (memory) {
      const inspectAgentId = url.searchParams.has('inspectAgentId')
        ? z.coerce.number().int().positive().parse(url.searchParams.get('inspectAgentId')) : undefined;
      if (memory[1] === 'notes' && request.method === 'GET') {
        reply(response, 200, { notes: options.runtime.contactNotes(principal.ownerId, inspectAgentId) });
      } else if (memory[1] === 'notes' && request.method === 'PUT') {
        if (inspectAgentId !== undefined) throw new Error('管理视角只读。');
        const input = setContactNoteSchema.parse(await body(request));
        reply(response, 200, { note: options.runtime.setContactNote(principal.ownerId, input) });
      } else if (memory[1] === 'search' && request.method === 'POST') {
        const input = searchSchema.parse(await body(request));
        reply(response, 200, options.runtime.searchConversations(principal.ownerId, {
          query: input.query,
          ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
          ...(input.sender !== undefined ? { sender: input.sender } : {}),
          ...(input.since !== undefined ? { since: input.since } : {}),
          ...(input.until !== undefined ? { until: input.until } : {}),
          ...(input.beforeSequence !== undefined ? { beforeSequence: input.beforeSequence } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        }, inspectAgentId));
      } else if (memory[1] === 'read' && request.method === 'POST') {
        const input = readSchema.parse(await body(request));
        reply(response, 200, options.runtime.readConversation(principal.ownerId, {
          conversationId: input.conversationId,
          ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
          ...(input.afterSequence !== undefined ? { afterSequence: input.afterSequence } : {}),
          ...(input.throughSequence !== undefined ? { throughSequence: input.throughSequence } : {}),
          ...(input.offset !== undefined ? { offset: input.offset } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        }, inspectAgentId));
      } else reply(response, 405, { error: '请求方法无效。' });
      return;
    }
    if (url.pathname === '/v1/memory/note' && request.method === 'POST') {
      const target = memoryMemberSchema.parse(await body(request));
      const inspectAgentId = url.searchParams.has('inspectAgentId')
        ? z.coerce.number().int().positive().parse(url.searchParams.get('inspectAgentId')) : undefined;
      reply(response, 200, { note: options.runtime.contactNote(principal.ownerId, target, inspectAgentId) }); return;
    }
    const chat = /^\/v1\/conversations\/([a-f0-9-]+)\/(messages|mailboxes|summary)$/u.exec(url.pathname);
    if (chat) {
      const id = chat[1]!;
      if (request.method === 'GET') {
        const inspectAgentId = url.searchParams.has('inspectAgentId')
          ? z.coerce.number().int().positive().parse(url.searchParams.get('inspectAgentId')) : undefined;
        reply(response, 200, chat[2] === 'summary'
          ? { summary: options.runtime.conversationSummary(id, principal.ownerId, inspectAgentId) } : chat[2] === 'messages'
          ? { messages: options.runtime.conversationMessages(id, principal.ownerId, inspectAgentId) }
          : { mailboxes: options.runtime.conversationMailboxes(id, principal.ownerId, inspectAgentId) });
      } else if (request.method === 'POST' && chat[2] === 'messages') {
        const input = chatMessageSchema.parse(await body(request));
        const message = options.runtime.sendMessage(id, principal.ownerId, {
          content: input.content, idempotencyKey: input.idempotencyKey,
          ...(input.replyTo ? { replyTo: input.replyTo } : {}), ...(input.mentions ? { mentions: input.mentions } : {}),
        });
        reply(response, 201, { message });
      } else reply(response, 405, { error: '请求方法无效。' });
      return;
    }
    const match = /^\/v1\/agents\/([1-9]\d*)(?:\/([a-z]+))?$/u.exec(url.pathname);
    if (!match) { reply(response, 404, { error: '接口不存在。' }); return; }
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id)) throw new Error('身份无效。');
    const action = match[2];
    options.runtime.inspect(id, principal.ownerId);
    if (!action && request.method === 'DELETE') {
      await options.runtime.dismiss(id, principal.ownerId);
      reply(response, 200, { agent: options.runtime.inspect(id, principal.ownerId) }); return;
    }
    if (!action && request.method === 'GET') {
      reply(response, 200, { agent: options.runtime.inspect(id, principal.ownerId) }); return;
    }
    if (action === 'events' && request.method === 'GET') {
      const after = z.coerce.number().int().nonnegative().parse(url.searchParams.get('after') ?? 0);
      reply(response, 200, { events: options.runtime.events(id, principal.ownerId, after) }); return;
    }
    if (action === 'messages' && request.method === 'GET') {
      reply(response, 200, { messages: options.runtime.messages(id, principal.ownerId) }); return;
    }
    if (action === 'conversations' && request.method === 'GET') {
      reply(response, 200, { conversations: options.runtime.agentConversations(id, principal.ownerId) }); return;
    }
    if (action === 'legacy' && request.method === 'GET') {
      reply(response, 200, { messages: options.runtime.legacyMessages(id, principal.ownerId) }); return;
    }
    if (action === 'interrupts' && request.method === 'GET') {
      reply(response, 200, { interrupts: options.runtime.interrupts(id, principal.ownerId) }); return;
    }
    if (action === 'approvals' && request.method === 'GET') {
      reply(response, 200, { approvals: options.runtime.approvals(id, principal.ownerId) }); return;
    }
    if (request.method !== 'POST') { reply(response, 405, { error: '请求方法无效。' }); return; }
    if (action === 'messages') {
      const input = messageSchema.parse(await body(request));
      options.runtime.submit(id, principal.ownerId, input.content, input.idempotencyKey);
    } else if (action === 'pause') await options.runtime.pause(id, principal.ownerId);
    else if (action === 'resume') options.runtime.resume(id, principal.ownerId);
    else if (action === 'dismiss') await options.runtime.dismiss(id, principal.ownerId);
    else if (action === 'cancel') await options.runtime.cancel(id, principal.ownerId);
    else if (action === 'approvals') {
      const input = z.object({ operationId: z.string().min(1), allowed: z.boolean() }).strict().parse(await body(request));
      options.runtime.approve(id, principal.ownerId, input.operationId, input.allowed);
    } else if (action === 'reconcile') {
      const input = z.object({
        operationId: z.string().min(1), outcome: z.enum(['succeeded', 'failed']), result: jsonSchema,
      }).strict().parse(await body(request));
      options.runtime.reconcile(id, principal.ownerId, input.operationId, { outcome: input.outcome, result: input.result });
    } else { reply(response, 404, { error: '接口不存在。' }); return; }
    reply(response, 202, { accepted: true });
  }
  return {
    async listen() {
      try {
        await options.runtime.initialize();
        options.runtime.start();
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(options.port ?? 8787, options.host ?? '127.0.0.1', () => {
            server.removeListener('error', reject); resolve();
          });
        });
      } catch (error) { await options.runtime.close(); throw error; }
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('服务器地址无效。');
      return { host: options.host ?? '127.0.0.1', port: address.port };
    },
    async close() {
      closing = true;
      const connections = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      await options.runtime.close();
      await connections;
    },
  };
}
