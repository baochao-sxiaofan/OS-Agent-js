/** 纯数据 IPC 契约，避免浏览器类型检查加载 Node Runtime 实现。 */
export type ConversationMember = { readonly kind: 'user'; readonly id: string } |
  { readonly kind: 'agent'; readonly id: number };
export type MemorySource = { readonly conversationId: string; readonly messageId: string };
export type ConversationSummary = {
  readonly conversationId: string; readonly overview: string;
  readonly unresolved: readonly { readonly text: string; readonly sourceRefs: readonly MemorySource[] }[];
  readonly quotations: readonly { readonly text: string; readonly sourceRef: MemorySource }[];
  readonly sourceRefs: readonly MemorySource[];
  readonly coveredSequence: number; readonly version: number; readonly updatedAt: number;
};
export type ContactNote = {
  readonly author: ConversationMember; readonly target: ConversationMember;
  readonly introduction: string; readonly body: string;
  readonly tags: readonly string[]; readonly unresolved: readonly string[];
  readonly sourceRefs: readonly MemorySource[]; readonly version: number; readonly updatedAt: number;
};
export type SetContactNote = Pick<ContactNote, 'target' | 'introduction' | 'body' | 'tags' | 'unresolved' | 'sourceRefs'> & {
  readonly expectedVersion: number; readonly idempotencyKey: string;
};
export type ConversationSearch = {
  readonly query: string; readonly conversationId?: string; readonly sender?: ConversationMember;
  readonly since?: number; readonly until?: number; readonly beforeSequence?: number; readonly limit?: number;
};
export type ConversationRead = {
  readonly conversationId: string; readonly messageId?: string; readonly afterSequence?: number;
  readonly throughSequence?: number; readonly offset?: number; readonly limit?: number;
};
export type HistoryExcerpt = {
  readonly conversationId: string; readonly messageId: string; readonly sequence: number;
  readonly sender: ConversationMember; readonly createdAt: number; readonly content: string;
  readonly offset: number; readonly totalLength: number; readonly nextOffset: number | null;
};
export type ConversationSearchResult = {
  readonly hits: readonly HistoryExcerpt[]; readonly nextBeforeSequence: number | null; readonly truncated: boolean;
};
export type ConversationReadResult = {
  readonly messages: readonly HistoryExcerpt[]; readonly next: ConversationRead | null; readonly truncated: boolean;
};
