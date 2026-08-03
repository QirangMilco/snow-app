// Windows / Linux 更新流程：保留 electron-updater 签名更新方案。
// macOS 无证书，改走 macUpdater 的无签名流程，不会进入此模块。

import { app, ipcMain, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import { snowLog } from "../../utils/snowLogger";
import { markCloseConfirmed } from "../app/mainWindow";
import { applySessionProxy } from "../app/sessionProxy";
import { native } from "../native/nativeBridge";
import {
  getUpdateStatus,
  setUpdateStatus,
  subscribeUpdateStatus,
} from "./updateStatus";

const { autoUpdater } = electronUpdater;

const UPDATE_CHANNEL = "updater:status-changed";

// 运行时定时检查间隔（毫秒），默认 1 小时
const RUNTIME_CHECK_INTERVAL_MS = 60 * 60 * 1000;
let runtimeCheckTimer: NodeJS.Timeout | null = null;

let initialized = false;
let mainWindowRef: BrowserWindow | null = null;

const broadcastStatus = (): void => {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(UPDATE_CHANNEL, getUpdateStatus());
  }
};

// 执行一次更新检查，统一处理错误日志
const checkForUpdatesAction = async (): Promise<void> => {
  try {
    // electron-updater 使用独立的 "electron-updater" 分区会话发请求，
    // 每次检查前同步代理设置，确保检查与下载都走配置的代理
    await applySessionProxy(native);
    await autoUpdater.checkForUpdates();
  } catch (error) {
    snowLog.error({
      module: "updater/electron",
      func: "checkForUpdatesAction",
      message: "Check for updates failed",
      error: error instanceof Error ? error.message : String(error),
    });
    setUpdateStatus({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const initElectronUpdater = (mainWindow: BrowserWindow): void => {
  if (initialized) {
    mainWindowRef = mainWindow;
    return;
  }
  initialized = true;
  mainWindowRef = mainWindow;

  // 不自动下载，由用户点击按钮触发
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.requestHeaders = {};

  subscribeUpdateStatus(() => {
    broadcastStatus();
  });

  autoUpdater.on("checking-for-update", () => {
    snowLog.info({
      module: "updater/electron",
      func: "checking-for-update",
      message: "Checking for updates...",
    });
  });

  autoUpdater.on("update-available", (info) => {
    snowLog.info({
      module: "updater/electron",
      func: "update-available",
      message: `Update available: ${info.version}`,
    });
    setUpdateStatus({
      available: true,
      version: info.version,
      downloading: false,
      downloaded: false,
      error: null,
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    snowLog.info({
      module: "updater/electron",
      func: "update-not-available",
      message: `No update available, current: ${info.version}`,
    });
    setUpdateStatus({
      available: false,
      version: null,
      downloading: false,
      progress: 0,
      downloaded: false,
      error: null,
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    setUpdateStatus({
      progress: Math.round(progress.percent),
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    snowLog.info({
      module: "updater/electron",
      func: "update-downloaded",
      message: `Update downloaded: ${info.version}`,
    });
    setUpdateStatus({
      downloading: false,
      progress: 100,
      downloaded: true,
    });
  });

  autoUpdater.on("error", (error) => {
    snowLog.error({
      module: "updater/electron",
      func: "error",
      message: "Update error",
      error: error instanceof Error ? error.message : String(error),
    });
    setUpdateStatus({
      downloading: false,
      downloaded: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // 启动时异步检查更新（dev 与打包环境均检查）
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true;
  }
  setTimeout(() => {
    void checkForUpdatesAction();
  }, 3000);

  // 运行时定时检查：应用长时间运行时周期性探测新版本
  // 仅在无可用更新、未在下载、未下载完成时才执行实际检查，避免重复打扰
  runtimeCheckTimer = setInterval(() => {
    const status = getUpdateStatus();
    if (status.available || status.downloading || status.downloaded) {
      return;
    }
    void checkForUpdatesAction();
  }, RUNTIME_CHECK_INTERVAL_MS);

  // 用户点击"立即更新" → 开始下载
  ipcMain.handle("updater:download-update", async () => {
    try {
      // 下载前同步代理设置，确保更新包下载走配置的代理
      await applySessionProxy(native);
      setUpdateStatus({ downloading: true, progress: 0, error: null });
      await autoUpdater.downloadUpdate();
      return getUpdateStatus();
    } catch (error) {
      snowLog.error({
        module: "updater/electron",
        func: "download-update",
        message: "Failed to download update",
        error: error instanceof Error ? error.message : String(error),
      });
      setUpdateStatus({
        downloading: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return getUpdateStatus();
    }
  });

  // 用户点击"重启更新" → 退出并安装
  ipcMain.handle("updater:install-update", () => {
    // 跳过关闭二次确认，避免重启更新被拦截
    markCloseConfirmed();
    autoUpdater.quitAndInstall();
  });

  ipcMain.handle("updater:get-status", () => getUpdateStatus());

  // 用户手动触发检查更新
  ipcMain.handle("updater:check-for-updates", () => {
    void checkForUpdatesAction();
    return getUpdateStatus();
  });

  // 应用退出时清理运行时定时检查
  app.on("before-quit", () => {
    if (runtimeCheckTimer) {
      clearInterval(runtimeCheckTimer);
      runtimeCheckTimer = null;
    }
  });
};
