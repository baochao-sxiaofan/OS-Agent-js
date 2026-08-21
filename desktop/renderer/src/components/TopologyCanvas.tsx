import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type NodeMouseHandler,
  useReactFlow,
} from '@xyflow/react';
import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  AgentNodeView,
  ConversationView,
} from '../../../shared/contracts.js';
import {
  AgentNodeCard,
  type CompletionVisualPhase,
  type AgentFlowNode,
} from './AgentNodeCard.js';

type TopologyCanvasProps = {
  conversation: ConversationView;
  selectedAgentId: string | undefined;
  onSelectAgent: (agentId: string | undefined) => void;
};

const nodeTypes = {
  agent: AgentNodeCard,
};

const COMPLETION_HOLD_MS = 800;
const RETRACTION_MS = 550;

export function TopologyCanvas(props: TopologyCanvasProps) {
  return (
    <ReactFlowProvider>
      <TopologyFlow {...props} />
    </ReactFlowProvider>
  );
}

function TopologyFlow({
  conversation,
  selectedAgentId,
  onSelectAgent,
}: TopologyCanvasProps) {
  const { fitView, setCenter } = useReactFlow();
  const [completionPhases, setCompletionPhases] = useState<
    Record<string, CompletionVisualPhase>
  >({});
  const conversationIdRef = useRef(conversation.id);
  const previousStatusesRef = useRef(
    new Map(
      conversation.agents.map((agent) => [agent.id, agent.status]),
    ),
  );
  const completionTimersRef = useRef(
    new Map<string, number[]>(),
  );

  useEffect(() => {
    if (conversationIdRef.current !== conversation.id) {
      clearCompletionTimers(completionTimersRef.current);
      conversationIdRef.current = conversation.id;
      previousStatusesRef.current = new Map(
        conversation.agents.map((agent) => [agent.id, agent.status]),
      );
      setCompletionPhases({});
      return;
    }

    const previousStatuses = previousStatusesRef.current;
    for (const agent of conversation.agents) {
      const justCompleted =
        agent.terminationKind === 'completed' &&
        previousStatuses.get(agent.id) !== 'TERMINATED';
      if (justCompleted) {
        scheduleCompletionAnimation(
          agent,
          setCompletionPhases,
          completionTimersRef.current,
        );
      }
    }
    previousStatusesRef.current = new Map(
      conversation.agents.map((agent) => [agent.id, agent.status]),
    );
  }, [conversation.agents, conversation.id]);

  useEffect(
    () => () => {
      clearCompletionTimers(completionTimersRef.current);
    },
    [],
  );

  const completionPhaseById = useMemo(
    () =>
      new Map(
        conversation.agents.map((agent) => [
          agent.id,
          resolveCompletionPhase(
            agent,
            completionPhases[agent.id],
            previousStatusesRef.current.get(agent.id),
          ),
        ]),
      ),
    [completionPhases, conversation.agents],
  );
  const visibleAgents = useMemo(
    () =>
      conversation.agents.filter(
        (agent) =>
          completionPhaseById.get(agent.id) !== 'retracted',
      ),
    [completionPhaseById, conversation.agents],
  );
  const rootResultVisible = visibleAgents.some(
    (agent) =>
      agent.parentTaskId === undefined &&
      completionPhaseById.get(agent.id) === 'settled' &&
      agent.result !== undefined,
  );
  const nodes = useMemo(
    () =>
      createFlowNodes(
        visibleAgents,
        completionPhaseById,
        rootResultVisible,
        selectedAgentId,
      ),
    [
      completionPhaseById,
      rootResultVisible,
      selectedAgentId,
      visibleAgents,
    ],
  );
  const edges = useMemo(
    () => createFlowEdges(visibleAgents, completionPhaseById),
    [completionPhaseById, visibleAgents],
  );

  useEffect(() => {
    const fit = () => {
      if (rootResultVisible && visibleAgents.length === 1) {
        void setCenter(215, 102, {
          duration: 420,
          zoom: 1,
        });
        return;
      }
      void fitView({
        duration: 420,
        maxZoom: 1.05,
        minZoom: 0.42,
        padding: 0.24,
      });
    };
    const initialTimer = window.setTimeout(fit, 60);
    const settleTimer = window.setTimeout(fit, 520);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearTimeout(settleTimer);
    };
  }, [
    fitView,
    rootResultVisible,
    selectedAgentId,
    setCenter,
    visibleAgents.length,
  ]);

  const handleNodeClick: NodeMouseHandler<AgentFlowNode> = (
    _event,
    node,
  ) => {
    onSelectAgent(node.id);
  };

  return (
    <ReactFlow<AgentFlowNode>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      elevateNodesOnSelect={false}
      fitView
      minZoom={0.35}
      maxZoom={1.5}
      panOnScroll
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
      onNodeClick={handleNodeClick}
      onPaneClick={() => onSelectAgent(undefined)}
    >
      <Background
        color="#d9d9d5"
        gap={28}
        size={1}
        variant={BackgroundVariant.Dots}
      />
      <Controls
        position="bottom-left"
        showInteractive={false}
      />
    </ReactFlow>
  );
}

