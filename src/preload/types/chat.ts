import type {
  StreamInterruptionReason,
  StreamRecoveryOutcome,
} from "./api";

export type ChatConversationRecord = {
  conversationId: string;
  title: string;
  summary: string;
  lastMessagePreview: string;
  messageCount: number;
  model: string;
  apiProfileName: string;
  status: string;
  directoryId: string;
  forkedFromConversationId: string;
  forkMessageCount: number;
  conversationType: string;
  parentConversationId: string;
  subAgentId: string;
  subAgentName: string;
  subAgentStatus: string;
  subAgentError: string;
  createdAt: string;
  updatedAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalDurationMs: number;
  emoji: string;
};

export type ChatConversationPage = {
  items: ChatConversationRecord[];
  total: number;
};

export type ConversationSearchResult = {
  conversationId: string;
  title: string;
  summary: string;
  lastMessagePreview: string;
  messageCount: number;
  model: string;
  status: string;
  directoryId: string;
  forkedFromConversationId: string;
  forkMessageCount: number;
  createdAt: string;
  updatedAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  matchedContent: string;
};

export type ChatMessageRecord = {
  id: string;
  role: string;
  content: string;
  thinking: string;
  status: string;
  model: string;
  responseId: string;
  checkpointId: string;
  toolCallsJson: string;
  interruptionReason?: StreamInterruptionReason | null;
  recoveryOutcome?: StreamRecoveryOutcome | null;
  createdAt: string;
};

export type ChatMessagePage = {
  items: ChatMessageRecord[];
  total: number;
  hasMore: boolean;
};

export type UserMessageSummary = {
  id: string;
  content: string;
  createdAt: string;
};
