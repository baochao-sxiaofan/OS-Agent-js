import {
  Check,
  Eye,
  EyeOff,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  type SyntheticEvent,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  PROVIDER_CATALOG,
  type ModelDescriptor,
  type ModelSettingsView,
  type ProviderId,
  type SaveModelSettingsResult,
} from '../../../shared/contracts.js';

type SettingsDialogProps = {
  open: boolean;
  onClose: () => void;
  onSaved: (result: SaveModelSettingsResult) => void;
};

export function SettingsDialog({
  open,
  onClose,
  onSaved,
}: SettingsDialogProps) {
  const [settings, setSettings] = useState<ModelSettingsView>();
  const [providerId, setProviderId] = useState<ProviderId>();
  const [apiKey, setApiKey] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [modelId, setModelId] = useState('');
  const [manualEntry, setManualEntry] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) {
      return;
    }
    setApiKey('');
    setWorkspaceId('');
    setModels([]);
    setManualEntry(false);
    setMessage(undefined);
    setError(undefined);
    void window.osAgent
      .getModelSettings()
      .then((nextSettings) => {
        setSettings(nextSettings);
        setProviderId(nextSettings.providerId);
        setModelId(nextSettings.modelId ?? '');
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [open]);

  const provider = useMemo(
    () =>
      PROVIDER_CATALOG.find(
        (candidate) => candidate.id === providerId,
      ),
    [providerId],
  );
  const mayUseSavedKey =
    settings?.providerId === providerId &&
    settings?.hasApiKey === true;
  const hasCredential = apiKey.trim().length > 0 || mayUseSavedKey;
  const requiresWorkspace =
    provider?.requiresWorkspaceId === true &&
    workspaceId.trim().length === 0;
  const canDiscover =
    provider?.catalogMode === 'api' &&
    hasCredential &&
    !requiresWorkspace &&
    !discovering &&
    !saving;
  const canSave =
    provider !== undefined &&
    hasCredential &&
    !requiresWorkspace &&
    modelId.trim().length > 0 &&
    !discovering &&
    !saving &&
    settings?.runtimeBusy !== true;

  if (!open) {
    return null;
  }

  const selectProvider = (nextProviderId: ProviderId) => {
    const nextProvider = PROVIDER_CATALOG.find(
      (candidate) => candidate.id === nextProviderId,
    );
    setProviderId(nextProviderId);
    setApiKey('');
    setWorkspaceId('');
    setModels([]);
    setModelId(
      settings?.providerId === nextProviderId
        ? settings.modelId ?? ''
        : '',
    );
    setManualEntry(nextProvider?.catalogMode === 'manual');
    setMessage(undefined);
    setError(undefined);
  };

  const discover = async () => {
    if (!providerId || !canDiscover) {
      return;
    }
    setDiscovering(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await window.osAgent.discoverModels({
        providerId,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(workspaceId.trim()
          ? { workspaceId: workspaceId.trim() }
          : {}),
      });
      setModels(result.models);
      setModelId((current) =>
        result.models.some((model) => model.id === current)
          ? current
          : result.models[0]?.id ?? '',
      );
      setMessage(`已获取 ${result.models.length} 个可用文本模型。`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDiscovering(false);
    }
  };

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!providerId || !canSave) {
      return;
    }
    setSaving(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await window.osAgent.saveModelSettings({
        providerId,
        modelId: modelId.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(workspaceId.trim()
          ? { workspaceId: workspaceId.trim() }
          : {}),
      });
      setSettings(result.settings);
      setApiKey('');
      setMessage(
        `协议验证通过 · ${result.verification.latencyMs} ms · ${result.verification.response}`,
      );
      onSaved(result);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-backdrop" role="presentation">
      <section
        className="settings-dialog settings-dialog--catalog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-settings-title"
      >
        <header className="settings-dialog__header">
          <div>
            <span>Runtime Provider</span>
            <h2 id="model-settings-title">模型与 API</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            title="关闭设置"
            aria-label="关闭设置"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        <form className="settings-form" onSubmit={save}>
          <section className="settings-step">
            <StepTitle number="1" title="选择模型厂商" />
            <div className="provider-grid">
              {PROVIDER_CATALOG.map((candidate) => (
                <button
                  className={
                    candidate.id === providerId ? 'is-selected' : ''
                  }
                  type="button"
                  key={candidate.id}
                  onClick={() => selectProvider(candidate.id)}
                >
                  <span>{candidate.label}</span>
                  <small>{candidate.brand}</small>
                  {candidate.id === 'mimo' && <em>低成本</em>}
                  {candidate.id === providerId && <Check size={14} />}
                </button>
              ))}
            </div>
          </section>

          {provider && (
            <section className="settings-step">
              <StepTitle number="2" title="连接账号" />
              <label className="settings-field">
                <span>{provider.credentialLabel}</span>
                <div className="secret-input">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKey}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={
                      mayUseSavedKey
                        ? '已安全保存，留空继续使用'
                        : '输入 API Key'
                    }
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  <button
                    type="button"
                    title={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                    aria-label={
                      showApiKey ? '隐藏 API Key' : '显示 API Key'
                    }
                    onClick={() =>
                      setShowApiKey((current) => !current)
                    }
                  >
                    {showApiKey ? (
                      <EyeOff size={16} />
                    ) : (
                      <Eye size={16} />
                    )}
                  </button>
                </div>
              </label>

              {provider.requiresWorkspaceId && (
                <label className="settings-field">
                  <span>Workspace ID</span>
                  <input
                    value={workspaceId}
                    spellCheck={false}
                    placeholder="百炼华北 2 业务空间 ID"
                    onChange={(event) =>
                      setWorkspaceId(event.target.value)
                    }
                  />
                </label>
              )}

              {provider.note && (
                <p className="provider-note">{provider.note}</p>
              )}

              {provider.catalogMode === 'api' && (
                <button
                  className="discover-models-button"
                  type="button"
                  disabled={!canDiscover}
                  onClick={() => void discover()}
                >
                  {discovering ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <RefreshCw size={15} />
                  )}
                  获取可用模型
                </button>
              )}
            </section>
          )}

          {provider && (
            <section className="settings-step">
              <StepTitle number="3" title="选择并验证模型" />
              {provider.catalogMode === 'api' &&
              !manualEntry ? (
                <>
                  <label className="settings-field">
                    <span>账号可用模型</span>
                    <select
                      value={modelId}
                      disabled={models.length === 0}
                      onChange={(event) =>
                        setModelId(event.target.value)
                      }
                    >
                      {models.length === 0 ? (
                        <option value="">请先获取模型列表</option>
                      ) : (
                        models.map((model) => (
                          <option value={model.id} key={model.id}>
                            {model.displayName}
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                  <button
                    className="manual-model-toggle"
                    type="button"
                    onClick={() => {
                      setManualEntry(true);
                      setModelId('');
                    }}
                  >
                    手工填写模型 ID
                  </button>
                </>
              ) : (
                <label className="settings-field">
                  <span>模型 ID</span>
                  <input
                    value={modelId}
                    spellCheck={false}
                    placeholder="输入厂商文档中的模型 ID"
                    onChange={(event) => setModelId(event.target.value)}
                  />
                </label>
              )}
            </section>
          )}

          <div className="settings-security-note">
            <ShieldCheck size={15} />
            <span>
              {settings?.secureStorageAvailable === false
                ? '当前开发环境无法访问系统加密存储；凭据仅保留在本次主进程内存中，退出后清除。'
                : '凭据由系统安全存储加密，不进入任务上下文、日志或 URL。'}
            </span>
          </div>

          {settings?.runtimeBusy && (
            <p className="settings-inline-error">
              当前有 Agent 正在运行，任务结束后才能切换模型。
            </p>
          )}
          {error && <p className="settings-inline-error">{error}</p>}
          {message && <p className="settings-success">{message}</p>}

          <footer className="settings-dialog__actions">
            <button type="button" onClick={onClose}>
              关闭
            </button>
            <button
              className="settings-save-button"
              type="submit"
              disabled={!canSave}
            >
              {saving && <LoaderCircle className="spin" size={15} />}
              保存并验证
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function StepTitle({
  number,
  title,
}: {
  number: string;
  title: string;
}) {
  return (
    <h3 className="settings-step-title">
      <span>{number}</span>
      {title}
    </h3>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
