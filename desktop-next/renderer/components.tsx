import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, FolderOpen, Plus, X } from 'lucide-react';
import { roles, type Contact, type CreateContact, type DesktopApi, type ModelSettings, type SaveModel, type Workspace, type CreateGroup } from '../shared/contracts.js';
import { tokenPresets, type TokenSettings } from '../shared/tokens.js';
import { ModelPicker, type ModelDrafts } from './model-picker.js';
import { errorMessage } from './errors.js';
export { errorMessage } from './errors.js';

declare global { interface Window { agents: DesktopApi } }
export function Avatar({ name, id, large = false }: { name: string; id: number; large?: boolean }) {
  return <span className={`avatar color-${id % 5} ${large ? 'large' : ''}`}>{Array.from(name).slice(0, 2).join('')}</span>;
}
export function stateText(contact: Contact): string {
  if (contact.status === 'dismissed') return '已解雇';
  if (contact.status === 'paused') return '已暂停';
  if (contact.status === 'cancelled') return '已停止';
  if (contact.approvals.length) return '等待处理';
  if (contact.error) return '等待重试';
  return { READY: '准备中', RUNNING: '正在处理', BLOCKED: '等待结果', SLEEPING: '等待消息' }[contact.state];
}
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    ref.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);
  return <dialog ref={ref} className="modal" onCancel={onClose}
    onClick={(event) => { if (event.target === ref.current) onClose(); }}>
    <header><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={20} /></button></header>
    {children}
  </dialog>;
}
export function CreateModal({ onClose, onCreated, onError }: {
  onClose: () => void; onCreated: (id: number) => void; onError: (error: unknown) => void;
}) {
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [character, setCharacter] = useState<CreateContact['character']>('coordinator');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [access, setAccess] = useState<CreateContact['access']>('none');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setFailure('');
    try {
      const id = await window.agents.create({ name, objective, character, workspaceId: workspace?.id ?? null, access });
      onCreated(id);
    } catch (error) { setFailure(errorMessage(error)); } finally { setBusy(false); }
  }
  async function chooseWorkspace() {
    try {
      const selected = await window.agents.chooseWorkspace();
      if (selected) { setWorkspace(selected); setAccess('read'); }
    } catch (error) { onError(error); }
  }
  return <Modal title="创建新的 Agent" onClose={onClose}>
    <p className="modal-intro">一位长期协作伙伴，拥有自己的职责、记忆和工作空间。</p>
    <form onSubmit={(event) => void create(event)}>
      <label>名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={40}
        placeholder="例如：小研、代码搭档、工作助手" required /></label>
      <label>长期职责<textarea value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={4000}
        placeholder="希望这位 Agent 持续帮你做什么？" rows={3} required /></label>
      <fieldset><legend>选择角色</legend><div className="role-grid">{roles.map((role) =>
        <button type="button" key={role.id} className={`role-option ${character === role.id ? 'chosen' : ''}`}
          onClick={() => { setCharacter(role.id); if (role.id === 'code_auditor' && access === 'write') setAccess('read'); }}>
          <strong>{role.name}{character === role.id && <Check size={14} />}</strong><span>{role.description}</span>
        </button>)}</div></fieldset>
      <div className="workspace-field">
        <div><strong>工作区</strong><span>可选 · 只访问你授权的目录</span></div>
        <button type="button" className="secondary" onClick={() => void chooseWorkspace()}><FolderOpen size={15} />{workspace ? '更换目录' : '选择目录'}</button>
      </div>
      {workspace && <div className="workspace-selected"><span title={workspace.path}>{workspace.path}</span>
        <select aria-label="工作区权限" value={access} onChange={(event) => setAccess(event.target.value as CreateContact['access'])}>
          <option value="none">不授予文件权限</option><option value="read">只读</option>
          {character !== 'code_auditor' && <option value="write">读取与编辑（不含删除）</option>}
        </select>
        <button type="button" className="icon-button" aria-label="移除工作区" onClick={() => { setWorkspace(null); setAccess('none'); }}><X size={16} /></button>
      </div>}
      {failure && <p className="error-banner" role="alert">{failure}</p>}
      <footer><span>创建后等待你的第一条消息</span><button className="primary" disabled={busy || !name.trim() || !objective.trim()}><Plus size={16} />{busy ? '创建中…' : '创建 Agent'}</button></footer>
    </form>
  </Modal>;
}
export function SettingsModal({ settings, onClose, onSaved }: {
  settings: ModelSettings; onClose: () => void; onSaved: () => void;
}) {
  const [mode, setMode] = useState<SaveModel['mode']>(settings.mode);
  const [drafts, setDrafts] = useState<ModelDrafts>({
    minimax: { model: settings.connections.minimax.model, apiKey: '' },
    deepseek: { model: settings.connections.deepseek.model, apiKey: '' },
  });
  const [tokens, setTokens] = useState<TokenSettings>({ ...settings.tokens });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setFailure('');
    try { await window.agents.saveModel({ mode, ...(mode === 'demo' ? { model: 'demo', apiKey: '' } : drafts[mode]), tokens }); onSaved(); }
    catch (error) { setFailure(errorMessage(error)); } finally { setBusy(false); }
  }
  return <Modal title="模型设置" onClose={onClose}>
    <p className="modal-intro">所有 Agent 共用这里的模型连接，各自保留独立的记忆与权限。</p>
    <form onSubmit={(event) => void save(event)}>
      <ModelPicker mode={mode} setMode={setMode} drafts={drafts} setDrafts={setDrafts} settings={settings} disabled={busy} />
      <fieldset className="token-settings"><legend>上下文与输出容量</legend>
        <div className="token-presets"><span>预设</span>{(['500K', '1M'] as const).map((preset) =>
          <button type="button" className="secondary compact" key={preset} onClick={() => setTokens({ ...tokenPresets[preset] })}>{preset}</button>)}</div>
        <div className="token-grid">{([
          ['maxRequestTokens', '单次请求容量（输入＋输出）'],
          ['maxOutputTokens', '单次最大输出 Tokens'],
          ['contextMaxTokens', '每层上下文硬上限'],
          ['contextCompactAtTokens', '每层自动压缩阈值'],
          ['contextTargetTokens', '每层压缩后目标容量'],
          ['tokensPerMinute', '每分钟 Token 额度'],
          ['maxTotalTokens', '每位 Agent 累计 Token 额度'],
        ] as const).map(([field, label]) => <label key={field}>{label}<input type="number" min={1} step={1} required
          value={tokens[field]} onChange={(event) => setTokens((previous) => ({ ...previous, [field]: event.target.valueAsNumber }))} /></label>)}</div>
        <p className="hint">单次输出与输入容量分开设置。500K / 1M 是宿主预算，实际可用窗口和输出上限取决于所选模型；
          上下文容量沿用 UTF-8 字节的保守估算，每次输出上限直接传给模型。提高容量不会要求模型写满。</p>
        <p className="hint">压缩目标须低于阈值，阈值低于硬上限；三层硬上限与输出预留之和不能超过请求容量。
          设置会应用到已有 Agent，保留历史和任务。已因总结失败暂停的 Agent，保存后点击“继续”可重新总结。</p>
      </fieldset>
      {failure && <p className="error-banner" role="alert">{failure}</p>}
      <footer><span>切换前请等待工作结束或暂停 Agent</span><button className="primary"
        disabled={busy || mode !== 'demo' && (!drafts[mode].model || !drafts[mode].apiKey.trim() && !settings.connections[mode].hasKey)}>
        {busy ? '保存中…' : '保存设置'}</button></footer>
    </form>
  </Modal>;
}

