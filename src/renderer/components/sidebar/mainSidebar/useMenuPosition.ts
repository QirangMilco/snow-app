import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

export type MenuPosition = {
  top: number;
  left: number;
} | null;

export type MenuPlacement = "auto-up-down" | "auto-left-right";

type UseMenuPositionOptions = {
  isOpen: boolean;
  placement: MenuPlacement;
  triggerRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  /** 固定锚点坐标（如右键菜单的光标位置）。非空时以该点代替触发元素矩形进行定位。 */
  anchorPoint?: { x: number; y: number } | null;
  /** 额外需要随其尺寸变化而重新定位的容器（如联动面板）。 */
  observeRefs?: Array<RefObject<HTMLElement | null>>;
  /** 每次重新定位后回调（用于联动其它面板）。 */
  onReposition?: () => void;
};

const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

/**
 * 悬浮菜单定位：基于触发元素（或固定锚点）与面板尺寸计算固定定位坐标，
 * 支持上下/左右自适应翻转，并跟随滚动、窗口缩放与容器尺寸变化重新定位。
 */
export function useMenuPosition({
  isOpen,
  placement,
  triggerRef,
  panelRef,
  anchorPoint,
  observeRefs,
  onReposition,
}: UseMenuPositionOptions): {
  position: MenuPosition;
  updatePosition: () => void;
} {
  const [position, setPosition] = useState<MenuPosition>(null);
  const observeRefsRef = useRef(observeRefs);
  observeRefsRef.current = observeRefs;
  const onRepositionRef = useRef(onReposition);
  onRepositionRef.current = onReposition;
  const anchorPointRef = useRef(anchorPoint);
  anchorPointRef.current = anchorPoint;

  const updatePosition = useCallback((): void => {
    const panel = panelRef.current;

    if (!panel) {
      return;
    }

    // 固定锚点（如右键光标位置）视为零尺寸触发矩形；否则取触发元素矩形
    let triggerRect: Pick<DOMRect, "top" | "bottom" | "left" | "right">;
    const anchor = anchorPointRef.current;
    const trigger = triggerRef.current;
    if (anchor) {
      triggerRect = {
        top: anchor.y,
        bottom: anchor.y,
        left: anchor.x,
        right: anchor.x,
      };
    } else {
      if (!trigger) {
        return;
      }
      triggerRect = trigger.getBoundingClientRect();
    }

    const panelRect = panel.getBoundingClientRect();

    let side: "above" | "below" | "left" | "right";

    if (placement === "auto-left-right") {
      const spaceRight =
        window.innerWidth - triggerRect.right - VIEWPORT_MARGIN;
      side = spaceRight < panelRect.width + MENU_GAP ? "left" : "right";
    } else {
      const spaceAbove = triggerRect.top - VIEWPORT_MARGIN;
      const spaceBelow =
        window.innerHeight - triggerRect.bottom - VIEWPORT_MARGIN;
      side =
        spaceBelow < panelRect.height + MENU_GAP && spaceAbove > spaceBelow
          ? "above"
          : "below";
    }

    let preferredTop: number;
    let preferredLeft: number;

    if (side === "above") {
      preferredTop = triggerRect.top - panelRect.height - MENU_GAP;
      preferredLeft = triggerRect.left;
    } else if (side === "below") {
      preferredTop = triggerRect.bottom + MENU_GAP;
      preferredLeft = triggerRect.left;
    } else if (side === "right") {
      preferredTop = triggerRect.top;
      preferredLeft = triggerRect.right + MENU_GAP;
    } else {
      preferredTop = triggerRect.top;
      preferredLeft = triggerRect.left - panelRect.width - MENU_GAP;
    }

    const maxTop = Math.max(
      VIEWPORT_MARGIN,
      window.innerHeight - panelRect.height - VIEWPORT_MARGIN
    );
    const maxLeft = Math.max(
      VIEWPORT_MARGIN,
      window.innerWidth - panelRect.width - VIEWPORT_MARGIN
    );

    setPosition({
      top: Math.min(Math.max(preferredTop, VIEWPORT_MARGIN), maxTop),
      left: Math.min(Math.max(preferredLeft, VIEWPORT_MARGIN), maxLeft),
    });

    onRepositionRef.current?.();
  }, [placement, triggerRef, panelRef]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setPosition(null);
      return;
    }

    updatePosition();
    const panel = panelRef.current;
    const sidebar = triggerRef.current?.closest<HTMLElement>(".sidebar");
    const layoutObserver = new ResizeObserver(updatePosition);

    if (panel) {
      layoutObserver.observe(panel);
    }
    if (sidebar) {
      layoutObserver.observe(sidebar);
    }
    for (const ref of observeRefsRef.current ?? []) {
      if (ref.current) {
        layoutObserver.observe(ref.current);
      }
    }

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      layoutObserver.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isOpen, updatePosition, panelRef, triggerRef, anchorPoint]);

  return { position, updatePosition };
}
