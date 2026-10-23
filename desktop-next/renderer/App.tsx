import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronRight, CircleHelp, Eye, FolderOpen, Info, MessageCircle, Pause, Play, Plus, Search, Settings2, ShieldCheck, Sparkles, Square, Users, X } from 'lucide-react';
import { roles, type Contact, type Snapshot } from '../shared/contracts.js';
import { Avatar, CreateModal, GroupModal, SettingsModal, errorMessage, stateText } from './components.js';
import { MemoryModal } from './memory.js';

const time = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const recentTime = (value: number) => new Date(value).toDateString() === new Date().toDateString()
  ? time(value) : new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
type Act = (operation: () => Promise<unknown>) => Promise<void>;
type Draft = { content: string; mentions: number[] };

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [view, setView] = useState<'chats' | 'agents'>('chats');
  const [selected, setSelected] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<number | null>(null);
  const [inspectedConversation, setInspectedConversation] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<'create' | 'group' | 'settings' | null>(null);
  const [details, setDetails] = useState(false);
  const [memoryTab, setMemoryTab] = useState<'summary' | 'history' | 'notes' | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const refreshVersion = useRef(0);
  const inspectorId = view === 'agents' ? agentId ?? undefined : undefined;
  const pendingSends = useRef(new Map<string, { fingerprint: string; key: string }>());
  const onError = useCallback((reason: unknown) => setError(errorMessage(reason)), []);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const next = await window.agents.snapshot(inspectorId);
      if (version === refreshVersion.current) setSnapshot(next);
    } catch (reason) { onError(reason); }
  }, [inspectorId, onError]);
  useEffect(() => {
    void refresh();
    const unsubscribe = window.agents.subscribe(() => void refresh());
    return () => { refreshVersion.current++; unsubscribe(); };
  }, [refresh]);
  const inspector = snapshot?.inspector?.agentId === agentId ? snapshot.inspector : null;
  const conversation = view === 'chats' ? snapshot?.conversations.find((item) => item.id === selected)
    : inspector?.conversations.find((item) => item.id === inspectedConversation);
  const contact = snapshot?.contacts.find((item) => view === 'agents' ? item.id === agentId
    : conversation?.kind === 'direct' && conversation.members[0]?.id === item.id);
  const readOnly = view === 'agents';
  const archive = readOnly && inspectedConversation === 'legacy';
  const draft = conversation ? drafts[conversation.id] ?? { content: '', mentions: [] } : { content: '', mentions: [] };
  const lastId = conversation?.messages.at(-1)?.id;
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [conversation?.id, lastId, archive]);
  useEffect(() => {
    if (!readOnly && conversation?.unread && document.hasFocus()) void window.agents.markRead(conversation.id).catch(onError);
  }, [readOnly, conversation?.id, conversation?.unread, onError, snapshot]);
  async function act(operation: () => Promise<unknown>) {
    try { await operation(); await refresh(); } catch (reason) { onError(reason); }
  }
  function updateDraft(next: Partial<Draft>) {
    if (conversation) setDrafts((previous) => ({ ...previous, [conversation.id]: { ...draft, ...next } }));
  }
  async function send() {
    if (!conversation || sending || readOnly || !draft.content.trim()) return;
    const id = conversation.id;
    const content = draft.content.trim();
    const fingerprint = JSON.stringify([content, draft.mentions]);
    let pending = pendingSends.current.get(id);
    if (!pending || pending.fingerprint !== fingerprint) {
      pending = { fingerprint, key: crypto.randomUUID() }; pendingSends.current.set(id, pending);
    }
    setSending(true);
    try {
      await window.agents.send(id, content, pending.key, draft.mentions);
      pendingSends.current.delete(id);
      setDrafts((previous) => JSON.stringify([previous[id]?.content.trim(), previous[id]?.mentions]) === fingerprint
        ? { ...previous, [id]: { content: '', mentions: [] } } : previous);
      await refresh();
    } catch (reason) { onError(reason); } finally { setSending(false); }
  }
  const conversations = [...(snapshot?.conversations ?? [])].sort((a, b) =>
    (b.messages.at(-1)?.createdAt ?? b.createdAt) - (a.messages.at(-1)?.createdAt ?? a.createdAt));
  const matches = (text: string) => text.toLowerCase().includes(search.toLowerCase());
  const contacts = snapshot?.contacts ?? [];
  const blocked = conversation?.members.some((member) => contacts.find((item) => item.id === member.id)?.status === 'cancelled');
  return <div className="app">
    <div className="titlebar"><span>OS Agent <b>Next</b></span><span className="titlebar-note">你的长期协作空间</span></div>
    <nav className="rail" aria-label="主导航">
      <div className="brand-mark"><Sparkles size={23} /></div>
      <button className={`rail-button ${view === 'chats' ? 'active' : ''}`} aria-label="我的对话" title="我的对话" onClick={() => { setView('chats'); setSearch(''); }}><MessageCircle size={23} /></button>
      <button className={`rail-button ${view === 'agents' ? 'active' : ''}`} aria-label="Agent 视角" title="Agent 视角" onClick={() => { setView('agents'); setSearch(''); }}><Users size={23} /></button>
      <div className="rail-bottom"><button className="rail-button" aria-label="模型设置" title="模型设置" onClick={() => setModal('settings')}><Settings2 size={22} /></button><span className="user-avatar">我</span></div>
    </nav>
    <aside className="sidebar">
      <header className="sidebar-header"><button className="add-button" title="创建 Agent" aria-label="创建 Agent" onClick={() => setModal('create')}><Plus size={20} /></button><h1>{view === 'chats' ? '我的对话' : 'Agent'}</h1>
        {view === 'chats' && <button className="icon-button" title="创建群聊" aria-label="创建群聊" disabled={!contacts.length} onClick={() => setModal('group')}><Users size={19} /></button>}
      </header>
      <div className="search"><Search size={16} /><input aria-label="搜索" placeholder={view === 'chats' ? '搜索会话' : '搜索 Agent'} value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button aria-label="清除搜索" onClick={() => setSearch('')}><X size={14} /></button>}</div>
      <div className="list-label">{view === 'chats' ? '我参与的会话' : '用户创建的长期 AGENT'}<span>{view === 'chats' ? '私聊与群聊' : '管理与只读查看'}</span></div>
      <div className="contact-list">
        {view === 'chats' ? conversations.filter((item) => matches(item.title)).map((item) =>
          <button key={item.id} className={`contact-item ${item.id === selected ? 'selected' : ''}`} onClick={() => setSelected(item.id)}>
            <Avatar name={item.kind === 'group' ? '群聊' : item.title} id={item.members[0]?.id ?? 0} />
            <div className="contact-copy"><div><strong>{item.title}</strong><time>{recentTime(item.messages.at(-1)?.createdAt ?? item.createdAt)}</time></div>
              <p>{item.messages.at(-1)?.content ?? '发送第一条消息，开始协作'}</p>
              <div className="contact-meta"><span>{item.kind === 'group' ? `${item.members.length + 1} 人群聊` : '私聊'}</span>{item.unread > 0 && <b>{item.unread > 99 ? '99+' : item.unread}</b>}</div>
            </div>
          </button>) : contacts.filter((item) => matches(`${item.name} ${item.objective} ${item.alias}`)).map((item) =>
          <button key={item.id} className={`contact-item ${item.id === agentId ? 'selected' : ''}`} onClick={() => { setAgentId(item.id); setInspectedConversation(null); }}>
            <Avatar name={item.name} id={item.id} /><div className="contact-copy"><div><strong>{item.name}</strong></div><p>{item.objective}</p><div className="contact-meta">{stateText(item)} · {item.alias}</div></div>
          </button>)}
        {!(view === 'chats' ? conversations.filter((item) => matches(item.title)).length : contacts.filter((item) => matches(`${item.name} ${item.objective} ${item.alias}`)).length) &&
          <div className="list-empty">{search ? '没有匹配的结果' : '还没有协作伙伴'}<span>点击左上角 ＋ 创建 Agent</span></div>}
      </div>
      <button className="model-indicator" onClick={() => setModal('settings')}>
        <span className={`model-dot ${snapshot?.settings.hasKey ? 'connected' : ''}`} />
        <div><strong>{snapshot && snapshot.settings.mode !== 'demo' ? snapshot.settings.model : '本地演示'}</strong>
          <span>{snapshot?.settings.mode === 'deepseek' ? 'DeepSeek 模型连接' : snapshot?.settings.mode === 'minimax'
            ? 'MiniMax 模型连接' : '连接模型，开始真实工作'}</span></div><ChevronRight size={15} /></button>
    </aside>
    <main className="main">
      {!snapshot ? <div className="welcome"><Sparkles /><h2>正在打开协作空间…</h2></div> : !snapshot.ready ? <div className="welcome"><h2>运行服务需要重启</h2><p>执行记录已保留。请退出并重新打开应用以恢复现场。</p></div> : conversation || readOnly && contact ? <>
        <header className="chat-header"><Avatar name={conversation?.kind === 'group' ? '群聊' : contact?.name ?? conversation?.title ?? ''} id={contact?.id ?? 0} />
          <div><h2>{readOnly ? `${contact?.name}的会话` : conversation?.title}</h2><p>{readOnly ? '只读查看 · 不会触发 Agent 或改变你的未读' : conversation?.kind === 'group'
            ? `${conversation.members.length + 1} 位成员 · ${conversation.participation === 'all' ? '自主判断是否发言' : '仅被点名时处理'}` : '独立私聊 · 按需要回复'}</p></div>
          <div className="chat-actions">{contact && <>
            <button className="secondary compact" onClick={() => void act(() => window.agents.control(contact.id, contact.status === 'active' ? 'pause' : 'resume'))}>
              {contact.status === 'active' ? <Pause size={14} /> : <Play size={14} />}{contact.status === 'active' ? '暂停' : '继续'}</button>
            {readOnly && <button className="secondary compact" onClick={() => { setView('chats'); setSelected(contact.directConversationId); }}>与它私聊</button>}
          </>}<button className="secondary compact" onClick={() => setMemoryTab('summary')}>会话记忆</button>
          <button className="icon-button" title="搜索历史消息" aria-label="搜索历史消息" onClick={() => setMemoryTab('history')}><Search size={18} /></button>
          <button className={`icon-button ${details ? 'on' : ''}`} title="查看详情" aria-label="查看详情" onClick={() => setDetails(!details)}><Info size={20} /></button></div>
        </header>
        {snapshot.settings.mode === 'demo' && <div className="demo-banner"><Sparkles size={14} /><span>本地演示 · 群聊仅演示点名回复，真实模型自主判断相关性</span><button onClick={() => setModal('settings')}>连接模型<ChevronRight size={13} /></button></div>}
        {readOnly && <div className="inspector-tabs" aria-label="Agent 会话列表">
          {inspector?.conversations.map((item) => <button key={item.id} className={inspectedConversation === item.id ? 'selected' : ''} onClick={() => setInspectedConversation(item.id)}>
            {item.includesUser && item.kind === 'direct' ? '与我的私聊' : item.title}{!item.includesUser && <Eye size={12} />}
          </button>)}
          <button className={archive ? 'selected' : ''} onClick={() => setInspectedConversation('legacy')}>旧版历史归档</button>
        </div>}
        <div className="conversation-body"><div className="conversation">
          <div className="messages">
            {conversation ? <>
              <div className="conversation-start"><span>{new Date(conversation.createdAt).toLocaleDateString('zh-CN')}</span><div><ShieldCheck size={13} />{conversation.title} · 消息保存在本机</div></div>
              {!conversation.messages.length && <div className="intro-card"><h3>{readOnly ? '这个会话还没有消息' : '从这里开始协作'}</h3><p>{contact?.objective ?? '群成员可以根据职责参与，也可以保持沉默。'}</p></div>}
              {conversation.messages.map((message) => <div key={message.id} className={`message ${message.sender.kind === 'user' ? 'outgoing' : 'incoming'}`}>
                {message.sender.kind === 'agent' && <Avatar name={message.senderName} id={message.sender.id} />}
                <div className="message-content"><small>{message.senderName}{message.mentions.map((id) => ` @${conversation.members.find((item) => item.id === id)?.name ?? id}`).join('')}</small>
                  {message.replyTo && <div className="reply-reference">回复：{conversation.messages.find((item) => item.id === message.replyTo)?.content.slice(0, 80) ?? '此前消息'}</div>}
                  <div className="bubble">{message.content}</div><time>{time(message.createdAt)}{message.sender.kind === 'user' && <Check size={12} />}</time></div>
                {message.sender.kind === 'user' && <span className="user-avatar">我</span>}
              </div>)}
              {conversation.mailboxes.map((mailbox) => {
                const member = contacts.find((item) => item.id === mailbox.agentId);
                const lastIncoming = conversation.messages.findLast((message) =>
                  message.sender.kind !== 'agent' || message.sender.id !== mailbox.agentId);
                const label = member?.status === 'paused' ? '已暂停' : member?.status === 'cancelled' ? '已停止'
                  : mailbox.state === 'aggregating' ? '等待合并处理' : mailbox.state === 'processing' ? '正在处理此会话'
                    : lastIncoming && lastIncoming.sequence > mailbox.processedSequence ? '新消息未触发处理'
                    : mailbox.processedSequence > 0 ? '已处理' : '暂无待处理消息';
                return <div key={mailbox.agentId} className="activity">{member?.name} · {label}</div>;
              })}
            </> : archive ? <>
              <div className="conversation-start">只读历史归档 · 旧记录的目标会话无法确定，保留原样供查阅</div>
              {inspector?.legacy.map((message) => <div key={message.id} className="message"><div className="message-content"><small>{message.sender ?? (message.role === 'user' ? '我' : contact?.name)}</small><div className="bubble">{message.content}</div><time>{time(message.createdAt)}</time></div></div>)}
              {!inspector?.legacy.length && <div className="list-empty">没有旧版记录</div>}
            </> : <div className="intro-card"><Eye size={28} /><h3>选择一个会话查看</h3><p>这里可以查看 {contact?.name} 与其他 Agent 的交流，或查看你们的私聊。</p></div>}
            <div ref={end} />
          </div>
          {contact?.error && <div className="error-banner"><CircleHelp size={16} /><span>{contact.error}</span></div>}
          {contact?.approvals.map((approval) => <ApprovalCard key={approval.operationId} contact={contact} approval={approval} act={act} />)}
          {readOnly ? <div className="readonly-banner"><Eye size={15} />Agent 视角 · 只读查看</div> : conversation && <>
            {blocked && <div className="paused-banner">会话中有已停止的 Agent，请在 Agent 视角恢复后发送。</div>}
            <div className="composer">
              {conversation.kind === 'group' && <div className="mentions"><span>点名</span>{conversation.members.map((member) =>
                <button key={member.id} className={draft.mentions.includes(member.id) ? 'selected' : ''} aria-pressed={draft.mentions.includes(member.id)}
                  onClick={() => updateDraft({ mentions: draft.mentions.includes(member.id) ? draft.mentions.filter((id) => id !== member.id) : [...draft.mentions, member.id] })}>@{member.name}</button>)}</div>}
              <textarea aria-label={`发消息给${conversation.title}`} placeholder={`发消息给 ${conversation.title}…`}
                value={draft.content} maxLength={12000} disabled={blocked} onChange={(event) => updateDraft({ content: event.target.value })}
                onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
              <div><span>Enter 发送 · Shift + Enter 换行</span><button className="send-button" aria-label="发送消息" disabled={sending || !draft.content.trim() || blocked} onClick={() => void send()}><ArrowUp size={20} /></button></div>
            </div>
          </>}
        </div>
          {details && <aside className="details"><header><h3>{contact ? 'Agent 详情' : '群成员'}</h3><button className="icon-button" aria-label="关闭详情" onClick={() => setDetails(false)}><X size={17} /></button></header>
            {contact ? <><Avatar name={contact.name} id={contact.id} large /><h3>{contact.name}</h3><span className="alias">{contact.alias} · {stateText(contact)}</span>
              <div className="detail-memory"><button className="secondary" onClick={() => setMemoryTab('notes')}>{readOnly ? '查看 Agent 的备注' : '编辑我的长备注'}</button></div>
              <label>长期职责</label><p>{contact.objective}</p><label><FolderOpen size={13} />工作区</label><p className="path">{contact.workspace ?? '未挂载工作区'}</p>
              <label><ShieldCheck size={13} />已授予权限</label><p>{contact.capabilities.join('、') || '无文件访问权限'}</p>
              <label>运行记录</label><div className="stats"><div><strong>{contact.rounds}</strong><span>模型请求</span></div><div><strong>{contact.totalTokens.toLocaleString()}</strong><span>计量 Tokens</span></div></div>
              <p className="detail-note">处理结束不一定发送消息。身份和各会话记忆会保留。用量缺失时按请求上限保守计量。</p>
              <button className="secondary danger" onClick={() => void act(() => window.agents.control(contact.id, 'cancel'))}><Square size={13} />停止自动执行</button>
            </> : <><p>我</p>{conversation?.members.map((member) => <button key={member.id} className="member-detail" onClick={() => { setView('agents'); setAgentId(member.id); setInspectedConversation(conversation.id); }}><Avatar name={member.name} id={member.id} /><span>{member.name}<small>{roles.find((role) => role.id === contacts.find((item) => item.id === member.id)?.character)?.name}</small></span></button>)}</>}
          </aside>}
        </div>
      </> : <div className="welcome"><div className="welcome-symbol"><Sparkles size={42} /></div><h2>{view === 'chats' ? '让你的 Agent 伙伴就位' : '查看 Agent 的协作'}</h2><p>{view === 'chats' ? '选择会话，或创建一位有独立职责和记忆的协作伙伴。' : '选择左侧 Agent，查看它参与的会话与工作状态。'}</p><button className="primary" onClick={() => setModal('create')}><Plus size={17} />创建 Agent</button></div>}
    </main>
    {modal === 'create' && <CreateModal onClose={() => setModal(null)} onError={onError} onCreated={(id) => {
      setModal(null); setView('chats');
      void window.agents.snapshot().then((next) => { setSnapshot(next); setSelected(next.contacts.find((item) => item.id === id)?.directConversationId ?? null); }).catch(onError);
    }} />}
    {modal === 'group' && <GroupModal contacts={contacts} onClose={() => setModal(null)} onCreated={(id) => { setSelected(id); setView('chats'); setModal(null); void refresh(); }} />}
    {modal === 'settings' && snapshot && <SettingsModal settings={snapshot.settings} onClose={() => setModal(null)} onSaved={() => { setModal(null); void refresh(); }} />}
    {memoryTab && <MemoryModal initialTab={memoryTab} conversation={conversation}
      conversations={readOnly ? inspector?.conversations ?? [] : snapshot?.conversations ?? []}
      contacts={contacts} inspectAgentId={inspectorId} targetId={readOnly ? undefined : contact?.id}
      onClose={() => setMemoryTab(null)} />}
    {error && <div className="toast" role="alert"><CircleHelp size={18} /><span>{error}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setError('')}><X size={17} /></button></div>}
  </div>;
}

