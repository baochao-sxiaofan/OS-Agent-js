import { z } from 'zod';
import { jsonSchema } from '../../types/json-schema.js';
import { contextSummarySchema } from '../../agent-context/index.js';
import { memoryActionSchemas } from './memory-schema.js';

export { jsonSchema } from '../../types/json-schema.js';
export const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('exact'), resource: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('subtree'), resource: z.string().min(1) }).strict(),
]);
export const capabilitySchema = z.object({
  capability: z.string().min(1), scope: scopeSchema, reason: z.string().optional(),
}).strict().transform(({ capability, scope, reason }) => ({
  capability, scope, ...(reason === undefined ? {} : { reason }),
}));
export const createRuntimeAgentSchema = z.object({
  ownerId: z.string().trim().min(1), workspaceId: z.string().min(1), character: z.string().min(1),
  objective: z.string().trim().min(1).max(12_000),
  instructions: z.array(z.string().min(1)).optional(), capabilities: z.array(capabilitySchema),
  startMode: z.enum(['immediate', 'on_message']).optional(),
  displayName: z.string().trim().min(1).max(80).optional(),
}).strict();
export const cursorSchema = z.object({
  frameId: z.string().min(1), planRevision: z.number().int().nonnegative(),
}).strict();
export const inputSchema = z.object({
  agentId: z.number().int().positive(), content: z.string(), target: cursorSchema.optional(),
  createdAt: z.number().int().nonnegative().optional(), sender: z.string().min(1).optional(),
}).strict();
const vendorSchema = z.enum(['minimax', 'deepseek', 'anthropic', 'openai', 'gemini']);
const assistantSchema = z.object({
  role: z.literal('assistant'), content: z.string(),
  toolCalls: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), arguments: z.record(jsonSchema) }).strict()),
  continuation: z.object({ provider: vendorSchema, model: z.string().min(1), data: z.record(jsonSchema) }).strict().optional(),
}).strict();
export const completionSchema = z.object({
  id: z.string().optional(), provider: vendorSchema, model: z.string().min(1),
  message: assistantSchema, finishReason: z.enum(['stop', 'tool_calls', 'length', 'content_filter', 'unknown']),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative() }).strict(),
}).strict();
export const requestSchema = z.object({
  messages: z.array(z.union([
    z.object({ role: z.literal('system'), content: z.string() }).strict(),
    z.object({ role: z.literal('user'), content: z.union([z.string(), z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }).strict(),
      z.object({ type: z.literal('image'), url: z.string() }).strict(),
      z.object({ type: z.literal('video'), url: z.string(), fps: z.number().positive().optional() }).strict(),
    ]))]) }).strict(),
    assistantSchema,
    z.object({ role: z.literal('tool'), callId: z.string(), content: jsonSchema }).strict(),
  ])),
  tools: z.array(z.object({ name: z.string(), description: z.string(), parameters: z.record(jsonSchema) }).strict()).optional(),
  toolChoice: z.union([z.enum(['auto', 'none', 'required']), z.object({ name: z.string() }).strict()]).optional(),
  maxOutputTokens: z.number().int().positive().optional(), temperature: z.number().finite().optional(),
  parallelToolCalls: z.boolean().optional(),
}).strict();
export const summarySchema = contextSummarySchema;
export const decisionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('plan'), objectives: z.array(z.string().min(1)).min(1).max(12) }).strict(),
  z.object({ type: z.literal('replan'), objectives: z.array(z.string().min(1)).min(1).max(12), reason: z.string().min(1) }).strict(),
  z.object({ type: z.literal('advance') }).strict(),
  z.object({ type: z.literal('step_completed'), result: summarySchema }).strict(),
  z.object({ type: z.literal('complete') }).strict(),
  z.object({ type: z.literal('interrupt'), reason: z.string().min(1) }).strict(),
  z.object({ type: z.literal('compact') }).strict(),
  z.object({ type: z.literal('idle') }).strict(),
  z.object({ type: z.literal('finish_turn') }).strict(),
  z.object({ type: z.literal('continue') }).strict(),
  z.object({ type: z.literal('wait') }).strict(),
]);
export const operationSchema = z.object({
  agentId: z.number().int().positive(), operationId: z.string().min(1), originRunId: z.string().min(1),
  startedAt: z.number().int().nonnegative(), deadline: z.number().int().positive(), state: z.literal('RUNNING'),
}).strict();
const outcomeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('succeeded'), resultRef: z.string().min(1) }).strict(),
  z.object({ type: z.literal('failed'), error: z.string().min(1), resultRef: z.string().optional() }).strict(),
  z.object({ type: z.literal('cancelled'), reason: z.string().min(1) }).strict(),
  z.object({ type: z.literal('timed_out') }).strict(),
]);
const resultSchema = z.object({
  operation: operationSchema, completedAt: z.number().int().nonnegative(), outcome: outcomeSchema,
}).strict();
const wakeSchema = z.object({ eventId: z.string().min(1), eventRef: z.string().min(1) }).strict();
const batchSchema = z.object({
  agentId: z.number().int().positive(), batchId: z.string().min(1), sealedAt: z.number().int().nonnegative(),
  results: z.array(resultSchema), events: z.array(wakeSchema), pendingOperations: z.array(operationSchema),
  continuation: z.boolean(),
}).strict();
export const scheduleSchema = z.object({
  schemaVersion: z.literal(1), agentId: z.number().int().positive(),
  state: z.enum(['READY', 'RUNNING', 'BLOCKED', 'SLEEPING']),
  pendingOperations: z.array(operationSchema), completedResults: z.array(resultSchema),
  pendingEvents: z.array(wakeSchema), queuedBatch: batchSchema.nullable(),
  running: z.object({ agentId: z.number().int().positive(), runId: z.string().min(1), batch: batchSchema }).strict().nullable(),
  batchDueAt: z.number().int().nonnegative().nullable(),
  suspension: z.object({ reason: z.string().min(1), resumeAt: z.number().int().positive().nullable() }).strict().nullable(),
  continuation: z.boolean(), recentEventIds: z.array(z.string().min(1)),
}).strict().superRefine((checkpoint, issue) => {
  const batches = [checkpoint.queuedBatch, checkpoint.running?.batch].filter((item) => item != null);
  const operations = [...checkpoint.pendingOperations, ...checkpoint.completedResults.map((item) => item.operation),
    ...batches.flatMap((item) => [...item.pendingOperations, ...item.results.map((result) => result.operation)])];
  if (operations.some((item) => item.agentId !== checkpoint.agentId || item.deadline <= item.startedAt) ||
      batches.some((item) => item.agentId !== checkpoint.agentId) ||
      checkpoint.running && (checkpoint.running.agentId !== checkpoint.agentId || checkpoint.queuedBatch)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, message: '调度恢复记录身份或期限不一致。' });
  }
});

