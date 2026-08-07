import { ipcMain } from "electron";
import type { NativeBridge } from "../../native/types";

export const registerIdeHandlers = (native: NativeBridge): void => {
  ipcMain.handle("ide:list", () => native.listInstalledIdes());

  ipcMain.handle(
    "ide:open",
    (_event, ideId: unknown, projectPath: unknown) => {
      if (typeof ideId !== "string" || !ideId.trim()) {
        throw new Error("IDE id is required");
      }
      if (typeof projectPath !== "string" || !projectPath.trim()) {
        throw new Error("Project path is required");
      }

      return native.openInIde(ideId.trim(), projectPath.trim());
    }
  );
};
