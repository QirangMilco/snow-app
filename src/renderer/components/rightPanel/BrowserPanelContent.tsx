import { useEffect, useRef, useState } from "react";
import {
  BrowserFindBar,
  type BrowserFindResult,
  BrowserToolbar,
  useBrowserHomepage,
  useWebviewScreenshot,
} from "./browser";
import { DEFAULT_BROWSER_HOMEPAGE } from "./browser/browserHomepageConstants";
import {
  focusBrowserMcpInstance,
  registerBrowserMcpInstance,
} from "./browser/browserMcpController";
import {
  clearBrowserRouteRulesForInstance,
  executeBrowserMcpOperation,
} from "./browser/browserMcpOperations";

export type BrowserPanelContentProps = {
  instanceId: string;
  initialUrl: string;
  isActive: boolean;
  onTitleChange?: (title: string) => void;
};

const normalizeUrl = (input: string, homepage: string): string => {
  const trimmed = input.trim();
  if (!trimmed) {
    return homepage || DEFAULT_BROWSER_HOMEPAGE;
  }
  // Already has a protocol (http, https, or file)
  if (/^(https?|file):\/\//i.test(trimmed)) {
    return trimmed;
  }
  // Looks like a domain (contains a dot, no spaces)
  if (/^\S+\.\S+/.test(trimmed)) {
    return `https://${trimmed}`;
  }
  // Otherwise treat as a search query
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
};

/**
 * Navigation error codes that are expected during normal browsing and should
 * not surface as real failures:
 *
 *   -3  ERR_ABORTED  page redirected (Cloudflare challenge, Google -> localized)
 *   -2  ERR_FAILED   request cancelled or interrupted by a redirect
 *
 * These fire through both the webview `did-fail-load` event and the
 * main-process `GUEST_VIEW_MANAGER_CALL` IPC handler promise rejection.
 */
const SUPPRESSED_ERROR_CODES = new Set([-3, -2]);

const isSuppressedNavigationError = (error: unknown): boolean => {
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    if (code === "ERR_ABORTED" || code === "ERR_FAILED") {
      return true;
    }
  }
  return false;
};

