import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  GripVertical,
  MousePointer2,
  Plus,
  RotateCcw,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { useI18n } from "../../../i18n";
import type { PickedElement } from "./useWebviewElementPicker";

export type BrowserElementPickerProps = {
  /** 元素锚点（弹窗相对于父容器的 left/top） */
  anchorLeft: number;
  anchorTop: number;
  /** 元素在 guest 视口内的尺寸（CSS 像素 × 缩放系数） */
  anchorWidth: number;
  anchorHeight: number;
  element: PickedElement;
  /** 确认将元素（含备注）加入聊天输入框 */
  onConfirm: (note: string) => void;
  /** 关闭弹窗（同时清除页面上的选中高亮） */
  onCancel: () => void;
  /** 样式修改即时应用到 guest 页面元素上（预览）；传入空串表示恢复原始样式 */
  onStyleChange: (styleText: string) => void;
};

const POPUP_GAP = 10;
const POPUP_MAX_WIDTH = 280;
const POPUP_ESTIMATED_HEIGHT = 118;

/** 常见可编辑样式属性列表（key 为 CSS 属性名，labelKey 为 i18n 键） */
const STYLE_FIELDS: {
  key: string;
  labelKey: string;
  isColor: boolean;
  isLength: boolean;
}[] = [
  { key: "color", labelKey: "browser.elementStyleColor", isColor: true, isLength: false },
  {
    key: "backgroundColor",
    labelKey: "browser.elementStyleBackgroundColor",
    isColor: true,
    isLength: false,
  },
  {
    key: "fontSize",
    labelKey: "browser.elementStyleFontSize",
    isColor: false,
    isLength: true,
  },
  {
    key: "fontWeight",
    labelKey: "browser.elementStyleFontWeight",
    isColor: false,
    isLength: false,
  },
  {
    key: "fontFamily",
    labelKey: "browser.elementStyleFontFamily",
    isColor: false,
    isLength: false,
  },
  {
    key: "textAlign",
    labelKey: "browser.elementStyleTextAlign",
    isColor: false,
    isLength: false,
  },
  {
    key: "border",
    labelKey: "browser.elementStyleBorder",
    isColor: false,
    isLength: false,
  },
  {
    key: "borderRadius",
    labelKey: "browser.elementStyleBorderRadius",
    isColor: false,
    isLength: true,
  },
  {
    key: "padding",
    labelKey: "browser.elementStylePadding",
    isColor: false,
    isLength: true,
  },
  {
    key: "margin",
    labelKey: "browser.elementStyleMargin",
    isColor: false,
    isLength: true,
  },
  {
    key: "opacity",
    labelKey: "browser.elementStyleOpacity",
    isColor: false,
    isLength: false,
  },
];

/** 纯数字（可带小数）匹配，用于长度类属性自动补 px 单位 */
const PURE_NUMBER_RE = /^\d+(\.\d+)?$/;

/**
 * 将 CSS 颜色值（#hex / rgb() / rgba()）转换为 #rrggbb，供颜色选择器使用；
 * 透明色（alpha 为 0）或无法解析时返回 null（选色板不显示颜色，避免误显示黑色）。
 */
const cssColorToHex = (value: string): string | null => {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "transparent") {
    return null;
  }
  if (/^#[0-9a-f]{6}$/.test(trimmed)) {
    return trimmed;
  }
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    return (
      "#" +
      trimmed
        .slice(1)
        .split("")
        .map((c) => c + c)
        .join("")
    );
  }
  const match = trimmed.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+))?\s*\)$/
  );
  if (match) {
    // alpha 为 0（透明）时不显示颜色
    const alpha = match[4];
    if (alpha !== undefined && Number(alpha) === 0) {
      return null;
    }
    const toHex = (n: number): string =>
      Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
    return (
      "#" +
      toHex(Number(match[1])) +
      toHex(Number(match[2])) +
      toHex(Number(match[3]))
    );
  }
  return null;
};

/** 将样式对象序列化为 CSS 声明文本（过滤空值），如 color:#fff;font-size:14px */
const buildStyleText = (styles: Record<string, string>): string =>
  Object.entries(styles)
    .filter(([, value]) => value.trim() !== "")
    .map(([key, value]) => `${key}:${value.trim()}`)
    .join(";");

/**
 * 元素选择完成后的预览弹窗：显示所选元素的标识，可添加文字备注（回车或
 * 按钮确认后由父组件通过全局事件把 ElementTag 派发给聊天输入框），并可
 * 切换到样式编辑界面——样式修改即时应用到页面元素上，方便用户直接查看
 * 效果，无需确认/取消。
 *
 * 弹窗可通过标题区域拖动，避免遮挡被修改的元素；关闭后由父组件清除
 * 页面上的蓝色高亮框。
 *
 * 定位规则：默认出现在元素右侧（垂直居中对齐），右侧空间不足时翻转到
 * 左侧，并在父容器（.browser-content）内做边界收敛。初始位置按估算尺寸
 * 给出，首次渲染后按真实尺寸精修一次；之后位置完全由用户拖动控制。
 */
