import { ipcMain } from "electron";
import type { NativeBridge } from "../../native/types";
import { importCodex, previewCodexImport } from "../../codex/importer";

export const registerCodexHandlers = (native: NativeBridge): void => {
  ipcMain.handle("codex:preview-import", () => previewCodexImport(native));
  ipcMain.handle("codex:import", () => importCodex(native));
};
