import {
  Activity,
  Boxes,
  Cpu,
  Gauge,
  Plus,
  X,
} from 'lucide-react';
import {
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  ConversationStatus,
  RuntimeSnapshotView,
} from '../../shared/contracts.js';
import { AgentCapacityMeter } from './components/AgentCapacityMeter.js';
import { AgentInspector } from './components/AgentInspector.js';
import { ConversationFlow } from './components/ConversationFlow.js';
import { ConversationSidebar } from './components/ConversationSidebar.js';
import { SettingsDialog } from './components/SettingsDialog.js';
import { TaskComposer } from './components/TaskComposer.js';
import { TopologyCanvas } from './components/TopologyCanvas.js';
import {
  ViewModeSwitch,
  type ViewMode,
} from './components/ViewModeSwitch.js';

export function App() {
  const [snapshot, setSnapshot] =
    useState<RuntimeSnapshotView | null>(null);
  const [selectedConversationId, setSelectedConversationId] =
    useState<string>();
  const [selectedTopologyRootTaskId, setSelectedTopologyRootTaskId] =
    useState<string>();
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('topology');
  const [roundDraftConversationId, setRoundDraftConversationId] =
    useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string>();
  const previousConversationStatuses = useRef(
    new Map<string, ConversationStatus>(),
  );

  useEffect(() => {
    let active = true;
    void window.osAgent.getSnapshot().then((nextSnapshot) => {
      if (active) {
        receiveSnapshot(nextSnapshot);
      }
    });
    const unsubscribe = window.osAgent.onSnapshotChanged((nextSnapshot) => {
      if (active) {
        receiveSnapshot(nextSnapshot);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const receiveSnapshot = (nextSnapshot: RuntimeSnapshotView) => {
    setSnapshot(nextSnapshot);
    setSelectedConversationId((current) => {
      if (
        current &&
        nextSnapshot.conversations.some(
          (conversation) => conversation.id === current,
        )
      ) {
        return current;
      }
      return nextSnapshot.conversations[0]?.id;
    });
  };

  const selectedConversation = useMemo(
    () =>
      snapshot?.conversations.find(
        (conversation) => conversation.id === selectedConversationId,
      ),
    [selectedConversationId, snapshot],
  );
  const selectedTopologyRound = selectedConversation?.rounds.find(
    (round) => round.rootTaskId === selectedTopologyRootTaskId,
  );
  const topologyConversation = useMemo(() => {
    if (!selectedConversation || !selectedTopologyRound) {
      return selectedConversation;
    }
    return {
      ...selectedConversation,
      rootTaskId: selectedTopologyRound.rootTaskId,
      status: selectedTopologyRound.status,
      agents: selectedTopologyRound.agents,
    };
  }, [selectedConversation, selectedTopologyRound]);
  const selectedAgent = topologyConversation?.agents.find(
    (agent) => agent.id === selectedAgentId,
  );

  useEffect(() => {
    if (!selectedConversation) {
      return;
    }
    setSelectedTopologyRootTaskId((current) =>
      current &&
      selectedConversation.rounds.some(
        (round) => round.rootTaskId === current,
      )
        ? current
        : selectedConversation.rootTaskId,
    );
  }, [selectedConversation]);

  useEffect(() => {
    if (!snapshot || !selectedConversation) {
      return;
    }

    const previousStatus = previousConversationStatuses.current.get(
      selectedConversation.id,
    );
    if (
      previousStatus === 'active' &&
      (selectedConversation.status === 'completed' ||
        selectedConversation.status === 'failed')
    ) {
      setSelectedAgentId(undefined);
      setViewMode('conversation');
    }
    previousConversationStatuses.current = new Map(
      snapshot.conversations.map((conversation) => [
        conversation.id,
        conversation.status,
      ]),
    );
  }, [selectedConversation, snapshot]);

  const createConversation = async () => {
    try {
      setError(undefined);
      const nextSnapshot = await window.osAgent.createConversation();
      setSnapshot(nextSnapshot);
      const newestEmpty = nextSnapshot.conversations.find(
        (conversation) => conversation.status === 'empty',
      );
      setSelectedConversationId(newestEmpty?.id);
      setSelectedTopologyRootTaskId(undefined);
      setSelectedAgentId(undefined);
      setRoundDraftConversationId(undefined);
      setViewMode('topology');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const submitTask = async (task: string, source: ViewMode) => {
    if (!selectedConversation) {
      return;
    }
    try {
      setError(undefined);
      const nextSnapshot = await window.osAgent.submitTask({
        conversationId: selectedConversation.id,
        task,
      });
      setSnapshot(nextSnapshot);
      const updatedConversation = nextSnapshot.conversations.find(
        (conversation) => conversation.id === selectedConversation.id,
      );
      setSelectedTopologyRootTaskId(updatedConversation?.rootTaskId);
      setRoundDraftConversationId(undefined);
      setViewMode(source);
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    }
  };

  const cancelTask = async (taskId: string) => {
    try {
      setError(undefined);
      setSnapshot(await window.osAgent.cancelTask(taskId));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  if (!snapshot || !selectedConversation) {
    return <div className="app-loading" />;
  }

  return (
    <main
      className={`desktop-shell platform-${snapshot.platform} ${
        sidebarCollapsed ? 'desktop-shell--sidebar-collapsed' : ''
      }`}
    >
      <ConversationSidebar
        collapsed={sidebarCollapsed}
        conversations={snapshot.conversations}
        selectedConversationId={selectedConversationId}
        onCreateConversation={() => void createConversation()}
        onOpenSettings={() => setSettingsOpen(true)}
        onSelectConversation={(conversationId) => {
          const nextConversation = snapshot.conversations.find(
            (conversation) => conversation.id === conversationId,
          );
          setSelectedConversationId(conversationId);
          setSelectedTopologyRootTaskId(nextConversation?.rootTaskId);
          setSelectedAgentId(undefined);
          setRoundDraftConversationId(undefined);
          setViewMode(
            nextConversation?.status === 'completed' ||
              nextConversation?.status === 'failed'
              ? 'conversation'
              : 'topology',
          );
        }}
        onToggle={() => setSidebarCollapsed((current) => !current)}
      />

      <section className="workspace">
        <header className="runtime-bar">
          <div className="runtime-title">
            <span>{selectedConversation.title}</span>
            <small>
              {snapshot.isDemoMode
                ? 'LOCAL SIMULATION'
                : snapshot.providerId.toUpperCase()}
            </small>
          </div>
          <div className="runtime-actions">
            <div className="runtime-metrics">
              <RuntimeMetric
                icon={<Boxes size={14} />}
                label="Agents"
                value={`${snapshot.metrics.liveAgents.current}`}
              />
              <RuntimeMetric
                icon={<Gauge size={14} />}
                label="Ready"
                value={`${snapshot.metrics.readyQueue.current}`}
              />
              <RuntimeMetric
                icon={<Cpu size={14} />}
                label="Requests"
                value={`${snapshot.metrics.providerRequests.active}`}
              />
              <RuntimeMetric
                icon={<Activity size={14} />}
                label="Ops"
                value={`${snapshot.metrics.activeOperations}`}
              />
            </div>
            <ViewModeSwitch mode={viewMode} onChange={setViewMode} />
          </div>
        </header>

        <div className="workspace-body">
          {viewMode === 'conversation' ? (
            <ConversationFlow
              conversation={selectedConversation}
              onSubmit={async (task) =>
                await submitTask(task, 'conversation')
              }
              onOpenTopology={(rootTaskId) => {
                setSelectedAgentId(undefined);
                setSelectedTopologyRootTaskId(rootTaskId);
                setViewMode('topology');
              }}
            />
          ) : (
            <section className="topology-stage">
              {topologyConversation?.agents.length === 0 ||
              roundDraftConversationId === selectedConversation.id ? (
                <TaskComposer
                  onSubmit={async (task) =>
                    await submitTask(task, 'topology')
                  }
                />
              ) : topologyConversation ? (
                <TopologyCanvas
                  conversation={topologyConversation}
                  selectedAgentId={selectedAgentId}
                  onSelectAgent={setSelectedAgentId}
                />
              ) : null}

              {selectedTopologyRound && (
                <div className="topology-round-indicator">
                  ROUND{' '}
                  {selectedConversation.rounds.findIndex(
                    (round) =>
                      round.rootTaskId ===
                      selectedTopologyRound.rootTaskId,
                  ) + 1}
                  <span>{selectedTopologyRound.goal}</span>
                </div>
              )}

              {(selectedConversation.status === 'completed' ||
                selectedConversation.status === 'failed') &&
                roundDraftConversationId !== selectedConversation.id && (
                <button
                  className="topology-new-round"
                  type="button"
                  onClick={() => {
                    setSelectedAgentId(undefined);
                    setRoundDraftConversationId(selectedConversation.id);
                  }}
                >
                  <Plus size={16} />
                  发起新一轮任务
                </button>
              )}

              <AgentCapacityMeter
                available={snapshot.metrics.liveAgents.available}
                limit={snapshot.metrics.liveAgents.limit}
              />
            </section>
          )}

          {viewMode === 'topology' && selectedAgent && (
            <AgentInspector
              agent={selectedAgent}
              onCancel={cancelTask}
              onClose={() => setSelectedAgentId(undefined)}
            />
          )}
        </div>
      </section>

      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button
            className="icon-button"
            type="button"
            title="关闭"
            aria-label="关闭"
            onClick={() => setError(undefined)}
          >
            <X size={15} />
          </button>
        </div>
      )}

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={(result) => setSnapshot(result.snapshot)}
      />
    </main>
  );
}

function RuntimeMetric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <span className="runtime-metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
