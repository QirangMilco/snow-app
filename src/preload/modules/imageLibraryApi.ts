import { ipcRenderer } from "electron";
import type { ImageLibraryRecord } from "../types/imageLibrary";

/** 图像管理系统（Image Library）API。 */
export const imageLibraryApi = {
  /** 图库根目录绝对路径（优先用户自定义路径，回退默认 ~/.snowapp/image） */
  getImageLibraryRoot: (): Promise<string> =>
    ipcRenderer.invoke("images:library-root"),

  /** 读取图库自定义保存目录（空字符串表示使用默认目录） */
  getImageLibraryDir: (): Promise<string> =>
    ipcRenderer.invoke("images:library-dir-get"),

  /** 设置图库自定义保存目录（传入空字符串重置为默认目录） */
  setImageLibraryDir: (dir: string): Promise<void> =>
    ipcRenderer.invoke("images:library-dir-set", dir),

  /** 弹出目录选择对话框，返回选中目录路径或 null */
  selectImageDirectory: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke("images:select-directory", dialogTitle),

  /** 列出全部生成图片（按创建时间倒序） */
  listImageLibrary: (): Promise<ImageLibraryRecord[]> =>
    ipcRenderer.invoke("images:library-list"),

  /** 删除图片：物理文件 + 索引 + 同步重写引用该图的会话消息 */
  deleteImageLibraryImage: (id: string): Promise<void> =>
    ipcRenderer.invoke("images:library-delete", id),

  /** 把图库相对路径（image/...）解析为 data URL，失败返回 null */
  resolveLibraryImage: (relativePath: string): Promise<string | null> =>
    ipcRenderer.invoke("images:resolve-library-image", relativePath),

  /** 统计指定会话中引用的图库图片数量（删除会话确认框用） */
  countConversationImages: (conversationIds: string[]): Promise<number> =>
    ipcRenderer.invoke("images:conversation-images-count", conversationIds),

  /** 级联删除指定会话中引用的图库图片（删除会话时选择不保留图片） */
  deleteConversationImages: (conversationIds: string[]): Promise<number> =>
    ipcRenderer.invoke("images:delete-conversation-images", conversationIds),
};
