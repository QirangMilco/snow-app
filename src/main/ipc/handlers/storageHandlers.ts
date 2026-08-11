import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import type {
  NativeBridge,
  StorageLocationKind,
  StorageMigrationProgress,
} from "../../native/types";

const isStorageLocationKind = (value: unknown): value is StorageLocationKind =>
  value === "checkpoint" || value === "upload";

/**
 * 存储位置（数据库 / 检查点 / 上传图片）IPC。
 *
 * - `storage:get-locations`：读取各存储位置路径（数据库文件、检查点根、
 *   上传根与自定义目录设置）
 * - `storage:open-directory`：在系统文件管理器中打开目录（跨平台：
 *   Windows 资源管理器 / macOS Finder / Linux 文件管理器）
 * - `storage:select-directory`：弹出目录选择对话框
 * - `storage:dir-set`：设置 checkpoint / upload 自定义目录
 * - `storage:migrate-prepare / -chunk / -commit / -rollback`：更换目录时的
 *   迁移流程（与图库迁移一致的 prepare → 分批复制 → commit / rollback）
 */
export const registerStorageHandlers = (native: NativeBridge): void => {
  ipcMain.handle("storage:get-locations", async (): Promise<unknown> => {
    const [databasePath, checkpointDir, uploadDir, checkpointRoot, uploadRoot] =
      await Promise.all([
        native.initializeAppStorage().then((info) => info.databasePath),
        native.getCheckpointDir(),
        native.getUploadDir(),
        native.getCheckpointRoot(),
        native.getUploadRoot(),
      ]);
    return {
      databasePath,
      checkpointDir,
      uploadDir,
      checkpointRoot,
      uploadRoot,
    };
  });

  ipcMain.handle(
    "storage:open-directory",
    async (_event, dirPath: unknown): Promise<string | null> => {
      if (typeof dirPath !== "string" || dirPath.trim() === "") {
        throw new Error("Directory path is required");
      }
      // shell.openPath 跨平台：Windows 资源管理器 / macOS Finder /
      // Linux 文件管理器；失败时返回错误信息字符串，成功返回空字符串。
      const errorMessage = await shell.openPath(dirPath.trim());
      return errorMessage || null;
    }
  );

  ipcMain.handle(
    "storage:select-directory",
    async (event, dialogTitle: unknown): Promise<string | null> => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const title =
        typeof dialogTitle === "string" && dialogTitle.trim()
          ? dialogTitle.trim()
          : "Select directory";
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ["openDirectory", "createDirectory"],
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    }
  );

  ipcMain.handle(
    "storage:dir-set",
    async (_event, kind: unknown, dir: unknown): Promise<void> => {
      if (!isStorageLocationKind(kind)) {
        throw new Error("Invalid storage location kind");
      }
      if (typeof dir !== "string") {
        throw new Error("Invalid storage directory");
      }
      if (kind === "checkpoint") {
        await native.setCheckpointDir(dir.trim());
      } else {
        await native.setUploadDir(dir.trim());
      }
    }
  );

  ipcMain.handle(
    "storage:migrate-prepare",
    async (_event, kind: unknown, targetDir: unknown): Promise<number> => {
      if (!isStorageLocationKind(kind)) {
        throw new Error("Invalid storage location kind");
      }
      if (typeof targetDir !== "string") {
        throw new Error("Invalid storage target directory");
      }
      return native.prepareStorageMigration(kind, targetDir.trim());
    }
  );

  ipcMain.handle(
    "storage:migrate-chunk",
    async (_event, kind: unknown): Promise<StorageMigrationProgress> => {
      if (!isStorageLocationKind(kind)) {
        throw new Error("Invalid storage location kind");
      }
      return native.migrateStorageChunk(kind);
    }
  );

  ipcMain.handle(
    "storage:migrate-commit",
    async (_event, kind: unknown): Promise<void> => {
      if (!isStorageLocationKind(kind)) {
        throw new Error("Invalid storage location kind");
      }
      await native.commitStorageMigration(kind);
    }
  );

  ipcMain.handle(
    "storage:migrate-rollback",
    async (_event, kind: unknown): Promise<void> => {
      if (!isStorageLocationKind(kind)) {
        throw new Error("Invalid storage location kind");
      }
      await native.rollbackStorageMigration(kind);
    }
  );
};
