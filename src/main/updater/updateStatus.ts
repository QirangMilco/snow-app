// 更新状态存储：被 autoUpdater（非 macOS）与 macUpdater（macOS 无签名流程）
// 共同使用，避免两套实现各自维护状态导致 UI 展示不一致。

export interface UpdateStatus {
  available: boolean;
  version: string | null;
  downloading: boolean;
  progress: number;
  downloaded: boolean;
  error: string | null;
}

const INITIAL_STATUS: UpdateStatus = {
  available: false,
  version: null,
  downloading: false,
  progress: 0,
  downloaded: false,
  error: null,
};

let status: UpdateStatus = { ...INITIAL_STATUS };

const listeners = new Set<(status: UpdateStatus) => void>();

export const getUpdateStatus = (): UpdateStatus => status;

export const setUpdateStatus = (partial: Partial<UpdateStatus>): void => {
  status = { ...status, ...partial };
  for (const listener of listeners) {
    listener(status);
  }
};

export const resetUpdateStatus = (): void => {
  status = { ...INITIAL_STATUS };
};

export const subscribeUpdateStatus = (
  listener: (status: UpdateStatus) => void
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
