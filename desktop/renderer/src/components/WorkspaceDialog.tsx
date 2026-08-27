import {
  FolderOpen,
  LoaderCircle,
  Settings,
  X,
} from 'lucide-react';
import { useState } from 'react';

type WorkspaceDialogProps = {
  open: boolean;
  workspacePath?: string;
  workspaceChangeBlocked: boolean;
  onClose: () => void;
  onSelect: () => Promise<boolean>;
};

export function WorkspaceDialog({
  open,
  workspacePath,
  workspaceChangeBlocked,
  onClose,
  onSelect,
}: WorkspaceDialogProps) {
  const [selecting, setSelecting] = useState(false);

  if (!open) {
    return null;
  }

  const select = async () => {
    if (selecting || workspaceChangeBlocked) {
      return;
    }
    setSelecting(true);
    try {
      if (await onSelect()) {
        onClose();
      }
    } finally {
      setSelecting(false);
    }
  };

  return (
    <div className="settings-backdrop" role="presentation">
      <section
        className="workspace-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-dialog-title"
      >
        <header className="settings-dialog__header">
          <div>
            <span>Conversation Mount</span>
            <h2 id="workspace-dialog-title">Workspace</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            title="关闭"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        <div className="workspace-dialog__body">
          <Settings size={18} />
          <div>
            <span>当前目录</span>
            <strong>{workspacePath ?? '未选择'}</strong>
          </div>
        </div>

        <footer className="workspace-dialog__actions">
          <button
            type="button"
            disabled={selecting}
            onClick={onClose}
          >
            {workspacePath ? '取消' : '暂时不选择'}
          </button>
          <button
            className="workspace-select-button"
            type="button"
            disabled={selecting || workspaceChangeBlocked}
            onClick={() => void select()}
          >
            {selecting ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <FolderOpen size={16} />
            )}
            {workspacePath ? '更换目录' : '选择目录'}
          </button>
        </footer>
      </section>
    </div>
  );
}
