import { Globe, Terminal, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";

type RightPanelTabContextMenuProps = {
  /** 右键时的鼠标坐标（viewport 坐标）。 */
  x: number;
  y: number;
  /** 该 tab 是否允许关闭（Git 固定 tab 不可关闭）。 */
  isClosable: boolean;
  onNewTerminal: () => void;
  onNewBrowser: () => void;
  onCloseTab: () => void;
  onClose: () => void;
};

const MENU_WIDTH = 170;

/**
 * 右侧面板 tab 的右键菜单：新建终端 / 新建浏览器 / 关闭标签页。
 * 定位在鼠标点击处，越界时自动收进视口；点击外部或按 Esc 关闭。
 */
export function RightPanelTabContextMenu({
  x,
  y,
  isClosable,
  onNewTerminal,
  onNewBrowser,
  onCloseTab,
  onClose,
}: RightPanelTabContextMenuProps): React.JSX.Element {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(y);

  // 测量菜单实际高度，避免超出窗口底部。
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      setTop(Math.max(8, window.innerHeight - rect.height - 8));
    } else if (rect.top < 8) {
      setTop(8);
    }
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) {
        return;
      }
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8);

  return createPortal(
    <div
      ref={menuRef}
      className="right-panel-tab-context-menu"
      role="menu"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
    >
      <button
        type="button"
        className="right-panel-tab-context-menu-item"
        role="menuitem"
        onClick={onNewTerminal}
      >
        <Terminal size={13} strokeWidth={1.8} />
        <span>
          {t("rightPanel.tabContextNewTerminal", { defaultValue: "New Terminal" })}
        </span>
      </button>
      <button
        type="button"
        className="right-panel-tab-context-menu-item"
        role="menuitem"
        onClick={onNewBrowser}
      >
        <Globe size={13} strokeWidth={1.8} />
        <span>
          {t("rightPanel.tabContextNewBrowser", { defaultValue: "New Browser" })}
        </span>
      </button>
      {isClosable && (
        <>
          <div className="right-panel-tab-context-menu-separator" role="separator" />
          <button
            type="button"
            className="right-panel-tab-context-menu-item"
            role="menuitem"
            onClick={onCloseTab}
          >
            <X size={13} strokeWidth={1.8} />
            <span>{t("rightPanel.closeTab", { defaultValue: "Close tab" })}</span>
          </button>
        </>
      )}
    </div>,
    document.body
  );
}
