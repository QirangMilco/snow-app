import type { ImportProvider, ImportScope } from "./importDiscovery";

export type PluginState = "enabled" | "disabled" | "update-available" | "broken";

export type PluginMarketplaceSourceType = "local" | "github" | "git" | "url";

export type PluginMarketplaceInput = {
  marketplaceId: string;
  name: string;
  displayName: string;
  description: string;
  sourceType: PluginMarketplaceSourceType;
  sourcePath: string;
  refName?: string;
  cachePath?: string;
  manifestPath: string;
  contentHash: string;
};

export type PluginMarketplaceRecord = PluginMarketplaceInput & {
  addedAt: string;
  updatedAt: string;
};

export type PluginMarketplacePlugin = {
  pluginName: string;
  displayName: string;
  description: string;
  version: string;
  category: string;
  tags: string[];
  supported: boolean;
  unsupportedReason?: string;
  installedPluginId?: string;
};

export type PluginMarketplaceCatalog = PluginMarketplaceRecord & {
  plugins: PluginMarketplacePlugin[];
  loadError?: string;
};

export type PluginMarketplaceMcpPreview = {
  componentId: string;
  name: string;
  transportType: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
  url: string;
  declarationPath: string;
  approvalHash: string;
};

export type PluginMarketplaceInstallPreview = {
  marketplaceId: string;
  marketplaceName: string;
  marketplaceSource: string;
  pluginName: string;
  pluginDisplayName: string;
  pluginSource: string;
  mcpServers: PluginMarketplaceMcpPreview[];
};

export type PluginMarketplaceMcpApproval = {
  componentId: string;
  approvalHash: string;
};

export type PluginRuntimePermission = "storage" | "network" | "child-process";

export type PluginRuntimeDeclaration = {
  entry: string;
  permissions: PluginRuntimePermission[];
  timeoutMs: number;
};

export type PluginRuntimeState =
  | "unavailable"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "timed-out"
  | "crashed"
  | "permission-denied"
  | "failed";

export type PluginRuntimeStatus = {
  state: PluginRuntimeState;
  message?: string;
  pid?: number;
  startedAt?: string;
};

export type PluginComponentType =
  | "skill"
  | "mcp"
  | "prompt"
  | "command"
  | "agent"
  | "hook";

export type PluginComponentStatus = "supported" | "unsupported";

export type PluginComponentInput = {
  componentId: string;
  componentType: PluginComponentType;
  logicalId: string;
  targetId: string;
  targetPath: string;
  originPath: string;
  contentHash: string;
  status: PluginComponentStatus;
  unsupportedReason?: string;
  sortOrder: number;
};

export type PluginInput = {
  pluginId: string;
  name: string;
  version: string;
  provider: ImportProvider;
  sourcePath: string;
  manifestPath: string;
  scope: ImportScope;
  projectId?: string;
  state: PluginState;
  capabilities: string[];
  runtime?: PluginRuntimeDeclaration;
  contentHash: string;
  components: PluginComponentInput[];
};

export type PluginComponentRecord = PluginComponentInput & {
  pluginId: string;
};

export type PluginRecord = Omit<PluginInput, "components"> & {
  desiredState: "enabled" | "disabled";
  importedAt: string;
  updatedAt: string;
  components: PluginComponentRecord[];
  runtimeStatus?: PluginRuntimeStatus;
};
