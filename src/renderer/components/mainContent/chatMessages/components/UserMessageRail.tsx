import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquare } from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { UserMessageSummary } from "../../../../../preload";

type RefValue<T> = { current: T };

type UserMessageRailProps = {
  conversationId: string | undefined;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Triggers paginated loading of older messages. Called repeatedly until the
   *  target message enters the DOM. */
  loadOlderMessages: () => Promise<void>;
  /** Whether older messages are currently being fetched. */
  isLoadingOlderMessages: boolean;
  /** Whether more historical messages remain unloaded. */
  hasMoreMessages: boolean;
  /** Monotonically increasing version counter that bumps on every message
   *  operation (send, receive, rollback, compaction, page-load). Used as the
   *  sole dependency for re-fetching the user-message list so the rail always
   *  reflects the true DB state. */
  conversationVersion: number;
  /** Ref to the chat-area's shouldStickToBottom flag. The rail sets this to
   *  false before loading older messages so the ResizeObserver / scroll-pin
   *  logic does not yank the viewport back to the bottom while we are trying
   *  to navigate to an earlier message. */
  shouldStickToBottomRef: RefValue<boolean>;
  /** Ref mirroring ChatContent's isInitialBottomPositioningRef. The rail
   *  resets this to false so updateScrollFollowState stops forcing
   *  shouldStickToBottom=true during the initial-bottom-positioning phase. */
  isInitialBottomPositioningRef: RefValue<boolean>;
  /** Ref mirroring ChatContent's isUserScrollIntentRef. The rail sets this to
   *  true to mark a user-initiated navigation, so the scroll-follow logic
   *  respects our programmatic scroll instead of pinning to the bottom. */
  isUserScrollIntentRef: RefValue<boolean>;
};

/** Extract a plain-text summary from a user message's content, stripping file
 *  tags and image data so the rail shows only human-readable text. */
const extractTextSummary = (content: string): string => {
  const withoutFileTags = content.replace(/@@file:[^@]+@@/g, "");
  const withoutImages = withoutFileTags.replace(
    /data:image\/[^;]+;base64,[^\s)]+/g,
    "[image]"
  );
  return withoutImages.trim();
};

/** Find the DOM element for a given message id. The VirtualizedMessage
 *  wrapper carries data-message-id on a permanently-mounted node, so this
 *  works even when the message is virtualized out to a placeholder. */
const findMessageElement = (
  container: HTMLElement,
  messageId: string
): HTMLElement | null => {
  return container.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(messageId)}"]`
  );
};

/** Wait for the next animation frame. */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

