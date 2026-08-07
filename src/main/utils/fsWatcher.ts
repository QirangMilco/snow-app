import { BrowserWindow } from "electron";
import { watch, type FSWatcher } from "node:fs";
import { safeSend } from "./safeSend";

type WatchEntry = {
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
};

const watchers = new Map<string, WatchEntry>();

const DEBOUNCE_MS = 300;

const flushChange = (dirPath: string): void => {
  const entry = watchers.get(dirPath);
  if (!entry) {
    return;
  }

  entry.timer = null;

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && window.webContents) {
      safeSend(window.webContents, "workspace-directories:changed", dirPath);
    }
  }
};

const scheduleChange = (dirPath: string): void => {
  const entry = watchers.get(dirPath);
  if (!entry) {
    return;
  }

  if (entry.timer) {
    clearTimeout(entry.timer);
  }

  entry.timer = setTimeout(() => flushChange(dirPath), DEBOUNCE_MS);
};

export const startDirectoryWatch = (dirPath: string): void => {
  if (watchers.has(dirPath)) {
    return;
  }

  try {
    const watcher = watch(
      dirPath,
      { recursive: true },
      (_eventType, filename) => {
        if (!filename) {
          return;
        }

        scheduleChange(dirPath);
      }
    );

    watcher.on("error", () => {
      stopDirectoryWatch(dirPath);
    });

    watchers.set(dirPath, { watcher, timer: null });
  } catch {
    // Directory may not exist or watch not supported
  }
};

export const stopDirectoryWatch = (dirPath: string): void => {
  const entry = watchers.get(dirPath);
  if (!entry) {
    return;
  }

  if (entry.timer) {
    clearTimeout(entry.timer);
  }

  entry.watcher.close();
  watchers.delete(dirPath);
};

export const stopAllDirectoryWatches = (): void => {
  for (const dirPath of watchers.keys()) {
    stopDirectoryWatch(dirPath);
  }
};
