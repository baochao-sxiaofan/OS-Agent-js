import {
  Ban,
  Bot,
  Clock3,
  Coins,
  FileArchive,
  Hash,
  Layers3,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';

import type { AgentNodeView } from '../../../shared/contracts.js';

type AgentInspectorProps = {
  agent: AgentNodeView;
  onCancel: (taskId: string) => Promise<void>;
  onClose: () => void;
};

export function AgentInspector({
  agent,
  onCancel,
  onClose,
}: AgentInspectorProps) {
  return (
    <aside className="agent-inspector">
      <header className="inspector-header">
        <div>
          <span className="inspector-eyebrow">
            <Bot size={14} />
            Agent D{agent.depth}
          </span>
          <h2>{agent.stateLabel}</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          title="关闭检查器"
          aria-label="关闭检查器"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>

      <div className="inspector-scroll">
        <section className="inspector-section">
          <h3>当前任务</h3>
          <p className="inspector-goal">{agent.goal}</p>
          {agent.stateDetail && (
            <p className="inspector-state-detail">{agent.stateDetail}</p>
          )}
          {agent.result && (
            <pre className="inspector-result">{agent.result}</pre>
          )}
        </section>

        <section className="inspector-section inspector-metrics">
          <Metric
            icon={<Layers3 size={15} />}
            label="调度深度"
            value={`D${agent.depth}`}
          />
          <Metric
            icon={<Zap size={15} />}
            label="模型轮次"
            value={`${agent.modelAttempts}/${agent.maxModelAttempts}`}
          />
          <Metric
            icon={<Coins size={15} />}
            label="Token"
            value={`${agent.inputTokens + agent.outputTokens}`}
          />
          <Metric
            icon={<Clock3 size={15} />}
            label="运行时间"
            value={formatDuration(agent.createdAt, agent.updatedAt)}
          />
        </section>

        <section className="inspector-section">
          <h3>身份</h3>
          <dl className="identity-list">
            {agent.characterId && (
              <div>
                <dt>Character</dt>
                <dd>{agent.characterId}</dd>
              </div>
            )}
            <div>
              <dt>
                <Hash size={13} />
                Task ID
              </dt>
              <dd>{agent.id}</dd>
            </div>
            <div>
              <dt>预算</dt>
              <dd>
                ${agent.spentCostUsd.toFixed(4)} /{' '}
                {agent.maxCostUsd < 1_000_000
                  ? `$${agent.maxCostUsd.toFixed(2)}`
                  : 'Unlimited'}
              </dd>
            </div>
          </dl>
        </section>

        {agent.workGraph && (
          <section className="inspector-section">
            <h3>
              <Workflow size={14} />
              Work Graph R{agent.workGraph.revision}
            </h3>
            <p className="inspector-state-detail">
              {agent.workGraph.mode}
              {agent.workGraph.currentNodeAlias
                ? ` · ${agent.workGraph.currentNodeAlias}`
                : ''}
            </p>
            <ol className="work-graph-list">
              {agent.workGraph.nodes.map((node) => (
                <li key={node.alias}>
                  <strong>{node.alias}</strong>
                  <span>
                    {node.kind} · {node.assignee} · {node.status}
                  </span>
                  <p>{node.objective}</p>
                </li>
              ))}
            </ol>
          </section>
        )}

        {agent.artifacts.length > 0 && (
          <section className="inspector-section">
            <h3>
              <FileArchive size={14} />
              Artifacts
            </h3>
            <ol className="artifact-list">
              {agent.artifacts.map((artifact) => (
                <li key={artifact.uri}>
                  <strong>{artifact.title}</strong>
                  <span>
                    {artifact.kind} · R{artifact.revision}
                    {artifact.graphNodeAlias
                      ? ` · ${artifact.graphNodeAlias}`
                      : ''}
                  </span>
                  <code>{artifact.uri}</code>
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className="inspector-section inspector-timeline">
          <h3>事件记录</h3>
          <ol>
            {[...agent.events].reverse().map((event) => (
              <li key={event.id}>
                <span className="event-marker" />
                <div className="event-copy">
                  <div>
                    <strong>{event.label}</strong>
                    <time>{formatTime(event.occurredAt)}</time>
                  </div>
                  {event.detail && <p>{event.detail}</p>}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {agent.status !== 'TERMINATED' && (
        <footer className="inspector-actions">
          <button
            className="cancel-task-button"
            type="button"
            onClick={() => void onCancel(agent.id)}
          >
            <Ban size={16} />
            取消任务
          </button>
        </footer>
      )}
    </aside>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="inspector-metric">
      <span>
        {icon}
        {label}
      </span>
      <strong>{value}</strong>
    </div>
  );
}

function formatDuration(startedAt: number, updatedAt: number): string {
  const seconds = Math.max(0, Math.round((updatedAt - startedAt) / 1_000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timestamp);
}
