import type { AppStorageInfo, NativeBridge } from "../native/types";
import { markStorageReady, markStorageFailed } from "./storageReady";
import { snowLog } from "../../utils/snowLogger";

const ensureDefaultWorkspaceDirectory = async (
  native: NativeBridge
): Promise<void> => {
  const directories = await native.listWorkspaceDirectories();

  if (directories.length === 0) {
    return;
  }

  if (!directories.some((directory) => directory.isActive)) {
    await native.activateWorkspaceDirectory(directories[0].directoryId);
  }
};

export const initializeApplicationServices = async (
  native: NativeBridge
): Promise<AppStorageInfo> => {
  try {
    const storageInfo = await native.initializeAppStorage();
    // 清理上次异常退出(崩溃/强杀/断电)残留的 checkpoint pending 孤儿快照。
    // 启动时不可能有活动快照,传 0 清空一切残留;失败不影响启动。
    try {
      const cleaned = await native.cleanupPendingCheckpoints(0);
      if (cleaned > 0) {
        console.info(`Cleaned up ${cleaned} orphaned pending checkpoint(s)`);
        snowLog.warn({
          module: "app/storage",
          func: "initializeApplicationServices",
          message: "Cleaned up orphaned pending checkpoint snapshots",
          context: `count=${cleaned}`,
        });
      }
    } catch (cleanupError) {
      console.error("Failed to clean up pending checkpoints:", cleanupError);
      snowLog.warn({
        module: "app/storage",
        func: "initializeApplicationServices",
        message: "Failed to clean up orphaned pending checkpoints",
        error:
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
      });
    }
    const cancelledSubAgentCount = await native.cancelRunningSubAgentSessions();
    await ensureDefaultWorkspaceDirectory(native);
    // 每次启动强制关闭请求日志，避免用户忘记手动关闭导致大量日志写入损伤硬盘。
    await native.setRequestLogging(false);
    await native.setRequestLoggingExpiry(0);
    if (cancelledSubAgentCount > 0) {
      console.info(
        `Cancelled ${cancelledSubAgentCount} interrupted sub-agent session(s)`
      );
      snowLog.warn({
        module: "app/storage",
        func: "initializeApplicationServices",
        message: "Cancelled interrupted sub-agent sessions from previous run",
        context: `count=${cancelledSubAgentCount}`,
      });
    }
    console.info("Snow App storage initialized:", storageInfo.databasePath);
    snowLog.info({
      module: "app/storage",
      func: "initializeApplicationServices",
      message: "Application storage initialized",
      context: storageInfo.databasePath,
    });
    markStorageReady();
    return storageInfo;
  } catch (error) {
    snowLog.error({
      module: "app/storage",
      func: "initializeApplicationServices",
      message: "Application storage initialization failed",
      error: error instanceof Error ? error.message : String(error),
    });
    markStorageFailed(error);
    throw error;
  }
};
