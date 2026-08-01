// 更新入口：按平台分发。
//   - macOS：无签名更新流程（macUpdater）—— 应用无证书，不走签名更新方案
//   - Windows / Linux：保留 electron-updater 方案（electronUpdater）
//
// 两套实现共用 updateStatus.ts 的状态存储与 "updater:status-changed" 推送通道，
// 渲染层 UI（侧边栏更新入口）无需感知差异。

import { app, ipcMain, type BrowserWindow } from "electron";
import { initElectronUpdater } from "./electronUpdater";
import { initMacUpdater } from "./macUpdater";

export type { UpdateStatus } from "./updateStatus";

let appVersionIpcRegistered = false;

export const initAutoUpdater = (mainWindow: BrowserWindow): void => {
  // app:get-version 对所有平台生效，与更新方案无关
  if (!appVersionIpcRegistered) {
    appVersionIpcRegistered = true;
    ipcMain.handle("app:get-version", () => app.getVersion());
  }

  if (process.platform === "darwin") {
    initMacUpdater(mainWindow);
    return;
  }

  initElectronUpdater(mainWindow);
};
