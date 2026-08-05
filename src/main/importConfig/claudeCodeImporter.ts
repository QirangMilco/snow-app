import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  NativeBridge,
  SystemPromptItemInput,
  WorkspaceDirectoryRecord,
} from "../native/types";
import { isRecord } from "../utils/value";
import {
  asStringArray,
  asStringRecord,
  collectSkillDirectories,
  createMcpInput,
  createPrompt,
  nonEmptyString,
  projectPathMatches,
  readJson,
  readText,
  safeSegment,
  type ImportedMcp,
  uniquePaths,
  walkFiles,
} from "./utils";
import {
  buildImportDiscovery,
  hashImportPath,
  hashImportValue,
  skillLogicalId,
  type ImportCandidateInput,
  type ImportSourceDiscovery,
} from "./discovery";
import type {
  ImportSource,
  ReadonlyImportResult,
} from "../../shared/importDiscovery";
import {
  selectionForInput,
  skillDestination,
  type ResolvedImportAction,
  type SelectedImportCandidate,
} from "./selectedImport";

const SOURCE: "claude-code" = "claude-code";

type ConfigSource = {
  scope: "global" | "project";
  path: string;
  values: Record<string, unknown>;
  projectId?: string;
  projectRoot?: string;
};

export type ClaudeCodeImportContext = {
  source: ImportSource;
  mcpServers: ImportedMcp[];
  prompts: SystemPromptItemInput[];
  skills: DiscoveredSkill[];
};

type DiscoveredSkill = {
  sourceDir: string;
  scope: "global" | "project";
  projectId?: string;
  projectRoot?: string;
};

const getClaudeHome = (): string => {
  const configuredHome = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configuredHome ? resolve(configuredHome) : join(homedir(), ".claude");
};

