import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  DirectoryEntry,
  FileContentResult,
  FileSearchAgentProgress,
  FileSearchResult,
  WorkspaceDirectoryInput,
  WorkspaceDirectoryRecord,
} from "../types";

const AGENT_SEARCH_PROGRESS_CHANNEL =
  "workspace-directories:search-files-by-agent:progress";

const agentSearchProgressCallbacks = new Map<
  string,
  (chunk: FileSearchAgentProgress) => void
>();
let agentSearchProgressListenerRegistered = false;

const ensureAgentSearchProgressListener = (): void => {
  if (agentSearchProgressListenerRegistered) {
    return;
  }
  agentSearchProgressListenerRegistered = true;
  ipcRenderer.on(
    AGENT_SEARCH_PROGRESS_CHANNEL,
    (_event, payload: unknown) => {
      const record = payload as Record<string, unknown> | null;
      const streamId = record?.streamId;
      const chunk = record?.chunk as FileSearchAgentProgress | undefined;
      if (typeof streamId !== "string" || !chunk) {
        return;
      }
      agentSearchProgressCallbacks.get(streamId)?.(chunk);
    }
  );
};

const createAgentSearchStreamId = (): string =>
  `agent-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const workspaceApi = {
  listWorkspaceDirectories: (): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke("workspace-directories:list"),
  upsertWorkspaceDirectory: (
    item: WorkspaceDirectoryInput
  ): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke("workspace-directories:upsert", item),
  activateWorkspaceDirectory: (
    directoryId: string
  ): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke("workspace-directories:activate", directoryId),
  reorderWorkspaceDirectories: (
    items: WorkspaceDirectoryInput[]
  ): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke("workspace-directories:reorder", items),
  deleteWorkspaceDirectory: (
    directoryId: string
  ): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke("workspace-directories:delete", directoryId),
  createWorkspaceProject: (
    parentPath: string,
    projectName: string
  ): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke(
      "workspace-directories:create-project",
      parentPath,
      projectName
    ),
  selectWorkspaceDirectory: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke(
      "workspace-directories:select-local-directory",
      dialogTitle
    ),
  readDirectoryEntries: (dirPath: string): Promise<DirectoryEntry[]> =>
    ipcRenderer.invoke("workspace-directories:read-entries", dirPath),
  renameWorkspaceEntry: (
    rootPath: string,
    entryPath: string,
    newName: string
  ): Promise<void> =>
    ipcRenderer.invoke(
      "workspace-directories:rename-entry",
      rootPath,
      entryPath,
      newName
    ),
  deleteWorkspaceEntry: (rootPath: string, entryPath: string): Promise<void> =>
    ipcRenderer.invoke(
      "workspace-directories:delete-entry",
      rootPath,
      entryPath
    ),
  readFileContent: (filePath: string): Promise<FileContentResult> =>
    ipcRenderer.invoke("workspace-directories:read-file", filePath),
  writeFileContent: (filePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke("workspace-directories:write-file", filePath, content),
  startDirectoryWatch: (dirPath: string): Promise<void> =>
    ipcRenderer.invoke("workspace-directories:start-watch", dirPath),
  stopDirectoryWatch: (dirPath: string): Promise<void> =>
    ipcRenderer.invoke("workspace-directories:stop-watch", dirPath),
  onDirectoryChanged: (callback: (dirPath: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, dirPath: string): void => {
      callback(dirPath);
    };

    ipcRenderer.on("workspace-directories:changed", handler);

    return () => {
      ipcRenderer.removeListener("workspace-directories:changed", handler);
    };
  },
  onWorkspaceDirectoryListChanged: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback();
    };

    ipcRenderer.on("workspace-directory-list:changed", handler);

    return () => {
      ipcRenderer.removeListener("workspace-directory-list:changed", handler);
    };
  },
  searchFiles: (dirPath: string, query: string): Promise<FileSearchResult[]> =>
    ipcRenderer.invoke("workspace-directories:search-files", dirPath, query),
  searchFilesByAgent: (
    query: string,
    workspacePath: string,
    onProgress?: (chunk: FileSearchAgentProgress) => void
  ): Promise<FileSearchResult[]> => {
    const streamId = createAgentSearchStreamId();
    ensureAgentSearchProgressListener();

    if (onProgress) {
      agentSearchProgressCallbacks.set(streamId, onProgress);
    }

    return ipcRenderer
      .invoke(
        "workspace-directories:search-files-by-agent",
        query,
        workspacePath,
        streamId
      )
      .finally(() => {
        agentSearchProgressCallbacks.delete(streamId);
      });
  },
  selectFiles: (
    dialogTitle?: string
  ): Promise<{ path: string; isDirectory: boolean }[] | null> =>
    ipcRenderer.invoke("workspace-directories:select-files", dialogTitle),
};
