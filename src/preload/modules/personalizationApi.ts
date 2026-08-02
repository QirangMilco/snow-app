import { ipcRenderer } from "electron";
import type { GlobalRoleFile } from "../types";

export const personalizationApi = {
  /** 读取全局规则文件（~/.snow/ROLE.md）。 */
  getGlobalRole: (): Promise<GlobalRoleFile> =>
    ipcRenderer.invoke("personalization:get-global-role"),
  /** 保存全局规则文件（~/.snow/ROLE.md）。 */
  saveGlobalRole: (content: string): Promise<void> =>
    ipcRenderer.invoke("personalization:save-global-role", content),
};
