import { ipcRenderer } from "electron";
import type { CodexImportPreview, CodexImportResult } from "../types/codex";

export const codexApi = {
  previewCodexImport: (): Promise<CodexImportPreview> =>
    ipcRenderer.invoke("codex:preview-import"),
  importCodex: (): Promise<CodexImportResult> =>
    ipcRenderer.invoke("codex:import"),
};
