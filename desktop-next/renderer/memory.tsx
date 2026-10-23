import { useEffect, useRef, useState } from 'react';
import type {
  Contact, ContactNote, Conversation, ConversationMember, ConversationRead, ConversationReadResult,
  ConversationSearchResult, ConversationSummary, MemorySource,
} from '../shared/contracts.js';
import { Modal, errorMessage } from './components.js';

type MemoryTab = 'summary' | 'history' | 'notes';
type MemoryProps = {
  conversation: Conversation | undefined; conversations: readonly Conversation[]; contacts: readonly Contact[];
  inspectAgentId: number | undefined; initialTab: MemoryTab; targetId: number | undefined; onClose: () => void;
};
const date = (value: number) => new Date(value).toLocaleString('zh-CN');
const memberKey = (member: ConversationMember) => `${member.kind}:${member.id}`;
const memberName = (member: ConversationMember, contacts: readonly Contact[]) =>
  member.kind === 'user' ? '我' : contacts.find((contact) => contact.id === member.id)?.name ?? `agent-${member.id}`;

export function MemoryModal(props: MemoryProps) {
  const [tab, setTab] = useState(props.initialTab);
  const [source, setSource] = useState<MemorySource | null>(null);
  const agent = props.contacts.find((contact) => contact.id === props.inspectAgentId);
  return <>
    <Modal title="会话记忆" onClose={props.onClose}>
      <p className="modal-intro">{agent ? `${agent.name}的视角 · 只读查看它参与的会话和它写的备注` : '我的视角 · 查看我的会话、编辑我给联系人的长备注'}</p>
      <nav className="memory-tabs" aria-label="记忆分类">
        <button className={tab === 'summary' ? 'selected' : ''} onClick={() => setTab('summary')}>会话摘要</button>
        <button className={tab === 'history' ? 'selected' : ''} onClick={() => setTab('history')}>历史搜索</button>
        <button className={tab === 'notes' ? 'selected' : ''} onClick={() => setTab('notes')}>{agent ? 'Agent 的备注' : '我的长备注'}</button>
      </nav>
      {tab === 'summary' && <SummaryPanel conversation={props.conversation} inspectAgentId={props.inspectAgentId} open={setSource} />}
      {tab === 'history' && <HistoryPanel {...props} open={setSource} />}
      {tab === 'notes' && <NotesPanel {...props} open={setSource} />}
    </Modal>
    {source && <SourceViewer key={`${source.conversationId}:${source.messageId}`} source={source}
      inspectAgentId={props.inspectAgentId} contacts={props.contacts} conversations={props.conversations} onClose={() => setSource(null)} />}
  </>;
}

function Sources({ refs, open }: { refs: readonly MemorySource[]; open: (source: MemorySource) => void }) {
  return <div className="memory-sources">{refs.map((source, index) =>
    <button type="button" className="secondary compact" key={`${source.conversationId}:${source.messageId}:${index}`}
      onClick={() => open(source)}>来源 {index + 1}</button>)}</div>;
}