/** 模型动作只能通过这个协议进入运行时，拒绝身份和权限额外字段。 */
export const actionSchema = z.discriminatedUnion('kind', [
  ...memoryActionSchemas,
  z.object({ kind: z.literal('context'), decision: decisionSchema }).strict(),
  z.object({ kind: z.literal('tools'), calls: z.array(z.object({
    name: z.string().min(1), arguments: z.record(jsonSchema),
  }).strict()).min(1).max(8) }).strict(),
  z.object({ kind: z.literal('message'), recipient: z.string().min(1), content: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('send_message'), conversationId: z.string().min(1),
    content: z.string().min(1), replyTo: z.string().min(1).optional(),
    mentions: z.array(z.number().int().positive()).max(32).optional(), finish: z.boolean().default(false),
  }).strict(),
  z.object({ kind: z.literal('output'), content: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('artifact'), ref: z.string().min(1), offset: z.number().int().nonnegative().default(0) }).strict(),
]);
export type RuntimeAction = z.infer<typeof actionSchema>;

const grantSchema = z.object({
  grantId: z.string().min(1), subjectTaskId: z.string().min(1), capability: z.string().min(1),
  scope: scopeSchema, source: z.discriminatedUnion('type', [
    z.object({ type: z.literal('root') }).strict(),
    z.object({ type: z.literal('human'), approvalRequestId: z.string() }).strict(),
  ]),
  delegable: z.literal(false), issuedAt: z.number().int().nonnegative(),
  execution: z.enum(['allowed', 'human_approval_required']).optional(),
  expiresAt: z.number().int().positive().optional(), remainingUses: z.number().int().nonnegative().optional(),
  consumedBy: z.string().optional(),
}).strict();
export const runtimeAgentSchema = z.object({
  schemaVersion: z.literal(2),
  control: z.object({
    agentId: z.number().int().positive(), character: z.string().min(1), agentName: z.string().min(1),
    state: z.enum(['READY', 'RUNNING', 'BLOCKED', 'SLEEPING']),
    capacity: z.array(z.object({ capability: z.string().min(1), scope: scopeSchema }).strict()),
    skills: z.array(z.string().min(1)), context: jsonSchema,
    createdAt: z.number().int().nonnegative(), modelConfigId: z.string().min(1),
  }).strict(),
  ownerId: z.string().min(1), workspaceId: z.string().min(1), contextKey: z.string().min(1),
  ceiling: z.array(capabilitySchema), grants: z.array(grantSchema),
  status: z.enum(['active', 'paused', 'cancelled']), rounds: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(), costUsd: z.number().finite().nonnegative(),
  lastAction: z.string(), repeatedActions: z.number().int().nonnegative(), lastError: z.string().nullable(),
}).strict();

/** 拒绝旧模型自动创建的身份，不把旧任务树静默转换为用户创建记录。 */
export function parseRuntimeAgent(value: unknown) {
  if (value !== null && typeof value === 'object' &&
      (!('schemaVersion' in value) || value.schemaVersion !== 2 ||
        ['parentId', 'parentTarget', 'childKey', 'depth'].some((key) => key in value))) {
    throw new Error('旧版父子 Agent 快照不能自动恢复；请保留原数据库，由用户在新数据库中创建长期 Agent。');
  }
  return runtimeAgentSchema.parse(value);
}
export const executionSchema = z.object({
  id: z.string().min(1), agentId: z.number().int().positive(), batchId: z.string().min(1),
  target: cursorSchema, toolName: z.string().min(1), arguments: z.record(jsonSchema),
  state: z.enum(['registered', 'running', 'succeeded', 'failed', 'approval', 'unknown']),
  effect: z.enum(['read_only', 'side_effect', 'privileged']),
  schedulerOperation: operationSchema.nullable(), result: jsonSchema,
}).strict();