function ApprovalCard({ contact, approval, act }: {
  contact: Contact; approval: Contact['approvals'][number]; act: Act;
}) {
  const [result, setResult] = useState('');
  const [outcome, setOutcome] = useState<'succeeded' | 'failed'>('succeeded');
  return <div className="approval-card"><strong>{approval.state === 'unknown' ? '需要确认上次操作结果' : '等待你的授权'} · {approval.toolName}</strong>
    <details><summary>查看操作参数</summary><pre>{JSON.stringify(approval.arguments, null, 2)}</pre></details>
    {approval.state === 'approval' ? <div className="approval-actions"><button className="secondary" onClick={() => void act(() => window.agents.approve(contact.id, approval.operationId, false))}>拒绝</button><button className="primary" onClick={() => void act(() => window.agents.approve(contact.id, approval.operationId, true))}>允许这次操作</button></div> :
      <><p>请核对实际执行结果，提交后再点击「继续」。</p><input aria-label="核对结果" placeholder="填写你核对到的结果或证据" value={result} onChange={(event) => setResult(event.target.value)} /><div className="approval-actions"><select aria-label="执行结果" value={outcome} onChange={(event) => setOutcome(event.target.value as 'succeeded' | 'failed')}><option value="succeeded">已成功执行</option><option value="failed">确认未成功</option></select><button className="primary" disabled={!result.trim()} onClick={() => void act(() => window.agents.reconcile(contact.id, approval.operationId, outcome, result))}>提交核对结果</button></div></>}
  </div>;
}
