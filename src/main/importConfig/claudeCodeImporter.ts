import type { NativeBridge, SystemPromptItemInput } from "../native/types";
import type { ImportSource } from "../../shared/importDiscovery";
import {
  buildImportDiscovery,
  hashImportValue,
  skillLogicalId,
  type ImportCandidateInput,
  type ImportSourceDiscovery,
} from "./discovery";
import type { ImportEnvironment } from "./importEnvironments";
import {
  buildProviderSource,
  collectSkillDirectoriesForEnvironment,
  hashSkillForEnvironment,
  scanProviderStandalone,
  type EnvironmentDiscoveredSkill,
  type ProviderScannerResult,
} from "./providerScanning";
import {
  selectionForInput,
  skillDestination,
  type ResolvedImportAction,
  type SelectedImportCandidate,
} from "./selectedImport";
import {
  asStringArray,
  asStringRecord,
  createMcpInput,
  createPrompt,
  nonEmptyString,
  safeSegment,
  uniquePaths,
  type ImportedMcp,
  type UnsupportedImportedMcp,
} from "./utils";
import { isRecord } from "../utils/value";

const SOURCE = "claude-code" as const;

type ConfigSource = {
  scope: "global" | "project";
  path: string;
  values: Record<string, unknown>;
  projectId?: string;
  projectRoot?: string;
  environmentId: string;
  environmentLabel: string;
};

export type ClaudeCodeImportContext = {
  source: ImportSource;
  mcpServers: ImportedMcp[];
  unsupportedMcpServers: UnsupportedImportedMcp[];
  prompts: SystemPromptItemInput[];
  skills: EnvironmentDiscoveredSkill[];
  scans: ProviderScannerResult[];
};

const envSegment = (environment: ImportEnvironment): string =>
  environment.kind === "local" ? "" : `:${environment.id.replace(/[^A-Za-z0-9._-]+/g, "-")}`;

