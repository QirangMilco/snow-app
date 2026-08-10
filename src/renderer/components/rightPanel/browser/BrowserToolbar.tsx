import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  Globe,
  Loader2,
  MousePointer2,
  RotateCw,
} from "lucide-react";
import type { ScreenshotFeedback } from "./useWebviewScreenshot";
import { BrowserMenu } from "./BrowserMenu";
import { useI18n } from "../../../i18n";

export type BrowserToolbarProps = {
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  /** 页面已加载完成且存在实际页面时才能选择元素（未加载完成时隐藏选择按钮） */
  canPickElement: boolean;
  addressInput: string;
  isCapturing: boolean;
  isPickingElement: boolean;
  screenshotFeedback: ScreenshotFeedback;
  onAddressChange: (value: string) => void;
  onAddressKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onScreenshot: () => void;
  onToggleElementPicker: () => void;
  // Browser menu
  zoomFactor: number;
  homepage: string;
  onClearCache: () => void;
  onClearCookies: () => void;
  onOpenSettings: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onForceReload: () => void;
  onFindInPage: () => void;
  onOpenDevTools: () => void;
  onSetHomepage: (url: string) => Promise<void>;
};

const buildScreenshotClassName = (feedback: ScreenshotFeedback): string => {
  const base = "browser-nav-btn browser-screenshot-btn";
  if (feedback === "success") {
    return `${base} is-success`;
  }
  if (feedback === "error") {
    return `${base} is-error`;
  }
  return base;
};

const renderScreenshotIcon = (
  isCapturing: boolean,
  feedback: ScreenshotFeedback
): React.JSX.Element => {
  if (isCapturing) {
    return <Loader2 size={15} strokeWidth={1.8} className="spin-icon" />;
  }
  if (feedback === "success") {
    return <Check size={15} strokeWidth={1.8} />;
  }
  return <Camera size={15} strokeWidth={1.8} />;
};

/**
 * The browser top toolbar: back / forward / reload navigation buttons,
 * an address bar, and a screenshot button that captures the current page
 * image to the clipboard.
 *
 * Extracted from BrowserPanelContent for maintainability.
 */
export const BrowserToolbar = ({
  canGoBack,
  canGoForward,
  isLoading,
  canPickElement,
  addressInput,
  isCapturing,
  isPickingElement,
  screenshotFeedback,
  onAddressChange,
  onAddressKeyDown,
  onBack,
  onForward,
  onReload,
  onScreenshot,
  onToggleElementPicker,
  zoomFactor,
  homepage,
  onClearCache,
  onClearCookies,
  onOpenSettings,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onForceReload,
  onFindInPage,
  onOpenDevTools,
  onSetHomepage,
}: BrowserToolbarProps): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <div className="browser-toolbar">
      <button
        type="button"
        className="browser-nav-btn"
        onClick={onBack}
        disabled={!canGoBack}
        aria-label={t("browser.back")}
        title={t("browser.back")}
      >
        <ArrowLeft size={15} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="browser-nav-btn"
        onClick={onForward}
        disabled={!canGoForward}
        aria-label={t("browser.forward")}
        title={t("browser.forward")}
      >
        <ArrowRight size={15} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="browser-nav-btn"
        onClick={onReload}
        aria-label={t("browser.reload")}
        title={t("browser.reload")}
      >
        {isLoading ? (
          <Loader2 size={15} strokeWidth={1.8} className="spin-icon" />
        ) : (
          <RotateCw size={15} strokeWidth={1.8} />
        )}
      </button>
      <div className="browser-address-bar">
        <Globe size={13} strokeWidth={1.6} className="browser-address-icon" />
        <input
          type="text"
          className="browser-address-input"
          value={addressInput}
          onChange={(e) => onAddressChange(e.target.value)}
          onKeyDown={onAddressKeyDown}
          placeholder={t("browser.addressPlaceholder")}
          spellCheck={false}
        />
      </div>
      {canPickElement && (
        <button
          type="button"
          className={`browser-nav-btn browser-element-pick-btn${
            isPickingElement ? " is-active" : ""
          }`}
          onClick={onToggleElementPicker}
          aria-label={t("browser.pickElement")}
          aria-pressed={isPickingElement}
          title={t("browser.pickElementTitle")}
        >
          <MousePointer2 size={15} strokeWidth={1.8} />
        </button>
      )}
      <button
        type="button"
        className={buildScreenshotClassName(screenshotFeedback)}
        onClick={onScreenshot}
        disabled={isCapturing}
        aria-label={t("browser.screenshot")}
        title={t("browser.screenshotTitle")}
      >
        {renderScreenshotIcon(isCapturing, screenshotFeedback)}
      </button>
      <BrowserMenu
        zoomFactor={zoomFactor}
        homepage={homepage}
        onClearCache={onClearCache}
        onClearCookies={onClearCookies}
        onOpenSettings={onOpenSettings}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onZoomReset={onZoomReset}
        onForceReload={onForceReload}
        onFindInPage={onFindInPage}
        onOpenDevTools={onOpenDevTools}
        onSetHomepage={onSetHomepage}
      />
    </div>
  );
};
