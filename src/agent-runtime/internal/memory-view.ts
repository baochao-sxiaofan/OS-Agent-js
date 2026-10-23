import { estimateContextTokens } from '../../agent-context/index.js';
import type { ConversationMember } from '../conversations.js';
import type { ConversationMemoryPolicy, ConversationSummary, HistoryExcerpt } from '../memory.js';
import { memberKey } from './conversations.js';
import { ConversationMemoryStore, excerpt, type MemoryIdentity } from './memory-store.js';

export const defaultMemoryPolicy: ConversationMemoryPolicy = {
  maxViewTokens: 4000, recentConversations: 10, recentMessages: 50,
  compactAfterMessages: 20, compactAfterTokens: 12_000, maxSummaryAttempts: 3, failureCooldownMs: 60_000,
};
type MemoryConversation = {
  id: string; title: string; members: readonly ConversationMember[]; latestSequence: number;
  latestMessageAt: number;
  coveredSequence: number; summary: ConversationSummary | null; summaryOmitted: boolean;
  delta: HistoryExcerpt[]; deltaOmitted: boolean;
};
type NotePreview = {
  target: ConversationMember; version: number; introduction: string; tags: readonly string[];
  excerpt: string; truncated: boolean;
};
export type MemoryView = {
  purpose: 'historical_reference_only'; tokenBudget: number; omittedConversations: number;
  conversations: MemoryConversation[]; notes: NotePreview[]; omittedNotes: number;
};

/** 增量和备注只在请求时拼装，不写入当前会话任务现场。 */
export function composeMemory(store: ConversationMemoryStore, identity: MemoryIdentity,
  currentId: string | undefined, policy: ConversationMemoryPolicy, availableTokens: number): MemoryView | null {
  const tokenBudget = Math.max(0, Math.min(policy.maxViewTokens, availableTokens));
  const recent = store.recent(identity).filter((item) => item.conversation.id !== currentId && item.latestSequence > 0);
  const current = currentId ? store.conversations.get(currentId) : null;
  const relevant = new Set(current?.members.map(memberKey) ?? []);
  const notes = store.notes(identity).sort((a, b) =>
    Number(relevant.has(memberKey(b.target))) - Number(relevant.has(memberKey(a.target))));
  const view: MemoryView = { purpose: 'historical_reference_only', tokenBudget,
    omittedConversations: recent.length, conversations: [], notes: [], omittedNotes: notes.length };
  const fits = () => estimateContextTokens(view) <= tokenBudget - 64;
  if (!fits()) return null;
  for (const item of recent.slice(0, policy.recentConversations)) {
    const summary = store.summary(identity, item.conversation.id);
    const entry: MemoryConversation = {
      id: item.conversation.id, title: item.conversation.title, members: item.conversation.members,
      latestSequence: item.latestSequence, latestMessageAt: item.latestMessageAt, coveredSequence: summary?.coveredSequence ?? 0,
      summary: null, summaryOmitted: summary !== null, delta: [],
      deltaOmitted: item.latestSequence > (summary?.coveredSequence ?? 0),
    };
    view.conversations.push(entry); view.omittedConversations--;
    if (!fits()) { view.conversations.pop(); view.omittedConversations++; break; }
  }
  for (const note of notes) {
    const entry: NotePreview = { target: note.target, version: note.version,
      introduction: note.introduction, tags: note.tags, excerpt: '', truncated: true };
    view.notes.push(entry); view.omittedNotes--;
    if (!fits()) { view.notes.pop(); view.omittedNotes++; break; }
  }
  for (const item of view.conversations) {
    const summary = store.summary(identity, item.id);
    if (summary) {
      item.summary = summary; item.summaryOmitted = false;
      if (!fits()) { item.summary = null; item.summaryOmitted = true; }
    }
    const candidates = store.range(item.id, item.coveredSequence, policy.recentMessages + 1, true);
    for (const message of candidates.slice(-policy.recentMessages).reverse()) {
      const part = excerpt(message);
      item.delta.unshift(part);
      if (!fits()) { item.delta.shift(); break; }
    }
    item.deltaOmitted = candidates.length > item.delta.length || item.delta.some((part) => part.nextOffset !== null);
  }
  for (const preview of view.notes) {
    const note = notes.find((item) => memberKey(item.target) === memberKey(preview.target))!;
    const content = JSON.stringify({ body: note.body, unresolved: note.unresolved, sourceRefs: note.sourceRefs });
    preview.excerpt = content.slice(0, 1000); preview.truncated = content.length > 1000;
    if (!fits()) { preview.excerpt = ''; preview.truncated = true; }
  }
  return view;
}
