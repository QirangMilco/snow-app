import { ArrowDown, Eye, Loader2, Square } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { WorkspaceDirectoryRecord } from "../../../preload";
import { useAutoScrollPreference } from "../../hooks/useAutoScrollPreference";
import { useI18n } from "../../i18n";
import { ChatInput } from "./ChatInput";
import { EmptyChatGreeting } from "./EmptyChatGreeting";
import { ChatMessageList, useChatConversationContext } from "./chatMessages";
import { FileChangeStatsPanel } from "./chatMessages/components/FileChangeStatsPanel";
import { RollbackConfirmDialog } from "./chatMessages/dialogs/RollbackConfirmDialog";
import { CompactionStream } from "./chatMessages/components/CompactionStream";
import { StreamMetrics } from "./chatInput/StreamMetrics";
import type { ChatInputSendOptions } from "./chatInput/types";
import type { MainContentView } from "./types";
import type { RollbackMode } from "./chatMessages/utils/conversationTypes";

type ChatContentProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onNavigateToView?: (view: MainContentView) => void;
};

type PendingScrollRestore = {
  conversationId: string;
  requestId: number;
  scrollHeight: number;
  scrollTop: number;
};

const LOAD_OLDER_SCROLL_THRESHOLD = 96;
const SHOW_SCROLL_TO_BOTTOM_THRESHOLD = 160;

