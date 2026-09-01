import {
  ArrowUp,
  Bot,
  CheckCircle2,
  LoaderCircle,
  TriangleAlert,
  UserRound,
  Workflow,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import type {
  ConversationRoundView,
  ConversationView,
  ImageAttachmentInput,
  TaskDraft,
  TaskModelPreferences,
} from '../../../shared/contracts.js';
import {
  ComposerOptions,
  DEFAULT_TASK_PREFERENCES,
} from './ComposerOptions.js';

type ConversationFlowProps = {
  conversation: ConversationView;
  onOpenTopology: (rootTaskId: string) => void;
  onError: (message: string) => void;
  onSubmit: (draft: TaskDraft) => Promise<void>;
  providerId: string;
};

export function ConversationFlow({
  conversation,
  onOpenTopology,
  onError,
  onSubmit,
  providerId,
}: ConversationFlowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasActiveRound = conversation.status === 'active';

  useEffect(() => {
    const element = scrollRef.current;
    if (element) {
      element.scrollTo({
        top: element.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [conversation.rounds]);

  return (
    <section className="conversation-flow">
      <div className="conversation-flow__scroll" ref={scrollRef}>
        {conversation.rounds.length === 0 ? (
          <div className="conversation-flow__empty">
            <div className="conversation-empty-mark">
              <Bot size={20} />
            </div>
          </div>
        ) : (
          <div className="conversation-thread">
            {conversation.rounds.map((round, index) => (
              <div className="conversation-round" key={round.rootTaskId}>
                <div className="conversation-round__label">
                  ROUND {index + 1}
                </div>
                <Message
                  author="你"
                  icon={<UserRound size={16} />}
                  content={round.goal}
                  tone="user"
                />
                <AssistantMessage
                  round={round}
                  onOpenTopology={onOpenTopology}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      <ConversationComposer
        disabled={hasActiveRound}
        onError={onError}
        onSubmit={onSubmit}
        providerId={providerId}
      />
    </section>
  );
}

function ConversationComposer({
  disabled,
  onError,
  onSubmit,
  providerId,
}: {
  disabled: boolean;
  onError: (message: string) => void;
  onSubmit: (draft: TaskDraft) => Promise<void>;
  providerId: string;
}) {
  const [task, setTask] = useState('');
  const [attachments, setAttachments] = useState<ImageAttachmentInput[]>([]);
  const [preferences, setPreferences] = useState<TaskModelPreferences>(
    DEFAULT_TASK_PREFERENCES,
  );
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextTask = task.trim();
    if (!nextTask || disabled || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        task: nextTask,
        preferences,
        ...(attachments.length === 0 ? {} : { attachments }),
      });
      setTask('');
      setAttachments([]);
    } catch {
      return;
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  return (
    <div className="conversation-composer-dock">
      <form
        ref={formRef}
        className="conversation-composer"
        onSubmit={submit}
      >
        <ComposerOptions
          attachments={attachments}
          disabled={disabled || submitting}
          preferences={preferences}
          providerId={providerId}
          onAttachmentsChange={setAttachments}
          onError={onError}
          onPreferencesChange={setPreferences}
        />
        <textarea
          value={task}
          rows={1}
          maxLength={4_000}
          disabled={disabled || submitting}
          aria-label="输入下一轮任务"
          placeholder={
            disabled ? '当前任务执行中' : '输入下一轮任务'
          }
          onChange={(event) => setTask(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="submit"
          title="发送任务"
          aria-label="发送任务"
          disabled={disabled || submitting || task.trim().length === 0}
        >
          {submitting ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <ArrowUp size={18} />
          )}
        </button>
      </form>
    </div>
  );
}

function RoundTopologyButton({
  rootTaskId,
  onOpenTopology,
}: {
  rootTaskId: string;
  onOpenTopology: (rootTaskId: string) => void;
}) {
  return (
    <button
      className="round-topology-button"
      type="button"
      onClick={() => onOpenTopology(rootTaskId)}
    >
      <Workflow size={14} />
      查看该轮工程图
    </button>
  );
}

function AssistantMessage({
  round,
  onOpenTopology,
}: {
  round: ConversationRoundView;
  onOpenTopology: (rootTaskId: string) => void;
}) {
  if (round.status === 'active') {
    return (
      <Message
        author="OS Agent"
        icon={<Bot size={16} />}
        content={
          <div className="conversation-progress">
            <div>
              <LoaderCircle className="spin" size={16} />
              <strong>{round.stateLabel}</strong>
            </div>
            <span>{round.agentCount} 个 Agent 正在协同执行</span>
            <RoundTopologyButton
              rootTaskId={round.rootTaskId}
              onOpenTopology={onOpenTopology}
            />
          </div>
        }
        tone="assistant"
      />
    );
  }

  if (round.status === 'completed') {
    return (
      <Message
        author="OS Agent"
        icon={<Bot size={16} />}
        content={
          <>
            <div className="conversation-answer-status">
              <CheckCircle2 size={16} />
              任务已完成
            </div>
            <p className="conversation-answer">
              {round.result ?? '任务已经完成。'}
            </p>
            <div className="conversation-answer-meta">
              <span>
                {round.agentCount} 个 Agent ·{' '}
                {round.inputTokens + round.outputTokens} Tokens
              </span>
              <RoundTopologyButton
                rootTaskId={round.rootTaskId}
                onOpenTopology={onOpenTopology}
              />
            </div>
          </>
        }
        tone="assistant"
      />
    );
  }

  return (
    <Message
      author="OS Agent"
      icon={<Bot size={16} />}
      content={
        <>
          <div className="conversation-answer-status conversation-answer-status--error">
            <TriangleAlert size={16} />
            任务未完成
          </div>
          <p className="conversation-answer">
            {round.stateDetail ?? round.stateLabel}
          </p>
          <div className="conversation-answer-meta">
            <RoundTopologyButton
              rootTaskId={round.rootTaskId}
              onOpenTopology={onOpenTopology}
            />
          </div>
        </>
      }
      tone="assistant"
    />
  );
}

function Message({
  author,
  icon,
  content,
  tone,
}: {
  author: string;
  icon: ReactNode;
  content: ReactNode;
  tone: 'assistant' | 'user';
}) {
  return (
    <article className={`conversation-message conversation-message--${tone}`}>
      <header>
        <span>{icon}</span>
        <strong>{author}</strong>
      </header>
      <div className="conversation-message__content">{content}</div>
    </article>
  );
}
