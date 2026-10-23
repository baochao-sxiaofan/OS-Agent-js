import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** 同一结构同时用于模型输出 schema 和上下文状态校验。 */
export const contextSummarySchema = z.object({
  outcome: z.string().min(1),
  observations: z.array(z.object({
    kind: z.enum(['fact', 'hypothesis']), statement: z.string().min(1),
    sourceRefs: z.array(z.string().min(1)),
  }).strict()),
  decisions: z.array(z.string().min(1)), artifactRefs: z.array(z.string().min(1)),
  unresolved: z.array(z.string().min(1)), nextResponsibilities: z.array(z.string().min(1)),
  lessonCandidates: z.array(z.object({
    statement: z.string().min(1), scope: z.string().min(1), sourceRefs: z.array(z.string().min(1)),
  }).strict()),
  sourceRefs: z.array(z.string().min(1)),
}).strict();

export const contextSummaryJsonSchema = zodToJsonSchema(contextSummarySchema) as import('../types/json.js').JsonObject;
