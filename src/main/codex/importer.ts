import type { NativeBridge, SystemPromptItemInput } from "../native/types";
import type { ImportSource } from "../../shared/importDiscovery";
import {
  buildImportDiscovery,
  hashImportValue,
  skillLogicalId,
  type ImportCandidateInput,
  type ImportSourceDiscovery,
} from "../importConfig/discovery";
import type { ImportEnvironment } from "../importConfig/importEnvironments";
import {
  buildProviderSource,
  collectSkillDirectoriesForEnvironment,
  hashSkillForEnvironment,
  scanProviderStandalone,
  type EnvironmentDiscoveredSkill,
  type ProviderScannerResult,
} from "../importConfig/providerScanning";
import {
  selectionForInput,
  skillDestination,
  type ResolvedImportAction,
  type SelectedImportCandidate,
} from "../importConfig/selectedImport";
import {
  asStringArray,
  asStringRecord,
  createMcpInput,
  createPrompt,
  nonEmptyString,
  type ImportedMcp,
  type UnsupportedImportedMcp,
} from "../importConfig/utils";
import { isRecord } from "../utils/value";

const SOURCE = "codex" as const;

type ConfigSource = {
  scope: "global" | "project";
  configPath: string;
  values: Record<string, unknown>;
  projectId?: string;
  projectRoot?: string;
  environmentId: string;
  environmentLabel: string;
};

export type CodexImportContext = {
  source: ImportSource;
  mcpServers: ImportedMcp[];
  unsupportedMcpServers: UnsupportedImportedMcp[];
  prompts: SystemPromptItemInput[];
  skills: EnvironmentDiscoveredSkill[];
  scans: ProviderScannerResult[];
};

const parseToml = async (text: string): Promise<Record<string, unknown>> => {
  const { parse } = await import("@iarna/toml");
  const parsed = parse(text);
  return isRecord(parsed) ? parsed : {};
};

const readAgentsPrompt = async (
  environment: ImportEnvironment,
  root: string
): Promise<{ path: string; content: string } | null> => {
  for (const fileName of ["AGENTS.override.md", "AGENTS.md"]) {
    const filePath = environment.fs.join(root, fileName);
    const content = await environment.fs.readText(filePath);
    if (content) {
      return { path: filePath, content };
    }
  }
  return null;
};

const envSegment = (environment: ImportEnvironment): string =>
  environment.kind === "local" ? "" : `:${environment.id.replace(/[^A-Za-z0-9._-]+/g, "-")}`;

const promptId = (
  environment: ImportEnvironment,
  scope: "global" | "project",
  projectId: string | undefined,
  kind: string
): string => {
  const scopePart =
    scope === "global"
      ? `codex:global`
      : `codex:project:${projectId ?? "unknown"}`;
  const segment = envSegment(environment);
  return segment ? `${scopePart}${segment}:${kind}` : `${scopePart}:${kind}`;
};

