import {
  BrainCircuit,
  ImagePlus,
  Plus,
  Thermometer,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type {
  ImageAttachmentInput,
  TaskModelPreferences,
} from '../../../shared/contracts.js';
import { PROVIDER_CATALOG } from '../../../shared/contracts.js';

export const DEFAULT_TASK_PREFERENCES: TaskModelPreferences = {
  maxContextTokens: 64_000,
  temperature: 0.2,
  reasoningEffort: 'auto',
};

type ComposerOptionsProps = {
  attachments: ImageAttachmentInput[];
  disabled?: boolean;
  preferences: TaskModelPreferences;
  providerId: string;
  onAttachmentsChange: (attachments: ImageAttachmentInput[]) => void;
  onError: (message: string) => void;
  onPreferencesChange: (preferences: TaskModelPreferences) => void;
};

export function ComposerOptions({
  attachments,
  disabled = false,
  preferences,
  providerId,
  onAttachmentsChange,
  onError,
  onPreferencesChange,
}: ComposerOptionsProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const provider = PROVIDER_CATALOG.find(
    (candidate) =>
      providerId === candidate.id ||
      providerId.startsWith(`${candidate.id}:`),
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const selectImages = async () => {
    try {
      const selected = await window.osAgent.selectImages();
      const merged = new Map(
        [...attachments, ...selected].map((attachment) => [
          attachment.id,
          attachment,
        ]),
      );
      onAttachmentsChange([...merged.values()].slice(0, 4));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="composer-options" ref={rootRef}>
      <button
        className="composer-add-button"
        type="button"
        title="任务上下文与模型选项"
        aria-label="任务上下文与模型选项"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Plus size={18} />
      </button>
      {open && (
        <div className="composer-options-popover">
          <label>
            <span>上下文上限</span>
            <select
              disabled={provider?.supportsTemperature === false}
              value={preferences.maxContextTokens ?? 0}
              onChange={(event) => {
                const maxContextTokens = Number(event.target.value);
                const {
                  maxContextTokens: _previousLimit,
                  ...remaining
                } = preferences;
                onPreferencesChange(
                  maxContextTokens === 0
                    ? remaining
                    : { ...remaining, maxContextTokens },
                );
              }}
            >
              <option value={16_000}>16K</option>
              <option value={32_000}>32K</option>
              <option value={64_000}>64K</option>
              <option value={128_000}>128K</option>
              <option value={0}>模型最大值</option>
            </select>
          </label>
          <label>
            <span>
              <Thermometer size={13} />
              温度
            </span>
            <select
              value={preferences.temperature ?? 0.2}
              onChange={(event) =>
                onPreferencesChange({
                  ...preferences,
                  temperature: Number(event.target.value),
                })
              }
            >
              <option value={0}>0 · 稳定</option>
              <option value={0.2}>0.2 · 工程</option>
              <option value={0.5}>0.5 · 均衡</option>
              <option value={0.8}>0.8 · 发散</option>
              <option value={1}>1.0 · 创意</option>
            </select>
          </label>
          {provider?.supportsReasoningEffort === true && (
            <label>
              <span>
                <BrainCircuit size={13} />
                思考深度
              </span>
              <select
                value={preferences.reasoningEffort ?? 'auto'}
                onChange={(event) =>
                  onPreferencesChange({
                    ...preferences,
                    reasoningEffort: event.target.value as
                      | 'auto'
                      | 'low'
                      | 'medium'
                      | 'high',
                  })
                }
              >
                <option value="auto">自动</option>
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
            </label>
          )}
          <button
            className="composer-image-button"
            type="button"
            onClick={() => void selectImages()}
          >
            <ImagePlus size={14} />
            添加图片
          </button>
          <small>不支持该参数的模型会忽略对应选项。</small>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((attachment) => (
            <span key={attachment.id}>
              <ImagePlus size={12} />
              {attachment.name}
              <button
                type="button"
                title={`移除 ${attachment.name}`}
                aria-label={`移除 ${attachment.name}`}
                onClick={() =>
                  onAttachmentsChange(
                    attachments.filter(
                      (candidate) => candidate.id !== attachment.id,
                    ),
                  )
                }
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