const expandEnvironment = (
  value: string,
  warnings: string,
  warningSink: string[]
): string =>
  value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g,
    (_match, name, _defaultPart, defaultValue) => {
      const replacement = process.env[name] ?? defaultValue;
      if (replacement === undefined) {
        warningSink.push(
          `${warnings} references missing environment variable ${name}`
        );
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
  const input = createMcpInput({
    serverId,
    name,
    source: SOURCE,
    sortOrder,
    transportType,
    url:
      transportType === "http" && typeof raw.url === "string"
        ? expandEnvironment(
            raw.url,
            `Claude Code MCP server ${name} URL`,
            warnings
          )
        : "",
    command:
      transportType === "stdio" && typeof raw.command === "string"
        ? expandEnvironment(
            raw.command,
            `Claude Code MCP server ${name} command`,
            warnings
          )
        : "",
    args: asStringArray(raw.args).map((argument) =>
      expandEnvironment(
        argument,
        `Claude Code MCP server ${name} argument`,
        warnings
      )
    ),
    env: expandStringRecord(
      asStringRecord(raw.env),
      `Claude Code MCP server ${name} environment`,
      warnings
    ),
    headers: expandStringRecord(
      asStringRecord(raw.headers),
      `Claude Code MCP server ${name} header`,
      warnings
    ),
    enabled: raw.enabled,
    timeoutMs: typeof raw.timeout === "number" ? raw.timeout : undefined,
  });
  return input ? { scope, projectId, input } : null;
};

const collectClaudeJsonSources = (
  claudeJson: Record<string, unknown> | null,
  projects: WorkspaceDirectoryRecord[]
): ConfigSource[] => {
  if (!claudeJson) {
    return [];
  }
  const sources: ConfigSource[] = [
    {
      scope: "global",
      path: join(homedir(), ".claude.json"),
      values: claudeJson,
    },
  ];
  const configuredProjects = isRecord(claudeJson.projects)
    ? claudeJson.projects
    : {};
  for (const project of projects.filter((item) => item.kind === "local")) {
    const config = Object.entries(configuredProjects).find(([path]) =>
      projectPathMatches(resolve(path), resolve(project.path))
    )?.[1];
    if (isRecord(config)) {
      sources.push({
        scope: "project",
        path: join(homedir(), ".claude.json"),
        values: config,
        projectId: project.directoryId,
        projectRoot: project.path,
      });
    }
  }
  return sources;
};

const collectProjectSources = (
  projects: WorkspaceDirectoryRecord[],
  warnings: string[]
): ConfigSource[] =>
  projects
    .filter((project) => project.kind === "local")
    .flatMap((project) => {
      const path = join(project.path, ".mcp.json");
      const values = readJson(path, warnings);
      return values
        ? [
            {
              scope: "project" as const,
              path,
              values,
              projectId: project.directoryId,
              projectRoot: project.path,
            },
          ]
        : [];
    });

const collectMcpServers = (
  sources: ConfigSource[],
  warnings: string[]
): {
  servers: ImportedMcp[];
  globalFound: boolean;
  projectIds: Set<string>;
} => {
  const servers = new Map<string, ImportedMcp>();
  let globalFound = false;
  const projectIds = new Set<string>();
  for (const source of sources) {
    const declared = isRecord(source.values.mcpServers)
      ? source.values.mcpServers
      : null;
    if (!declared) {
      continue;
    }
    if (source.scope === "global") {
      globalFound = true;
    } else if (source.projectId) {
      projectIds.add(source.projectId);
    }
    for (const [index, [name, raw]] of Object.entries(declared).entries()) {
      const id =
        source.scope === "global"
          ? `${SOURCE}:global:${name}`
          : `${SOURCE}:project:${source.projectId}:${name}`;
      const server = toMcpServer(
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
  return { servers: [...servers.values()], globalFound, projectIds };
};

const addPrompt = (
  prompts: Map<string, SystemPromptItemInput>,
  id: string,
  name: string,
  content: string | null,
  scope: "global" | "project",
  projectId?: string,
  isActive = true
): void => {
  if (!content) {
    return;
  }
  const prompt = createPrompt(id, name, content, prompts.size);
  if (prompt) {
    prompts.set(id, {
      ...prompt,
      isActive,
      scope,
      ...(scope === "project" && projectId ? { projectId } : {}),
    });
  }
};

const collectPrompts = async (
  claudeHome: string,
  projects: WorkspaceDirectoryRecord[],
  warnings: string[]
): Promise<{
  prompts: SystemPromptItemInput[];
  instructionPaths: string[];
}> => {
  const prompts = new Map<string, SystemPromptItemInput>();
  const instructionPaths: string[] = [];
  const addFile = (
    id: string,
    name: string,
    path: string,
    scope: "global" | "project",
    projectId?: string,
    isActive = true
  ): void => {
    const content = readText(path, warnings);
    if (content) {
      instructionPaths.push(path);
      addPrompt(prompts, id, name, content, scope, projectId, isActive);
    }
  };

  addFile(
    `${SOURCE}:global:claude-md`,
    "Claude Code CLAUDE.md",
    join(claudeHome, "CLAUDE.md"),
    "global"
  );
  for (const path of await walkFiles(join(claudeHome, "rules"), (file) =>
    file.endsWith(".md")
  )) {
    addFile(
      `${SOURCE}:global:rule:${safeSegment(path)}`,
      "Claude Code rule",
      path,
      "global"
    );
  }
  for (const path of await walkFiles(join(claudeHome, "commands"), (file) =>
    file.endsWith(".md")
  )) {
    addFile(
      `${SOURCE}:global:command:${safeSegment(path)}`,
      "Claude Code command",
      path,
      "global",
      undefined,
      false
    );
  }

  const localProjects = projects.filter((item) => item.kind === "local");
  // Walk .claude/rules and .claude/commands for every project in parallel.
  // Results are consumed in the original per-project order so prompt
  // sortOrder stays deterministic.
  const promptWalkTasks: Array<{
    project: WorkspaceDirectoryRecord;
    kind: string;
    root: string;
  }> = [];
  for (const project of localProjects) {
    for (const [kind, root] of [
      ["rule", join(project.path, ".claude", "rules")],
      ["command", join(project.path, ".claude", "commands")],
    ] as const) {
      promptWalkTasks.push({ project, kind, root });
    }
  }
  const walkedPrompts = await Promise.all(
    promptWalkTasks.map(async (task) => ({
      task,
      paths: existsSync(task.root)
        ? await walkFiles(task.root, (file) => file.endsWith(".md"))
        : [],
    }))
  );
  for (const project of localProjects) {
    addFile(
      `${SOURCE}:project:${project.directoryId}:claude-md`,
      `Claude Code CLAUDE.md (${project.directoryId})`,
      join(project.path, "CLAUDE.md"),
      "project",
      project.directoryId
    );
    addFile(
      `${SOURCE}:project:${project.directoryId}:claude-dir-md`,
      `Claude Code .claude/CLAUDE.md (${project.directoryId})`,
      join(project.path, ".claude", "CLAUDE.md"),
      "project",
      project.directoryId
    );
    for (const { task, paths } of walkedPrompts) {
      if (task.project !== project) {
        continue;
      }
      for (const path of paths) {
        addFile(
          `${SOURCE}:project:${task.project.directoryId}:${
            task.kind
          }:${safeSegment(path)}`,
          `Claude Code ${task.kind}`,
          path,
          "project",
          task.project.directoryId,
          task.kind !== "command"
        );
      }
    }
  }
  return { prompts: [...prompts.values()], instructionPaths };
};

const collectSkills = async (
  claudeHome: string,
  projects: WorkspaceDirectoryRecord[]
): Promise<DiscoveredSkill[]> => {
  const skills: DiscoveredSkill[] = [];
  const sourcePaths = new Set<string>();
  // Walk all skills roots in parallel; skip roots that do not exist so we
  // avoid a worker round-trip for every project without a .claude/skills
  // folder. Task order matches the previous sequential loop, so discovery
  // order (and sortOrder in later phases) is unchanged.
  const localProjects = projects.filter((item) => item.kind === "local");
  const tasks: Array<{
    sourceRoot: string;
    scope: "global" | "project";
    project?: WorkspaceDirectoryRecord;
  }> = [
    { sourceRoot: join(claudeHome, "skills"), scope: "global" },
    ...localProjects.map((project) => ({
      sourceRoot: join(project.path, ".claude", "skills"),
      scope: "project" as const,
      project,
    })),
  ];
  const results = await Promise.all(
    tasks.map(async (task) => ({
      task,
      skillDirs: existsSync(task.sourceRoot)
        ? await collectSkillDirectories(task.sourceRoot)
        : [],
    }))
  );
  for (const { task, skillDirs } of results) {
    for (const sourceDir of skillDirs) {
      const key = resolve(sourceDir);
      if (sourcePaths.has(key)) {
        continue;
      }
      sourcePaths.add(key);
      skills.push({
        sourceDir,
        scope: task.scope,
        ...(task.project
          ? {
              projectId: task.project.directoryId,
              projectRoot: task.project.path,
            }
          : {}),
      });
    }
  }
  return skills;
};

export const buildClaudeCodeContext = async (
  native: NativeBridge
): Promise<ClaudeCodeImportContext> => {
  const claudeHome = getClaudeHome();
  const claudeJsonPath = join(homedir(), ".claude.json");
  const warnings: string[] = [];
  const projects = await native.listWorkspaceDirectories();
  const claudeJson = readJson(claudeJsonPath, warnings);
  const sources = [
    ...collectProjectSources(projects, warnings),
    ...collectClaudeJsonSources(claudeJson, projects),
  ];
  const mcp = collectMcpServers(sources, warnings);
  const [promptData, skills] = await Promise.all([
    collectPrompts(claudeHome, projects, warnings),
    collectSkills(claudeHome, projects),
  ]);
  const configPaths = [
    {
      label: "User configuration",
      path: claudeJsonPath,
      found: existsSync(claudeJsonPath),
    },
    {
      label: "User settings",
      path: join(claudeHome, "settings.json"),
      found: existsSync(join(claudeHome, "settings.json")),
    },
  ];
  const source: ImportSource = {
    provider: SOURCE,
    sourceHome: claudeHome,
    sourceFound: existsSync(claudeHome) || existsSync(claudeJsonPath),
    configPaths,
    instructionPaths: uniquePaths(promptData.instructionPaths).map((path) => ({
      label: "Imported instruction",
      path,
      found: true,
    })),
    projectConfigCount: sources.filter((source) => source.scope === "project")
      .length,
    warnings,
  };
  if (!source.sourceFound) {
    warnings.push(`Claude Code configuration not found: ${claudeHome}`);
  }
  return {
    source,
    mcpServers: mcp.servers,
    prompts: promptData.prompts,
    skills,
  };
};

export const discoverClaudeCodeImportFromContext = async (
  context: ClaudeCodeImportContext
): Promise<ImportSourceDiscovery> => {
  const skillCandidates = await Promise.all(
    context.skills.map(async (skill) => ({
      type: "skill" as const,
      provider: SOURCE,
      scope: skill.scope,
      originPath: skill.sourceDir,
      logicalId: skillLogicalId(skill.sourceDir),
      contentHash: await hashImportPath(skill.sourceDir),
      ...(skill.projectId ? { projectId: skill.projectId } : {}),
      ...(skill.projectRoot ? { projectRoot: skill.projectRoot } : {}),
    }))
  );
  const candidates: ImportCandidateInput[] = [
    ...context.mcpServers.map((server) => ({
      type: "mcp" as const,
      provider: SOURCE,
      scope: server.scope,
      originPath: context.source.sourceHome,
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
    })),
    ...context.prompts.map((prompt) => ({
      type: prompt.promptId.includes(":command:")
        ? ("command" as const)
        : ("prompt" as const),
      provider: SOURCE,
      scope: prompt.scope ?? "global",
      originPath: context.source.sourceHome,
      logicalId: prompt.promptId,
      contentHash: hashImportValue(prompt.content),
      ...(prompt.projectId ? { projectId: prompt.projectId } : {}),
    })),
    ...skillCandidates,
  ];
  return { source: context.source, candidates };
};

export const discoverClaudeCodeImport = async (
  native: NativeBridge
): Promise<ImportSourceDiscovery> =>
  discoverClaudeCodeImportFromContext(await buildClaudeCodeContext(native));

export const resolveClaudeCodeSelectedImports = async (
  native: NativeBridge,
  selected: SelectedImportCandidate[],
  // Reuse a previously built context (e.g. from discoverAllImportContexts)
  // to avoid re-scanning every Claude Code directory twice per commit.
  context?: ClaudeCodeImportContext
): Promise<{ actions: ResolvedImportAction[]; warnings: string[] }> => {
  const ctx = context ?? (await buildClaudeCodeContext(native));
  const actions: ResolvedImportAction[] = [];
  for (const server of ctx.mcpServers) {
    const input: ImportCandidateInput = {
      type: "mcp",
      provider: SOURCE,
      scope: server.scope,
      originPath: ctx.source.sourceHome,
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
    };
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
    const type = prompt.promptId.includes(":command:")
      ? ("command" as const)
      : ("prompt" as const);
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
    const input: ImportCandidateInput = {
      type: "skill",
      provider: SOURCE,
      scope: skill.scope,
      originPath: skill.sourceDir,
      logicalId: skillLogicalId(skill.sourceDir),
      contentHash: await hashImportPath(skill.sourceDir),
      ...(skill.projectId ? { projectId: skill.projectId } : {}),
      ...(skill.projectRoot ? { projectRoot: skill.projectRoot } : {}),
    };
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
): Promise<ReadonlyImportResult> => ({
  ...(await previewClaudeCodeImport(native)),
  applied: false,
});