export const UserMessageRail = memo(
  ({
    conversationId,
    scrollContainerRef,
    loadOlderMessages,
    isLoadingOlderMessages,
    hasMoreMessages,
    conversationVersion,
    shouldStickToBottomRef,
    isInitialBottomPositioningRef,
    isUserScrollIntentRef,
  }: UserMessageRailProps): React.JSX.Element | null => {
    const { t } = useI18n();
    const [userMessages, setUserMessages] = useState<UserMessageSummary[]>([]);
    const [hovered, setHovered] = useState(false);
    const [loading, setLoading] = useState(false);
    const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(
      null
    );
    const [popoverHeight, setPopoverHeight] = useState<number>(0);
    const [visibleUserIndices, setVisibleUserIndices] = useState<Set<number>>(new Set());
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const railRef = useRef<HTMLDivElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const userMessagesRef = useRef<UserMessageSummary[]>([]);

    // Fetch all user messages from the Rust backend on every version bump
    // and conversation switch. No caching — the backend query is lightweight
    // (id + content + created_at only, filtered by role='user') and every
    // bump means the DB state changed (send, rollback, compaction, etc.).
    useEffect(() => {
      if (!conversationId) {
        setUserMessages([]);
        userMessagesRef.current = [];
        return;
      }

      let cancelled = false;
      setLoading(true);
      window.snow
        .listUserMessages(conversationId)
        .then((fetchedMessages) => {
          if (cancelled) return;
          setUserMessages(fetchedMessages);
          userMessagesRef.current = fetchedMessages;
        })
        .catch(() => {
          if (cancelled) return;
          setUserMessages([]);
          userMessagesRef.current = [];
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });

      return () => {
        cancelled = true;
      };
    }, [conversationId, conversationVersion]);

    // Track which user messages are currently visible in the scroll viewport.
    // On every scroll/resize, iterate the DB user messages, find their DOM
    // elements by id, and check whether they intersect the viewport. The
    // resulting Set of indices (into userMessages) is used to
    // highlight the corresponding rail popover items so the user knows where
    // they are in the conversation.
    useEffect(() => {
      const container = scrollContainerRef.current;
      if (!container) return;

      const computeVisible = (): void => {
        const dbUserMsgs = userMessagesRef.current;
        if (dbUserMsgs.length === 0) {
          setVisibleUserIndices(new Set());
          return;
        }

        const containerRect = container.getBoundingClientRect();
        const visible = new Set<number>();

        for (let i = 0; i < dbUserMsgs.length; i++) {
          const dbMsg = dbUserMsgs[i];
          // The frontend replaces temporary ids with DB ids after persistence,
          // so data-message-id always matches the DB snowflake id.
          const el = findMessageElement(container, dbMsg.id);
          if (!el) continue;

          const rect = el.getBoundingClientRect();
          // Consider the message visible if it overlaps the viewport band
          // of the scroll container (with a small threshold so partially
          // visible messages count).
          const THRESHOLD = 40;
          const isVisible =
            rect.bottom > containerRect.top + THRESHOLD &&
            rect.top < containerRect.bottom - THRESHOLD;

          if (isVisible) {
            visible.add(i);
          }
        }

        setVisibleUserIndices((prev) => {
          if (prev.size === visible.size) {
            let same = true;
            for (const idx of visible) {
              if (!prev.has(idx)) {
                same = false;
                break;
              }
            }
            if (same) return prev;
          }
          return visible;
        });
      };

      // Initial compute after a frame so layout is ready.
      const raf = requestAnimationFrame(computeVisible);
      container.addEventListener("scroll", computeVisible, { passive: true });
      window.addEventListener("resize", computeVisible);

      return () => {
        cancelAnimationFrame(raf);
        container.removeEventListener("scroll", computeVisible);
        window.removeEventListener("resize", computeVisible);
      };
    }, [scrollContainerRef, conversationId, conversationVersion]);

    // Compute popover position relative to the rail element so it opens to
    // the left, hugging the rail's left edge. The popover top is clamped to
    // keep the entire popover within the viewport so it never overflows or
    // grows infinitely off-screen when there are many messages.
    const computePopoverPosition = useCallback((): {
      top: number;
      left: number;
    } | null => {
      const rail = railRef.current;
      if (!rail) return null;
      const railRect = rail.getBoundingClientRect();
      const POPOVER_WIDTH = 260;
      const POPOVER_GAP = 8;
      const VIEWPORT_MARGIN = 8;

      // Prefer to center the popover vertically on the rail, but clamp it
      // so the popover never extends beyond the viewport. We need the
      // popover's actual height for this; if not yet measured, fall back
      // to a reasonable estimate.
      const measuredH = popoverRef.current?.offsetHeight ?? 0;
      const approxH = measuredH > 0 ? measuredH : popoverHeight;
      const effectiveH = approxH > 0 ? approxH : 400;

      const desiredTop = railRect.top + railRect.height / 2 - effectiveH / 2;
      const minTop = VIEWPORT_MARGIN;
      const maxTop = window.innerHeight - effectiveH - VIEWPORT_MARGIN;
      const top = Math.max(minTop, Math.min(desiredTop, maxTop));

      const left = railRect.left - POPOVER_WIDTH - POPOVER_GAP;
      return { top, left };
    }, [popoverHeight]);

    const handleMouseEnter = useCallback((): void => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      setPopoverPos(computePopoverPosition());
      setHovered(true);
    }, [computePopoverPosition]);

    const handleMouseLeave = useCallback((): void => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
      hideTimerRef.current = setTimeout(() => {
        setHovered(false);
        setPopoverPos(null);
        setPopoverHeight(0);
      }, 200);
    }, []);

    useEffect(() => {
      return () => {
        if (hideTimerRef.current) {
          clearTimeout(hideTimerRef.current);
        }
      };
    }, []);

    // After the popover mounts (hovered becomes true), measure its real
    // height on the next frame and compute the final clamped position. This
    // runs once per open — it reads offsetHeight synchronously after layout
    // so the initial estimate is corrected to exact centering + viewport
    // clamping.
    useEffect(() => {
      if (!hovered) return;
      const rail = railRef.current;
      if (!rail) return;
      let cancelled = false;

      const measureAndPosition = (): void => {
        if (cancelled) return;
        const el = popoverRef.current;
        const railRect = rail.getBoundingClientRect();
        const POPOVER_WIDTH = 260;
        const POPOVER_GAP = 8;
        const VIEWPORT_MARGIN = 8;

        const effectiveH = el?.offsetHeight && el.offsetHeight > 0
          ? el.offsetHeight
          : 400;

        const desiredTop =
          railRect.top + railRect.height / 2 - effectiveH / 2;
        const minTop = VIEWPORT_MARGIN;
        const maxTop = window.innerHeight - effectiveH - VIEWPORT_MARGIN;
        const top = Math.max(minTop, Math.min(desiredTop, maxTop));
        const left = railRect.left - POPOVER_WIDTH - POPOVER_GAP;

        setPopoverPos({ top, left });
        if (el && el.offsetHeight > 0) {
          setPopoverHeight(el.offsetHeight);
        }
      };

      // Defer one frame so the portaled popover has been laid out.
      const raf = requestAnimationFrame(measureAndPosition);
      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
      };
    }, [hovered, userMessages]);

    // Recompute on viewport resize so the clamp stays correct.
    useEffect(() => {
      if (!hovered) return;
      const onResize = (): void => {
        const rail = railRef.current;
        if (!rail) return;
        const railRect = rail.getBoundingClientRect();
        const POPOVER_WIDTH = 260;
        const POPOVER_GAP = 8;
        const VIEWPORT_MARGIN = 8;
        const effectiveH =
          popoverRef.current?.offsetHeight &&
          popoverRef.current.offsetHeight > 0
            ? popoverRef.current.offsetHeight
            : popoverHeight > 0
              ? popoverHeight
              : 400;
        const desiredTop =
          railRect.top + railRect.height / 2 - effectiveH / 2;
        const minTop = VIEWPORT_MARGIN;
        const maxTop = window.innerHeight - effectiveH - VIEWPORT_MARGIN;
        const top = Math.max(minTop, Math.min(desiredTop, maxTop));
        const left = railRect.left - POPOVER_WIDTH - POPOVER_GAP;
        setPopoverPos({ top, left });
      };
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, [hovered, popoverHeight]);

    // Scroll to a target user message. The frontend replaces temporary ids
    // with real DB ids after persistence, so the DOM's data-message-id always
    // matches the DB snowflake id from listUserMessages. If the message is not
    // yet in the DOM (paginated loading hasn't reached it), repeatedly call
    // loadOlderMessages until it appears or there are no more pages. Then use
    // scrollIntoView and iterate: virtualized placeholders above the target
    // expand to real content (height changes), pushing the target down. We
    // keep re-scrolling until the position stabilizes.
    const handleItemClick = useCallback(
      async (messageId: string): Promise<void> => {
        const container = scrollContainerRef.current;
        if (!container) {
          return;
        }

        // Mark this as a user-initiated scroll, exactly like
        // markUserScrollIntent does. This resets isInitialBottomPositioning
        // (so updateScrollFollowState stops forcing shouldStickToBottom=true)
        // and sets isUserScrollIntent (so the follow state is derived from
        // the live geometry instead of pinning to the bottom). Without this,
        // the ResizeObserver's keepAtBottomSync yanks the viewport back to
        // the bottom the instant loadOlderMessages finishes prepending pages.
        isUserScrollIntentRef.current = true;
        isInitialBottomPositioningRef.current = false;
        shouldStickToBottomRef.current = false;

        let el = findMessageElement(container, messageId);

        // If not found, load older messages in a loop until it appears.
        const MAX_LOAD_ROUNDS = 200;
        let round = 0;
        while (!el && hasMoreMessages && round < MAX_LOAD_ROUNDS) {
          round++;
          if (isLoadingOlderMessages) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            continue;
          }
          await loadOlderMessages();
          await nextFrame();
          await nextFrame();
          el = findMessageElement(container, messageId);
        }

        if (!el) {
          setHovered(false);
          setPopoverPos(null);
          return;
        }

        // Iterate scrollIntoView until the target's offsetTop stabilizes.
        // Each scrollIntoView brings the target to the top of the viewport,
        // which causes virtualized placeholders *above* it (within the 600px
        // IntersectionObserver buffer) to render real content. Their height
        // grows, pushing the target down. We re-scroll and repeat until the
        // target's offsetTop no longer changes between frames.
        let prevOffsetTop = -1;
        for (let i = 0; i < 30; i++) {
          el = findMessageElement(container, messageId);
          if (!el) break;
          el.scrollIntoView({ block: "start", behavior: "auto" });
          await nextFrame();
          await nextFrame();
          const elNow = findMessageElement(container, messageId);
          if (!elNow) break;
          const currentOffsetTop = elNow.offsetTop;
          if (currentOffsetTop === prevOffsetTop) {
            break;
          }
          prevOffsetTop = currentOffsetTop;
        }

        setHovered(false);
        setPopoverPos(null);
      },
      [
        scrollContainerRef,
        loadOlderMessages,
        isLoadingOlderMessages,
        hasMoreMessages,
        shouldStickToBottomRef,
        isInitialBottomPositioningRef,
        isUserScrollIntentRef,
      ]
    );

    if (userMessages.length === 0 && !loading) {
      return null;
    }

    const popover =
      hovered && userMessages.length > 0 && popoverPos
        ? createPortal(
            <div
              ref={popoverRef}
              className="user-message-rail-popover"
              style={{ top: `${popoverPos.top}px`, left: `${popoverPos.left}px` }}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              <div className="user-message-rail-popover-header">
                <span>
                  {t("chat.userMessageRail.title", {
                    defaultValue: "User messages",
                  })}
                </span>
                <span className="user-message-rail-popover-count">
                  {userMessages.length}
                </span>
              </div>
              <div className="user-message-rail-popover-list">
                {userMessages.map((msg, index) => {
                  const summary = extractTextSummary(msg.content);
                  const display =
                    summary.length > 0
                      ? summary.length > 64
                        ? `${summary.slice(0, 64)}...`
                        : summary
                      : `#${index + 1}`;
                  const isVisible = visibleUserIndices.has(index);
                  return (
                    <button
                      type="button"
                      key={msg.id}
                      className={`user-message-rail-popover-item${isVisible ? " is-visible" : ""}`}
                      onClick={() => void handleItemClick(msg.id)}
                      title={summary}
                    >
                      <span className="user-message-rail-popover-item-index">
                        {index + 1}
                      </span>
                      <span className="user-message-rail-popover-item-text">
                        {display}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body
          )
        : null;

    return (
      <>
        <div
          ref={railRef}
          className="user-message-rail"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          aria-label={t("chat.userMessageRail.title", {
            defaultValue: "User messages",
          })}
          title={t("chat.userMessageRail.title", {
            defaultValue: "User messages",
          })}
        >
          <MessageSquare size={15} strokeWidth={2} aria-hidden="true" />
          {userMessages.length > 0 ? (
            <span className="user-message-rail-count">
              {userMessages.length}
            </span>
          ) : null}
        </div>
        {popover}
      </>
    );
  }
);

UserMessageRail.displayName = "UserMessageRail";
