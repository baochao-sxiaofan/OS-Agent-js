/** 会话成员身份由宿主生成，模型不能代替其他成员发言。 */
export type ConversationMember = { readonly kind: 'user'; readonly id: string } |
  { readonly kind: 'agent'; readonly id: number };

export type RuntimeConversation = {
  readonly id: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly kind: 'direct' | 'group';
  readonly title: string;
  readonly members: readonly ConversationMember[];
  readonly participation: 'all' | 'mentioned';
  readonly createdAt: number;
};

export type ConversationMessage = {
  readonly id: string;
  readonly sequence: number;
  readonly conversationId: string;
  readonly sender: ConversationMember;
  readonly content: string;
  readonly createdAt: number;
  readonly replyTo: string | null;
  readonly mentions: readonly number[];
  /** 宿主传播的自动交流预算标识，Agent 发言不能重置。 */
  readonly phaseId: string;
};

export type SendConversationMessage = {
  readonly content: string;
  readonly idempotencyKey: string;
  readonly replyTo?: string;
  readonly mentions?: readonly number[];
};

export type CreateConversation = {
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly kind: 'direct' | 'group';
  readonly title?: string;
  readonly members: readonly ConversationMember[];
  readonly participation?: 'all' | 'mentioned';
};

export type ConversationMailbox = {
  readonly agentId: number;
  readonly conversationId: string;
  readonly processedSequence: number;
  readonly state: 'processed' | 'aggregating' | 'processing' | 'dismissed';
  readonly dueAt: number | null;
};

export type ConversationPolicy = {
  readonly quietMs: number;
  readonly maxWaitMs: number;
  readonly groupQuietMs: number;
  readonly maxAutomaticMessages: number;
};