export function GroupModal({ contacts, onClose, onCreated }: {
  contacts: readonly Contact[]; onClose: () => void; onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [ids, setIds] = useState<number[]>([]);
  const [participation, setParticipation] = useState<CreateGroup['participation']>('all');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const workspace = contacts.find((contact) => ids.includes(contact.id))?.workspaceId;
  return <Modal title="创建群聊" onClose={onClose}>
    <p className="modal-intro">你与现有 Agent 在同一个会话里协作。成员需要属于同一工作区。</p>
    <form onSubmit={(event) => {
      event.preventDefault(); setBusy(true); setFailure('');
      void window.agents.createGroup({ title, agentIds: ids, participation }).then(onCreated)
        .catch((error: unknown) => setFailure(errorMessage(error))).finally(() => setBusy(false));
    }}>
      <label>群名称<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} required placeholder="例如：项目讨论" /></label>
      <fieldset><legend>选择成员（你已在群中）</legend><div className="member-options">{contacts.map((contact) =>
        <label key={contact.id}><input type="checkbox" checked={ids.includes(contact.id)}
          disabled={['cancelled', 'dismissed'].includes(contact.status) || workspace !== undefined && workspace !== contact.workspaceId}
          onChange={(event) => setIds((previous) => event.target.checked ? [...previous, contact.id] : previous.filter((id) => id !== contact.id))} />
          <span>{contact.name}<small>{contact.workspace ?? '未挂载工作区'}</small></span></label>)}</div></fieldset>
      <label>参与方式<select value={participation} onChange={(event) => setParticipation(event.target.value as CreateGroup['participation'])}>
        <option value="all">自主判断 · 有帮助时发言</option><option value="mentioned">仅点名 · 被 @ 时处理</option>
      </select></label>
      <p className="hint">自主判断模式允许 Agent 保持沉默；仅点名模式下，普通通知不会唤醒成员。</p>
      {failure && <p className="error-banner" role="alert">{failure}</p>}
      <footer><span>{ids.length} 位 Agent 已选择</span><button className="primary" disabled={busy || !title.trim() || !ids.length}>创建群聊</button></footer>
    </form>
  </Modal>;
}
