import type { WebContents } from "electron";

/**
 * Electron 在渲染 frame 已释放时访问 webFrameMain 抛出的错误标记。
 *
 * 页面刷新/导航/关闭过程中，渲染 frame 会先于 webContents 被释放，
 * 此时 `webContents.isDestroyed()` 仍返回 false，但 `send()` 内部
 * 访问 webFrameMain 会抛出：
 *
 *   Error sending from webFrameMain: Error: Render frame was disposed
 *   before WebFrameMain could be accessed
 *
 * 这类发送属于预期内的生命周期竞态（窗口正在刷新/导航/关闭），
 * 应静默丢弃，不应作为错误刷屏。
 */
const FRAME_DISPOSED_MARKER = "Render frame was disposed";

/**
 * 安全地向渲染进程发送 IPC 消息。
 *
 * 相比裸 `webContents.send()`：
 * - 先检查 `isDestroyed()`，整体销毁时直接跳过；
 * - frame 已释放但 webContents 尚存活时，吞掉 Electron 内部抛出的
 *   frame-disposed 错误（预期竞态），其余异常照常向上抛出。
 *
 * @returns 是否成功发出；false 表示目标已销毁或 frame 已释放。
 */
export const safeSend = (
  target: WebContents,
  channel: string,
  ...args: unknown[]
): boolean => {
  if (target.isDestroyed()) {
    return false;
  }
  try {
    target.send(channel, ...args);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(FRAME_DISPOSED_MARKER)
    ) {
      return false;
    }
    throw error;
  }
};
