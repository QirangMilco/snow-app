export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchemaJson: string;
};

export type McpToolStatus = McpToolDefinition & {
  enabled: boolean;
};

export type SkillDefinition = {
  id: string;
  name: string;
  description: string;
  location: "project" | "global";
  source: "snow" | "agents";
  path: string;
  allowedTools?: string[];
  enabled: boolean;
};

export type ProjectSkillDefinition = Omit<SkillDefinition, "enabled"> & {
  defaultEnabled: boolean;
  enabled: boolean;
};

export type SkillInstallResult = {
  success: boolean;
  skillId: string;
  path: string;
  installedAt: string;
  commitSha?: string;
  error?: string;
};

export type SkillBatchInstallResult = {
  success: boolean;
  results: SkillInstallResult[];
  installedCount: number;
  totalCount: number;
  commitSha?: string;
  error?: string;
};

export type GithubSkillRecord = {
  id: string;
  name: string;
  description: string;
  location: string;
  sourceUrl: string;
  installedAt: string;
  commitSha?: string;
};

export type SkillUninstallResult = {
  success: boolean;
  skillId: string;
  message: string;
  error?: string;
};

export type McpProjectToolStatus = McpToolDefinition & {
  enabled: boolean;
};

export type McpProjectServerStatus = {
  id: string;
  name: string;
  source: "system" | "external" | "project";
  globalEnabled: boolean;
  enabled: boolean;
  tools: McpProjectToolStatus[];
  error?: string;
};
export type BashStreamChunk = {
  stream:
    | "stdout"
    | "stderr"
    | "interactive_session"
    | "tool_execution"
    | "imagegen";
  data: string;
};

export type BrowserCommandRequest = {
  commandId: string;
  operation: string;
  argsJson: string;
};

export type BrowserCommandResponse = {
  commandId: string;
  resultJson?: string;
  error?: string;
};

export type TerminalCommandRequest = {
  commandId: string;
  operation: string;
  argsJson: string;
};

export type TerminalCommandResponse = {
  commandId: string;
  resultJson?: string;
  error?: string;
};

export type UserQuestionRequest = {
  questionId: string;
  interactionId: string;
  question: string;
  options: string[];
};

export type UserQuestionResponse = {
  questionId: string;
  resultJson?: string;
  error?: string;
};

export type McpServerConfigInput = {
  serverId: string;
  name: string;
  transportType: string;
  url: string;
  command: string;
  argsJson: string;
  envJson: string;
  headersJson: string;
  enabled: boolean;
  timeoutMs?: number;
  sortOrder: number;
  source: string;
};

export type McpServerConfigRecord = Omit<McpServerConfigInput, "timeoutMs"> & {
  id: string;
  timeoutMs: number | null;
  updatedAt: string;
};

export type ProjectMcpServerConfigRecord = Omit<
  McpServerConfigInput,
  "timeoutMs"
> & {
  timeoutMs: number | null;
  updatedAt: string;
};
