import { ipcRenderer } from "electron";
import type {
  CustomHeaderSchemeInput,
  CustomHeaderSchemeRecord,
  HookConfigInput,
  HookConfigRecord,
  HookExecuteInput,
  HookExecuteResult,
  HookScope,
  McpServerConfigInput,
  McpServerConfigRecord,
  ProjectMcpServerConfigRecord,
  ProjectSensitiveCommandConfigInput,
  ProjectSensitiveCommandConfigRecord,
  SensitiveCommandConfigInput,
  SensitiveCommandConfigRecord,
  SubAgentConfigInput,
  SubAgentConfigRecord,
  SystemPromptItemInput,
  SystemPromptItemRecord,
  FeaturePromptRecord,
} from "../types";

export const configApi = {
  listSystemPrompts: (): Promise<SystemPromptItemRecord[]> =>
    ipcRenderer.invoke("system-prompts:list"),
  upsertSystemPrompt: (item: SystemPromptItemInput): Promise<void> =>
    ipcRenderer.invoke("system-prompts:upsert", item),
  deleteSystemPrompt: (promptId: string): Promise<void> =>
    ipcRenderer.invoke("system-prompts:delete", promptId),
  importSnowCliSystemPromptConfig: (): Promise<SystemPromptItemRecord[]> =>
    ipcRenderer.invoke("system-prompts:import-snow-cli"),
  listFeaturePrompts: (): Promise<FeaturePromptRecord[]> =>
    ipcRenderer.invoke("feature-prompts:list"),
  setFeaturePrompt: (
    promptKey: string,
    content: string
  ): Promise<FeaturePromptRecord[]> =>
    ipcRenderer.invoke("feature-prompts:set", promptKey, content),
  resetFeaturePrompt: (promptKey: string): Promise<FeaturePromptRecord[]> =>
    ipcRenderer.invoke("feature-prompts:reset", promptKey),
  listCustomHeaderSchemes: (): Promise<CustomHeaderSchemeRecord[]> =>
    ipcRenderer.invoke("custom-header-schemes:list"),
  upsertCustomHeaderScheme: (
    item: CustomHeaderSchemeInput
  ): Promise<CustomHeaderSchemeRecord[]> =>
    ipcRenderer.invoke("custom-header-schemes:upsert", item),
  deleteCustomHeaderScheme: (
    schemeId: string
  ): Promise<CustomHeaderSchemeRecord[]> =>
    ipcRenderer.invoke("custom-header-schemes:delete", schemeId),
  importSnowCliCustomHeadersConfig: (): Promise<CustomHeaderSchemeRecord[]> =>
    ipcRenderer.invoke("custom-header-schemes:import-snow-cli"),
  listMcpServerConfigs: (): Promise<McpServerConfigRecord[]> =>
    ipcRenderer.invoke("mcp-server-configs:list"),
  upsertMcpServerConfig: (
    item: McpServerConfigInput
  ): Promise<McpServerConfigRecord[]> =>
    ipcRenderer.invoke("mcp-server-configs:upsert", item),
  deleteMcpServerConfig: (serverId: string): Promise<McpServerConfigRecord[]> =>
    ipcRenderer.invoke("mcp-server-configs:delete", serverId),
  importSnowCliMcpConfig: (): Promise<McpServerConfigRecord[]> =>
    ipcRenderer.invoke("mcp-server-configs:import-snow-cli"),
  listProjectMcpServerConfigs: (
    projectId: string
  ): Promise<ProjectMcpServerConfigRecord[]> =>
    ipcRenderer.invoke("project-mcp-server-configs:list", projectId),
  upsertProjectMcpServerConfig: (
    projectId: string,
    item: McpServerConfigInput
  ): Promise<ProjectMcpServerConfigRecord[]> =>
    ipcRenderer.invoke("project-mcp-server-configs:upsert", projectId, item),
  deleteProjectMcpServerConfig: (
    projectId: string,
    serverId: string
  ): Promise<ProjectMcpServerConfigRecord[]> =>
    ipcRenderer.invoke(
      "project-mcp-server-configs:delete",
      projectId,
      serverId
    ),
  listSubAgentConfigs: (projectId?: string): Promise<SubAgentConfigRecord[]> =>
    ipcRenderer.invoke("sub-agent-configs:list", projectId),
  getSubAgentConfig: (
    agentId: string,
    projectId?: string
  ): Promise<SubAgentConfigRecord | null> =>
    ipcRenderer.invoke("sub-agent-configs:get", agentId, projectId),
  upsertSubAgentConfig: (
    projectId: string | undefined,
    item: SubAgentConfigInput
  ): Promise<SubAgentConfigRecord[]> =>
    ipcRenderer.invoke("sub-agent-configs:upsert", projectId, item),
  deleteSubAgentConfig: (
    agentId: string,
    projectId?: string
  ): Promise<SubAgentConfigRecord[]> =>
    ipcRenderer.invoke("sub-agent-configs:delete", agentId, projectId),
  listSensitiveCommandConfigs: (): Promise<SensitiveCommandConfigRecord[]> =>
    ipcRenderer.invoke("sensitive-command-configs:list"),
  upsertSensitiveCommandConfig: (
    item: SensitiveCommandConfigInput
  ): Promise<SensitiveCommandConfigRecord[]> =>
    ipcRenderer.invoke("sensitive-command-configs:upsert", item),
  deleteSensitiveCommandConfig: (
    commandId: string
  ): Promise<SensitiveCommandConfigRecord[]> =>
    ipcRenderer.invoke("sensitive-command-configs:delete", commandId),
  importSnowCliSensitiveCommandConfig: (): Promise<
    SensitiveCommandConfigRecord[]
  > => ipcRenderer.invoke("sensitive-command-configs:import-snow-cli"),
  listProjectSensitiveCommandConfigs: (
    projectId: string
  ): Promise<ProjectSensitiveCommandConfigRecord[]> =>
    ipcRenderer.invoke("project-sensitive-command-configs:list", projectId),
  setProjectSensitiveCommandEnabled: (
    projectId: string,
    commandId: string,
    enabled: boolean
  ): Promise<ProjectSensitiveCommandConfigRecord[]> =>
    ipcRenderer.invoke(
      "project-sensitive-command-configs:set-enabled",
      projectId,
      commandId,
      enabled
    ),
  upsertProjectSensitiveCommandConfig: (
    projectId: string,
    item: ProjectSensitiveCommandConfigInput
  ): Promise<ProjectSensitiveCommandConfigRecord[]> =>
    ipcRenderer.invoke(
      "project-sensitive-command-configs:upsert",
      projectId,
      item
    ),
  deleteProjectSensitiveCommandConfig: (
    projectId: string,
    commandId: string
  ): Promise<ProjectSensitiveCommandConfigRecord[]> =>
    ipcRenderer.invoke(
      "project-sensitive-command-configs:delete",
      projectId,
      commandId
    ),
  checkSensitiveCommandMatch: (
    command: string,
    projectId?: string
  ): Promise<
    Array<{
      commandId: string;
      pattern: string;
      description: string;
    }>
  > =>
    ipcRenderer.invoke(
      "sensitive-command-configs:check-match",
      command,
      projectId
    ),
  listHookConfigs: (
    scope: HookScope,
    projectId?: string
  ): Promise<HookConfigRecord[]> =>
    ipcRenderer.invoke("hook-configs:list", scope, projectId),
  upsertHookConfig: (item: HookConfigInput): Promise<void> =>
    ipcRenderer.invoke("hook-configs:upsert", item),
  deleteHookConfig: (
    hookType: string,
    scope: HookScope,
    projectId?: string
  ): Promise<void> =>
    ipcRenderer.invoke("hook-configs:delete", hookType, scope, projectId),
  executeHooks: (input: HookExecuteInput): Promise<HookExecuteResult> =>
    ipcRenderer.invoke("hooks:execute", input),
};
