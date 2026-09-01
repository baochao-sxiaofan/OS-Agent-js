import {
  ArrowUp,
  LoaderCircle,
  Sparkles,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type SyntheticEvent,
  useRef,
  useState,
} from 'react';
import type {
  ImageAttachmentInput,
  TaskDraft,
  TaskModelPreferences,
} from '../../../shared/contracts.js';
import {
  ComposerOptions,
  DEFAULT_TASK_PREFERENCES,
} from './ComposerOptions.js';

type TaskComposerProps = {
  onError: (message: string) => void;
  onSubmit: (draft: TaskDraft) => Promise<void>;
  providerId: string;
};

export function TaskComposer({
  onError,
  onSubmit,
  providerId,
}: TaskComposerProps) {
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState('');
  const [attachments, setAttachments] = useState<ImageAttachmentInput[]>([]);
  const [preferences, setPreferences] = useState<TaskModelPreferences>(
    DEFAULT_TASK_PREFERENCES,
  );
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedTask = task.trim();
    if (!trimmedTask || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        task: trimmedTask,
        preferences,
        ...(attachments.length === 0 ? {} : { attachments }),
      });
    } catch {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      formRef.current?.requestSubmit();
    }
  };

  return (
    <div
      className={`task-entry ${
        open ? 'task-entry--open' : ''
      } ${submitting ? 'task-entry--submitting' : ''}`}
    >
      {!open ? (
        <button
          className="voice-orb"
          type="button"
          title="创建任务"
          aria-label="创建任务"
          onClick={() => setOpen(true)}
        >
          <span className="voice-orb__glow" />
          <span className="voice-orb__surface" />
          <span className="voice-orb__shine" />
          <Sparkles className="voice-orb__icon" size={22} />
        </button>
      ) : (
        <form ref={formRef} className="task-composer" onSubmit={submit}>
          <textarea
            autoFocus
            value={task}
            maxLength={4_000}
            placeholder="描述你要完成的任务"
            aria-label="任务内容"
            disabled={submitting}
            onChange={(event) => setTask(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="composer-footer">
            <ComposerOptions
              attachments={attachments}
              disabled={submitting}
              preferences={preferences}
              providerId={providerId}
              onAttachmentsChange={setAttachments}
              onError={onError}
              onPreferencesChange={setPreferences}
            />
            <span className="composer-provider">Agent Runtime</span>
            <button
              className="send-button"
              type="submit"
              title="发送任务"
              aria-label="发送任务"
              disabled={task.trim().length === 0 || submitting}
            >
              {submitting ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <ArrowUp size={18} />
              )}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