const readJson = async (
  environment: ImportEnvironment,
  filePath: string,
  warnings: string[]
): Promise<Record<string, unknown> | null> => {
  if (!(await environment.fs.exists(filePath))) {
    return null;
  }
  const text = await environment.fs.readText(filePath);
  if (text === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      return parsed;
    }
    warnings.push("Ignoring non-object configuration file: " + filePath);
    return null;
  } catch (error) {
    warnings.push(
      `Unable to parse ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
};

const expandEnvironment = (
  value: string,
  label: string,
  warnings: string[]
): string =>
  value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g,
    (_match, name, _defaultPart, defaultValue) => {
      const replacement = process.env[name] ?? defaultValue;
      if (replacement === undefined) {
        warnings.push(`${label} references missing environment variable ${name}`);
        return "";
      }
      return replacement;
    }
  );

const expandStringRecord = (
  record: Record<string, string>,
  label: string,
  warnings: string[]
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      expandEnvironment(value, `${label} field ${key}`, warnings),
    ])
  );

const toMcpServer = (
  environment: ImportEnvironment,
  name: string,
  raw: unknown,
  serverId: string,
  scope: "global" | "project",
  projectId: string | undefined,
  sortOrder: number,
  warnings: string[]
): ImportedMcp | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const type = nonEmptyString(raw.type) ?? "stdio";
  if (type === "ws") {
    warnings.push(
      `Skipping Claude Code WebSocket MCP server ${name}: Snow App supports stdio and HTTP only`
    );
    return null;
  }
  if (type === "sse") {
    warnings.push(
      `Skipping Claude Code SSE MCP server ${name}: Snow App supports streamable HTTP only`
    );
    return null;
  }
  if (type !== "stdio" && type !== "http" && type !== "streamable-http") {
    warnings.push(
      `Skipping Claude Code MCP server ${name}: unsupported transport ${type}`
    );
    return null;
  }
  if (nonEmptyString(raw.headersHelper)) {
    warnings.push(
      `Claude Code MCP server ${name} uses headersHelper, which Snow App cannot import`
    );
  }
  const transportType = type === "stdio" ? "stdio" : "http";

  if (transportType === "stdio") {
    const command = expandEnvironment(
      typeof raw.command === "string" ? raw.command : "",
      `Claude Code MCP server ${name} command`,
      warnings
    );
    const args = asStringArray(raw.args).map((argument) =>
      expandEnvironment(argument, `Claude Code MCP server ${name} argument`, warnings)
    );
    const adaptation = environment.adaptStdioMcp(command, args);
    if ("unsupportedReason" in adaptation) {
      return null;
    }
    const input = createMcpInput({
      serverId,
      name,
      source: SOURCE,
      sortOrder,
      transportType,
      command: adaptation.command,
      args: adaptation.args,
      env: expandStringRecord(
        asStringRecord(raw.env),
        `Claude Code MCP server ${name} environment`,
        warnings
      ),
      enabled: raw.enabled,
      timeoutMs: typeof raw.timeout === "number" ? raw.timeout : undefined,
    });
    return input ? { scope, projectId, input, environmentId: environment.id, environmentLabel: environment.label } : null;
  }

  const input = createMcpInput({
    serverId,
    name,
    source: SOURCE,
    sortOrder,
    transportType,
    url:
      typeof raw.url === "string"
        ? expandEnvironment(raw.url, `Claude Code MCP server ${name} URL`, warnings)
        : "",
    headers: expandStringRecord(
      asStringRecord(raw.headers),
      `Claude Code MCP server ${name} header`,
      warnings
    ),
    enabled: raw.enabled,
    timeoutMs: typeof raw.timeout === "number" ? raw.timeout : undefined,
  });
  return input ? { scope, projectId, input, environmentId: environment.id, environmentLabel: environment.label } : null;
};

/**
 * Build an UnsupportedImportedMcp for an SSH environment where the stdio
 * command cannot be run locally.
 */
const toUnsupportedMcp = (
  environment: ImportEnvironment,
  name: string,
  raw: unknown,
  scope: "global" | "project",
  projectId: string | undefined,
  originPath: string
): UnsupportedImportedMcp | null => {
  if (!isRecord(raw)) return null;
  const type = nonEmptyString(raw.type) ?? "stdio";
  if (type !== "stdio") return null;
  const command = nonEmptyString(raw.command);
  if (!command) return null;
  return {
    name,
    scope,
    ...(projectId ? { projectId } : {}),
    reason: "Stdio MCP commands declared on an SSH remote host cannot run locally",
    originPath,
    environmentId: environment.id,
    environmentLabel: environment.label,
  };
};

const collectProjectSources = async (
  environment: ImportEnvironment,
  warnings: string[]
): Promise<ConfigSource[]> => {
  const sources: ConfigSource[] = [];
  for (const project of environment.projects) {
    const projectRoot = environment.projectRoot(project);
    const path = environment.fs.join(projectRoot, ".mcp.json");
    const values = await readJson(environment, path, warnings);
    if (values) {
      sources.push({
        scope: "project",
        path,
        values,
        projectId: project.directoryId,
        projectRoot,
        environmentId: environment.id,
        environmentLabel: environment.label,
      });
    }
  }
  return sources;
};

const collectMcpServers = (
  environment: ImportEnvironment,
  sources: ConfigSource[],
  warnings: string[]
): { servers: ImportedMcp[]; unsupported: UnsupportedImportedMcp[] } => {
  const servers = new Map<string, ImportedMcp>();
  const unsupported: UnsupportedImportedMcp[] = [];
  for (const source of sources) {
    const declared = isRecord(source.values.mcpServers) ? source.values.mcpServers : null;
    if (!declared) continue;
    for (const [index, [name, raw]] of Object.entries(declared).entries()) {
      const id =
        source.scope === "global"
          ? `${SOURCE}:global${envSegment(environment)}:${name}`
          : `${SOURCE}:project:${source.projectId}${envSegment(environment)}:${name}`;
      if (environment.kind === "ssh") {
        const unsupportedEntry = toUnsupportedMcp(
          environment,
          name,
          raw,
          source.scope,
          source.projectId,
          source.path
        );
        if (unsupportedEntry) {
          unsupported.push(unsupportedEntry);
          continue;
        }
      }
      const server = toMcpServer(
        environment,
        name,
        raw,
        id,
        source.scope,
        source.projectId,
        index,
        warnings
      );
      if (server) {
        servers.set(id, server);
      }
    }
  }
  return { servers: [...servers.values()], unsupported };
};

const collectPrompts = async (
  environment: ImportEnvironment,
  claudeHome: string,
  warnings: string[]
): Promise<{ prompts: SystemPromptItemInput[]; instructionPaths: string[] }> => {
  const prompts = new Map<string, SystemPromptItemInput>();
  const instructionPaths: string[] = [];
  const addFile = async (
    id: string,
    name: string,
    path: string,
    scope: "global" | "project",
    projectId?: string,
    isActive = true
  ): Promise<void> => {
    const content = await environment.fs.readText(path);
    if (content) {
      instructionPaths.push(path);
      const prompt = createPrompt(id, name, content, prompts.size);
      if (prompt) {
        prompts.set(id, {
          ...prompt,
          isActive,
          scope,
          ...(scope === "project" && projectId ? { projectId } : {}),
        });
      }
    }
  };

  const envSuffix = environment.kind === "local" ? "" : ` (${environment.label})`;

  await addFile(
    `${SOURCE}:global${envSegment(environment)}:claude-md`,
    `Claude Code CLAUDE.md${envSuffix}`,
    environment.fs.join(claudeHome, "CLAUDE.md"),
    "global"
  );

  const rulesRoot = environment.fs.join(claudeHome, "rules");
  if (await environment.fs.exists(rulesRoot)) {
    for (const path of await environment.fs.walkFiles(rulesRoot)) {
      if (!path.endsWith(".md")) continue;
      await addFile(
        `${SOURCE}:global${envSegment(environment)}:rule:${safeSegment(path)}`,
        `Claude Code rule${envSuffix}`,
        path,
        "global"
      );
    }
  }

  const commandsRoot = environment.fs.join(claudeHome, "commands");
  if (await environment.fs.exists(commandsRoot)) {
    for (const path of await environment.fs.walkFiles(commandsRoot)) {
      if (!path.endsWith(".md")) continue;
      await addFile(
        `${SOURCE}:global${envSegment(environment)}:command:${safeSegment(path)}`,
        `Claude Code command${envSuffix}`,
        path,
        "global",
        undefined,
        false
      );
    }
  }

  const walkedPrompts = await Promise.all(
    environment.projects.map(async (project) => {
      const projectRoot = environment.projectRoot(project);
      const tasks: Array<{ kind: string; root: string }> = [
        { kind: "rule", root: environment.fs.join(projectRoot, ".claude", "rules") },
        { kind: "command", root: environment.fs.join(projectRoot, ".claude", "commands") },
      ];
      const results = await Promise.all(
        tasks.map(async (task) => ({
          task,
          paths: (await environment.fs.exists(task.root))
            ? await environment.fs.walkFiles(task.root)
            : [],
        }))
      );
      return { project, results };
    })
  );

  for (const { project, results } of walkedPrompts) {
    const projectRoot = environment.projectRoot(project);
    await addFile(
      `${SOURCE}:project:${project.directoryId}${envSegment(environment)}:claude-md`,
      `Claude Code CLAUDE.md (${project.directoryId}${envSuffix})`,
      environment.fs.join(projectRoot, "CLAUDE.md"),
      "project",
      project.directoryId
    );
    await addFile(
      `${SOURCE}:project:${project.directoryId}${envSegment(environment)}:claude-dir-md`,
      `Claude Code .claude/CLAUDE.md (${project.directoryId}${envSuffix})`,
      environment.fs.join(projectRoot, ".claude", "CLAUDE.md"),
      "project",
      project.directoryId
    );
    for (const { task, paths } of results) {
      for (const path of paths) {
        if (!path.endsWith(".md")) continue;
        await addFile(
          `${SOURCE}:project:${project.directoryId}${envSegment(environment)}:${task.kind}:${safeSegment(path)}`,
          `Claude Code ${task.kind}${envSuffix}`,
          path,
          "project",
          project.directoryId,
          task.kind !== "command"
        );
      }
    }
  }

  return { prompts: [...prompts.values()], instructionPaths: uniquePaths(instructionPaths) };
};

const collectSkills = async (
  environment: ImportEnvironment,
  claudeHome: string
): Promise<EnvironmentDiscoveredSkill[]> => {
  const skills: EnvironmentDiscoveredSkill[] = [];
  const sourcePaths = new Set<string>();
  const tasks: Array<{
    sourceRoot: string;
    scope: "global" | "project";
    project?: { directoryId: string; path: string };
  }> = [
    { sourceRoot: environment.fs.join(claudeHome, "skills"), scope: "global" },
    ...environment.projects.map((project) => ({
      sourceRoot: environment.fs.join(environment.projectRoot(project), ".claude", "skills"),
      scope: "project" as const,
      project: { directoryId: project.directoryId, path: project.path },
    })),
  ];
  const results = await Promise.all(
    tasks.map(async (task) => ({
      task,
      skillDirs: (await environment.fs.exists(task.sourceRoot))
        ? await collectSkillDirectoriesForEnvironment(environment, task.sourceRoot)
        : [],
    }))
  );
  for (const { task, skillDirs } of results) {
    for (const sourceDir of skillDirs) {
      if (sourcePaths.has(sourceDir)) continue;
      sourcePaths.add(sourceDir);
      skills.push({
        sourceDir,
        scope: task.scope,
        ...(task.project
          ? { projectId: task.project.directoryId, projectRoot: task.project.path }
          : {}),
        environmentId: environment.id,
        environmentLabel: environment.label,
        contentHash: "",
        ...(environment.sshWorkspaceUrl
          ? { sshWorkspaceUrl: environment.sshWorkspaceUrl }
          : {}),
      });
    }
  }
  for (const skill of skills) {
    skill.contentHash = await hashSkillForEnvironment(environment, skill.sourceDir);
  }
  return skills;
};

const scanClaudeCodeEnvironment = async (
  environment: ImportEnvironment,
  warnings: string[]
): Promise<ProviderScannerResult> => {
  const claudeHome = environment.fs.join(environment.home, ".claude");
  const envWarnings = [...environment.warnings];
  // Claude Code keeps the global `.claude.json` in the user home, not inside
  // `.claude`. For non-local environments we read it from the same home.
  const claudeJsonPath = environment.fs.join(environment.home, ".claude.json");
  const claudeJson = await readJson(environment, claudeJsonPath, envWarnings);

  const projectSources = await collectProjectSources(environment, envWarnings);
  const sources: ConfigSource[] = [
    ...(claudeJson
      ? [{
          scope: "global" as const,
          path: claudeJsonPath,
          values: claudeJson,
          environmentId: environment.id,
          environmentLabel: environment.label,
        }]
      : []),
    ...projectSources,
  ];
  // Match `.claude.json` projects section against registered projects.
  if (claudeJson) {
    const configuredProjects = isRecord(claudeJson.projects) ? claudeJson.projects : {};
    for (const project of environment.projects) {
      const projectRoot = environment.projectRoot(project);
      const config = Object.entries(configuredProjects).find(([path]) =>
        environment.projectMatches(project, path)
      )?.[1];
      if (isRecord(config)) {
        sources.push({
          scope: "project",
          path: claudeJsonPath,
          values: config,
          projectId: project.directoryId,
          projectRoot,
          environmentId: environment.id,
          environmentLabel: environment.label,
        });
      }
    }
  }

  const { servers, unsupported } = collectMcpServers(environment, sources, envWarnings);
  const { prompts, instructionPaths } = await collectPrompts(environment, claudeHome, envWarnings);
  const skills = await collectSkills(environment, claudeHome);

  const configPaths = [
    { label: "User configuration", path: claudeJsonPath, found: await environment.fs.exists(claudeJsonPath) },
    { label: "User settings", path: environment.fs.join(claudeHome, "settings.json"), found: await environment.fs.exists(environment.fs.join(claudeHome, "settings.json")) },
  ];
  const found = (await environment.fs.exists(claudeHome)) || (await environment.fs.exists(claudeJsonPath));
  if (!found) {
    envWarnings.push(`Claude Code configuration not found: ${claudeHome}`);
  }
  warnings.push(...envWarnings);
  return {
    environment,
    home: claudeHome,
    found,
    configPaths,
    instructionPaths: instructionPaths.map((path) => ({ label: "Imported instruction", path, found: true })),
    projectConfigCount: sources.filter((source) => source.scope === "project").length,
    mcpServers: servers,
    unsupportedMcpServers: unsupported,
    prompts,
    skills,
  };
};

const buildContextFromScans = (
  scans: ProviderScannerResult[],
  warnings: string[]
): ClaudeCodeImportContext => {
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
    source: buildProviderSource(scans, SOURCE, warnings),
    mcpServers,
    unsupportedMcpServers,
    prompts,
    skills,
    scans,
  };
};

export const buildClaudeCodeContext = async (
  native: NativeBridge,
  activeDirectoryId?: string
): Promise<ClaudeCodeImportContext> => {
  const { scans, warnings } = await scanProviderStandalone(native, scanClaudeCodeEnvironment, activeDirectoryId);
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
  type: prompt.promptId.includes(":command:") ? "command" : "prompt",
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

export const discoverClaudeCodeImportFromContext = async (
  context: ClaudeCodeImportContext
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

export const discoverClaudeCodeImport = async (
  native: NativeBridge
): Promise<ImportSourceDiscovery> =>
  discoverClaudeCodeImportFromContext(await buildClaudeCodeContext(native));

export const resolveClaudeCodeSelectedImports = async (
  native: NativeBridge,
  selected: SelectedImportCandidate[],
  context?: ClaudeCodeImportContext
): Promise<{ actions: ResolvedImportAction[]; warnings: string[] }> => {
  const ctx = context ?? (await buildClaudeCodeContext(native));
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
    const type = prompt.promptId.includes(":command:") ? "command" : "prompt";
    const input: ImportCandidateInput = {
      type,
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

export const previewClaudeCodeImport = async (
  native: NativeBridge
): Promise<ReturnType<typeof buildImportDiscovery>> =>
  buildImportDiscovery([await discoverClaudeCodeImport(native)]);

export const importClaudeCode = async (
  native: NativeBridge
): Promise<{ applied: false } & ReturnType<typeof buildImportDiscovery>> => ({
  ...(await previewClaudeCodeImport(native)),
  applied: false,
});
