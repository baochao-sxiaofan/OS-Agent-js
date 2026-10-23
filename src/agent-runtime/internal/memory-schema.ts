import { z } from 'zod';

export const memoryMemberSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('agent'), id: z.number().int().positive() }).strict(),
]);
export const memorySourceSchema = z.object({
  conversationId: z.string().min(1).max(200), messageId: z.string().min(1).max(200),
}).strict();
export const digestSchema = z.object({
  overview: z.string().min(1).max(1200),
  unresolved: z.array(z.object({
    text: z.string().min(1).max(400), sourceRefs: z.array(memorySourceSchema).min(1).max(8),
  }).strict()).max(12),
  quotations: z.array(z.object({
    text: z.string().min(1).max(600), sourceRef: memorySourceSchema,
  }).strict()).max(12),
  sourceRefs: z.array(memorySourceSchema).min(1).max(50),
}).strict();
export const conversationSummarySchema = digestSchema.extend({
  conversationId: z.string().min(1), coveredSequence: z.number().int().positive(),
  version: z.number().int().positive(), updatedAt: z.number().int().nonnegative(),
}).strict();
const noteContent = {
  target: memoryMemberSchema, introduction: z.string().max(200), body: z.string().max(6000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  unresolved: z.array(z.string().min(1).max(400)).max(20),
  sourceRefs: z.array(memorySourceSchema).max(50),
};
export const setContactNoteSchema = z.object({
  ...noteContent, expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).max(300),
}).strict();
export const contactNoteSchema = z.object({
  ...noteContent, ownerId: z.string().min(1), author: memoryMemberSchema,
  version: z.number().int().positive(), updatedAt: z.number().int().nonnegative(),
}).strict();
export const searchSchema = z.object({
  query: z.string().trim().min(1).max(200), conversationId: z.string().min(1).optional(),
  sender: memoryMemberSchema.optional(), since: z.number().int().nonnegative().optional(),
  until: z.number().int().nonnegative().optional(), beforeSequence: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(30).optional(),
}).strict();
export const readSchema = z.object({
  conversationId: z.string().min(1), messageId: z.string().min(1).optional(),
  afterSequence: z.number().int().nonnegative().optional(),
  throughSequence: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(30).optional(),
}).strict();
export const memoryActionSchemas = [
  searchSchema.extend({ kind: z.literal('conversation_search') }).strict(),
  readSchema.extend({ kind: z.literal('conversation_read') }).strict(),
  z.object({ kind: z.literal('contact_note_get'), target: memoryMemberSchema,
    offset: z.number().int().nonnegative().default(0) }).strict(),
  setContactNoteSchema.omit({ idempotencyKey: true }).extend({ kind: z.literal('contact_note_set') }).strict(),
] as const;