const collectConfigs = async (
  environment: ImportEnvironment,
  codexHome: string,
  warnings: string[]
): Promise<ConfigSource[]> => {
  const configs: ConfigSource[] = [];
  const globalConfigPath = environment.fs.join(codexHome, "config.toml");
  if (await environment.fs.exists(globalConfigPath)) {
    const text = await environment.fs.readText(globalConfigPath);
    if (text) {
      try {
        configs.push({
          scope: "global",
          configPath: globalConfigPath,
          values: await parseToml(text),
          environmentId: environment.id,
          environmentLabel: environment.label,
        });
      } catch (error) {
        warnings.push(
          `Unable to parse ${globalConfigPath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
  for (const project of environment.projects) {
    const projectRoot = environment.projectRoot(project);
    const configPath = environment.fs.join(projectRoot, ".codex", "config.toml");
    if (!(await environment.fs.exists(configPath))) {
      continue;
    }
    const text = await environment.fs.readText(configPath);
    if (!text) {
      continue;
    }
    try {
      configs.push({
        scope: "project",
        configPath,
        values: await parseToml(text),
        projectId: project.directoryId,
        projectRoot,
        environmentId: environment.id,
        environmentLabel: environment.label,
      });
    } catch (error) {
      warnings.push(
        `Unable to parse ${configPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return configs;
};

const collectMcpServers = (
  environment: ImportEnvironment,
  configs: ConfigSource[],
  warnings: string[]
): { servers: ImportedMcp[]; unsupported: UnsupportedImportedMcp[] } => {
  const servers: ImportedMcp[] = [];
  const unsupported: UnsupportedImportedMcp[] = [];
  for (const config of configs) {
    const declared = isRecord(config.values.mcp_servers)
      ? config.values.mcp_servers
      : {};
    for (const [index, [name, raw]] of Object.entries(declared).entries()) {
      if (!isRecord(raw)) {
        continue;
      }
      const command = nonEmptyString(raw.command) ?? "";
      const url = nonEmptyString(raw.url) ?? "";
      if (!command && !url) {
        continue;
      }
      const idPrefix =
        config.scope === "global"
          ? `codex:global`
          : `codex:project:${config.projectId}`;
      const serverId = `${idPrefix}:${name}`;
      const originPath = config.configPath;
      const timeoutMs =
        typeof raw.startup_timeout_ms === "number"
          ? raw.startup_timeout_ms
          : typeof raw.startup_timeout_sec === "number"
          ? Math.round(raw.startup_timeout_sec * 1000)
          : typeof raw.timeout === "number"
          ? raw.timeout
          : undefined;

      if (command) {
        const adaptation = environment.adaptStdioMcp(
          command,
          asStringArray(raw.args)
        );
        if ("unsupportedReason" in adaptation) {
          unsupported.push({
            name,
            scope: config.scope,
            ...(config.projectId ? { projectId: config.projectId } : {}),
            reason: adaptation.unsupportedReason,
            originPath,
            environmentId: environment.id,
            environmentLabel: environment.label,
          });
          continue;
        }
        const input = createMcpInput({
          serverId,
          name,
          source: SOURCE,
          sortOrder: index,
          transportType: "stdio",
          command: adaptation.command,
          args: adaptation.args,
          env: asStringRecord(raw.env),
          enabled: raw.enabled,
          timeoutMs,
        });
        if (input) {
          servers.push({
            scope: config.scope,
            ...(config.projectId ? { projectId: config.projectId } : {}),
            input,
            originPath,
            environmentId: environment.id,
            environmentLabel: environment.label,
          });
          continue;
        }
      } else {
        const input = createMcpInput({
          serverId,
          name,
          source: SOURCE,
          sortOrder: index,
          transportType: "http",
          url,
          headers: asStringRecord(raw.http_headers ?? raw.headers),
          enabled: raw.enabled,
          timeoutMs,
        });
        if (input) {
          servers.push({
            scope: config.scope,
            ...(config.projectId ? { projectId: config.projectId } : {}),
            input,
            originPath,
            environmentId: environment.id,
            environmentLabel: environment.label,
          });
          continue;
        }
      }
      warnings.push(`Skipping Codex MCP server ${name}: incomplete configuration`);
    }
  }
  return { servers, unsupported };
};

const collectPrompts = async (
  environment: ImportEnvironment,
  codexHome: string,
  configs: ConfigSource[],
  warnings: string[]
): Promise<SystemPromptItemInput[]> => {
  const prompts = new Map<string, SystemPromptItemInput>();
  let order = 0;
  const add = (
    id: string,
    name: string,
    content: string,
    scope: "global" | "project",
    projectId?: string,
    isActive = true
  ): void => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const prompt = createPrompt(id, name, trimmed, order++);
    if (prompt) {
      prompts.set(id, {
        ...prompt,
        isActive,
        scope,
        ...(scope === "project" && projectId ? { projectId } : {}),
      });
    }
  };

  const globalAgents = await readAgentsPrompt(environment, codexHome);
  if (globalAgents) {
    add(
      promptId(environment, "global", undefined, "agents"),
      `Codex AGENTS.md (${environment.label})`,
      globalAgents.content,
      "global"
    );
  }

  const collectConfigPrompts = async (
    config: ConfigSource,
    values: Record<string, unknown>,
    idFor: (kind: string) => string,
    labelSuffix: string
  ): Promise<void> => {
    const labels: Array<[string, string, string]> = [
      ["instructions", "Codex instructions", "instructions"],
      ["developer_instructions", "Codex developer instructions", "developer-instructions"],
      ["compact_prompt", "Codex compact prompt", "compact-prompt"],
    ];
    for (const [key, name, idPart] of labels) {
      const value = nonEmptyString(values[key]);
      if (value) add(idFor(idPart), name + labelSuffix, value, config.scope, config.projectId);
    }
    const filePrompts: Array<[string, string, string]> = [
      ["model_instructions_file", "Codex model instructions", "model-instructions"],
      ["experimental_compact_prompt_file", "Codex compact prompt file", "compact-prompt-file"],
    ];
    for (const [key, name, idPart] of filePrompts) {
      const declaredPath = nonEmptyString(values[key]);
      if (!declaredPath) continue;
      const filePath = environment.fs.resolveDeclared(
        environment.fs.dirname(config.configPath),
        declaredPath
      );
      const content = await environment.fs.readText(filePath);
      if (content) {
        add(idFor(idPart), name + labelSuffix, content, config.scope, config.projectId);
      } else {
        warnings.push(`Unable to read Codex prompt file ${filePath}`);
      }
    }
  };

  for (const config of configs) {
    const suffix =
      config.scope === "global"
        ? ` (${environment.label})`
        : ` (${config.projectId ?? "unknown"} · ${environment.label})`;
    await collectConfigPrompts(
      config,
      config.values,
      (kind) => promptId(environment, config.scope, config.projectId, kind),
      suffix
    );
    const profiles = isRecord(config.values.profiles) ? config.values.profiles : {};
    for (const [profileName, rawProfile] of Object.entries(profiles)) {
      if (!isRecord(rawProfile)) continue;
      await collectConfigPrompts(
        config,
        rawProfile,
        (kind) =>
          promptId(
            environment,
            config.scope,
            config.projectId,
            `profile:${profileName}:${kind}`
          ),
        `${suffix} [${profileName}]`
      );
    }
    if (config.projectRoot) {
      const agents = await readAgentsPrompt(environment, config.projectRoot);
      if (agents) {
        add(
          promptId(environment, config.scope, config.projectId, "agents"),
          `Codex AGENTS.md (${config.projectId ?? "unknown"} · ${environment.label})`,
          agents.content,
          config.scope,
          config.projectId
        );
      }
    }
  }

  const configuredProjectIds = new Set(
    configs
      .filter((config) => config.scope === "project" && config.projectId)
      .map((config) => config.projectId as string)
  );
  for (const project of environment.projects) {
    if (configuredProjectIds.has(project.directoryId)) continue;
    const projectRoot = environment.projectRoot(project);
    const agents = await readAgentsPrompt(environment, projectRoot);
    if (agents) {
      add(
        promptId(environment, "project", project.directoryId, "agents"),
        `Codex AGENTS.md (${project.directoryId} · ${environment.label})`,
        agents.content,
        "project",
        project.directoryId
      );
    }
  }
  return [...prompts.values()];
};

const collectSkills = async (
  environment: ImportEnvironment,
  codexHome: string
): Promise<EnvironmentDiscoveredSkill[]> => {
  const skills: EnvironmentDiscoveredSkill[] = [];
  const sourcePaths = new Set<string>();
  const addSkill = (
    sourceDir: string,
    scope: "global" | "project",
    projectId?: string,
    projectRoot?: string
  ): void => {
    if (sourcePaths.has(sourceDir)) return;
    sourcePaths.add(sourceDir);
    skills.push({
      sourceDir,
      scope,
      ...(projectId ? { projectId } : {}),
      ...(projectRoot ? { projectRoot } : {}),
      environmentId: environment.id,
      environmentLabel: environment.label,
      contentHash: "",
      ...(environment.sshWorkspaceUrl
        ? { sshWorkspaceUrl: environment.sshWorkspaceUrl }
        : {}),
    });
  };

  const tasks: Array<{
    sourceRoot: string;
    scope: "global" | "project";
    projectId?: string;
    projectRoot?: string;
  }> = [
    { sourceRoot: environment.fs.join(codexHome, "skills"), scope: "global" },
  ];
  if (environment.home) {
    tasks.push({
      sourceRoot: environment.fs.join(environment.home, ".agents", "skills"),
      scope: "global",
    });
  }
  for (const project of environment.projects) {
    const projectRoot = environment.projectRoot(project);
    tasks.push({
      sourceRoot: environment.fs.join(projectRoot, ".codex", "skills"),
      scope: "project",
      projectId: project.directoryId,
      projectRoot,
    });
    tasks.push({
      sourceRoot: environment.fs.join(projectRoot, ".agents", "skills"),
      scope: "project",
      projectId: project.directoryId,
      projectRoot,
    });
  }
  const results = await Promise.all(
    tasks.map(async (task) => ({
      task,
      skillDirs: (await environment.fs.exists(task.sourceRoot))
        ? await collectSkillDirectoriesForEnvironment(environment, task.sourceRoot)
        : [],
    }))
  );
  for (const { task, skillDirs } of results) {
    for (const skillDir of skillDirs) {
      addSkill(skillDir, task.scope, task.projectId, task.projectRoot);
    }
  }
  // Hash skills after collecting them so each walk only runs once.
  for (const skill of skills) {
    skill.contentHash = await hashSkillForEnvironment(environment, skill.sourceDir);
  }
  return skills;
};

const scanCodexEnvironment = async (
  environment: ImportEnvironment,
  warnings: string[]
): Promise<ProviderScannerResult> => {
  const codexHome = environment.fs.join(environment.home, ".codex");
  const envWarnings = [...environment.warnings];
  const configs = await collectConfigs(environment, codexHome, envWarnings);
  const { servers, unsupported } = collectMcpServers(environment, configs, envWarnings);
  const prompts = await collectPrompts(environment, codexHome, configs, envWarnings);
  const skills = await collectSkills(environment, codexHome);

  const configPath = environment.fs.join(codexHome, "config.toml");
  const configPaths = [
    { label: "config.toml", path: configPath, found: await environment.fs.exists(configPath) },
  ];
  const globalAgents = await readAgentsPrompt(environment, codexHome);
  const instructionPaths = globalAgents
    ? [{ label: "AGENTS.md", path: globalAgents.path, found: true }]
    : [];

  warnings.push(...envWarnings);
  return {
    environment,
    home: codexHome,
    found: await environment.fs.exists(codexHome),
    configPaths,
    instructionPaths,
    projectConfigCount: configs.filter((config) => config.scope === "project").length,
    mcpServers: servers,
    unsupportedMcpServers: unsupported,
    prompts,
    skills,
  };
};

const buildCodexSourceFromScans = (
  scans: ProviderScannerResult[],
  warnings: string[]
): ImportSource => buildProviderSource(scans, "codex", warnings);

const buildContextFromScans = (
  scans: ProviderScannerResult[],
  warnings: string[]
): CodexImportContext => {
  const mcpServers: ImportedMcp[] = [];
  const unsupportedMcpServers: UnsupportedImportedMcp[] = [];
  const prompts: SystemPromptItemInput[] = [];
  const skills: EnvironmentDiscoveredSkill[] = [];
  for (const scan of scans) {
    mcpServers.push(...scan.mcpServers);
    unsupportedMcpServers.push(...scan.unsupportedMcpServers);
    prompts.push(...scan.prompts);
    skills.push(...scan.skills);
  }
  return {
    source: buildCodexSourceFromScans(scans, warnings),
    mcpServers,
    unsupportedMcpServers,
    prompts,
    skills,
    scans,
  };
};

export const buildCodexContext = async (
  native: NativeBridge,
  activeDirectoryId?: string
): Promise<CodexImportContext> => {
  const { scans, warnings } = await scanProviderStandalone(native, scanCodexEnvironment, activeDirectoryId);
  return buildContextFromScans(scans, warnings);
};

const mcpCandidateFromServer = (server: ImportedMcp, originHome: string): ImportCandidateInput => ({
  type: "mcp",
  provider: SOURCE,
  scope: server.scope,
  originPath: server.originPath ?? originHome,
  logicalId: server.input.name,
  contentHash: hashImportValue({
    transportType: server.input.transportType,
    url: server.input.url,
    command: server.input.command,
    argsJson: server.input.argsJson,
    envJson: server.input.envJson,
    headersJson: server.input.headersJson,
  }),
  ...(server.projectId ? { projectId: server.projectId } : {}),
  environmentId: server.environmentId,
  environmentLabel: server.environmentLabel,
});

const mcpCandidateFromUnsupported = (
  unsupported: UnsupportedImportedMcp
): ImportCandidateInput => ({
  type: "mcp",
  provider: SOURCE,
  scope: unsupported.scope,
  originPath: unsupported.originPath,
  logicalId: unsupported.name,
  contentHash: hashImportValue({
    unsupported: unsupported.reason,
    name: unsupported.name,
  }),
  ...(unsupported.projectId ? { projectId: unsupported.projectId } : {}),
  unsupportedReason: unsupported.reason,
  environmentId: unsupported.environmentId,
  environmentLabel: unsupported.environmentLabel,
});

const promptCandidateFromPrompt = (
  prompt: SystemPromptItemInput,
  scan: ProviderScannerResult
): ImportCandidateInput => ({
  type: "prompt",
  provider: SOURCE,
  scope: prompt.scope ?? "global",
  originPath: scan.home,
  logicalId: prompt.promptId,
  contentHash: hashImportValue(prompt.content),
  ...(prompt.projectId ? { projectId: prompt.projectId } : {}),
  environmentId: scan.environment.id,
  environmentLabel: scan.environment.label,
});

const skillCandidateFromSkill = (skill: EnvironmentDiscoveredSkill): ImportCandidateInput => ({
  type: "skill",
  provider: SOURCE,
  scope: skill.scope,
  originPath: skill.sourceDir,
  logicalId: skillLogicalId(skill.sourceDir),
  contentHash: skill.contentHash,
  ...(skill.projectId ? { projectId: skill.projectId } : {}),
  ...(skill.projectRoot ? { projectRoot: skill.projectRoot } : {}),
  environmentId: skill.environmentId,
  environmentLabel: skill.environmentLabel,
});

export const discoverCodexImportFromContext = async (
  context: CodexImportContext
): Promise<ImportSourceDiscovery> => ({
  source: context.source,
  candidates: [
    ...context.mcpServers.map((server) =>
      mcpCandidateFromServer(server, context.source.sourceHome)
    ),
    ...context.unsupportedMcpServers.map(mcpCandidateFromUnsupported),
    ...context.scans.flatMap((scan) =>
      scan.prompts.map((prompt) => promptCandidateFromPrompt(prompt, scan))
    ),
    ...context.skills.map(skillCandidateFromSkill),
  ],
});

export const discoverCodexImport = async (
  native: NativeBridge
): Promise<ImportSourceDiscovery> =>
  discoverCodexImportFromContext(await buildCodexContext(native));

export const resolveCodexSelectedImports = async (
  native: NativeBridge,
  selected: SelectedImportCandidate[],
  context?: CodexImportContext
): Promise<{ actions: ResolvedImportAction[]; warnings: string[] }> => {
  const ctx = context ?? (await buildCodexContext(native));
  const actions: ResolvedImportAction[] = [];

  for (const server of ctx.mcpServers) {
    const input = mcpCandidateFromServer(server, ctx.source.sourceHome);
    const candidate = selectionForInput(input, selected);
    if (candidate) {
      actions.push({
        candidate,
        scope: server.scope,
        ...(server.projectId ? { projectId: server.projectId } : {}),
        mcpInput: server.input,
      });
    }
  }

  for (const prompt of ctx.prompts) {
    const input: ImportCandidateInput = {
      type: "prompt",
      provider: SOURCE,
      scope: prompt.scope ?? "global",
      originPath: ctx.source.sourceHome,
      logicalId: prompt.promptId,
      contentHash: hashImportValue(prompt.content),
      ...(prompt.projectId ? { projectId: prompt.projectId } : {}),
    };
    const candidate = selectionForInput(input, selected);
    if (candidate) {
      actions.push({
        candidate,
        scope: input.scope,
        ...(prompt.projectId ? { projectId: prompt.projectId } : {}),
        promptInput: prompt,
      });
    }
  }

  for (const skill of ctx.skills) {
    const input = skillCandidateFromSkill(skill);
    const candidate = selectionForInput(input, selected);
    if (candidate) {
      actions.push({
        candidate,
        scope: skill.scope,
        ...(skill.projectId ? { projectId: skill.projectId } : {}),
        skill: {
          sourceDir: skill.sourceDir,
          destinationDir: skillDestination(
            SOURCE,
            skill.sourceDir,
            skill.scope,
            skill.projectRoot
          ),
          ...(skill.sshWorkspaceUrl ? { sshWorkspaceUrl: skill.sshWorkspaceUrl } : {}),
        },
      });
    }
  }

  return { actions, warnings: ctx.source.warnings };
};

export const previewCodexImport = async (
  native: NativeBridge
): Promise<ReturnType<typeof buildImportDiscovery>> =>
  buildImportDiscovery([await discoverCodexImport(native)]);

export const importCodex = async (
  native: NativeBridge
): Promise<{ applied: false } & ReturnType<typeof buildImportDiscovery>> => ({
  ...(await previewCodexImport(native)),
  applied: false,
});
