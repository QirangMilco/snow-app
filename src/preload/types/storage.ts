/** 可迁移的存储位置种类：checkpoint（检查点）| upload（上传图片） */
export type StorageLocationKind = "checkpoint" | "upload";

/** 各存储位置路径信息 */
export type StorageLocations = {
  /** 数据库文件绝对路径（~/.snowapp/snowapp.db 或自定义） */
  databasePath: string;
  /** 检查点自定义保存目录（空字符串表示使用默认目录） */
  checkpointDir: string;
  /** 上传图片自定义保存目录（空字符串表示使用默认目录） */
  uploadDir: string;
  /** 检查点根目录绝对路径（优先自定义，回退默认） */
  checkpointRoot: string;
  /** 上传图片根目录绝对路径（优先自定义，回退默认） */
  uploadRoot: string;
};

/** 存储目录迁移进度 */
export type StorageMigrationProgress = {
  copied: number;
  total: number;
  done: boolean;
};
