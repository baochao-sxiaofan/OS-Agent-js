import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import type { ModelCatalog, ModelProvider, ModelSettings, SaveModel } from '../shared/contracts.js';
import { errorMessage } from './errors.js';

export type ModelDrafts = Record<ModelProvider, { model: string; apiKey: string }>;
export function ModelPicker({ mode, setMode, drafts, setDrafts, settings, disabled }: {
  mode: SaveModel['mode']; setMode: (mode: SaveModel['mode']) => void;
  drafts: ModelDrafts; setDrafts: React.Dispatch<React.SetStateAction<ModelDrafts>>;
  settings: ModelSettings; disabled: boolean;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');
  const [refresh, setRefresh] = useState(0);
  const draft = mode === 'demo' ? null : drafts[mode];
  const apiKey = draft?.apiKey ?? '';
  const hasKey = mode !== 'demo' && settings.connections[mode].hasKey;
  useEffect(() => {
    let current = true;
    setCatalog(null); setFailure('');
    if (mode === 'demo' || mode === 'deepseek' && !apiKey.trim() && !hasKey) {
      setLoading(false); return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void window.agents.listModels({ provider: mode, apiKey }).then((result) => {
        if (!current) return;
        setCatalog(result);
        if (!result.models.length) { setFailure('当前账户没有返回可用型号，请检查账户或稍后刷新。'); return; }
        setDrafts((previous) => ({ ...previous, [mode]: {
          ...previous[mode], model: previous[mode].model || result.models[0]!.id,
        } }));
      }).catch((error: unknown) => { if (current) setFailure(errorMessage(error)); })
        .finally(() => { if (current) setLoading(false); });
    }, apiKey ? 650 : 0);
    // 凭据、供应商切换或弹窗关闭后，旧请求不能覆盖新的选择。
    return () => { current = false; clearTimeout(timer); };
  }, [mode, apiKey, hasKey, refresh, setDrafts]);
  const available = catalog?.provider === mode ? catalog.models : [];
  const previousModel = draft?.model && !available.some((item) => item.id === draft.model) ? draft.model : '';
  return <>
    <div className="mode-options">
      {([
        ['demo', '本地演示', '无需 API，体验对话流程'],
        ['minimax', 'MiniMax', '选择预置型号'],
        ['deepseek', 'DeepSeek', '用 Key 读取可用型号'],
      ] as const).map(([id, title, description]) => <button key={id} type="button"
        disabled={disabled} className={mode === id ? 'chosen' : ''} onClick={() => setMode(id)}>
        <strong>{title}</strong><span>{description}</span>
      </button>)}
    </div>
    {mode !== 'demo' && draft ? <>
      <label>API Key<input type="password" autoComplete="off" value={draft.apiKey} disabled={disabled}
        onChange={(event) => {
          const value = event.target.value;
          setDrafts((previous) => ({ ...previous, [mode]: { apiKey: value,
            model: mode === 'deepseek' ? '' : previous[mode].model } }));
          setCatalog(null); setFailure('');
        }}
        placeholder={hasKey ? '已有本供应商凭据，留空保留' : `输入 ${mode === 'deepseek' ? 'DeepSeek' : 'MiniMax'} API Key`}
        maxLength={1024} /></label>
      <label>具体型号<select required value={draft.model} disabled={disabled || loading}
        onChange={(event) => setDrafts((previous) => ({
          ...previous, [mode]: { ...previous[mode], model: event.target.value },
        }))}>
        <option value="">{loading ? '正在读取型号…' : '请选择型号'}</option>
        {previousModel && <option value={previousModel}>{previousModel}（上次选择，未在当前列表中）</option>}
        {available.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <div className="model-list-status">
        <span className="hint" role="status">{loading ? '正在读取型号列表…'
          : mode === 'deepseek' ? catalog ? `已从 DeepSeek 读取 ${available.length} 个型号`
            : '填入 Key 后自动读取可用型号' : '官方预置型号；实际可用性取决于账户和套餐，未验证 Key。'}</span>
        <button type="button" className="secondary compact" disabled={disabled || loading || mode === 'deepseek' && !hasKey && !apiKey.trim()}
          onClick={() => setRefresh((value) => value + 1)}>刷新列表</button>
      </div>
      {failure && <p className="error-banner" role="alert">{failure}</p>}
      <p className="hint"><KeyRound size={15} />两家凭据独立保存。系统安全存储可用时加密保存，否则仅本次会话有效。</p>
      <p className="hint">{mode === 'deepseek' ? 'api.deepseek.com · 默认开启深度思考。' : 'api.minimaxi.com · '}
        保存后在下一次模型请求中使用。切换供应商会保留各自上次保存的型号。</p>
    </> : <p className="settings-note">演示模式会生成固定格式的回复，不调用网络模型、不操作工作区文件。对话与 Agent 身份仍会保存在本机。</p>}
  </>;
}
