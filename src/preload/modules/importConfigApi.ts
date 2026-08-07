import { ipcRenderer } from "electron";
import type {
  ExternalImportPreview,
  ExternalImportResult,
  ImportDiscovery,
  ImportCommitResult,
  ImportResourceRecord,
  ImportResourceRelease,
  ImportResourceReleaseInput,
  ImportSelection,
} from "../types/importConfig";

export const importConfigApi = {
  discoverImportCandidates: (
    activeDirectoryId?: string
  ): Promise<ImportDiscovery> =>
    ipcRenderer.invoke("import-config:discover", activeDirectoryId),
  commitImportSelection: (selection: ImportSelection): Promise<ImportCommitResult> =>
    ipcRenderer.invoke("import-config:commit", selection),
  listManagedImportResources: (): Promise<ImportResourceRecord[]> =>
    ipcRenderer.invoke("import-config:list-managed-resources"),
  releaseManagedImportResource: (
    input: ImportResourceReleaseInput
  ): Promise<ImportResourceRelease> =>
    ipcRenderer.invoke("import-config:release-managed-resource", input),
  previewClaudeCodeImport: (): Promise<ExternalImportPreview> =>
    ipcRenderer.invoke("import-config:preview-claude-code"),
  importClaudeCode: (): Promise<ExternalImportResult> =>
    ipcRenderer.invoke("import-config:claude-code"),
  previewOpenCodeImport: (): Promise<ExternalImportPreview> =>
    ipcRenderer.invoke("import-config:preview-opencode"),
  importOpenCode: (): Promise<ExternalImportResult> =>
    ipcRenderer.invoke("import-config:opencode"),
};
