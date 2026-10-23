// 宿主输入只使用公开校验契约，运行状态和持久化 schema 留在内部。
export { capabilitySchema as runtimeCapabilitySchema } from './internal/schema.js';
export {
  memoryMemberSchema as conversationMemberSchema,
  readSchema as conversationReadSchema,
  searchSchema as conversationSearchSchema,
  setContactNoteSchema,
} from './internal/memory-schema.js';
