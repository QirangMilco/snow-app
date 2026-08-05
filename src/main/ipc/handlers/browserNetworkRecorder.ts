import { app, session, webContents } from "electron";

/**
 * 内置浏览器调试数据收集：
 * - 网络请求记录（仅 webview；环形缓冲，上限 500 条）
 * - JavaScript 弹窗（alert/confirm/prompt）通过 CDP 捕获与响应
 *
 * 只追加监听，不改动既有代理逻辑（sessionProxy.ts 的 setProxy 不受影响）。
 */

const browserWebContentsIds = new Set<number>();

// ===== 网络请求记录 =====

export type BrowserNetworkRecord = {
  id: number;
  webContentsId: number;
  url: string;
  method: string;
  status: number | string;
  resourceType: string;
  durationMs: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string[]>;
  recordedAt: string;
  error?: string;
};

type BrowserRequestDetails = {
  webContentsId?: number;
  webContents?: Electron.WebContents;
};

const MAX_RECORDS = 500;
const networkRecords: BrowserNetworkRecord[] = [];
let nextRecordId = 1;
let networkRecorderInitialized = false;

const getBrowserWebContentsId = (
  details: BrowserRequestDetails
): number | undefined => {
  const id = details.webContentsId ?? details.webContents?.id;
  return id !== undefined && browserWebContentsIds.has(id) ? id : undefined;
};

const pushNetworkRecord = (record: BrowserNetworkRecord): void => {
  networkRecords.push(record);
  if (networkRecords.length > MAX_RECORDS) {
    networkRecords.splice(0, networkRecords.length - MAX_RECORDS);
  }
};

/** 注册 webRequest 监听（幂等）。需在 app ready 之后调用。 */
export const initBrowserNetworkRecorder = (): void => {
  if (networkRecorderInitialized) {
    return;
  }
  networkRecorderInitialized = true;

  const pendingRequests = new Map<
    number,
    {
      webContentsId: number;
      startedAt: number;
      method: string;
      requestHeaders: Record<string, string>;
    }
  >();

  // onBeforeSendHeaders 携带最终请求头；仅记录已识别的 webview 请求，
  // 避免把 Snow App 自身 API、更新检查等请求混进浏览器调试结果。
  session.defaultSession.webRequest.onBeforeSendHeaders(
    (details, callback) => {
      const webContentsId = getBrowserWebContentsId(details);
      if (webContentsId !== undefined) {
        pendingRequests.set(details.id, {
          webContentsId,
          startedAt: Date.now(),
          method: details.method,
          requestHeaders: details.requestHeaders,
        });
      }

      // onBeforeSendHeaders 是阻塞型事件；无论是否记录该请求，都必须调用
      // callback 放行，否则 defaultSession 的所有请求（包括主窗口 file://）
      // 都会永久停在 about:blank，表现为全应用白屏。
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  session.defaultSession.webRequest.onCompleted((details) => {
    const pending = pendingRequests.get(details.id);
    pendingRequests.delete(details.id);
    if (!pending) {
      return;
    }
    pushNetworkRecord({
      id: nextRecordId++,
      webContentsId: pending.webContentsId,
      url: details.url,
      method: pending.method,
      status: details.statusCode,
      resourceType: details.resourceType,
      durationMs: Date.now() - pending.startedAt,
      requestHeaders: pending.requestHeaders,
      responseHeaders: details.responseHeaders ?? {},
      recordedAt: new Date().toISOString(),
    });
  });

  session.defaultSession.webRequest.onErrorOccurred((details) => {
    const pending = pendingRequests.get(details.id);
    pendingRequests.delete(details.id);
    if (!pending) {
      return;
    }
    pushNetworkRecord({
      id: nextRecordId++,
      webContentsId: pending.webContentsId,
      url: details.url,
      method: pending.method,
      status: "error",
      resourceType: details.resourceType,
      durationMs: Date.now() - pending.startedAt,
      requestHeaders: pending.requestHeaders,
      responseHeaders: {},
      recordedAt: new Date().toISOString(),
      error: details.error,
    });
  });
};

/** 查询网络记录：最新在前；filter 为 URL 正则（Rust 入口已校验）。 */
export const queryNetworkRecords = (
  webContentsId: number,
  filter?: string,
  limit = 50
): BrowserNetworkRecord[] => {
  let result = networkRecords.filter(
    (record) => record.webContentsId === webContentsId
  );
  if (filter) {
    try {
      const expression = new RegExp(filter);
      result = result.filter((record) => expression.test(record.url));
    } catch {
      return [];
    }
  }
  return result.slice(-limit).reverse();
};

// ===== JavaScript 弹窗捕获与响应 =====

export type PendingBrowserDialog = {
  webContentsId: number;
  dialogType: string;
  message: string;
  defaultText: string | null;
  url: string | null;
  capturedAt: string;
};

type JavascriptDialogOpeningParams = {
  url?: string;
  message?: string;
  type?: string;
  defaultPrompt?: string;
};

const pendingDialogs = new Map<number, PendingBrowserDialog>();
let dialogHandlerInitialized = false;

const readDialogOpeningParams = (
  params: unknown
): JavascriptDialogOpeningParams =>
  params !== null && typeof params === "object"
    ? (params as JavascriptDialogOpeningParams)
    : {};

const attachDialogDebugger = async (
  contents: Electron.WebContents
): Promise<void> => {
  if (contents.isDestroyed() || contents.isDevToolsOpened()) {
    return;
  }
  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
    }
    await contents.debugger.sendCommand("Page.enable");
  } catch {
    // DevTools 或其他调试客户端可能暂时占用 CDP；devtools-closed 后会重试。
  }
};

