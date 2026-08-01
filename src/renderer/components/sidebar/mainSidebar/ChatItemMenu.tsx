import {
  Ellipsis,
  Pin,
  PinOff,
  Pencil,
  Trash2,
  AlertTriangle,
  Download,
  ChevronRight,
  ChevronLeft,
  SmilePlus,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../../i18n";
import { useMenuPosition } from "./useMenuPosition";
import { EmojiPicker } from "./EmojiPicker";

export type ExportFormat = "markdown" | "html" | "json" | "csv";

type ChatItemMenuProps = {
  isPinned: boolean;
  emoji: string;
  onPin: () => void;
  onRename: () => void;
  onSetEmoji: (emoji: string) => void | Promise<void>;
  onDelete: () => void;
  onExport: (format: ExportFormat) => void;
  onOpenChange?: (isOpen: boolean) => void;
};

export function ChatItemMenu({
  isPinned,
  emoji,
  onPin,
  onRename,
  onSetEmoji,
  onDelete,
  onExport,
  onOpenChange,
}: ChatItemMenuProps): React.JSX.Element {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const exportPanelRef = useRef<HTMLDivElement>(null);
  const exportTriggerRef = useRef<HTMLButtonElement>(null);
  const emojiTriggerRef = useRef<HTMLButtonElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const showExportRef = useRef(showExport);
  showExportRef.current = showExport;

  const { position: menuPosition } = useMenuPosition({
    isOpen,
    placement: "auto-up-down",
    triggerRef,
    panelRef: menuRef,
    onReposition: () => {
      if (showExportRef.current) {
        updateExportPositionRef.current?.();
      }
    },
  });

  const {
    position: exportPosition,
    updatePosition: updateExportPosition,
  } = useMenuPosition({
    isOpen: isOpen && showExport,
    placement: "auto-left-right",
    triggerRef: exportTriggerRef,
    panelRef: exportPanelRef,
    observeRefs: [menuRef],
  });

  const updateExportPositionRef = useRef(updateExportPosition);
  updateExportPositionRef.current = updateExportPosition;

  useEffect(() => {
    onOpenChangeRef.current?.(isOpen);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent): void => {
      const target = event.target as Node;

      if (
        (containerRef.current && containerRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target)) ||
        (exportPanelRef.current && exportPanelRef.current.contains(target))
      ) {
        return;
      }

      setIsOpen(false);
      setShowConfirm(false);
      setShowExport(false);
      setShowEmoji(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleToggle = (event: React.SyntheticEvent): void => {
    event.stopPropagation();
    event.preventDefault();
    setIsOpen((prev) => !prev);
    setShowConfirm(false);
    setShowExport(false);
    setShowEmoji(false);
  };

  const handlePin = (): void => {
    onPin();
    setIsOpen(false);
  };

  const handleRename = (): void => {
    onRename();
    setIsOpen(false);
  };

  const handleDeleteClick = (): void => {
    setShowConfirm(true);
    setShowExport(false);
    setShowEmoji(false);
  };

  const handleDeleteConfirm = (): void => {
    onDelete();
    setIsOpen(false);
    setShowConfirm(false);
  };

  const handleDeleteCancel = (): void => {
    setShowConfirm(false);
  };

  const handleExportClick = (): void => {
    setShowExport((prev) => !prev);
    setShowConfirm(false);
    setShowEmoji(false);
  };

  const handleExportSelect = (format: ExportFormat): void => {
    onExport(format);
    setIsOpen(false);
    setShowExport(false);
  };

  const handleEmojiClick = (): void => {
    setShowEmoji((prev) => !prev);
    setShowConfirm(false);
    setShowExport(false);
  };

  const handleEmojiSelect = (emoji: string): void => {
    void onSetEmoji(emoji);
    setIsOpen(false);
    setShowEmoji(false);
    setShowConfirm(false);
    setShowExport(false);
  };

  // Escape / 焦点离开面板等场景：关闭整个菜单
  const handleEmojiClose = (): void => {
    setIsOpen(false);
    setShowEmoji(false);
    setShowConfirm(false);
    setShowExport(false);
  };

  return (
    <span className="chat-item-actions-wrapper" ref={containerRef}>
      <span
        ref={triggerRef}
        className="chat-item-actions"
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={handleToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            handleToggle(event);
          }
        }}
      >
        <Ellipsis size={14} />
      </span>
      {isOpen
        ? createPortal(
            <div
              ref={menuRef}
              className="chat-item-menu"
              style={
                menuPosition
                  ? { top: menuPosition.top, left: menuPosition.left }
                  : undefined
              }
              role="menu"
            >
              {showConfirm ? (
                <>
                  <div className="chat-item-menu-confirm">
                    <AlertTriangle
                      size={13}
                      className="chat-item-menu-confirm-icon"
                    />
                    <span className="chat-item-menu-confirm-text">
                      {t("sidebar.chatDeleteConfirm", {
                        defaultValue:
                          "Are you sure you want to delete this conversation?",
                      })}
                    </span>
                  </div>
                  <div className="chat-item-menu-confirm-actions">
                    <button
                      type="button"
                      className="chat-item-menu-confirm-btn cancel"
                      onClick={handleDeleteCancel}
                    >
                      {t("common.cancel", { defaultValue: "Cancel" })}
                    </button>
                    <button
                      type="button"
                      className="chat-item-menu-confirm-btn delete"
                      onClick={handleDeleteConfirm}
                    >
                      {t("sidebar.chatActionDelete", {
                        defaultValue: "Delete",
                      })}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="chat-item-menu-item"
                    onClick={handlePin}
                    role="menuitem"
                  >
                    {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
                    <span>
                      {isPinned
                        ? t("sidebar.chatActionUnpin", {
                            defaultValue: "Unpin",
                          })
                        : t("sidebar.chatActionPin", { defaultValue: "Pin" })}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="chat-item-menu-item"
                    onClick={handleRename}
                    role="menuitem"
                  >
                    <Pencil size={13} />
                    <span>
                      {t("sidebar.chatActionRename", {
                        defaultValue: "Rename",
                      })}
                    </span>
                  </button>
                  <button
                    type="button"
                    ref={emojiTriggerRef}
                    className={`chat-item-menu-item${
                      showEmoji ? " active" : ""
                    }`}
                    onClick={handleEmojiClick}
                    role="menuitem"
                    aria-expanded={showEmoji}
                    aria-haspopup="menu"
                  >
                    {emoji ? (
                      <span className="chat-item-menu-emoji">{emoji}</span>
                    ) : (
                      <SmilePlus size={13} />
                    )}
                    <span>
                      {t("sidebar.chatActionIcon", { defaultValue: "Icon" })}
                    </span>
                    <ChevronRight
                      size={11}
                      className="chat-item-menu-sub-arrow"
                    />
                  </button>
                  <button
                    type="button"
                    ref={exportTriggerRef}
                    className={`chat-item-menu-item${
                      showExport ? " active" : ""
                    }`}
                    onClick={handleExportClick}
                    role="menuitem"
                    aria-expanded={showExport}
                    aria-haspopup="menu"
                  >
                    <Download size={13} />
                    <span>
                      {t("sidebar.chatActionExport", {
                        defaultValue: "Export",
                      })}
                    </span>
                    <ChevronRight size={11} className="chat-item-menu-sub-arrow" />
                  </button>
                  <button
                    type="button"
                    className="chat-item-menu-item danger"
                    onClick={handleDeleteClick}
                    role="menuitem"
                  >
                    <Trash2 size={13} />
                    <span>
                      {t("sidebar.chatActionDelete", {
                        defaultValue: "Delete",
                      })}
                    </span>
                  </button>
                </>
              )}
            </div>,
            document.body
          )
        : null}
      {isOpen && showExport
        ? createPortal(
            <div
              ref={exportPanelRef}
              className="chat-item-menu chat-item-export-panel"
              style={
                exportPosition
                  ? { top: exportPosition.top, left: exportPosition.left }
                  : undefined
              }
              role="menu"
            >
              <div className="chat-item-export-panel-header">
                <ChevronLeft size={11} className="chat-item-export-back-icon" />
                <span>
                  {t("sidebar.chatActionExport", {
                    defaultValue: "Export",
                  })}
                </span>
              </div>
              {(
                [
                  { format: "markdown" as const, label: "Markdown" },
                  { format: "html" as const, label: "HTML" },
                  { format: "json" as const, label: "JSON" },
                  { format: "csv" as const, label: "CSV" },
                ] satisfies Array<{ format: ExportFormat; label: string }>
              ).map(({ format, label }) => (
                <button
                  key={format}
                  type="button"
                  className="chat-item-menu-item"
                  onClick={() => handleExportSelect(format)}
                  role="menuitem"
                >
                  <span className="chat-item-export-format-label">{label}</span>
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
      {isOpen && showEmoji && (
        <EmojiPicker
          triggerRef={emojiTriggerRef}
          currentEmoji={emoji}
          onSelect={handleEmojiSelect}
          onClose={handleEmojiClose}
          focusOutKeepRef={menuRef}
        />
      )}
    </span>
  );
}
