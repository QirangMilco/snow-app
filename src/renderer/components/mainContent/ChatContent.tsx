import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  CheckCircle2,
  XCircle,
} from "lucide-react";
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
import { RollbackConfirmDialog } from "./chatMessages/dialogs/RollbackConfirmDialog";
import { CompactionStream } from "./chatMessages/components/CompactionStream";
import { UserMessageRail } from "./chatMessages/components/UserMessageRail";
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
    isLoadingOlderMessages,
    hasMoreMessages,
    isInitialHistoryLoaded,
    isLoadingInitialHistory,
    loadOlderMessages,
    handleSendMessage,
    isStreaming,
    isAborting,
    handleAbort,
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
    conversationVersion,
    subAgentSessionEvents,
    handleSelectConversation,
  } = useChatConversationContext();
  const { t } = useI18n();
  const { autoScrollEnabled, setAutoScrollEnabled } = useAutoScrollPreference();
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const hasMessages = messages.length > 0;
  const hasHistoryContent = hasMessages || isLoadingInitialHistory;
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

  // Sub-agent run state of the active conversation. The persisted record
  // (fetched on switch) covers conversations opened after their run ended
  // (e.g. after an app restart); the live session event takes precedence
  // while a run is in flight or has just finished in this app session.
  const [activeConversationMeta, setActiveConversationMeta] = useState<{
    conversationType: string;
    subAgentStatus: string;
    parentConversationId: string;
  } | null>(null);

  useEffect(() => {
    if (!activeConversationId) {
      setActiveConversationMeta(null);
      return;
    }

    let cancelled = false;
    void window.snow
      .getChatConversation(activeConversationId)
      .then((record) => {
        if (cancelled || !record) {
          return;
        }
        setActiveConversationMeta({
          conversationType: record.conversationType,
          subAgentStatus: record.subAgentStatus,
          parentConversationId: record.parentConversationId,
        });
      })
      .catch(() => {
        // Best effort — live session events still cover in-flight runs.
      });

    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  const liveSubAgentEvent = activeConversationId
    ? subAgentSessionEvents[activeConversationId]
    : undefined;
  const isSubAgentConversation =
    Boolean(liveSubAgentEvent) ||
    activeConversationMeta?.conversationType === "sub_agent";
  const subAgentRunStatus =
    liveSubAgentEvent?.status ??
    activeConversationMeta?.subAgentStatus ??
    "";
  // Once its run ends the sub-agent conversation becomes read-only: the
  // input box disappears and only a status notice remains. While the run is
  // live the input stays visible so the user can insert pending messages.
  const isSubAgentFinished =
    isSubAgentConversation &&
    subAgentRunStatus !== "" &&
    subAgentRunStatus !== "running";
  const subAgentParentConversationId =
    activeConversationMeta?.parentConversationId ||
    liveSubAgentEvent?.parentConversationId ||
    "";

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
  // Animation-frame id of the custom scroll-to-bottom tween. Unlike the native
  // smooth scroll, this re-derives the target every frame so streaming content
  // that grows mid-animation is always reached, and the ResizeObserver's
  // synchronous pin is suppressed while the tween is active to avoid the
  // instant jump that used to interrupt the animation.
  const scrollToBottomAnimRef = useRef(0);
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
    if (scrollToBottomAnimRef.current !== 0) {
      cancelAnimationFrame(scrollToBottomAnimRef.current);
      scrollToBottomAnimRef.current = 0;
    }
    isSmoothScrollingToBottomRef.current = false;
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

      // Skip while older messages are being prepended — the pending scroll
      // restore will re-position the viewport and the follow-up scroll event
      // re-evaluates the state. Also skip while the scroll-to-bottom tween is
      // running: it re-derives its own target each frame, so a synchronous jump
      // here would fight the animation and cause the half-scroll / jitter.
      if (
        !isLoadingOlderWithScrollRef.current &&
        pendingScrollRestoreRef.current === null &&
        !isSmoothScrollingToBottomRef.current
      ) {
        updateScrollFollowState(container);
      }

      if (
        !shouldStickToBottomRef.current ||
        isLoadingOlderWithScrollRef.current ||
        pendingScrollRestoreRef.current !== null ||
        isSmoothScrollingToBottomRef.current
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

    // Cancel any tween already in flight before starting a new one.
    if (scrollToBottomAnimRef.current !== 0) {
      cancelAnimationFrame(scrollToBottomAnimRef.current);
      scrollToBottomAnimRef.current = 0;
    }

    shouldStickToBottomRef.current = true;
    isInitialBottomPositioningRef.current = false;
    isUserScrollIntentRef.current = false;
    // Protect the follow state while the tween runs: during the animation the
    // distance is still large, so without this the scroll handler would flip
    // the stick flag back to false and a streaming conversation would stop
    // tracking new content right after the animation lands on a stale target.
    isSmoothScrollingToBottomRef.current = true;
    setShowScrollToBottom(false);

    // Capture the starting scrollTop once so the easing curve is stable. The
    // *target* (maxScrollTop) is re-read every frame so content that streams
    // in mid-animation is always reached — the native smooth scroll computed
    // its target once at call time and would stop short when the target moved.
    const startTop = container.scrollTop;
    const startTimeMs = performance.now();
    const durationMs = 350;
    let lastTop = startTop;

    const tick = (nowMs: number): void => {
      if (scrollRef.current !== container) {
        scrollToBottomAnimRef.current = 0;
        isSmoothScrollingToBottomRef.current = false;
        return;
      }

      const maxScrollTop =
        container.scrollHeight - container.clientHeight;

      // The user took over the wheel / keyboard and moved away from the
      // tween's last position: stop the animation and let the live geometry
      // drive the follow state, respecting the user's intent.
      if (
        isUserScrollIntentRef.current &&
        Math.abs(container.scrollTop - lastTop) > 2
      ) {
        scrollToBottomAnimRef.current = 0;
        isSmoothScrollingToBottomRef.current = false;
        updateScrollFollowState(container);
        return;
      }

      const elapsed = nowMs - startTimeMs;
      const progress = Math.min(1, elapsed / durationMs);
      // easeOutCubic — decelerates to the target, feels native.
      const eased = 1 - Math.pow(1 - progress, 3);
      const currentTarget =
        startTop + (maxScrollTop - startTop) * eased;
      const nextTop = Math.min(currentTarget, maxScrollTop);
      container.scrollTop = nextTop;
      lastTop = nextTop;

      if (progress >= 1 || nextTop >= maxScrollTop - 1) {
        container.scrollTop = maxScrollTop;
        scrollToBottomAnimRef.current = 0;
        isSmoothScrollingToBottomRef.current = false;
        updateScrollFollowState(container);
        return;
      }

      scrollToBottomAnimRef.current = requestAnimationFrame(tick);
    };

    scrollToBottomAnimRef.current = requestAnimationFrame(tick);
  }, [updateScrollFollowState]);

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

  // Cancel any pending scroll-throttle and scroll-to-bottom animation frames
  // on unmount.
  useEffect(() => {
    return () => {
      if (scrollRafIdRef.current !== 0) {
        cancelAnimationFrame(scrollRafIdRef.current);
        scrollRafIdRef.current = 0;
      }
      if (scrollToBottomAnimRef.current !== 0) {
        cancelAnimationFrame(scrollToBottomAnimRef.current);
        scrollToBottomAnimRef.current = 0;
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

      {hasMessages ? (
        <UserMessageRail
          conversationId={activeConversationId}
          scrollContainerRef={scrollRef}
          loadOlderMessages={loadOlderMessages}
          isLoadingOlderMessages={isLoadingOlderMessages}
          hasMoreMessages={hasMoreMessages}
          conversationVersion={conversationVersion}
          shouldStickToBottomRef={shouldStickToBottomRef}
          isInitialBottomPositioningRef={isInitialBottomPositioningRef}
          isUserScrollIntentRef={isUserScrollIntentRef}
        />
      ) : null}

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
        {isLoadingInitialHistory ? null : isSubAgentFinished ? (
          <SubAgentFinishedNotice
            status={subAgentRunStatus}
            parentConversationId={subAgentParentConversationId}
            onBackToParent={handleSelectConversation}
          />
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

/**
 * Read-only footer shown in place of the input box once a sub-agent
 * conversation's run has ended (completed, failed or cancelled). Offers a
 * shortcut back to the parent conversation where the dialogue continues.
 */
const SubAgentFinishedNotice = ({
  status,
  parentConversationId,
  onBackToParent,
}: {
  status: string;
  parentConversationId: string;
  onBackToParent: (conversationId: string) => Promise<void> | void;
}): React.JSX.Element => {
  const { t } = useI18n();

  const icon =
    status === "failed" ? (
      <AlertCircle size={15} aria-hidden="true" />
    ) : status === "cancelled" ? (
      <XCircle size={15} aria-hidden="true" />
    ) : (
      <CheckCircle2 size={15} aria-hidden="true" />
    );
  const [messageKey, messageDefault] =
    status === "failed"
      ? [
          "chat.subAgentFinished.failed",
          "This sub-agent failed. The conversation is read-only.",
        ]
      : status === "cancelled"
        ? [
            "chat.subAgentFinished.cancelled",
            "This sub-agent was cancelled. The conversation is read-only.",
          ]
        : [
            "chat.subAgentFinished.completed",
            "This sub-agent has finished. The conversation is read-only.",
          ];

  return (
    <div
      className={`sub-agent-finished-bar${
        status === "failed" || status === "cancelled" ? " is-error" : ""
      }`}
    >
      <span className="sub-agent-finished-bar-status">
        {icon}
        <span>{t(messageKey, { defaultValue: messageDefault })}</span>
      </span>
      {parentConversationId ? (
        <button
          type="button"
          className="sub-agent-finished-bar-back"
          onClick={() => void onBackToParent(parentConversationId)}
        >
          <ArrowLeft size={13} aria-hidden="true" />
          {t("chat.subAgentFinished.backToParent", {
            defaultValue: "Back to parent conversation",
          })}
        </button>
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
