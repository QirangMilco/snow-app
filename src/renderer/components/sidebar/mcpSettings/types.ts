import type {
  McpServerConfigRecord,
  McpToolDefinition,
  ProjectMcpServerConfigRecord,
} from "../../../../preload";

export type McpServerConfig = McpServerConfigRecord;
export type ProjectMcpServerConfig = ProjectMcpServerConfigRecord;
export type McpServerConfigLike = Omit<McpServerConfig, "id">;
export type McpServerTool = McpToolDefinition & { enabled: boolean };

export type McpKeyValuePair = {
  id: string;
  key: string;
  value: string;
};

export type McpStringItem = {
  id: string;
  value: string;
};

export type McpServerDraft = {
  serverId: string;
  name: string;
  transportType: string;
  url: string;
  command: string;
  args: McpStringItem[];
  env: McpKeyValuePair[];
  headers: McpKeyValuePair[];
  enabled: boolean;
  timeoutMs: string;
  sortOrder: number;
  source: string;
};
