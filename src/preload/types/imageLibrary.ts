/** 图像管理系统（生成图片图库）记录 */
export type ImageLibraryRecord = {
  id: string;
  relativePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  prompt: string;
  model: string;
  provider: string;
  createdAt: string;
};

/** 图库目录迁移进度 */
export type ImageLibraryMigrationProgress = {
  copied: number;
  total: number;
  done: boolean;
};
