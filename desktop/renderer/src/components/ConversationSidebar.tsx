import {
  CheckCircle2,
  CircleDashed,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  TriangleAlert,
  Wrench,
} from 'lucide-react';

import type {
  ConversationStatus,
  ConversationView,
} from '../../../shared/contracts.js';

type ConversationSidebarProps = {
  collapsed: boolean;
  conversations: readonly ConversationView[];
  selectedConversationId: string | undefined;
  onCreateConversation: () => void;
  onOpenSettings: () => void;
  onSelectConversation: (conversationId: string) => void;
  onToggle: () => void;
};

export function ConversationSidebar({
  collapsed,
  conversations,
  selectedConversationId,
  onCreateConversation,
  onOpenSettings,
  onSelectConversation,
  onToggle,
}: ConversationSidebarProps) {
  return (
    <aside
      className={`conversation-sidebar ${
        collapsed ? 'conversation-sidebar--collapsed' : ''
      }`}
    >
      <div className="sidebar-header">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        {!collapsed && <strong className="brand-name">OS Agent</strong>}
        <button
          className="icon-button sidebar-toggle"
          type="button"
          title={collapsed ? '展开会话列表' : '收起会话列表'}
          aria-label={collapsed ? '展开会话列表' : '收起会话列表'}
          onClick={onToggle}
        >
          {collapsed ? (
            <PanelLeftOpen size={17} />
          ) : (
            <PanelLeftClose size={17} />
          )}
        </button>
      </div>

      <button
        className={`new-conversation-button ${
          collapsed ? 'new-conversation-button--collapsed' : ''
        }`}
        type="button"
        title="新建 Conversation"
        onClick={onCreateConversation}
      >
        <Plus size={17} />
        {!collapsed && <span>新建 Conversation</span>}
      </button>

      <div className="conversation-list">
        {conversations.map((conversation) => (
          <button
            className={`conversation-item ${
              selectedConversationId === conversation.id
                ? 'conversation-item--selected'
                : ''
            } ${collapsed ? 'conversation-item--collapsed' : ''}`}
            type="button"
            title={conversation.title}
            key={conversation.id}
            onClick={() => onSelectConversation(conversation.id)}
          >
            <span className="conversation-icon">
              <ConversationStatusIcon status={conversation.status} />
            </span>
            {!collapsed && (
              <span className="conversation-copy">
                <span className="conversation-title">
                  {conversation.title}
                </span>
                <span className="conversation-meta">
                  {conversation.totalAgentCount === 0
                    ? '尚未开始'
                    : `${conversation.totalAgentCount} Agents`}
                </span>
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="sidebar-footer">
        <button
          className={`settings-button ${
            collapsed ? 'settings-button--collapsed' : ''
          }`}
          type="button"
          title="模型设置"
          onClick={onOpenSettings}
        >
          <Wrench size={16} />
          {!collapsed && <span>模型与 API</span>}
        </button>
      </div>
    </aside>
  );
}

function ConversationStatusIcon({
  status,
}: {
  status: ConversationStatus;
}) {
  switch (status) {
    case 'active':
      return <CircleDashed className="status-icon status-icon--active" />;
    case 'completed':
      return <CheckCircle2 className="status-icon status-icon--completed" />;
    case 'failed':
      return <TriangleAlert className="status-icon status-icon--failed" />;
    case 'empty':
      return <MessageSquare className="status-icon status-icon--empty" />;
  }
}