export const BrowserElementPicker = ({
  anchorLeft,
  anchorTop,
  anchorWidth,
  anchorHeight,
  element,
  onConfirm,
  onCancel,
  onStyleChange,
}: BrowserElementPickerProps): React.JSX.Element => {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"note" | "style">("note");
  const [styles, setStyles] = useState<Record<string, string>>(() => ({
    ...(element.style ?? {}),
  }));
  const [customName, setCustomName] = useState("");
  const [customValue, setCustomValue] = useState("");
  const popupRef = useRef<HTMLDivElement>(null);
  const positionedOnceRef = useRef(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    left: number;
    top: number;
  } | null>(null);

  /** 不在固定列表中的自定义属性名（按插入顺序） */
  const customKeys = useMemo(
    () =>
      Object.keys(styles).filter(
        (key) => !STYLE_FIELDS.some((f) => f.key === key)
      ),
    [styles]
  );

  const estimatePosition = (): { left: number; top: number } => {
    const centerY = anchorTop + anchorHeight / 2;
    let left = anchorLeft + anchorWidth + POPUP_GAP;
    let top = centerY - POPUP_ESTIMATED_HEIGHT / 2;
    const maxLeft = window.innerWidth - POPUP_MAX_WIDTH - POPUP_GAP;
    if (left > maxLeft) {
      left = anchorLeft - POPUP_MAX_WIDTH - POPUP_GAP;
    }
    left = Math.max(POPUP_GAP, Math.min(left, maxLeft));
    top = Math.max(POPUP_GAP, top);
    return { left, top };
  };

  const [pos, setPos] = useState<{ left: number; top: number }>(
    estimatePosition
  );

  // 仅在弹窗首次渲染后按真实尺寸精修一次位置，之后位置由用户拖动控制，
  // 避免拖动后被自动定位逻辑拉回锚点旁。
  useLayoutEffect(() => {
    if (positionedOnceRef.current) {
      return;
    }
    positionedOnceRef.current = true;
    const el = popupRef.current;
    if (!el) {
      return;
    }
    const parent = el.parentElement;
    if (!parent) {
      return;
    }
    const elW = el.offsetWidth || POPUP_MAX_WIDTH;
    const elH = el.offsetHeight;
    const centerY = anchorTop + anchorHeight / 2;

    let left = anchorLeft + anchorWidth + POPUP_GAP;
    let top = centerY - elH / 2;

    const maxLeft = parent.clientWidth - elW - POPUP_GAP;
    const maxTop = parent.clientHeight - elH - POPUP_GAP;
    if (left > maxLeft) {
      left = anchorLeft - elW - POPUP_GAP;
    }
    left = Math.max(POPUP_GAP, Math.min(left, maxLeft));
    top = Math.max(POPUP_GAP, Math.min(top, maxTop));
    setPos({ left, top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 拖动弹窗：按住非交互区域移动，位置限制在父容器内。
  useEffect(() => {
    const handleMouseMove = (event: MouseEvent): void => {
      const drag = dragRef.current;
      if (!drag || !popupRef.current) {
        return;
      }
      const parent = popupRef.current.parentElement;
      const elW = popupRef.current.offsetWidth || POPUP_MAX_WIDTH;
      const elH = popupRef.current.offsetHeight;
      const maxLeft = parent
        ? parent.clientWidth - elW - POPUP_GAP
        : window.innerWidth - elW - POPUP_GAP;
      const maxTop = parent
        ? parent.clientHeight - elH - POPUP_GAP
        : window.innerHeight - elH - POPUP_GAP;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      setPos({
        left: Math.max(POPUP_GAP, Math.min(drag.left + dx, maxLeft)),
        top: Math.max(POPUP_GAP, Math.min(drag.top + dy, maxTop)),
      });
    };
    const handleMouseUp = (): void => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // Esc 关闭弹窗。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onCancel]);

  const handleNoteKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>
  ): void => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onConfirm(note);
    }
  };

  const handlePopupMouseDown = (event: React.MouseEvent): void => {
    const target = event.target as HTMLElement;
    if (target.closest("input, button, select, textarea")) {
      return;
    }
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      left: pos.left,
      top: pos.top,
    };
    event.preventDefault();
  };

  const updateStyle = (key: string, value: string): void => {
    setStyles((prev) => {
      const next = { ...prev, [key]: value };
      onStyleChange(buildStyleText(next));
      return next;
    });
  };

  const removeStyle = (key: string): void => {
    setStyles((prev) => {
      const next = { ...prev };
      delete next[key];
      onStyleChange(buildStyleText(next));
      return next;
    });
  };

  const resetStyles = (): void => {
    setStyles({ ...(element.style ?? {}) });
    // 清空内联样式，恢复元素选中前的原始样式。
    onStyleChange("");
  };

  const addCustomStyle = (): void => {
    const name = customName.trim().replace(/\s+/g, "-");
    const value = customValue.trim();
    if (!name || !value) {
      return;
    }
    setStyles((prev) => {
      const next = { ...prev, [name]: value };
      onStyleChange(buildStyleText(next));
      return next;
    });
    setCustomName("");
    setCustomValue("");
  };

  const renderStyleRow = (
    key: string,
    label: string,
    isColor: boolean,
    isLength: boolean,
    removable: boolean
  ): React.JSX.Element => {
    const value = styles[key] ?? "";
    const hex = isColor ? cssColorToHex(value) : null;
    return (
      <div className="browser-element-picker-style-row" key={key}>
        <span className="browser-element-picker-style-label" title={key}>
          {label}
        </span>
        {isColor && (
          <input
            type="color"
            className="browser-element-picker-color"
            value={hex ?? "#000000"}
            onChange={(event) => updateStyle(key, event.target.value)}
            title={key}
          />
        )}
        <input
          type="text"
          className="browser-element-picker-style-value"
          value={value}
          onChange={(event) => updateStyle(key, event.target.value)}
          onBlur={() => {
            // 长度类属性失焦时自动补 px 单位（纯数字输入，如 20 -> 20px）
            const current = styles[key]?.trim() ?? "";
            if (isLength && PURE_NUMBER_RE.test(current) && !current.endsWith("px")) {
              updateStyle(key, `${current}px`);
            }
          }}
          placeholder={isLength ? t("browser.elementStyleLengthPlaceholder") : ""}
          spellCheck={false}
        />
        {removable && (
          <button
            type="button"
            className="browser-element-picker-icon-btn danger"
            title={t("common.delete")}
            onClick={() => removeStyle(key)}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      ref={popupRef}
      className="browser-element-picker-popup"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={handlePopupMouseDown}
    >
      <div className="browser-element-picker-header">
        <GripVertical
          size={12}
          className="browser-element-picker-drag-handle"
        />
        <MousePointer2 size={12} className="browser-element-picker-header-icon" />
        <span
          className="browser-element-picker-label"
          title={element.text || element.url}
        >
          {element.label}
        </span>
        <div className="browser-element-picker-header-actions">
          {mode === "style" && (
            <>
              <button
                type="button"
                className="browser-element-picker-icon-btn"
                title={t("browser.elementStyleReset")}
                onClick={resetStyles}
              >
                <RotateCcw size={13} />
              </button>
              <button
                type="button"
                className="browser-element-picker-icon-btn"
                title={t("browser.elementStyleBack")}
                onClick={() => setMode("note")}
              >
                <ArrowLeft size={13} />
              </button>
            </>
          )}
          <button
            type="button"
            className="browser-element-picker-icon-btn"
            title={t("common.close")}
            onClick={onCancel}
          >
            <X size={13} />
          </button>
        </div>
      </div>
      {mode === "note" ? (
        <>
          <div className="browser-element-picker-input-row">
            <input
              autoFocus
              type="text"
              className="browser-element-picker-input"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={handleNoteKeyDown}
              placeholder={t("browser.elementNotePlaceholder")}
              maxLength={200}
              spellCheck={false}
            />
            <button
              type="button"
              className="browser-element-picker-settings-btn"
              title={t("browser.elementStyleTitle")}
              onClick={() => setMode("style")}
            >
              <Settings size={14} />
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="browser-element-picker-style-list">
            {STYLE_FIELDS.map((field) =>
              renderStyleRow(
                field.key,
                t(field.labelKey),
                field.isColor,
                field.isLength,
                false
              )
            )}
            {customKeys.map((key) => renderStyleRow(key, key, false, false, true))}
          </div>
          <div className="browser-element-picker-style-add">
            <input
              type="text"
              className="browser-element-picker-style-add-name"
              value={customName}
              onChange={(event) => setCustomName(event.target.value)}
              placeholder={t("browser.elementStyleCustomName")}
              spellCheck={false}
            />
            <input
              type="text"
              className="browser-element-picker-style-add-value"
              value={customValue}
              onChange={(event) => setCustomValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  addCustomStyle();
                }
              }}
              placeholder={t("browser.elementStyleCustomValue")}
              spellCheck={false}
            />
            <button
              type="button"
              className="browser-element-picker-icon-btn"
              title={t("browser.elementStyleAdd")}
              onClick={addCustomStyle}
            >
              <Plus size={13} />
            </button>
          </div>
        </>
      )}
      {mode === "note" && (
        <div className="browser-element-picker-actions">
          <button
            type="button"
            className="browser-element-picker-btn primary"
            onClick={() => onConfirm(note)}
          >
            {t("browser.elementAddToInput")}
          </button>
        </div>
      )}
    </div>
  );
};
