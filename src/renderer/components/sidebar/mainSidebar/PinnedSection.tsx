import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useI18n } from "../../../i18n";
import { useChatConversationContext } from "../../mainContent/chatMessages";
import type {
  ChatConversationRecord,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import { ChatItem } from "./ChatItem";
import type { ExportFormat } from "./ChatItemMenu";

type PinnedSectionProps = {
  isSwitchingDirectory: boolean;
  activeDirectory?: WorkspaceDirectoryRecord | null;
};

export function PinnedSection({
  isSwitchingDirectory,
  activeDirectory,
}: PinnedSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const {
    conversationListVersion,
    upsertedConversation,
    refreshConversations,
    updateConversationSummary,
    handleSelectConversation,
    handleNewChat,
    activeConversationId,
    abortConversation,
    streamingConversationIds,
    completedConversationIds,
  } = useChatConversationContext();
  const [conversations, setConversations] = useState<ChatConversationRecord[]>(
    []
  );
  const [isLoading, setIsLoading] = useState(false);

  const directoryId = activeDirectory?.directoryId ?? "";

  useEffect(() => {
    if (!directoryId) {
      setConversations([]);
      return;
    }

    let cancelled = false;

    const loadPinnedConversations = async (): Promise<void> => {
      setIsLoading(true);

      try {
        const result = await window.snow.listPinnedConversations(directoryId);

        if (!cancelled) {
          setConversations(result);
        }
      } catch {
        if (!cancelled) {
          setConversations([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadPinnedConversations();

    return () => {
      cancelled = true;
    };
  }, [directoryId, conversationListVersion]);

  useEffect(() => {
    if (!upsertedConversation) {
      return;
    }

    const { record: conv } = upsertedConversation;
    if (conv.directoryId !== directoryId) {
      return;
    }

    setConversations((prev) => {
      const existing = prev.find(
        (item) => item.conversationId === conv.conversationId
      );

      if (existing) {
        // If the conversation was unpinned, remove it from the pinned list
        if (conv.status !== "pin") {
          return prev.filter(
            (item) => item.conversationId !== conv.conversationId
          );
        }
        // 记录内容未变化时保持原引用，避免无意义替换触发重渲染
        if (JSON.stringify(existing) === JSON.stringify(conv)) {
          return prev;
        }
        // Otherwise update in place
        return prev.map((item) =>
          item.conversationId === conv.conversationId ? conv : item
        );
      }

      // New pinned conversation: prepend
      if (conv.status === "pin") {
        return [conv, ...prev];
      }

      return prev;
    });
  }, [upsertedConversation, directoryId]);

  const showLoading = isSwitchingDirectory || (isLoading && directoryId !== "");

  const handleUnpin = async (
    conversation: ChatConversationRecord
  ): Promise<void> => {
    try {
      await window.snow.updateConversationStatus(
        conversation.conversationId,
        "active"
      );
      refreshConversations();
    } catch {
      // 静默失败
    }
  };

  const handleRename = async (
    conversation: ChatConversationRecord,
    newTitle: string
  ): Promise<void> => {
    await window.snow.renameConversation(conversation.conversationId, newTitle);
    // 同步更新内存中 session 的 summary，让 TopBar 标题即时刷新
    updateConversationSummary(conversation.conversationId, newTitle);
    refreshConversations();
  };

  const handleSetEmoji = async (
    conversation: ChatConversationRecord,
    emoji: string
  ): Promise<void> => {
    // 乐观更新：直接修改本地 state，异步落库，不刷新列表
    setConversations((prev) =>
      prev.map((item) =>
        item.conversationId === conversation.conversationId
          ? { ...item, emoji }
          : item
      )
    );
    try {
      await window.snow.updateConversationEmoji(
        conversation.conversationId,
        emoji
      );
    } catch {
      // 落库失败时回滚
      setConversations((prev) =>
        prev.map((item) =>
          item.conversationId === conversation.conversationId
            ? { ...item, emoji: conversation.emoji }
            : item
        )
      );
    }
  };

  const handleDelete = async (
    conversation: ChatConversationRecord
  ): Promise<void> => {
    try {
      // 置顶列表不维护子代理映射：删除前查询一次，以便级联删除时
      // 中止对应流，并在当前正打开被删会话或其子代理时清空聊天区
      let deleteTargetIds = [conversation.conversationId];
      try {
        const subAgents = await window.snow.listSubAgentConversations(
          conversation.conversationId
        );
        deleteTargetIds = [
          ...deleteTargetIds,
          ...subAgents.map((sub) => sub.conversationId),
        ];
      } catch {
        // 查询失败按无子代理处理，不阻塞删除
      }
      for (const targetId of deleteTargetIds) {
        abortConversation(targetId);
      }

      await window.snow.deleteConversation(conversation.conversationId);

      if (
        activeConversationId &&
        deleteTargetIds.includes(activeConversationId)
      ) {
        handleNewChat();
      }
      refreshConversations();
    } catch {
      // 静默失败
    }
  };

  const handleExport = async (
    conversation: ChatConversationRecord,
    format: ExportFormat
  ): Promise<void> => {
    const fileName =
      conversation.summary ||
      conversation.title ||
      t("sidebar.untitledChat", { defaultValue: "Untitled" });
    await window.snow.exportConversation(
      conversation.conversationId,
      format,
      fileName
    );
  };

  return (
    <div className="sidebar-section">
      <div className="section-header">
        <span className="section-title">
          {t("sidebar.pinned", { defaultValue: "Pinned" })}
        </span>
      </div>
      <div className="section-list">
        {showLoading ? (
          <span className="empty-text loading">
            <Loader2 className="spin" size={13} />
            {t("sidebar.loadingWorkspaceContent", {
              defaultValue: "Loading workspace content...",
            })}
          </span>
        ) : !directoryId ? (
          <span className="empty-text">
            {t("sidebar.noActiveDirectory", {
              defaultValue: "No active directory",
            })}
          </span>
        ) : conversations.length === 0 ? (
          <span className="empty-text">
            {t("sidebar.noPinnedItems", { defaultValue: "No pinned items" })}
          </span>
        ) : (
          conversations.map((conversation) => (
            <ChatItem
              key={conversation.conversationId}
              conversation={conversation}
              isActive={conversation.conversationId === activeConversationId}
              isStreaming={streamingConversationIds.has(
                conversation.conversationId
              )}
              isCompleted={completedConversationIds.has(
                conversation.conversationId
              )}
              onPin={() => void handleUnpin(conversation)}
              onRename={(newTitle) => handleRename(conversation, newTitle)}
              onSetEmoji={(emoji) => handleSetEmoji(conversation, emoji)}
              onDelete={() => void handleDelete(conversation)}
              onExport={(format) => handleExport(conversation, format)}
              onSelect={() =>
                void handleSelectConversation(
                  conversation.conversationId,
                  conversation.summary || conversation.title,
                  {
                    inputTokens: conversation.inputTokens,
                    outputTokens: conversation.outputTokens,
                    cacheCreationInputTokens:
                      conversation.cacheCreationInputTokens,
                    cacheReadInputTokens: conversation.cacheReadInputTokens,
                  },
                  conversation.directoryId
                )
              }
            />
          ))
        )}
      </div>
    </div>
  );
}