export const BrowserPanelContent = ({
  instanceId,
  initialUrl,
  isActive,
  onTitleChange,
}: BrowserPanelContentProps): React.JSX.Element => {
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const consoleMessagesRef = useRef<unknown[]>([]);
  // onTitleChange 由 RightPanel 内联传入,每次父组件 render 都是新引用。
  // 通过 ref 持有,事件监听 effect 只需依赖 instanceId,监听器只绑定一次,
  // 避免多个浏览器实例时每次父组件重渲染都反复卸载/重建 webview 监听器。
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const { homepage, loaded, setHomepage } = useBrowserHomepage();
  // When an explicit initialUrl is provided, use it immediately. Otherwise,
  // leave the address bar and webview src empty until the homepage has been
  // loaded from the database — otherwise the default google fallback is used
  // before the real homepage arrives (useState only evaluates its initial
  // value once, so the late-arriving homepage would be ignored).
  const [addressInput, setAddressInput] = useState(initialUrl || "");
  // webviewSrc drives the <webview src={...}> attribute. It is ONLY updated on
  // explicit user navigation (address-bar Enter), never by did-navigate.
  //
  // This breaks the re-navigation loop that occurs with Cloudflare challenges
  // and other redirect-heavy pages:
  //   redirect -> did-navigate -> setCurrentUrl -> src change
  //   -> attribute observer -> loadURL -> redirect -> ...
  const [webviewSrc, setWebviewSrc] = useState(
    initialUrl ? normalizeUrl(initialUrl, homepage) : ""
  );

  // Once the homepage finishes loading from the database (and no explicit
  // initialUrl was given), navigate to the real homepage. Without this, the
  // webview would stay on the default google fallback because useState only
  // evaluates its initial value once.
  useEffect(() => {
    if (loaded && !initialUrl && !webviewSrc) {
      const url = homepage || DEFAULT_BROWSER_HOMEPAGE;
      const normalized = normalizeUrl(url, homepage);
      setWebviewSrc(normalized);
      setAddressInput(normalized);
    }
  }, [loaded, initialUrl, homepage, webviewSrc]);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const { isCapturing, feedback, captureScreenshot } =
    useWebviewScreenshot(webviewRef);
  const [zoomFactor, setZoomFactor] = useState(1);
  const [findVisible, setFindVisible] = useState(false);
  const [findText, setFindText] = useState("");
  const [findResult, setFindResult] = useState<BrowserFindResult | null>(null);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }

    const unregister = registerBrowserMcpInstance(
      instanceId,
      (operation, args) =>
        executeBrowserMcpOperation(
          webview,
          instanceId,
          operation,
          args,
          consoleMessagesRef.current
        ).then((result) => {
          if (
            operation === "devtools" &&
            args.action === "console" &&
            args.clearConsole === true
          ) {
            consoleMessagesRef.current = [];
          }
          return result;
        })
    );
    return () => {
      unregister();
      // 实例卸载时清理其累积的路由 mock 规则,避免残留规则影响其他实例。
      clearBrowserRouteRulesForInstance(instanceId);
    };
  }, [instanceId]);

  useEffect(() => {
    if (isActive) {
      focusBrowserMcpInstance(instanceId);
    }
  }, [instanceId, isActive]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }

    const handleNavigationStateUpdate = (): void => {
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
    };

    // did-navigate fires for every navigation including server-side redirects
    // and in-page pushState. We update the address bar for display but
    // deliberately do NOT update webviewSrc — changing src would trigger a
    // fresh loadURL via the webview attribute observer, re-triggering the
    // redirect and creating an infinite loop (e.g. Cloudflare challenges).
    const handleDidNavigate = (e: Electron.DidNavigateEvent): void => {
      setAddressInput(e.url);
      handleNavigationStateUpdate();
      // Keep the menu's zoom display in sync with the webview's actual zoom
      // (Electron persists zoom per webContents across navigations).
      setZoomFactor(webview.getZoomFactor());
    };

    const handleDidStartLoading = (): void => {
      setIsLoading(true);
    };

    const handleDidStopLoading = (): void => {
      setIsLoading(false);
      handleNavigationStateUpdate();
    };

    const handlePageTitleUpdated = (
      e: Electron.PageTitleUpdatedEvent
    ): void => {
      if (onTitleChangeRef.current && e.title) {
        onTitleChangeRef.current(e.title);
      }
    };

    const handleNewWindow = (e: Event & { url?: string }): void => {
      e.preventDefault();
      // Navigate in the same webview instead of opening a new window.
      // We use loadURL directly and do NOT update webviewSrc, because
      // changing src would fire a second racing loadURL call.
      if (e.url) {
        const url = normalizeUrl(e.url, homepage);
        Promise.resolve(webview.loadURL(url)).catch((error: unknown) => {
          if (!isSuppressedNavigationError(error)) {
            console.error("Failed to navigate to new window URL:", error);
          }
        });
      }
    };

    // ERR_ABORTED (-3) and ERR_FAILED (-2) are expected when a page redirects
    // (e.g. Cloudflare managed challenge, Google -> localized). Chromium aborts
    // the original request, which fires did-fail-load. Suppress these so the
    // console stays clean; the redirect target loads normally afterward.
    const handleDidFailLoad = (e: Event & { errorCode?: number }): void => {
      if (
        e.errorCode !== undefined &&
        SUPPRESSED_ERROR_CODES.has(e.errorCode)
      ) {
        return;
      }
    };

    const handleFoundInPage = (e: Electron.FoundInPageEvent): void => {
      setFindResult({
        activeMatchOrdinal: e.result.activeMatchOrdinal,
        matches: e.result.matches,
      });
    };

    const handleConsoleMessage = (e: Electron.ConsoleMessageEvent): void => {
      consoleMessagesRef.current = [
        ...consoleMessagesRef.current,
        {
          level: e.level,
          message: e.message,
          line: e.line,
          sourceId: e.sourceId,
          recordedAt: new Date().toISOString(),
        },
      ].slice(-500);
    };

    webview.addEventListener("did-navigate", handleDidNavigate);
    webview.addEventListener("did-navigate-in-page", handleDidNavigate);
    webview.addEventListener(
      "did-start-loading",
      handleDidStartLoading as EventListener
    );
    webview.addEventListener(
      "did-stop-loading",
      handleDidStopLoading as EventListener
    );
    webview.addEventListener(
      "page-title-updated",
      handlePageTitleUpdated as EventListener
    );
    webview.addEventListener("new-window", handleNewWindow);
    webview.addEventListener(
      "did-fail-load",
      handleDidFailLoad as EventListener
    );
    webview.addEventListener("found-in-page", handleFoundInPage);
    webview.addEventListener("console-message", handleConsoleMessage);

    return () => {
      webview.removeEventListener("did-navigate", handleDidNavigate);
      webview.removeEventListener("did-navigate-in-page", handleDidNavigate);
      webview.removeEventListener(
        "did-start-loading",
        handleDidStartLoading as EventListener
      );
      webview.removeEventListener(
        "did-stop-loading",
        handleDidStopLoading as EventListener
      );
      webview.removeEventListener(
        "page-title-updated",
        handlePageTitleUpdated as EventListener
      );
      webview.removeEventListener("new-window", handleNewWindow);
      webview.removeEventListener(
        "did-fail-load",
        handleDidFailLoad as EventListener
      );
      webview.removeEventListener("found-in-page", handleFoundInPage);
      webview.removeEventListener("console-message", handleConsoleMessage);
    };
  }, [instanceId]);

  // 非激活 tab 的 webview 静音,避免多个浏览器实例时后台页面持续播放
  // 音频/占用音频设备(对齐 Chrome 后台标签页行为);激活时恢复声音。
  // 注意:webview 方法(含 setAudioMuted)要求 guest 已触发 dom-ready,
  // 新 tab 挂载时 guest 可能尚未就绪,直接调用会抛
  // "The WebView must be attached to the DOM and the dom-ready event
  // emitted before this method can be called" 并中断渲染;因此先尝试
  // 一次,失败则由 dom-ready 事件补一次。
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }
    const applyMuted = (): void => {
      try {
        webview.setAudioMuted(!isActive);
      } catch {
        // guest 尚未就绪(dom-ready 未触发),等待 dom-ready 后重试。
      }
    };
    applyMuted();
    webview.addEventListener("dom-ready", applyMuted);
    return () => {
      webview.removeEventListener("dom-ready", applyMuted);
    };
  }, [instanceId, isActive]);

  const handleNavigate = (rawInput?: string): void => {
    const input = (rawInput ?? addressInput).trim();
    if (!input) {
      return;
    }
    const url = normalizeUrl(input, homepage);
    setAddressInput(url);
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }
    if (url === webviewSrc) {
      // Same URL — src won't change, so explicitly reload.
      webview.reload();
    } else {
      // Different URL — updating src triggers navigation via the webview's
      // attribute observer. We intentionally do NOT call loadURL() directly
      // here, as that would race with the src-triggered navigation and cause
      // spurious ERR_ABORTED errors via GUEST_VIEW_MANAGER_CALL.
      setWebviewSrc(url);
    }
  };

  const handleAddressKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>
  ): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleNavigate();
    }
  };

  const handleBack = (): void => {
    const webview = webviewRef.current;
    if (webview && webview.canGoBack()) {
      webview.goBack();
    }
  };

  const handleForward = (): void => {
    const webview = webviewRef.current;
    if (webview && webview.canGoForward()) {
      webview.goForward();
    }
  };

  const handleReload = (): void => {
    const webview = webviewRef.current;
    if (webview) {
      webview.reload();
    }
  };

  const handleClearCache = async (): Promise<void> => {
    try {
      await window.snow.clearBrowserCache();
    } catch (error) {
      console.error("Failed to clear browser cache:", error);
    }
    // Reload ignoring cache so the effect is immediately visible.
    webviewRef.current?.reloadIgnoringCache();
  };

  const handleClearCookies = async (): Promise<void> => {
    try {
      await window.snow.clearBrowserCookies();
    } catch (error) {
      console.error("Failed to clear browser cookies:", error);
    }
    webviewRef.current?.reload();
  };

  const applyZoom = (next: number): void => {
    setZoomFactor(next);
    webviewRef.current?.setZoomFactor(next);
  };

  const handleZoomIn = (): void => {
    const next = Math.min(Math.round((zoomFactor + 0.1) * 100) / 100, 5);
    applyZoom(next);
  };

  const handleZoomOut = (): void => {
    const next = Math.max(Math.round((zoomFactor - 0.1) * 100) / 100, 0.25);
    applyZoom(next);
  };

  const handleZoomReset = (): void => {
    applyZoom(1);
  };

  const handleForceReload = (): void => {
    webviewRef.current?.reloadIgnoringCache();
  };

  const handleOpenDevTools = (): void => {
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }
    void window.snow
      .openBrowserDevTools(webview.getWebContentsId())
      .catch((error) => {
        console.error("Failed to open browser DevTools:", error);
      });
  };

  const handleOpenFind = (): void => {
    setFindVisible(true);
  };

  const handleFindSearch = (text: string): void => {
    setFindText(text);
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }
    if (text) {
      webview.findInPage(text);
    } else {
      webview.stopFindInPage("clearSelection");
      setFindResult(null);
    }
  };

  const handleFindNext = (): void => {
    if (!findText) {
      return;
    }
    webviewRef.current?.findInPage(findText, {
      forward: true,
      findNext: true,
    });
  };

  const handleFindPrev = (): void => {
    if (!findText) {
      return;
    }
    webviewRef.current?.findInPage(findText, {
      forward: false,
      findNext: true,
    });
  };

  const handleFindClose = (): void => {
    webviewRef.current?.stopFindInPage("clearSelection");
    setFindVisible(false);
    setFindText("");
    setFindResult(null);
  };

  return (
    <div className="browser-panel">
      <BrowserToolbar
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        isLoading={isLoading}
        addressInput={addressInput}
        isCapturing={isCapturing}
        screenshotFeedback={feedback}
        onAddressChange={setAddressInput}
        onAddressKeyDown={handleAddressKeyDown}
        onBack={handleBack}
        onForward={handleForward}
        onReload={handleReload}
        onScreenshot={captureScreenshot}
        zoomFactor={zoomFactor}
        homepage={homepage}
        onClearCache={handleClearCache}
        onClearCookies={handleClearCookies}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
        onForceReload={handleForceReload}
        onFindInPage={handleOpenFind}
        onOpenDevTools={handleOpenDevTools}
        onSetHomepage={setHomepage}
      />
      <div className="browser-content">
        <webview
          ref={webviewRef}
          src={webviewSrc}
          className="browser-webview"
        />
        {findVisible && (
          <BrowserFindBar
            value={findText}
            result={findResult}
            onSearch={handleFindSearch}
            onNext={handleFindNext}
            onPrev={handleFindPrev}
            onClose={handleFindClose}
          />
        )}
      </div>
    </div>
  );
};