function SummaryPanel({ conversation, inspectAgentId, open }: {
  conversation: Conversation | undefined; inspectAgentId: number | undefined; open: (source: MemorySource) => void;
}) {
  const [summary, setSummary] = useState<ConversationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true); setError('');
    if (!conversation) { setLoading(false); return; }
    void window.agents.memorySummary(conversation.id, inspectAgentId).then((value) => {
      if (current) setSummary(value);
    }).catch((reason: unknown) => { if (current) setError(errorMessage(reason)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [conversation?.id, inspectAgentId, revision]);
  if (!conversation) return <p className="memory-empty">请先选择一个会话，再查看摘要。</p>;
  return <section className="memory-panel">
    <div className="memory-heading"><strong>{conversation.title}</strong><button className="secondary compact" disabled={loading} onClick={() => setRevision(revision + 1)}>刷新摘要</button></div>
    {error ? <p role="alert" className="error-banner">{error}</p> : loading ? <p className="memory-empty">正在读取…</p> : summary ? <>
      <p className="memory-meta">版本 {summary.version} · 覆盖至消息序号 {summary.coveredSequence} · {date(summary.updatedAt)}</p>
      <p className="memory-meta">此会话另有 {conversation.messages.filter((message) => message.sequence > summary.coveredSequence).length} 条消息尚未纳入摘要</p>
      <p className="memory-text">{summary.overview}</p>
      {!!summary.unresolved.length && <><h3>待跟进</h3>{summary.unresolved.map((item, index) =>
        <div className="memory-card" key={index}><p className="memory-text">{item.text}</p><Sources refs={item.sourceRefs} open={open} /></div>)}</>}
      {!!summary.quotations.length && <><h3>重要原文</h3>{summary.quotations.map((item, index) =>
        <div className="memory-card" key={index}><blockquote>{item.text}</blockquote><Sources refs={[item.sourceRef]} open={open} /></div>)}</>}
      <h3>摘要来源</h3><Sources refs={summary.sourceRefs} open={open} />
    </> : <p className="memory-empty">尚未生成摘要。积累足够消息后，Agent 会在处理新消息时自动整理；目前可直接搜索原始记录。</p>}
    <p className="hint">摘要用于辅助回忆；需要确认具体事实时，可以打开来源核对原文。</p>
  </section>;
}

function HistoryPanel({ conversation, conversations, contacts, inspectAgentId, open }: MemoryProps & {
  open: (source: MemorySource) => void;
}) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState(conversation?.id ?? '');
  const [result, setResult] = useState<ConversationSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function search(beforeSequence?: number) {
    setBusy(true); setError('');
    try {
      const next = await window.agents.searchHistory({
        query, ...(scope ? { conversationId: scope } : {}), ...(beforeSequence === undefined ? {} : { beforeSequence }),
      }, inspectAgentId);
      setResult((previous) => beforeSequence === undefined ? next : { ...next, hits: [...(previous?.hits ?? []), ...next.hits] });
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  return <section className="memory-panel">
    <form className="memory-search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
      <label>搜索范围<select value={scope} disabled={busy} onChange={(event) => { setScope(event.target.value); setResult(null); }}>
        <option value="">全部可访问会话</option>{conversations.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>
      <label>历史关键词<input value={query} maxLength={200} disabled={busy} placeholder="例如：暗号、待办、交付时间"
        onChange={(event) => { setQuery(event.target.value); setResult(null); }} /></label>
      <button className="primary" disabled={busy || !query.trim()}>{busy ? '搜索中…' : '搜索历史'}</button>
    </form>
    {error && <p role="alert" className="error-banner">{error}</p>}
    {result && <p className="memory-meta">已显示 {result.hits.length} 条结果{result.truncated ? ' · 长消息显示片段，可打开原文继续阅读' : ''}</p>}
    {result?.hits.map((hit) => <article className="memory-card" key={hit.messageId}>
      <div className="memory-heading"><strong>{conversations.find((item) => item.id === hit.conversationId)?.title ?? '历史会话'}</strong>
        <button className="secondary compact" onClick={() => open(hit)}>查看原文</button></div>
      <p className="memory-meta">{memberName(hit.sender, contacts)} · {date(hit.createdAt)} · 序号 {hit.sequence}</p>
      <p className="memory-text">{hit.offset > 0 && '…'}{hit.content}{hit.nextOffset !== null && '…'}</p>
    </article>)}
    {result?.hits.length === 0 && <p className="memory-empty">没有匹配的记录。可以尝试原文中的其他关键词。</p>}
    {result?.nextBeforeSequence != null && <button className="secondary" disabled={busy}
      onClick={() => void search(result.nextBeforeSequence!)}>加载更早结果</button>}
  </section>;
}

function NotesPanel({ contacts, conversation, inspectAgentId, targetId, open }: MemoryProps & {
  open: (source: MemorySource) => void;
}) {
  const [notes, setNotes] = useState<readonly ContactNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [revision, setRevision] = useState(0);
  const [targetKey, setTargetKey] = useState(targetId === undefined ? 'user:desktop-user' : `agent:${targetId}`);
  const targets: ConversationMember[] = [{ kind: 'user', id: 'desktop-user' }, ...contacts.map((item) => ({ kind: 'agent' as const, id: item.id }))];
  const target = targets.find((item) => memberKey(item) === targetKey)!;
  const note = notes.find((item) => memberKey(item.target) === targetKey);
  useEffect(() => {
    let current = true;
    setLoading(true); setError('');
    void window.agents.contactNotes(inspectAgentId).then((value) => { if (current) setNotes(value); })
      .catch((reason: unknown) => { if (current) setError(errorMessage(reason)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [inspectAgentId, revision]);
  return <section className="memory-panel">
    <label>备注对象<select value={targetKey} onChange={(event) => { setTargetKey(event.target.value); setStatus(''); }}>
      {targets.map((item) => <option key={memberKey(item)} value={memberKey(item)}>{memberName(item, contacts)}{notes.some((existing) => memberKey(existing.target) === memberKey(item)) ? ' · 有备注' : ''}</option>)}
    </select></label>
    <p className="hint">{inspectAgentId === undefined ? '这些备注由你维护，Agent 自动整理的内容保存在它自己的备注里。' : '这里展示该 Agent 写下的备注，你可以只读查看；对用户和对其他 Agent 的备注均按作者独立保存。'}</p>
    {status && <p className="memory-status" role="status">{status}</p>}
    {error && <p role="alert" className="error-banner">{error}</p>}
    {loading ? <p className="memory-empty">正在读取…</p> : error ? <button className="secondary" onClick={() => setRevision(revision + 1)}>重新读取</button> :
      <NoteEditor key={`${targetKey}:${note?.version ?? 0}:${revision}`} note={note} target={target} readOnly={inspectAgentId !== undefined}
        conversation={conversation} open={open} reload={() => { setStatus(''); setRevision(revision + 1); }}
        onSaved={(saved) => { setNotes((previous) => [...previous.filter((item) => memberKey(item.target) !== memberKey(saved.target)), saved]); setStatus(`已保存 · 版本 ${saved.version}`); }} />}
  </section>;
}

function NoteEditor({ note, target, readOnly, conversation, open, reload, onSaved }: {
  note: ContactNote | undefined; target: ConversationMember; readOnly: boolean; conversation: Conversation | undefined;
  open: (source: MemorySource) => void; reload: () => void; onSaved: (note: ContactNote) => void;
}) {
  const [introduction, setIntroduction] = useState(note?.introduction ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [tags, setTags] = useState(note?.tags.join('、') ?? '');
  const [unresolved, setUnresolved] = useState(note?.unresolved.join('\n') ?? '');
  const [sources, setSources] = useState<readonly MemorySource[]>(note?.sourceRefs ?? []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  async function save() {
    setBusy(true); setError('');
    const input = { target, introduction, body, tags: tags.split(/[,，、\n]/u).map((item) => item.trim()).filter(Boolean),
      unresolved: unresolved.split('\n').map((item) => item.trim()).filter(Boolean), sourceRefs: sources, expectedVersion: note?.version ?? 0 };
    const fingerprint = JSON.stringify(input);
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, key: crypto.randomUUID() };
    try { onSaved(await window.agents.saveNote({ ...input, idempotencyKey: pending.current.key })); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  if (readOnly && !note) return <p className="memory-empty">该 Agent 尚未给这个对象写备注。</p>;
  return <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
    {note && <p className="memory-meta">版本 {note.version} · {date(note.updatedAt)}</p>}
    <label>简短介绍<input readOnly={readOnly} disabled={busy} maxLength={200} value={introduction} onChange={(event) => setIntroduction(event.target.value)} /></label>
    <label>长备注<textarea readOnly={readOnly} disabled={busy} rows={7} maxLength={6000} value={body}
      placeholder="记录背景、偏好、约定、相处方式或重要事实…" onChange={(event) => setBody(event.target.value)} /></label>
    <p className="memory-meta">{body.length} / 6000 字符</p>
    <label>标签<input readOnly={readOnly} disabled={busy} value={tags} placeholder="用顿号或逗号分隔，最多 20 个" onChange={(event) => setTags(event.target.value)} /></label>
    <label>待跟进<textarea readOnly={readOnly} disabled={busy} rows={3} value={unresolved} placeholder="每行一项，最多 20 项，每项 400 字符" onChange={(event) => setUnresolved(event.target.value)} /></label>
    <h3>关联原文</h3>
    {sources.map((source, index) => <div className="memory-source-row" key={`${source.messageId}:${index}`}>
      <button type="button" className="secondary compact" onClick={() => open(source)}>查看来源 {index + 1}</button>
      {!readOnly && <button type="button" disabled={busy} className="secondary compact" onClick={() => setSources(sources.filter((_, position) => position !== index))}>移除来源 {index + 1}</button>}
    </div>)}
    {!readOnly && !!conversation?.messages.length && <label>关联本会话消息<select value="" disabled={busy || sources.length >= 50} onChange={(event) => {
      if (event.target.value && !sources.some((source) => source.messageId === event.target.value)) {
        setSources([...sources, { conversationId: conversation.id, messageId: event.target.value }]);
      }
    }}><option value="">选择消息作为来源（可选）</option>{conversation.messages.slice(-50).reverse().map((message) =>
      <option key={message.id} value={message.id}>{message.senderName}：{message.content.slice(0, 65)}</option>)}</select></label>}
    {error && <p role="alert" className="error-banner">{error}。如版本已变化，请先保留草稿，再重新读取。</p>}
    <footer><button type="button" className="secondary" disabled={busy} onClick={reload}>{readOnly ? '刷新备注' : '丢弃草稿并重新读取'}</button>
      {!readOnly && <button className="primary" disabled={busy}>{busy ? '保存中…' : '保存备注'}</button>}</footer>
  </form>;
}

function SourceViewer({ source, inspectAgentId, contacts, conversations, onClose }: {
  source: MemorySource; inspectAgentId: number | undefined; contacts: readonly Contact[];
  conversations: readonly Conversation[]; onClose: () => void;
}) {
  const [pages, setPages] = useState<ConversationRead[]>([{
    conversationId: source.conversationId, messageId: source.messageId,
  }]);
  const [result, setResult] = useState<ConversationReadResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const query = pages.at(-1)!;
  useEffect(() => {
    let current = true;
    setBusy(true); setError('');
    void window.agents.readHistory(query, inspectAgentId).then((value) => { if (current) setResult(value); })
      .catch((reason: unknown) => { if (current) setError(errorMessage(reason)); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [query, inspectAgentId, revision]);
  const focus = result?.messages.find((item) => item.messageId === source.messageId);
  return <Modal title="来源原文" onClose={onClose}>
    <p className="modal-intro">{conversations.find((item) => item.id === source.conversationId)?.title ?? '历史会话'} · 只读查看</p>
    {error ? <><p className="error-banner" role="alert">{error}</p><button className="secondary" onClick={() => setRevision(revision + 1)}>重试读取</button></>
      : busy ? <p className="memory-empty">正在读取原文…</p> : result?.messages.map((message) =>
        <article key={`${message.messageId}:${message.offset}`} className="memory-card">
          <p className="memory-meta">{memberName(message.sender, contacts)} · {date(message.createdAt)} · 序号 {message.sequence}</p>
          <p className="memory-text">{message.content}</p>
          <p className="memory-meta">字符 {message.offset + 1}–{message.offset + message.content.length} / {message.totalLength}</p>
        </article>)}
    {!busy && !error && !result?.messages.length && <p className="memory-empty">没有更多原文。</p>}
    <div className="memory-pagination">
      <button className="secondary" disabled={busy || pages.length < 2} onClick={() => setPages(pages.slice(0, -1))}>上一页</button>
      <button className="secondary" disabled={busy || !!error || !result?.next} onClick={() => { if (result?.next) setPages([...pages, result.next]); }}>继续阅读</button>
      {focus && <button className="secondary" disabled={busy || !!error} onClick={() => setPages([...pages, {
        conversationId: source.conversationId, afterSequence: Math.max(0, focus.sequence - 6), throughSequence: focus.sequence + 5,
      }])}>查看前后消息</button>}
    </div>
  </Modal>;
}