function createFlowNodes(
  agents: readonly AgentNodeView[],
  completionPhaseById: ReadonlyMap<string, CompletionVisualPhase>,
  rootResultVisible: boolean,
  selectedAgentId: string | undefined,
): AgentFlowNode[] {
  const positions = layoutAgents(agents, rootResultVisible);
  return agents.map((agent) => {
    const isRoot = agent.parentTaskId === undefined;
    const completionPhase =
      completionPhaseById.get(agent.id) ?? 'live';
    const showResult =
      isRoot &&
      completionPhase === 'settled' &&
      agent.result !== undefined;
    const dimensions = showResult
      ? { width: 430, height: 204 }
      : { width: 238, height: 112 };
    const ownPosition =
      positions.get(agent.id) ?? { x: 0, y: 0 };
    const parentPosition =
      agent.parentTaskId === undefined
        ? undefined
        : positions.get(agent.parentTaskId);
    const position =
      completionPhase === 'retracting' && parentPosition
        ? parentPosition
        : ownPosition;
    return {
      id: agent.id,
      type: 'agent',
      position,
      selected: selectedAgentId === agent.id,
      ...(completionPhase === 'retracting'
        ? { className: 'agent-flow-node--retracting' }
        : {}),
      width: dimensions.width,
      height: dimensions.height,
      initialWidth: dimensions.width,
      initialHeight: dimensions.height,
      measured: dimensions,
      data: {
        agent,
        completionPhase,
        isRoot,
        showResult,
      },
    };
  });
}

function createFlowEdges(
  agents: readonly AgentNodeView[],
  completionPhaseById: ReadonlyMap<string, CompletionVisualPhase>,
): Edge[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return agents.flatMap((agent): Edge[] => {
    if (!agent.parentTaskId) {
      return [];
    }
    const parent = byId.get(agent.parentTaskId);
    const completionPhase =
      completionPhaseById.get(agent.id) ?? 'live';
    const completing =
      completionPhase === 'celebrating' ||
      completionPhase === 'retracting';
    const blocked =
      agent.status === 'BLOCKED' ||
      parent?.status === 'BLOCKED';
    const stroke = completing
      ? '#3d8b5f'
      : blocked
        ? '#b8b8b2'
        : '#1d1d1b';
    return [
      {
        id: `${agent.parentTaskId}:${agent.id}`,
        source: agent.parentTaskId,
        target: agent.id,
        type: 'straight',
        animated: false,
        style: {
          stroke,
          strokeWidth: completing ? 1.6 : blocked ? 1 : 1.35,
          transition: `stroke 220ms ease, stroke-width 220ms ease, opacity ${RETRACTION_MS}ms ease`,
        },
      },
    ];
  });
}

function layoutAgents(
  agents: readonly AgentNodeView[],
  conversationCompleted: boolean,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const childrenByParent = new Map<string, AgentNodeView[]>();
  const roots: AgentNodeView[] = [];

  for (const agent of agents) {
    if (!agent.parentTaskId) {
      roots.push(agent);
      continue;
    }
    const children = childrenByParent.get(agent.parentTaskId) ?? [];
    children.push(agent);
    childrenByParent.set(agent.parentTaskId, children);
  }

  let nextLeafRow = 0;
  const visit = (agent: AgentNodeView): number => {
    const children = childrenByParent.get(agent.id) ?? [];
    let row: number;
    if (children.length === 0) {
      row = nextLeafRow;
      nextLeafRow += 1;
    } else {
      const childRows = children.map(visit);
      row =
        childRows.reduce((sum, childRow) => sum + childRow, 0) /
        childRows.length;
    }
    const depthX =
      agent.depth === 1
        ? 0
        : conversationCompleted
          ? 480 + (agent.depth - 2) * 330
          : (agent.depth - 1) * 330;
    positions.set(agent.id, {
      x: depthX,
      y: row * 164,
    });
    return row;
  };

  for (const root of roots) {
    visit(root);
    nextLeafRow += 1;
  }

  return positions;
}

function resolveCompletionPhase(
  agent: AgentNodeView,
  explicitPhase: CompletionVisualPhase | undefined,
  previousStatus: AgentNodeView['status'] | undefined,
): CompletionVisualPhase {
  if (explicitPhase) {
    return explicitPhase;
  }
  if (agent.terminationKind !== 'completed') {
    return 'live';
  }
  if (previousStatus !== undefined && previousStatus !== 'TERMINATED') {
    return 'celebrating';
  }
  return agent.parentTaskId === undefined ? 'settled' : 'retracted';
}

function scheduleCompletionAnimation(
  agent: AgentNodeView,
  setCompletionPhases: Dispatch<
    SetStateAction<Record<string, CompletionVisualPhase>>
  >,
  timers: Map<string, number[]>,
): void {
  for (const timer of timers.get(agent.id) ?? []) {
    window.clearTimeout(timer);
  }

  setCompletionPhases((current) => ({
    ...current,
    [agent.id]: 'celebrating',
  }));
  const holdTimer = window.setTimeout(() => {
    if (agent.parentTaskId === undefined) {
      setCompletionPhases((current) => ({
        ...current,
        [agent.id]: 'settled',
      }));
      timers.delete(agent.id);
      return;
    }

    setCompletionPhases((current) => ({
      ...current,
      [agent.id]: 'retracting',
    }));
    const retractTimer = window.setTimeout(() => {
      setCompletionPhases((current) => ({
        ...current,
        [agent.id]: 'retracted',
      }));
      timers.delete(agent.id);
    }, RETRACTION_MS);
    timers.set(agent.id, [retractTimer]);
  }, COMPLETION_HOLD_MS);
  timers.set(agent.id, [holdTimer]);
}

function clearCompletionTimers(timers: Map<string, number[]>): void {
  for (const timerGroup of timers.values()) {
    for (const timer of timerGroup) {
      window.clearTimeout(timer);
    }
  }
  timers.clear();
}
