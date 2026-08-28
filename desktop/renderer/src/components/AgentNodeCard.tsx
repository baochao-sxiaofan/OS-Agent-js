import {
  Bot,
  Check,
  CircleDashed,
  LoaderCircle,
  Pause,
} from 'lucide-react';
import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from '@xyflow/react';

import type { AgentNodeView } from '../../../shared/contracts.js';

export type CompletionVisualPhase =
  | 'celebrating'
  | 'live'
  | 'retracted'
  | 'retracting'
  | 'settled';

export type AgentFlowNodeData = Record<string, unknown> & {
  agent: AgentNodeView;
  completionPhase: CompletionVisualPhase;
  isRoot: boolean;
  showResult: boolean;
};

export type AgentFlowNode = Node<AgentFlowNodeData, 'agent'>;

export function AgentNodeCard({
  data,
  selected,
}: NodeProps<AgentFlowNode>) {
  const {
    agent,
    completionPhase,
    isRoot,
    showResult,
  } = data;
  const failedTermination =
    agent.status === 'TERMINATED' &&
    agent.terminationKind !== 'completed';

  return (
    <article
      className={[
        'agent-node',
        `agent-node--${agent.status.toLowerCase()}`,
        completionPhase !== 'live'
          ? `agent-node--completion-${completionPhase}`
          : '',
        failedTermination ? 'agent-node--terminal-error' : '',
        selected ? 'agent-node--selected' : '',
        showResult ? 'agent-node--result' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
      />
      <div className="agent-node__header">
        <span className="agent-node__identity">
          <Bot size={15} />
          {isRoot ? 'ROOT' : `D${agent.depth}`}
          {agent.characterId
            ? ` · ${agent.characterId.toUpperCase()}`
            : ' · AGENT'}
        </span>
        <NodeStateIcon status={agent.status} />
      </div>

      {showResult ? (
        <div className="agent-node__result">
          <strong>当前任务已完成</strong>
          <p>{agent.result}</p>
        </div>
      ) : (
        <>
          <p className="agent-node__goal">{agent.goal}</p>
          <div className="agent-node__footer">
            <span>
              {agent.workGraph?.currentNodeAlias ??
                agent.workGraph?.mode ??
                agent.stateLabel}
            </span>
            <span>
              {agent.modelAttempts}/{agent.maxModelAttempts}
            </span>
          </div>
        </>
      )}

      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
      />
    </article>
  );
}

function NodeStateIcon({ status }: { status: AgentNodeView['status'] }) {
  switch (status) {
    case 'READY':
      return <CircleDashed size={15} />;
    case 'RUNNING':
      return <LoaderCircle className="spin" size={15} />;
    case 'BLOCKED':
      return <Pause size={15} />;
    case 'TERMINATED':
      return <Check size={15} />;
  }
}
