import { ipcRenderer } from "electron";
import type { IdeInfo } from "../types";

export const ideApi = {
  listInstalledIdes: (): Promise<IdeInfo[]> => ipcRenderer.invoke("ide:list"),
  openInIde: (ideId: string, projectPath: string): Promise<void> =>
    ipcRenderer.invoke("ide:open", ideId, projectPath),
};
