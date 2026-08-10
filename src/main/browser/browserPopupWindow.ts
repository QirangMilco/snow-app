import { app, BrowserWindow, nativeTheme, type WebContents } from "electron";
import { APP_WINDOW_ICON_PATH } from "../app/constants";

/**
 * 内置浏览器（<webview>）弹出窗口管理。
 *
 * 背景：guest 页面调用 window.open() 或点击 target=_blank 时（典型场景如
 * Google 账号登录弹出的 OAuth 窗口），Electron 37 的 <webview> 标签已不再
 * 触发 new-window 事件（该事件已从 API 中移除）。且 webview guest 默认
 * disablePopups=true（除非标签带 allowpopups 属性），window.open 会被
 * Chromium 直接拦截返回 null，根本不会到达任何 handler —— 因此渲染端
 * <webview> 必须声明 allowpopups（注意 React 18 会丢弃未知 boolean 属性，
 * 须用字符串值/ref callback 写入，见 BrowserPanelContent.tsx），请求才会
 * 进入下面的处理流程。
 *
 * 这里在 guest webContents 上注册 setWindowOpenHandler 并返回
 * { action: "allow", overrideBrowserWindowOptions }，由 Electron 创建真正的
 * 弹出 BrowserWindow：
 *   - 保留 window.opener / postMessage 关系（OAuth 弹出登录依赖它）；
 *   - 与 webview 共享同一 session（cookie 同步，登录态互通）；
 *   - 弹出窗口内的二次 window.open 递归走同一逻辑。
 */

const DEFAULT_POPUP_WIDTH = 800;
const DEFAULT_POPUP_HEIGHT = 640;
const MIN_POPUP_WIDTH = 320;
const MIN_POPUP_HEIGHT = 240;
const MAX_POPUP_WIDTH = 1600;
const MAX_POPUP_HEIGHT = 1200;

const popupWindows = new Set<BrowserWindow>();

const getPopupBackgroundColor = (): string =>
  nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";

/** 解析 window.open() features 字符串中的宽高（如 "popup=yes,width=500,height=600"）。 */
const parseWindowFeatures = (
  features: string
): { width: number; height: number } => {
  const widthMatch = /(?:^|,)\s*width\s*=\s*(\d+)/i.exec(features);
  const heightMatch = /(?:^|,)\s*height\s*=\s*(\d+)/i.exec(features);
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max);
  return {
    width: widthMatch
      ? clamp(parseInt(widthMatch[1], 10), MIN_POPUP_WIDTH, MAX_POPUP_WIDTH)
      : DEFAULT_POPUP_WIDTH,
    height: heightMatch
      ? clamp(parseInt(heightMatch[1], 10), MIN_POPUP_HEIGHT, MAX_POPUP_HEIGHT)
      : DEFAULT_POPUP_HEIGHT,
  };
};

/** 相对发起窗口居中计算弹出窗口位置（发起窗口不可见时交给系统默认定位）。 */
const computeCenteredPosition = (
  opener: BrowserWindow | null,
  width: number,
  height: number
): { x: number; y: number } | undefined => {
  if (!opener || opener.isDestroyed() || opener.isMinimized()) {
    return undefined;
  }
  const bounds = opener.getBounds();
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + (bounds.height - height) / 2),
  };
};

/**
 * 为指定 webContents（webview guest 或已创建的弹出窗口）注册弹出窗口处理：
 * window.open / target=_blank 统一创建真实的 BrowserWindow。
 */
export const attachBrowserPopupWindowHandler = (contents: WebContents): void => {
  contents.setWindowOpenHandler(({ features }) => {
    const { width, height } = parseWindowFeatures(features);
    const opener = BrowserWindow.fromWebContents(contents);
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        ...computeCenteredPosition(opener, width, height),
        width,
        height,
        minWidth: MIN_POPUP_WIDTH,
        minHeight: MIN_POPUP_HEIGHT,
        icon: APP_WINDOW_ICON_PATH,
        autoHideMenuBar: true,
        backgroundColor: getPopupBackgroundColor(),
        show: false,
        webPreferences: {
          // 弹出窗口是纯网页，无需 Node 能力，保持沙箱开启。
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      },
    };
  });

  // did-create-window 仅在 setWindowOpenHandler 返回 allow 且窗口创建成功时触发。
  contents.on("did-create-window", (win) => {
    popupWindows.add(win);
    win.setMenu(null);
    win.setMenuBarVisibility(false);
    // 等待首帧渲染后再显示，避免白屏闪烁。
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) {
        win.show();
      }
    });
    win.once("closed", () => {
      popupWindows.delete(win);
    });
    // 弹出窗口内的 window.open 递归走同一处理逻辑。
    attachBrowserPopupWindowHandler(win.webContents);
  });
};

/** 初始化：为所有 webview guest 注册弹出窗口处理（幂等）。 */
export const initBrowserPopupHandler = (): void => {
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") {
      return;
    }
    attachBrowserPopupWindowHandler(contents);
  });
};

/** 关闭所有浏览器弹出窗口（主窗口关闭时调用，避免 macOS 残留孤儿窗口）。 */
export const closeAllBrowserPopups = (): void => {
  for (const win of popupWindows) {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
  popupWindows.clear();
};
