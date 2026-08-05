import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

const SOURCE: "opencode" = "opencode";
type ConfigSource = {
  scope: "global" | "project";
  path: string;
  root: string;
  values: Record<string, unknown>;
  projectId?: string;
  projectRoot?: string;
};

export type OpenCodeImportContext = {
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

const getOpenCodeConfigHome = (): string => {
  const configuredHome = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (configuredHome) {
    return resolve(configuredHome);
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  return join(
    xdgConfigHome ? resolve(xdgConfigHome) : join(homedir(), ".config"),
    "opencode"
  );
};

const resolveDeclaredPath = (root: string, declaredPath: string): string =>
  isAbsolute(declaredPath)
    ? resolve(declaredPath)
    : resolve(root, declaredPath);

const readConfig = (
  path: string,
  scope: "global" | "project",
  root: string,
  warnings: string[],
  project?: WorkspaceDirectoryRecord
): ConfigSource | null => {
  const values = readJson(path, warnings, true);
  return values
    ? {
        scope,
        path,
        root,
        values,
        ...(project
          ? { projectId: project.directoryId, projectRoot: project.path }
          : {}),
      }
    : null;
};

const configCandidates = (root: string): string[] => [
  join(root, "config.json"),
  join(root, "opencode.json"),
  join(root, "opencode.jsonc"),
];

const collectConfigSources = (
  configHome: string,
  projects: WorkspaceDirectoryRecord[],
  warnings: string[]
): ConfigSource[] => {
  const sources: ConfigSource[] = [];
  for (const path of configCandidates(configHome)) {
    const source = readConfig(path, "global", configHome, warnings);
    if (source) {
      sources.push(source);
    }
  }
  const legacyHome = join(homedir(), ".opencode");
  for (const path of [
    join(legacyHome, "opencode.json"),
    join(legacyHome, "opencode.jsonc"),
  ]) {
    const source = readConfig(path, "global", legacyHome, warnings);
    if (source) {
      sources.push(source);
    }
  }
  for (const project of projects.filter((item) => item.kind === "local")) {
    for (const path of [
      join(project.path, "opencode.json"),
      join(project.path, "opencode.jsonc"),
      join(project.path, ".opencode", "opencode.json"),
      join(project.path, ".opencode", "opencode.jsonc"),
    ]) {
      const source = readConfig(
        path,
        "project",
        dirname(path),
        warnings,
        project
      );
      if (source) {
        sources.push(source);
      }
    }
  }
  return sources;
};

const toMcpServer = (
  name: string,
  raw: unknown,
  source: ConfigSource,
  sortOrder: number,
  warnings: string[]
): ImportedMcp | null => {
  if (!isRecord(raw) || raw.type === undefined) {
    return null;
  }
  const type = nonEmptyString(raw.type);
  if (type !== "local" && type !== "remote") {
    warnings.push(
      `Skipping OpenCode MCP server ${name}: unsupported type ${String(
        raw.type
      )}`
    );
    return null;
  }
  const serverId =
    source.scope === "global"
      ? `${SOURCE}:global:${name}`
      : `${SOURCE}:project:${source.projectId}:${name}`;
  let input;
  if (type === "local") {
    const command = asStringArray(raw.command);
    input = createMcpInput({
      serverId,
      name,
      source: SOURCE,
      sortOrder,
      transportType: "stdio",
      command: command[0],
      args: command.slice(1),
      env: asStringRecord(raw.environment),
      enabled: raw.enabled,
      timeoutMs: typeof raw.timeout === "number" ? raw.timeout : undefined,
    });
  } else {
    input = createMcpInput({
      serverId,
      name,
      source: SOURCE,
      sortOrder,
      transportType: "http",
      url: typeof raw.url === "string" ? raw.url : "",
      headers: asStringRecord(raw.headers),
      enabled: raw.enabled,
      timeoutMs: typeof raw.timeout === "number" ? raw.timeout : undefined,
    });
  }
  if (!input) {
    warnings.push(
      `Skipping OpenCode MCP server ${name}: incomplete ${type} configuration`
    );
    return null;
  }
  return { scope: source.scope, projectId: source.projectId, input };
};

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
    const declared = isRecord(source.values.mcp) ? source.values.mcp : null;
    if (!declared) {
      continue;
    }
    if (source.scope === "global") {
      globalFound = true;
    } else if (source.projectId) {
      projectIds.add(source.projectId);
    }
    for (const [index, [name, raw]] of Object.entries(declared).entries()) {
      const server = toMcpServer(name, raw, source, index, warnings);
      if (server) {
        servers.set(server.input.serverId, server);
        continue;
      }
      if (isRecord(raw) && typeof raw.enabled === "boolean") {
        const serverId =
          source.scope === "global"
            ? `${SOURCE}:global:${name}`
            : `${SOURCE}:project:${source.projectId}:${name}`;
        const existing = servers.get(serverId);
        if (existing) {
          servers.set(serverId, {
            ...existing,
            input: { ...existing.input, enabled: raw.enabled },
          });
        }
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

const globPatternToRegExp = (pattern: string): RegExp => {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (char === "*") {
      expression += "[^/]*";
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`);
};

const resolveInstructionPaths = async (
  source: ConfigSource,
  declaredPath: string
): Promise<string[]> => {
  const root = dirname(source.path);
  if (!/[?*]/.test(declaredPath)) {
    return [resolveDeclaredPath(root, declaredPath)];
  }
  const normalizedPattern = declaredPath
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  const matches = globPatternToRegExp(normalizedPattern);
  return walkFiles(
    root,
    (path) => matches.test(relative(root, path).split(sep).join("/")),
    20
  );
};

const collectPrompts = async (
  sources: ConfigSource[],
  configHome: string,
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
  const addDirectoryPrompts = async (
    source: ConfigSource,
    kind: "agent" | "command",
    root: string
  ): Promise<void> => {
    for (const path of await walkFiles(root, (file) => file.endsWith(".md"))) {
      const id =
        source.scope === "global"
          ? `${SOURCE}:global:${kind}:${safeSegment(path)}`
          : `${SOURCE}:project:${source.projectId}:${kind}:${safeSegment(
              path
            )}`;
      addFile(
        id,
        `OpenCode ${kind}`,
        path,
        source.scope,
        source.projectId,
        false
      );
    }
  };

  for (const source of sources) {
    const idPrefix =
      source.scope === "global"
        ? `${SOURCE}:global`
        : `${SOURCE}:project:${source.projectId}`;
    const instructions = asStringArray(source.values.instructions);
    for (const [index, instruction] of instructions.entries()) {
      (await resolveInstructionPaths(source, instruction)).forEach(
        (path, pathIndex) => {
          addFile(
            `${idPrefix}:instruction:${index}:${pathIndex}`,
            "OpenCode instruction",
            path,
            source.scope,
            source.projectId
          );
        }
      );
    }
    const commands = isRecord(source.values.command)
      ? source.values.command
      : {};
    for (const [name, command] of Object.entries(commands)) {
      if (isRecord(command) && typeof command.template === "string") {
        addPrompt(
          prompts,
          `${idPrefix}:command:${safeSegment(name)}`,
          `OpenCode command ${name}`,
          command.template,
          source.scope,
          source.projectId,
          false
        );
      }
    }
    const agents = isRecord(source.values.agent) ? source.values.agent : {};
    for (const [name, agent] of Object.entries(agents)) {
      if (isRecord(agent) && typeof agent.prompt === "string") {
        addPrompt(
          prompts,
          `${idPrefix}:agent:${safeSegment(name)}`,
          `OpenCode agent ${name}`,
          agent.prompt,
          source.scope,
          source.projectId,
          false
        );
      }
    }
    await addDirectoryPrompts(source, "agent", join(source.root, "agent"));
    await addDirectoryPrompts(source, "agent", join(source.root, "agents"));
    await addDirectoryPrompts(source, "command", join(source.root, "command"));
    await addDirectoryPrompts(source, "command", join(source.root, "commands"));
  }
  for (const path of await walkFiles(join(configHome, "instructions"), (file) =>
    file.endsWith(".md")
  )) {
    addFile(
      `${SOURCE}:global:instruction:${safeSegment(path)}`,
      "OpenCode instruction",
      path,
      "global"
    );
  }
  return { prompts: [...prompts.values()], instructionPaths };
};

const collectSkills = async (
  sources: ConfigSource[]
): Promise<DiscoveredSkill[]> => {
  const skills: DiscoveredSkill[] = [];
  const sourcePaths = new Set<string>();
  // Walk every skills root in parallel; skip roots that do not exist so we
  // avoid a worker round-trip per missing directory. Task order matches the
  // previous sequential loop, so discovery order is unchanged.
  const tasks: Array<{ source: ConfigSource; sourceRoot: string }> = [];
  for (const source of sources) {
    tasks.push({ source, sourceRoot: join(source.root, "skills") });
    const declaredSkills = isRecord(source.values.skills)
      ? source.values.skills
      : {};
    for (const path of asStringArray(declaredSkills.paths)) {
      tasks.push({
        source,
        sourceRoot: resolveDeclaredPath(dirname(source.path), path),
      });
    }
  }
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
        scope: task.source.scope,
        ...(task.source.projectId ? { projectId: task.source.projectId } : {}),
        ...(task.source.projectRoot
          ? { projectRoot: task.source.projectRoot }
          : {}),
      });
    }
  }
  return skills;
};

export const buildOpenCodeContext = async (
  native: NativeBridge
): Promise<OpenCodeImportContext> => {
  const configHome = getOpenCodeConfigHome();
  const warnings: string[] = [];
  const projects = await native.listWorkspaceDirectories();
  const sources = collectConfigSources(configHome, projects, warnings);
  const mcp = collectMcpServers(sources, warnings);
  const [promptData, skills] = await Promise.all([
    collectPrompts(sources, configHome, warnings),
    collectSkills(sources),
  ]);
  const configPaths = [
    ...configCandidates(configHome),
    join(homedir(), ".opencode", "opencode.json"),
    join(homedir(), ".opencode", "opencode.jsonc"),
  ].map((path) => ({
    label: "Global configuration",
    path,
    found: existsSync(path),
  }));
  const source: ImportSource = {
    provider: SOURCE,
    sourceHome: configHome,
    sourceFound:
      existsSync(configHome) || existsSync(join(homedir(), ".opencode")),
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
    warnings.push(`OpenCode configuration not found: ${configHome}`);
  }
  return {
    source,
    mcpServers: mcp.servers,
    prompts: promptData.prompts,
    skills,
  };
};

export const discoverOpenCodeImportFromContext = async (
  context: OpenCodeImportContext
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
        : prompt.promptId.includes(":agent:")
        ? ("agent" as const)
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

export const discoverOpenCodeImport = async (
  native: NativeBridge
): Promise<ImportSourceDiscovery> =>
  discoverOpenCodeImportFromContext(await buildOpenCodeContext(native));

export const resolveOpenCodeSelectedImports = async (
  native: NativeBridge,
  selected: SelectedImportCandidate[],
  // Reuse a previously built context (e.g. from discoverAllImportContexts)
  // to avoid re-scanning every OpenCode directory twice per commit.
  context?: OpenCodeImportContext
): Promise<{ actions: ResolvedImportAction[]; warnings: string[] }> => {
  const ctx = context ?? (await buildOpenCodeContext(native));
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
      ? "command"
      : prompt.promptId.includes(":agent:")
      ? "agent"
      : "prompt";
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

export const previewOpenCodeImport = async (
  native: NativeBridge
): Promise<ReturnType<typeof buildImportDiscovery>> =>
  buildImportDiscovery([await discoverOpenCodeImport(native)]);

export const importOpenCode = async (
  native: NativeBridge
): Promise<ReadonlyImportResult> => ({
  ...(await previewOpenCodeImport(native)),
  applied: false,
});
