import { ipcMain } from "electron";
import { readFile } from "fs/promises";
import { join, normalize, sep } from "path";
import type { NativeBridge } from "../../native/types";

/**
 * 图片相关 IPC。
 *
 * `images:resolve-upload-image`：把参考图路径解析为 data URL，
 * 供渲染端展示会话内图片（如 imagegen 参考图缩略图）。支持两种路径：
 * 绝对磁盘路径（用户本地任意目录的图片）与 `upload/` 目录内的相对路径
 * （相对数据库文件所在目录）。渲染进程无法直接访问磁盘，必须经主进程读取。
 */
export const registerImageHandlers = (native: NativeBridge): void => {
  ipcMain.handle(
    "images:resolve-upload-image",
    async (_event, relativePath: unknown): Promise<string | null> => {
      if (typeof relativePath !== "string") {
        return null;
      }
      const normalized = relativePath.trim().replace(/\\/g, "/");
      // 绝对路径（Windows 盘符 C:/... 或 POSIX /...）直接读取用户本地文件；
      // 相对路径仅允许 upload/ 目录内，拒绝路径穿越（..）
      const isAbsolute =
        /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/");
      if (
        !isAbsolute &&
        (!normalized.startsWith("upload/") || normalized.includes(".."))
      ) {
        return null;
      }
      try {
        const uploadRoot = await native.getUploadRoot();
        let filePath: string;
        if (isAbsolute) {
          filePath = normalize(normalized);
        } else {
          // normalized 已带 upload/ 前缀（如 upload/2026-08-05/xxx.jpg），
          // 直接基于上传根目录拼接（根目录已含用户自定义或默认位置，不能再拼
          // 一次 uploadRoot，否则会出现 uploadRoot\upload\... 双重前缀导致
          // 文件读不到（历史 bug）。
          filePath = normalize(join(uploadRoot, normalized));
          // 二次校验：解析后的路径必须仍在 upload 目录内
          const rootPrefix = uploadRoot.endsWith(sep)
            ? uploadRoot
            : uploadRoot + sep;
          if (
            filePath !== uploadRoot &&
            !filePath.toLowerCase().startsWith(rootPrefix.toLowerCase())
          ) {
            return null;
          }
        }
        const bytes = await readFile(filePath);
        const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
        const mimeType =
          ext === "png"
            ? "image/png"
            : ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : ext === "webp"
            ? "image/webp"
            : ext === "gif"
            ? "image/gif"
            : ext === "bmp"
            ? "image/bmp"
            : "image/png";
        return `data:${mimeType};base64,${bytes.toString("base64")}`;
      } catch {
        // 文件不存在/读取失败等一律返回 null，渲染端回退到占位展示
        return null;
      }
    }
  );
};
