import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useI18n } from "../../../i18n";
import { useChatConversationContext } from "../../mainContent/chatMessages";
import { PENDING_SESSION_KEY } from "../../mainContent/chatMessages/utils/conversationTypes";
import type {
  ChatConversationRecord,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import { ChatItem } from "./ChatItem";
import type { ExportFormat } from "./ChatItemMenu";
import {
  groupConversationsByTime,
  parseDbTimestamp,
  type TimeGroupKey,
} from "./chatTimeGroup";

const CHAT_PAGE_SIZE = 20;

/**
 * 按 updatedAt 倒序排序会话列表。
 * 必须基于时间戳比较，不能直接用字符串 localeCompare：
 * 占位符会话的 updatedAt 是 ISO UTC 格式（带 T 与 Z），
 * 而数据库返回的是 SQLite 本地时间格式（空格分隔、无时区），
 * 两种格式的字典序与真实时间顺序不一致，会导致新会话排到旧会话下方。
 */
const sortConversationsByUpdatedAt = (
  items: ChatConversationRecord[]
): ChatConversationRecord[] =>
  [...items].sort(
    (a, b) =>
      parseDbTimestamp(b.updatedAt).getTime() -
        parseDbTimestamp(a.updatedAt).getTime() ||
      b.conversationId.localeCompare(a.conversationId)
  );

type ChatsSectionProps = {
  isSwitchingDirectory: boolean;
  activeDirectory?: WorkspaceDirectoryRecord | null;
};

type SubAgentMap = Record<string, ChatConversationRecord[]>;

export function ChatsSection({
  isSwitchingDirectory,
  activeDirectory,
}: ChatsSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const {
    conversationVersion,
    upsertedConversation,
    subAgentSessionEvents,
    refreshConversations,
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
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subAgentMap, setSubAgentMap] = useState<SubAgentMap>({});
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const sectionListRef = useRef<HTMLDivElement | null>(null);

  const directoryId = activeDirectory?.directoryId ?? "";
  const hasMore = conversations.length < total;

  useEffect(() => {
    if (!directoryId) {
      setConversations([]);
      setTotal(0);
      return;
    }

    let cancelled = false;

    const loadFirstPage = async (): Promise<void> => {
      setIsLoading(true);
      setError(null);

      try {
        const result = await window.snow.listChatConversationsPaginated(
          directoryId,
          CHAT_PAGE_SIZE,
          0
        );

        if (!cancelled) {
          setConversations(result.items);
          setTotal(result.total);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : t("sidebar.loadChatsError", {
                  defaultValue: "Failed to load chats",
                })
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadFirstPage();

    return () => {
      cancelled = true;
    };
  }, [directoryId, t, conversationVersion]);

  useEffect(() => {
    if (!upsertedConversation) {
      return;
    }

    const { record: conv } = upsertedConversation;
    if (conv.directoryId !== directoryId) {
      return;
    }
    if (conv.status === "pin") {
      return;
    }

    let isNew = false;
    setConversations((prev) => {
      const existingIndex = prev.findIndex(
        (item) => item.conversationId === conv.conversationId
      );

      if (existingIndex >= 0) {
        const updated = prev.map((item) =>
          item.conversationId === conv.conversationId ? conv : item
        );
        return sortConversationsByUpdatedAt(updated);
      }

      // If the real conversation arrives, replace the pending placeholder.
      const pendingIndex = prev.findIndex(
        (item) => item.conversationId === PENDING_SESSION_KEY
      );
      if (pendingIndex >= 0) {
        const replaced = prev.map((item, index) =>
          index === pendingIndex ? conv : item
        );
        return sortConversationsByUpdatedAt(replaced);
      }

      isNew = true;
      // New conversation: prepend and re-sort by updatedAt
      return sortConversationsByUpdatedAt([conv, ...prev]);
    });

    if (isNew) {
      setTotal((prev) => prev + 1);
    }
  }, [upsertedConversation, directoryId]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (isLoadingMore || !hasMore || !directoryId || isLoading) {
      return;
    }

    setIsLoadingMore(true);

    try {
      const result = await window.snow.listChatConversationsPaginated(
        directoryId,
        CHAT_PAGE_SIZE,
        conversations.length
      );

      setConversations((prev) => [...prev, ...result.items]);
      setTotal(result.total);
    } catch {
      // Silent fail for pagination
    } finally {
      setIsLoadingMore(false);
    }
  }, [conversations.length, directoryId, hasMore, isLoading, isLoadingMore]);

  useEffect(() => {
    if (!hasMore || isLoading) {
      return;
    }

    const sentinel = loadMoreRef.current;

    if (!sentinel) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      {
        root: sectionListRef.current,
        rootMargin: "0px 0px 64px",
        threshold: 0.1,
      }
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [hasMore, isLoading, loadMore, conversations.length]);

  const showLoading = isSwitchingDirectory || (isLoading && directoryId !== "");

  const handlePin = async (
    conversation: ChatConversationRecord
  ): Promise<void> => {
    try {
      await window.snow.updateConversationStatus(
        conversation.conversationId,
        "pin"
      );
      refreshConversations();
    } catch {
      // Silent fail
    }
  };

  const handleRename = async (
    conversation: ChatConversationRecord,
    newTitle: string
  ): Promise<void> => {
    await window.snow.renameConversation(conversation.conversationId, newTitle);
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
      abortConversation(conversation.conversationId);
      await window.snow.deleteConversation(conversation.conversationId);
      if (conversation.conversationId === activeConversationId) {
        handleNewChat();
      }
      refreshConversations();
    } catch {
      // Silent fail
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

  const timeGroups = groupConversationsByTime(conversations);

  useEffect(() => {
    if (conversations.length === 0) {
      setSubAgentMap({});
      return;
    }

    let cancelled = false;

    const loadSubAgents = async (): Promise<void> => {
      const entries = await Promise.all(
        conversations.map(async (conv) => {
          try {
            const subAgents = await window.snow.listSubAgentConversations(
              conv.conversationId
            );
            return [conv.conversationId, subAgents] as const;
          } catch {
            return [
              conv.conversationId,
              [] as ChatConversationRecord[],
            ] as const;
          }
        })
      );

      if (!cancelled) {
        const map: SubAgentMap = {};
        for (const [id, subs] of entries) {
          if (subs.length > 0) {
            map[id] = subs;
          }
        }
        setSubAgentMap(map);
      }
    };

    void loadSubAgents();

    return () => {
      cancelled = true;
    };
  }, [conversations]);

  useEffect(() => {
    const events = Object.values(subAgentSessionEvents);
    if (events.length === 0) {
      return;
    }

    setSubAgentMap((prev) => {
      let next = prev;
      for (const event of events) {
        const { parentConversationId, conversationId, agentName, status } =
          event;

        const existing = next[parentConversationId] ?? [];
        const existingIndex = existing.findIndex(
          (item) => item.conversationId === conversationId
        );

        const subAgentRecord: ChatConversationRecord = {
          conversationId,
          title: agentName,
          summary: "",
          lastMessagePreview: "",
          messageCount: 0,
          model: "",
          apiProfileName: "",
          status: "active",
          directoryId: "",
          forkedFromConversationId: "",
          forkMessageCount: 0,
          conversationType: "sub_agent",
          parentConversationId,
          subAgentId: event.agentId,
          subAgentName: agentName,
          subAgentStatus: status,
          subAgentError: "",
          createdAt: new Date(event.timestamp).toISOString(),
          updatedAt: new Date(event.timestamp).toISOString(),
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalDurationMs: 0,
          emoji: "",
        };

        if (existingIndex >= 0) {
          const updated = [...existing];
          updated[existingIndex] = {
            ...updated[existingIndex],
            subAgentStatus: status,
            subAgentName: agentName,
          };
          next = { ...next, [parentConversationId]: updated };
        } else {
          next = {
            ...next,
            [parentConversationId]: [...existing, subAgentRecord],
          };
        }
      }
      return next;
    });
  }, [subAgentSessionEvents]);

  const getGroupLabel = (key: TimeGroupKey): string => {
    switch (key) {
      case "today":
        return t("sidebar.chatTimeToday", { defaultValue: "Today" });
      case "yesterday":
        return t("sidebar.chatTimeYesterday", {
          defaultValue: "Yesterday",
        });
      case "last7days":
        return t("sidebar.chatTimeLast7Days", {
          defaultValue: "Last 7 days",
        });
      case "earlier":
        return t("sidebar.chatTimeEarlier", { defaultValue: "Earlier" });
      default:
        return "";
    }
  };

  return (
    <div className="sidebar-section chats-section">
      <div className="section-header">
        <span className="section-title">
          {t("sidebar.chats", { defaultValue: "Chats" })}
        </span>
      </div>
      <div className="section-list" ref={sectionListRef}>
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
        ) : error ? (
          <span className="empty-text error">{error}</span>
        ) : conversations.length === 0 ? (
          <span className="empty-text">
            {t("sidebar.noChats", { defaultValue: "No chats" })}
          </span>
        ) : (
          <>
            {timeGroups.map((group) => (
              <div key={group.key}>
                <div className="chat-time-group-header">
                  {getGroupLabel(group.key)}
                </div>
                {group.conversations.map((conversation) => (
                  <ChatItem
                    key={conversation.conversationId}
                    conversation={conversation}
                    isActive={
                      conversation.conversationId === activeConversationId
                    }
                    isStreaming={streamingConversationIds.has(
                      conversation.conversationId
                    )}
                    isCompleted={completedConversationIds.has(
                      conversation.conversationId
                    )}
                    subAgentConversations={
                      subAgentMap[conversation.conversationId] ?? []
                    }
                    activeSubAgentConversationId={activeConversationId}
                    onPin={() => void handlePin(conversation)}
                    onRename={(newTitle) =>
                      handleRename(conversation, newTitle)
                    }
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
                          cacheReadInputTokens:
                            conversation.cacheReadInputTokens,
                        },
                        conversation.directoryId
                      )
                    }
                    onSelectSubAgent={(subConvId) =>
                      void handleSelectConversation(
                        subConvId,
                        undefined,
                        undefined,
                        conversation.directoryId
                      )
                    }
                  />
                ))}
              </div>
            ))}
            {hasMore ? (
              <div
                className={`chat-load-more ${
                  isLoadingMore ? "is-loading" : ""
                }`}
                ref={loadMoreRef}
                role={isLoadingMore ? "status" : undefined}
                aria-live="polite"
                aria-label={
                  isLoadingMore
                    ? t("sidebar.chatLoadingMore", {
                        defaultValue: "Loading more chats...",
                      })
                    : undefined
                }
              >
                {isLoadingMore ? (
                  <>
                    <Loader2 className="spin" size={14} aria-hidden="true" />
                    <span>
                      {t("sidebar.chatLoadingMore", {
                        defaultValue: "Loading more chats...",
                      })}
                    </span>
                  </>
                ) : null}
              </div>
            ) : (
              <div className="chat-all-loaded">
                {t("sidebar.chatAllLoaded", {
                  defaultValue: "All chats loaded",
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
