import { ipcRenderer } from "electron";
import type {
  StorageLocationKind,
  StorageLocations,
  StorageMigrationProgress,
} from "../types/storage";

/** 存储位置（数据库 / 检查点 / 上传图片）API。 */
export const storageApi = {
  /** 读取各存储位置路径信息 */
  getStorageLocations: (): Promise<StorageLocations> =>
    ipcRenderer.invoke("storage:get-locations"),

  /** 在系统文件管理器中打开目录（跨平台）；失败时返回错误信息字符串，成功返回 null */
  openStorageDirectory: (dirPath: string): Promise<string | null> =>
    ipcRenderer.invoke("storage:open-directory", dirPath),

  /** 弹出目录选择对话框，返回选中目录路径或 null */
  selectStorageDirectory: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke("storage:select-directory", dialogTitle),

  /** 设置 checkpoint / upload 自定义保存目录（传入空字符串重置为默认目录） */
  setStorageDir: (kind: StorageLocationKind, dir: string): Promise<void> =>
    ipcRenderer.invoke("storage:dir-set", kind, dir),

  /** 准备存储目录迁移：校验目标目录并写入迁移日志；返回待迁移文件数量（0 表示无需迁移） */
  prepareStorageMigration: (
    kind: StorageLocationKind,
    targetDir: string
  ): Promise<number> => ipcRenderer.invoke("storage:migrate-prepare", kind, targetDir),

  /** 复制下一批存储目录文件并返回迁移进度（copied/total/done） */
  migrateStorageChunk: (
    kind: StorageLocationKind
  ): Promise<StorageMigrationProgress> =>
    ipcRenderer.invoke("storage:migrate-chunk", kind),

  /** 提交存储目录迁移：写入新目录设置并清理旧根目录文件 */
  commitStorageMigration: (kind: StorageLocationKind): Promise<void> =>
    ipcRenderer.invoke("storage:migrate-commit", kind),

  /** 回滚存储目录迁移：删除已复制到新目录的文件并移除日志（幂等） */
  rollbackStorageMigration: (kind: StorageLocationKind): Promise<void> =>
    ipcRenderer.invoke("storage:migrate-rollback", kind),
};