/**
 * 捕获 webview guest 页面的 alert/confirm/prompt。
 * Electron 没有公开 JavaScript dialog 事件，因此使用官方 debugger/CDP：
 * Page.javascriptDialogOpening → Page.handleJavaScriptDialog。
 */
export const initBrowserDialogHandler = (): void => {
  if (dialogHandlerInitialized) {
    return;
  }
  dialogHandlerInitialized = true;

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") {
      return;
    }

    browserWebContentsIds.add(contents.id);
    void attachDialogDebugger(contents);

    contents.debugger.on("message", (_event, method, params) => {
      if (method !== "Page.javascriptDialogOpening") {
        return;
      }
      const details = readDialogOpeningParams(params);
      pendingDialogs.set(contents.id, {
        webContentsId: contents.id,
        dialogType: details.type ?? "unknown",
        message: details.message ?? "",
        defaultText: details.defaultPrompt ?? null,
        url: details.url ?? null,
        capturedAt: new Date().toISOString(),
      });
    });

    // 打开 DevTools 会让 Electron debugger 会话断开；关闭后恢复弹窗监听。
    contents.on("devtools-closed", () => {
      void attachDialogDebugger(contents);
    });
    contents.once("destroyed", () => {
      browserWebContentsIds.delete(contents.id);
      pendingDialogs.delete(contents.id);
    });
  });
};

export const listPendingDialogs = (
  webContentsId: number
): PendingBrowserDialog[] => {
  const dialog = pendingDialogs.get(webContentsId);
  return dialog ? [dialog] : [];
};

/** 响应指定 webview 的 pending 弹窗。 */
export const respondPendingDialog = async (
  webContentsId: number,
  accept: boolean,
  promptText?: string
): Promise<{ responded: boolean; remaining: number; error?: string }> => {
  const first = pendingDialogs.get(webContentsId);
  if (!first) {
    return { responded: false, remaining: 0 };
  }

  const contents = webContents.fromId(first.webContentsId);
  if (!contents || contents.isDestroyed()) {
    pendingDialogs.delete(first.webContentsId);
    return {
      responded: false,
      remaining: pendingDialogs.size,
      error: "Dialog web contents no longer exists",
    };
  }

  try {
    await attachDialogDebugger(contents);
    if (!contents.debugger.isAttached()) {
      throw new Error(
        "Browser debugger is unavailable; close the page DevTools and retry"
      );
    }
    await contents.debugger.sendCommand("Page.handleJavaScriptDialog", {
      accept,
      promptText: accept && promptText !== undefined ? promptText : undefined,
    });
    pendingDialogs.delete(first.webContentsId);
    return { responded: true, remaining: pendingDialogs.size };
  } catch (error) {
    // 保留 pending，允许用户关闭 DevTools 后重试，避免弹窗状态丢失。
    return {
      responded: false,
      remaining: pendingDialogs.size,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
