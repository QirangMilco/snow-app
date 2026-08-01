import {
  ChevronRight,
  GitFork,
  Loader2,
  MessageSquareMore,
  AlertCircle,
  CheckCircle2,
  Bot,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../../i18n";
import type { ChatConversationRecord } from "../../../../preload";
import { ChatItemMenu, type ExportFormat } from "./ChatItemMenu";
import { formatTimeLabel, parseDbTimestamp } from "./chatTimeGroup";

type ChatItemProps = {
  conversation: ChatConversationRecord;
  isActive?: boolean;
  isStreaming?: boolean;
  isCompleted?: boolean;
  subAgentConversations?: ChatConversationRecord[];
  activeSubAgentConversationId?: string;
  onPin: () => void;
  onRename: (newTitle: string) => Promise<void>;
  onSetEmoji: (emoji: string) => Promise<void>;
  onDelete: () => void;
  onExport: (format: ExportFormat) => void;
  onSelect?: () => void;
  onSelectSubAgent?: (conversationId: string) => void;
};

export function ChatItem({
  conversation,
  isActive = false,
  isStreaming = false,
  isCompleted = false,
  subAgentConversations = [],
  activeSubAgentConversationId,
  onPin,
  onRename,
  onSetEmoji,
  onDelete,
  onExport,
  onSelect,
  onSelectSubAgent,
}: ChatItemProps): React.JSX.Element {
  const { t } = useI18n();
  const [isEditing, setIsEditing] = useState(false);
  const [editingValue, setEditingValue] = useState("");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  const isSubmittingRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (isEditing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [isEditing]);

  const hasSubAgents = subAgentConversations.length > 0;
  const hasActiveSubAgent = subAgentConversations.some(
    (sub) => sub.conversationId === activeSubAgentConversationId
  );

  useEffect(() => {
    if (hasActiveSubAgent) {
      setIsExpanded(true);
    }
  }, [hasActiveSubAgent]);

  const handleRenameStart = (): void => {
    setEditingValue(conversation.summary || conversation.title || "");
    isSubmittingRef.current = false;
    cancelledRef.current = false;
    setIsEditing(true);
  };

  const handleRenameSubmit = async (): Promise<void> => {
    if (isSubmittingRef.current || cancelledRef.current) {
      return;
    }
    isSubmittingRef.current = true;

    const trimmed = editingValue.trim();
    const original = conversation.summary || conversation.title || "";

    if (!trimmed) {
      setEditingValue(original);
      setIsEditing(false);
      isSubmittingRef.current = false;
      return;
    }

    if (trimmed === original) {
      setIsEditing(false);
      isSubmittingRef.current = false;
      return;
    }

    try {
      await onRename(trimmed);
    } finally {
      setIsEditing(false);
      isSubmittingRef.current = false;
    }
  };

  const handleRenameCancel = (): void => {
    cancelledRef.current = true;
    setIsEditing(false);
  };

  const handleRenameKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>
  ): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      void handleRenameSubmit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      handleRenameCancel();
    }
  };

  const isPinned = conversation.status === "pin";
  const isForked = conversation.forkedFromConversationId !== "";
  const hasEmoji = conversation.emoji.trim() !== "";
  const displayName =
    conversation.summary ||
    conversation.title ||
    t("sidebar.untitledChat", { defaultValue: "Untitled" });

  const now = new Date();
  const parsedDate = parseDbTimestamp(conversation.updatedAt);
  const rawTimeLabel = formatTimeLabel(parsedDate, now);
  const timeLabel =
    rawTimeLabel === "yesterday"
      ? t("sidebar.chatTimeYesterday", { defaultValue: "Yesterday" })
      : rawTimeLabel;

  const handleSelectClick = (): void => {
    if (isEditing) {
      return;
    }
    onSelect?.();
  };

  const handleToggleExpand = (event: React.MouseEvent): void => {
    event.stopPropagation();
    setIsExpanded((prev) => !prev);
  };

  const renderSubAgentIcon = (status: string): React.ReactNode => {
    if (status === "running") {
      return <Loader2 size={11} className="spin" />;
    }
    if (status === "failed") {
      return <AlertCircle size={11} className="sub-agent-failed" />;
    }
    if (status === "completed") {
      return <CheckCircle2 size={11} className="sub-agent-completed" />;
    }
    return <Bot size={11} />;
  };

  const runningSubAgentCount = subAgentConversations.filter(
    (sub) => sub.subAgentStatus === "running"
  ).length;

  return (
    <div
      className={`chat-item${isMenuOpen ? " menu-open" : ""}${
        isActive ? " active" : ""
      }`}
      key={conversation.conversationId}
      onClick={handleSelectClick}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (
          !isEditing &&
          (event.key === "Enter" || event.key === " ") &&
          onSelect
        ) {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <span
        className={`chat-item-icon${isStreaming ? " streaming" : ""}${
          isCompleted && !isStreaming ? " completed" : ""
        }${isForked ? " forked" : ""}${hasSubAgents ? " has-sub-agents" : ""}${
          hasEmoji ? " has-emoji" : ""
        }`}
        onClick={(event) => {
          // 图标不再承载交互，点击仅阻止选中会话；修改入口在右键菜单中
          event.stopPropagation();
        }}
      >
        {isStreaming ? (
          <Loader2 size={11} className="spin" />
        ) : hasEmoji ? (
          <span className="chat-item-emoji">{conversation.emoji}</span>
        ) : isForked ? (
          <GitFork size={11} />
        ) : (
          <MessageSquareMore size={11} />
        )}
        {isCompleted && !isStreaming && <span className="chat-item-badge" />}
      </span>
      <div className="chat-item-content">
        {isEditing ? (
          <input
            ref={editInputRef}
            className="chat-item-rename-input"
            type="text"
            value={editingValue}
            onChange={(event) => setEditingValue(event.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={() => void handleRenameSubmit()}
            placeholder={t("sidebar.chatRenamePlaceholder", {
              defaultValue: "Enter new name",
            })}
          />
        ) : (
          <>
            <div className="chat-item-title-row">
              {hasSubAgents && (
                <span
                  className="chat-item-expand-toggle"
                  onClick={handleToggleExpand}
                  role="button"
                  tabIndex={-1}
                >
                  <ChevronRight
                    size={12}
                    className={isExpanded ? "expanded" : ""}
                  />
                </span>
              )}
              <span
                className="chat-item-title"
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  handleRenameStart();
                }}
              >
                {displayName}
              </span>
              {hasSubAgents && runningSubAgentCount > 0 && (
                <span className="chat-item-sub-agent-count">
                  {runningSubAgentCount}
                </span>
              )}
              <span className="chat-item-time">{timeLabel}</span>
            </div>
          </>
        )}
      </div>
      {!isEditing && (
        <span
          className="chat-item-menu-wrapper"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <ChatItemMenu
            isPinned={isPinned}
            emoji={conversation.emoji}
            onPin={onPin}
            onRename={handleRenameStart}
            onSetEmoji={onSetEmoji}
            onDelete={onDelete}
            onExport={onExport}
            onOpenChange={setIsMenuOpen}
          />
        </span>
      )}
      {hasSubAgents && isExpanded && (
        <div className="chat-item-sub-agents">
          {subAgentConversations.map((subAgent) => (
            <div
              key={subAgent.conversationId}
              className={`chat-sub-agent-item${
                subAgent.conversationId === activeSubAgentConversationId
                  ? " active"
                  : ""
              }`}
              onClick={(event) => {
                event.stopPropagation();
                onSelectSubAgent?.(subAgent.conversationId);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectSubAgent?.(subAgent.conversationId);
                }
              }}
            >
              <span className="chat-sub-agent-icon">
                {renderSubAgentIcon(subAgent.subAgentStatus)}
              </span>
              <span className="chat-sub-agent-name">
                {subAgent.subAgentName ||
                  subAgent.title ||
                  t("sidebar.subAgent", { defaultValue: "Sub-agent" })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
