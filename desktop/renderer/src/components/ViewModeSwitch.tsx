import { MessagesSquare, Workflow } from 'lucide-react';

export type ViewMode = 'conversation' | 'topology';

type ViewModeSwitchProps = {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
};

export function ViewModeSwitch({
  mode,
  onChange,
}: ViewModeSwitchProps) {
  return (
    <div
      className={`view-mode-switch view-mode-switch--${mode}`}
      role="group"
      aria-label="界面模式"
    >
      <span className="view-mode-switch__thumb" aria-hidden="true" />
      <button
        className={mode === 'conversation' ? 'is-active' : ''}
        type="button"
        title="对话流"
        aria-pressed={mode === 'conversation'}
        onClick={() => onChange('conversation')}
      >
        <MessagesSquare size={14} />
        <span>对话</span>
      </button>
      <button
        className={mode === 'topology' ? 'is-active' : ''}
        type="button"
        title="Agent 工程"
        aria-pressed={mode === 'topology'}
        onClick={() => onChange('topology')}
      >
        <Workflow size={14} />
        <span>工程</span>
      </button>
    </div>
  );
}