const ChatContentBody = ({
  activeDirectory,
  onNavigateToView,
}: ChatContentProps): React.JSX.Element => {
  const {
    messages,
    activeConversationId,
    activeConversationType,
    isLoadingOlderMessages,
    hasMoreMessages,
    isInitialHistoryLoaded,
    isLoadingInitialHistory,
    loadOlderMessages,
    handleSendMessage,
    isStreaming,
    isAborting,
    isPaused,
    handleAbort,
    handlePause,
    handleResume,
    streamTokenCount,
    streamElapsedMs,
    streamTtftMs,
    streamStartedAt,
    tokenUsage,
    draftToRestore,
    autoSendToken,
    clearDraftToRestore,
    rollbackPreview,
    confirmRollback,
    cancelRollback,
    pendingMessages,
    withdrawPendingMessage,
    sendPendingMessageNow,
    compactConversation,
    compactionPreview,
    compactionError,
    isCompacting,
    compactingConversationId,
    yoloMode,
    isUpdatingYoloMode,
    setYoloMode,
    refreshYoloMode,
    planMode,
    isUpdatingPlanMode,
    setPlanMode,
    refreshPlanMode,
    goalMode,
    isUpdatingGoalMode,
    setGoalMode,
    refreshGoalMode,
    goalModeTokenBudget,
    setGoalModeTokenBudget,
    pendingToolAuthorizations,
  } = useChatConversationContext();
  const { t } = useI18n();
  const { autoScrollEnabled, setAutoScrollEnabled } = useAutoScrollPreference();
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const hasMessages = messages.length > 0;
  const hasHistoryContent = hasMessages || isLoadingInitialHistory;
  const isSubAgentConversation = activeConversationType === "sub_agent";
  // Compaction state is global, but the preview/error UI must only appear in
  // the conversation that is actually compacting — otherwise it bleeds into
  // other conversations after a switch.
  const isCompactionForActiveConversation =
    activeConversationId != null &&
    activeConversationId === compactingConversationId;
  const isCompactingActive = isCompacting && isCompactionForActiveConversation;
  const activeCompactionError = isCompactionForActiveConversation
    ? compactionError
    : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeConversationIdRef = useRef(activeConversationId);
  const previousActiveConversationIdRef = useRef(activeConversationId);
  const positionedConversationIdsRef = useRef(new Set<string>());
  const pendingScrollRestoreRef = useRef<PendingScrollRestore | null>(null);
  const scrollRestoreRequestIdRef = useRef(0);
  const isLoadingOlderWithScrollRef = useRef(false);
  const scrolledAuthorizationSignatureRef = useRef("");
  const shouldStickToBottomRef = useRef(true);
  const isInitialBottomPositioningRef = useRef(false);
  const isUserScrollIntentRef = useRef(false);
  // True while the scroll-to-bottom button's smooth animation is running:
  // the scroll handler must not re-derive the follow state from the still-far
  // distance during the animation, or a streaming conversation stops tracking
  // new content right after the animation lands on its stale target.
  const isSmoothScrollingToBottomRef = useRef(false);
  const previousIsCompactingRef = useRef(isCompactingActive);
  const scrollRafIdRef = useRef(0);
  const hasMessagesRef = useRef(hasMessages);
  activeConversationIdRef.current = activeConversationId;
  hasMessagesRef.current = hasMessages;

  // Shared by the scroll handler and the resize observer: content height
  // changes (tool details expanding/collapsing, lazily rendered message
  // groups, decoded images) can leave the viewport at the bottom — or remove
  // the scrollbar entirely — without ever firing a scroll event, so the
  // follow state and button visibility must be derived from live geometry.
  const updateScrollFollowState = useCallback(
    (container: HTMLDivElement): void => {
      if (isSmoothScrollingToBottomRef.current) {
        shouldStickToBottomRef.current = true;
        setShowScrollToBottom(false);
        return;
      }

      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;

      if (
        isInitialBottomPositioningRef.current &&
        !isUserScrollIntentRef.current
      ) {
        shouldStickToBottomRef.current = true;
        setShowScrollToBottom(false);
        return;
      }

      shouldStickToBottomRef.current = distanceFromBottom < 48;
      setShowScrollToBottom(
        hasMessagesRef.current &&
          distanceFromBottom > SHOW_SCROLL_TO_BOTTOM_THRESHOLD
      );
    },
    []
  );

  useLayoutEffect(() => {
    if (previousActiveConversationIdRef.current === activeConversationId) {
      return;
    }

    previousActiveConversationIdRef.current = activeConversationId;
    scrollRestoreRequestIdRef.current += 1;
    pendingScrollRestoreRef.current = null;
    isLoadingOlderWithScrollRef.current = false;
    scrolledAuthorizationSignatureRef.current = "";
    shouldStickToBottomRef.current = true;
    isInitialBottomPositioningRef.current = false;
    isUserScrollIntentRef.current = false;
    setShowScrollToBottom(false);
    if (activeConversationId) {
      positionedConversationIdsRef.current.delete(activeConversationId);
    }

    const container = scrollRef.current;
    if (container) {
      container.scrollTop = 0;
    }
  }, [activeConversationId]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (
      !container ||
      !activeConversationId ||
      !isInitialHistoryLoaded ||
      isLoadingInitialHistory ||
      messages.length === 0 ||
      positionedConversationIdsRef.current.has(activeConversationId)
    ) {
      return;
    }

    // content-visibility: auto on .chat-message-group causes scrollHeight to
    // be based on contain-intrinsic-size estimates (80px per message) until
    // the browser lazily renders off-screen messages. These immediate passes
    // handle the first paints; the ResizeObserver below keeps following later
    // height changes from Markdown workers, tool views, and image decoding.
    let rafId1 = 0;
    let rafId2 = 0;
    let rafId3 = 0;

    const scrollToBottom = (): void => {
      container.scrollTop = container.scrollHeight;
    };

    isInitialBottomPositioningRef.current = true;
    isUserScrollIntentRef.current = false;
    shouldStickToBottomRef.current = true;
    setShowScrollToBottom(false);
    scrollToBottom();
    rafId1 = requestAnimationFrame(() => {
      scrollToBottom();
      rafId2 = requestAnimationFrame(() => {
        scrollToBottom();
        rafId3 = requestAnimationFrame(scrollToBottom);
      });
    });

    positionedConversationIdsRef.current.add(activeConversationId);

    return (): void => {
      cancelAnimationFrame(rafId1);
      cancelAnimationFrame(rafId2);
      cancelAnimationFrame(rafId3);
    };
  }, [
    activeConversationId,
    isInitialHistoryLoaded,
    isLoadingInitialHistory,
    messages.length,
  ]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || !activeConversationId) {
      return;
    }

    let resizeRafId = 0;
    let lastScrollHeight = container.scrollHeight;
    const observedChildren = new Set<Element>();

    // Keep the viewport pinned to the latest content synchronously, within
    // the same frame and before paint. The ResizeObserver notification step
    // runs before requestAnimationFrame and before paint, so adjusting
    // scrollTop here ensures grown streaming content is never painted at a
    // stale scroll position — which was the source of the jitter when this
    // work was deferred to requestAnimationFrame.
    const keepAtBottomSync = (): void => {
      if (
        scrollRef.current !== container ||
        activeConversationIdRef.current !== activeConversationId
      ) {
        return;
      }

      const nextScrollHeight = container.scrollHeight;
      const didContentHeightChange = nextScrollHeight !== lastScrollHeight;
      lastScrollHeight = nextScrollHeight;

      if (!didContentHeightChange) {
        return;
      }

      // Re-evaluate against the fresh geometry before deciding whether to
      // pin: a shrink may have already landed the viewport at the bottom.
      // Skip while older messages are being prepended — the pending scroll
      // restore will re-position the viewport and the follow-up scroll event
      // re-evaluates the state.
      if (
        !isLoadingOlderWithScrollRef.current &&
        pendingScrollRestoreRef.current === null
      ) {
        updateScrollFollowState(container);
      }

      if (
        !shouldStickToBottomRef.current ||
        isLoadingOlderWithScrollRef.current ||
        pendingScrollRestoreRef.current !== null
      ) {
        return;
      }

      container.scrollTop = nextScrollHeight;
    };

    // Coalesce bulk DOM mutations (child list changes, image loads) into a
    // single check per animation frame. These events can fire in bursts and a
    // one-frame delay is acceptable here, unlike the per-frame streaming
    // growth handled synchronously by the ResizeObserver above.
    const scheduleResizeCheck = (): void => {
      if (resizeRafId === 0) {
        resizeRafId = requestAnimationFrame(() => {
          resizeRafId = 0;
          keepAtBottomSync();
        });
      }
    };

    const resizeObserver = new ResizeObserver(keepAtBottomSync);
    // Once the smooth scroll-to-bottom animation finishes (or is interrupted
    // by the pinning jump below), the follow state can be re-derived from the
    // live geometry again. "scrollend" fires after every programmatic and
    // user-initiated scroll settles, including one that was cut short.
    const handleScrollEnd = (): void => {
      if (!isSmoothScrollingToBottomRef.current) {
        return;
      }
      isSmoothScrollingToBottomRef.current = false;
      updateScrollFollowState(container);
    };
    container.addEventListener("scrollend", handleScrollEnd);
    const observeCurrentChildren = (): void => {
      for (const child of observedChildren) {
        if (!container.contains(child)) {
          resizeObserver.unobserve(child);
          observedChildren.delete(child);
        }
      }

      for (const child of Array.from(container.children)) {
        if (!observedChildren.has(child)) {
          observedChildren.add(child);
          resizeObserver.observe(child);
        }
      }
    };

    observeCurrentChildren();

    const mutationObserver = new MutationObserver(() => {
      observeCurrentChildren();
      scheduleResizeCheck();
    });
    mutationObserver.observe(container, { childList: true });
    container.addEventListener("load", scheduleResizeCheck, true);

    return (): void => {
      if (resizeRafId !== 0) {
        cancelAnimationFrame(resizeRafId);
      }
      container.removeEventListener("scrollend", handleScrollEnd);
      container.removeEventListener("load", scheduleResizeCheck, true);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [activeConversationId, updateScrollFollowState]);

  // When tool authorization prompts appear, force-scroll the chat area to
  // the bottom so users do not miss the confirmation while reading earlier
  // messages and leave the agent loop blocked without noticing.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || !activeConversationId) {
      return;
    }

    const visibleAuthorizations = pendingToolAuthorizations.filter(
      (toolCall) =>
        toolCall.authorizationConversationId === activeConversationId
    );
    if (visibleAuthorizations.length === 0) {
      scrolledAuthorizationSignatureRef.current = "";
      return;
    }

    const signature = visibleAuthorizations
      .map(
        (toolCall) =>
          toolCall.authorizationId ??
          `${toolCall.name}-${toolCall.callId ?? toolCall.arguments}`
      )
      .join("|");
    if (signature === scrolledAuthorizationSignatureRef.current) {
      return;
    }

    scrolledAuthorizationSignatureRef.current = signature;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, [activeConversationId, pendingToolAuthorizations]);

  // Keep the chat pinned to the latest AI output while streaming, unless the
  // user scrolls away or has disabled the preference entirely.
  useLayoutEffect(() => {
    if (
      !autoScrollEnabled ||
      !isStreaming ||
      !shouldStickToBottomRef.current ||
      !scrollRef.current
    ) {
      return;
    }

    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [autoScrollEnabled, isStreaming, messages]);

  // Compaction is an explicit operation, so its preview and persisted boundary
  // must remain visible regardless of the user's normal auto-scroll preference.
  useLayoutEffect(() => {
    const wasCompacting = previousIsCompactingRef.current;
    previousIsCompactingRef.current = isCompactingActive;
    if (wasCompacting === isCompactingActive) {
      return;
    }

    shouldStickToBottomRef.current = true;
    const scrollToBottom = (): void => {
      const container = scrollRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    };

    scrollToBottom();
    requestAnimationFrame(scrollToBottom);
  }, [isCompactingActive]);

  const handleLoadOlderWithScroll = useCallback(async (): Promise<void> => {
    const container = scrollRef.current;
    const conversationId = activeConversationIdRef.current;
    if (!container || !conversationId || isLoadingOlderWithScrollRef.current) {
      return;
    }

    const requestId = ++scrollRestoreRequestIdRef.current;
    isLoadingOlderWithScrollRef.current = true;
    pendingScrollRestoreRef.current = {
      conversationId,
      requestId,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
    };

    try {
      await loadOlderMessages();
    } finally {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const pendingRestore = pendingScrollRestoreRef.current;
          if (
            pendingRestore &&
            pendingRestore.requestId === requestId &&
            pendingRestore.conversationId === activeConversationIdRef.current &&
            scrollRef.current === container
          ) {
            const addedHeight =
              container.scrollHeight - pendingRestore.scrollHeight;
            container.scrollTop =
              pendingRestore.scrollTop + Math.max(0, addedHeight);
          }

          if (scrollRestoreRequestIdRef.current === requestId) {
            pendingScrollRestoreRef.current = null;
            isLoadingOlderWithScrollRef.current = false;
          }
        });
      });
    }
  }, [loadOlderMessages]);

  const markUserScrollIntent = useCallback((): void => {
    isUserScrollIntentRef.current = true;
    isInitialBottomPositioningRef.current = false;
    // A user-initiated scroll cancels the button's smooth animation: stop
    // protecting the follow state so the user's position is respected.
    isSmoothScrollingToBottomRef.current = false;
  }, []);

  const handleChatPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX >= bounds.right - 16) {
        markUserScrollIntent();
      }
    },
    [markUserScrollIntent]
  );

  const handleChatKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (
        event.key === "ArrowUp" ||
        event.key === "ArrowDown" ||
        event.key === "PageUp" ||
        event.key === "PageDown" ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === " "
      ) {
        markUserScrollIntent();
      }
    },
    [markUserScrollIntent]
  );

  const handleChatScroll = useCallback((): void => {
    // Throttle scroll handling with requestAnimationFrame to avoid
    // excessive layout reads during fast scrolling through many
    // Markdown-rendered messages.
    if (scrollRafIdRef.current !== 0) {
      return;
    }

    scrollRafIdRef.current = requestAnimationFrame(() => {
      scrollRafIdRef.current = 0;
      const container = scrollRef.current;
      if (!container) {
        return;
      }

      const isFollowingInitialContent =
        isInitialBottomPositioningRef.current && !isUserScrollIntentRef.current;
      updateScrollFollowState(container);
      if (isFollowingInitialContent) {
        return;
      }

      if (
        container.scrollTop > LOAD_OLDER_SCROLL_THRESHOLD ||
        !hasMoreMessages ||
        isLoadingOlderMessages ||
        isLoadingOlderWithScrollRef.current
      ) {
        return;
      }

      void handleLoadOlderWithScroll();
    });
  }, [
    handleLoadOlderWithScroll,
    hasMoreMessages,
    isLoadingOlderMessages,
    updateScrollFollowState,
  ]);

  const handleScrollToBottom = useCallback((): void => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    shouldStickToBottomRef.current = true;
    isInitialBottomPositioningRef.current = false;
    isUserScrollIntentRef.current = false;
    // Protect the follow state while the smooth animation runs: during the
    // animation the distance is still large, so without this the scroll
    // handler would flip the stick flag back to false and a streaming
    // conversation would stop tracking new content right after the animation
    // lands on its stale target.
    isSmoothScrollingToBottomRef.current = true;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth",
    });
  }, []);

  const handleSendWithScroll = useCallback(
    (message: string, options: ChatInputSendOptions) => {
      handleSendMessage(message, options);
      shouldStickToBottomRef.current = true;
      isInitialBottomPositioningRef.current = false;
      isUserScrollIntentRef.current = false;
      setShowScrollToBottom(false);
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    },
    [handleSendMessage]
  );

  const handleConfirmRollback = useCallback(
    (mode: RollbackMode): void => {
      void confirmRollback(mode);
    },
    [confirmRollback]
  );

  // Cancel any pending scroll-throttle animation frame on unmount.
  useEffect(() => {
    return () => {
      if (scrollRafIdRef.current !== 0) {
        cancelAnimationFrame(scrollRafIdRef.current);
        scrollRafIdRef.current = 0;
      }
    };
  }, []);

  return (
    <div
      className={`chat-content ${
        hasHistoryContent ? "has-messages" : "is-empty"
      }`}
    >
      <div
        key={activeConversationId ?? "new-chat"}
        className={`chat-area ${
          isLoadingInitialHistory ? "is-loading-history" : ""
        }`}
        ref={scrollRef}
        onWheel={markUserScrollIntent}
        onTouchStart={markUserScrollIntent}
        onPointerDown={handleChatPointerDown}
        onKeyDown={handleChatKeyDown}
        onScroll={handleChatScroll}
        tabIndex={0}
        aria-busy={isLoadingInitialHistory || isLoadingOlderMessages}
      >
        {isLoadingInitialHistory ? (
          <div className="chat-initial-history-skeleton" aria-hidden="true">
            {Array.from({ length: 3 }, (_, index) => (
              <div
                className={`chat-message-skeleton ${
                  index === 1 ? "is-user" : "is-assistant"
                }`}
                key={index}
              >
                <div className="chat-message-skeleton-line is-primary" />
                <div className="chat-message-skeleton-line is-secondary" />
                {index === 0 ? (
                  <div className="chat-message-skeleton-line is-tertiary" />
                ) : null}
              </div>
            ))}
          </div>
        ) : hasMessages ? (
          <>
            {isLoadingOlderMessages ? (
              <div className="chat-history-skeleton" aria-hidden="true">
                <div className="chat-history-skeleton-line" />
                <div className="chat-history-skeleton-line" />
                <div className="chat-history-skeleton-line" />
              </div>
            ) : null}
            <FileChangeStatsPanel conversationId={activeConversationId} />
            <ChatMessageList
              messages={messages}
              isStreaming={isStreaming}
              isAborting={isAborting}
              scrollContainerRef={scrollRef}
            />
            <CompactionStream
              isCompacting={isCompactingActive}
              compactionPreview={compactionPreview}
              compactionError={activeCompactionError}
            />
          </>
        ) : (
          <EmptyChatGreeting
            activeDirectory={activeDirectory}
            onNavigateToView={onNavigateToView}
          />
        )}
      </div>

      <div className="chat-input-region">
        {showScrollToBottom && hasMessages ? (
          <button
            className={`chat-scroll-to-bottom${
              isStreaming ? " is-streaming" : ""
            }`}
            type="button"
            onClick={handleScrollToBottom}
            aria-label={t("chat.scrollToBottom")}
            title={t("chat.scrollToBottom")}
          >
            <ArrowDown size={20} strokeWidth={2} aria-hidden="true" />
          </button>
        ) : null}
        {isLoadingInitialHistory ? null : isSubAgentConversation ? (
          <div className="sub-agent-monitor">
            <div
              className="sub-agent-monitor-status"
              role="status"
              aria-live="polite"
            >
              <Eye size={14} aria-hidden="true" />
              <span>{t("chat.subAgentReadOnly")}</span>
            </div>
            {isStreaming || isAborting ? (
              <div className="sub-agent-monitor-controls">
                {isStreaming ? (
                  <StreamMetrics
                    tokenCount={streamTokenCount}
                    elapsedMs={streamElapsedMs}
                    ttftMs={streamTtftMs}
                    startedAt={streamStartedAt}
                    isPaused={isPaused}
                    onPause={handlePause}
                    onResume={handleResume}
                  />
                ) : null}
                <button
                  className={`abort-btn ${isAborting ? "is-aborting" : ""}`}
                  aria-label={
                    isAborting
                      ? t("chat.subAgentStopping")
                      : t("chat.subAgentStop")
                  }
                  title={
                    isAborting
                      ? t("chat.subAgentStopping")
                      : t("chat.subAgentStop")
                  }
                  onClick={handleAbort}
                  disabled={isAborting}
                  type="button"
                >
                  {isAborting ? (
                    <Loader2 size={14} className="spin" aria-hidden="true" />
                  ) : (
                    <Square size={14} fill="currentColor" aria-hidden="true" />
                  )}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <ChatInput
            projectId={activeDirectory?.directoryId}
            projectName={activeDirectory?.name}
            conversationId={activeConversationId}
            onSend={handleSendWithScroll}
            isStreaming={isStreaming}
            isAborting={isAborting}
            onAbort={handleAbort}
            tokenUsage={tokenUsage}
            draftToRestore={draftToRestore}
            autoSendToken={autoSendToken}
            onDraftRestored={clearDraftToRestore}
            pendingMessages={pendingMessages}
            onWithdrawPendingMessage={withdrawPendingMessage}
            onSendPendingMessageNow={sendPendingMessageNow}
            onCompactConversation={compactConversation}
            yoloMode={yoloMode}
            isUpdatingYoloMode={isUpdatingYoloMode}
            onYoloModeChange={setYoloMode}
            onRefreshYoloMode={refreshYoloMode}
            planMode={planMode}
            isUpdatingPlanMode={isUpdatingPlanMode}
            onPlanModeChange={setPlanMode}
            onRefreshPlanMode={refreshPlanMode}
            goalMode={goalMode}
            isUpdatingGoalMode={isUpdatingGoalMode}
            onGoalModeChange={setGoalMode}
            onRefreshGoalMode={refreshGoalMode}
            goalModeTokenBudget={goalModeTokenBudget}
            onGoalModeTokenBudgetChange={setGoalModeTokenBudget}
            autoScrollEnabled={autoScrollEnabled}
            onAutoScrollChange={setAutoScrollEnabled}
            isCompacting={isCompactingActive}
          />
        )}
      </div>

      {rollbackPreview ? (
        <RollbackConfirmDialog
          changes={rollbackPreview.changes}
          checkpointId={rollbackPreview.checkpointId}
          workDir={rollbackPreview.workDir}
          isFirstMessage={rollbackPreview.isFirstMessage}
          todoItems={rollbackPreview.todoItems}
          onConfirm={handleConfirmRollback}
          onCancel={cancelRollback}
        />
      ) : null}
    </div>
  );
};

export const ChatContent = ({
  activeDirectory,
  onNavigateToView,
}: ChatContentProps): React.JSX.Element => {
  return (
    <ChatContentBody
      activeDirectory={activeDirectory}
      onNavigateToView={onNavigateToView}
    />
  );
};
