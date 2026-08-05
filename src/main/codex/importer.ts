import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "@iarna/toml";
import type {
  McpServerConfigInput,
  NativeBridge,
  SystemPromptItemInput,
  WorkspaceDirectoryRecord,
} from "../native/types";
import { isRecord, toBoolean } from "../utils/value";
import { getCodexConfigPath, getCodexHome } from "./paths";
import type { CodexImportPreview, CodexImportResult } from "./types";
import {
  buildImportDiscovery,
  hashImportPath,
  hashImportValue,
  skillLogicalId,
  type ImportCandidateInput,
  type ImportSourceDiscovery,
} from "../importConfig/discovery";
import type { ImportSource } from "../../shared/importDiscovery";
import { walkFiles as walkImportFiles } from "../importConfig/utils";
import {
  selectionForInput,
  skillDestination,
  type ResolvedImportAction,
  type SelectedImportCandidate,
} from "../importConfig/selectedImport";

const CODEX_MCP_SOURCE = "codex";
const CODEX_PLUGIN_MCP_SOURCE = "codex-plugin";
const SKILL_FILE_NAME = "SKILL.md";
const MAX_SCAN_DEPTH = 10;

type ImportScope = "global" | "project";

type ConfigSource = {
  scope: ImportScope;
  configPath: string;
  projectId?: string;
  projectRoot?: string;
  values: Record<string, unknown>;
};

type ImportedMcp = {
  scope: ImportScope;
  projectId?: string;
  input: McpServerConfigInput;
};

type ImportedPrompt = SystemPromptItemInput;

type PluginDescriptor = {
  manifestKind: "codex" | "claude" | "cursor";
  id: string;
  name: string;
  root: string;
  manifestPath: string;
  scope: ImportScope;
  projectId?: string;
  projectRoot?: string;
  enabled: boolean;
  manifest: Record<string, unknown>;
  skillRoots: string[];
  mcpServers: Record<string, unknown>;
  defaultPrompts: string[];
};

type DiscoveredSkill = {
  sourceDir: string;
  scope: ImportScope;
  projectId?: string;
  projectRoot?: string;
  plugin?: boolean;
};

export type CodexImportContext = {
  source: ImportSource;
  mcpServers: ImportedMcp[];
  prompts: ImportedPrompt[];
  skills: DiscoveredSkill[];
  plugins: PluginDescriptor[];
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const asStringRecord = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, item]) => key.trim().length > 0 && typeof item === "string"
    )
  ) as Record<string, string>;
};

const asPathList = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") {
        return [item];
      }
      if (isRecord(item) && typeof item.path === "string") {
        return [item.path];
      }
      return [];
    });
  }
  if (isRecord(value) && typeof value.path === "string") {
    return [value.path];
  }
  return [];
};

const nonEmptyString = (value: unknown): string | null => {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
};

const safeSegment = (value: string): string =>
  value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\.\.+/g, ".") || "codex-plugin";

const readToml = (
  filePath: string,
  warnings: string[]
): Record<string, unknown> | null => {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = parseToml(readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    warnings.push(
      `Unable to parse ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
};

const readJson = (
  filePath: string,
  warnings: string[]
): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    warnings.push(
      `Unable to parse ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
};

const walkFiles = (
  root: string,
  predicate: (filePath: string) => boolean
): Promise<string[]> => walkImportFiles(root, predicate, MAX_SCAN_DEPTH);

const collectSkillDirectories = async (root: string): Promise<string[]> => {
  const files = await walkFiles(root, (filePath) =>
    filePath.endsWith(`${sep}${SKILL_FILE_NAME}`)
  );
  return files
    .map(dirname)
    .filter((skillDir) => relative(root, skillDir) !== "");
};

const resolveDeclaredPath = (root: string, declaredPath: string): string => {
  const trimmed = declaredPath.trim();
  return isAbsolute(trimmed)
    ? resolve(trimmed)
    : resolve(root, trimmed.replace(/^\.\//, ""));
};

const resolvePluginDeclaredPath = (
  root: string,
  declaredPath: string,
  warnings: string[],
  resourceName: string
): string | null => {
  const trimmed = declaredPath.trim();
  if (!trimmed.startsWith("./") || isAbsolute(trimmed)) {
    warnings.push(
      "Ignoring " + resourceName + " path outside plugin root: " + declaredPath
    );
    return null;
  }
  const candidate = resolve(root, trimmed.slice(2));
  const resolvedRoot = resolve(root);
  const rootWithSeparator = resolvedRoot + sep;
  if (candidate !== resolvedRoot && !candidate.startsWith(rootWithSeparator)) {
    warnings.push(
      "Ignoring " + resourceName + " path outside plugin root: " + declaredPath
    );
    return null;
  }
  return candidate;
};

const pluginManifestFile = (filePath: string): boolean => {
  const parent = dirname(filePath).split(sep).pop();
  return (
    parent === ".codex-plugin" ||
    parent === ".claude-plugin" ||
    parent === ".cursor-plugin"
  );
};

const pluginManifestKind = (
  manifestPath: string
): PluginDescriptor["manifestKind"] => {
  const parent = dirname(manifestPath).split(sep).pop();
  return parent === ".claude-plugin"
    ? "claude"
    : parent === ".cursor-plugin"
    ? "cursor"
    : "codex";
};

const pluginRootFromManifest = (manifestPath: string): string => {
  const parent = dirname(manifestPath);
  const parentName = parent.split(sep).pop();
  return parentName === ".codex-plugin" ||
    parentName === ".claude-plugin" ||
    parentName === ".cursor-plugin"
    ? dirname(parent)
    : parent;
};

// Callers must pass projects sorted by path length (longest first) so the
// deepest matching workspace directory wins for nested project roots.
const projectForPath = (
  filePath: string,
  projects: WorkspaceDirectoryRecord[]
): WorkspaceDirectoryRecord | undefined =>
  projects
    .filter((project) => project.kind === "local")
    .find(
      (project) =>
        filePath === project.path ||
        filePath.startsWith(`${project.path}${sep}`)
    );

const pluginIdFor = (name: string, root: string, codexHome: string): string => {
  const marketplaceRoot = join(codexHome, ".tmp", "marketplaces");
  const marketplaceRelative = relative(marketplaceRoot, root);
  const marketplace =
    marketplaceRelative && !marketplaceRelative.startsWith(`..${sep}`)
      ? marketplaceRelative.split(sep)[0]
      : "local";
  return `${name}@${marketplace}`;
};

const pluginIsEnabled = (
  pluginId: string,
  name: string,
  configs: ConfigSource[]
): boolean => {
  let explicit: boolean | undefined;
  for (const config of configs) {
    const plugins = isRecord(config.values.plugins)
      ? config.values.plugins
      : {};
    for (const [key, rawConfig] of Object.entries(plugins)) {
      if (key !== pluginId && key !== name && !key.startsWith(`${name}@`)) {
        continue;
      }
      if (isRecord(rawConfig) && typeof rawConfig.enabled === "boolean") {
        explicit = rawConfig.enabled;
      }
    }
  }
  return explicit ?? true;
};

const loadPlugin = (
  manifestPath: string,
  codexHome: string,
  projects: WorkspaceDirectoryRecord[],
  configs: ConfigSource[],
  warnings: string[]
): PluginDescriptor | null => {
  const manifest = readJson(manifestPath, warnings);
  if (!manifest) {
    return null;
  }
  const root = pluginRootFromManifest(manifestPath);
  const manifestKind = pluginManifestKind(manifestPath);
  const name =
    nonEmptyString(manifest.name) ?? root.split(sep).pop() ?? "plugin";
  const project = projectForPath(root, projects);
  const scope: ImportScope = project ? "project" : "global";
  const interfaceValue = isRecord(manifest.interface) ? manifest.interface : {};
  const rawDefaultPrompt =
    interfaceValue.defaultPrompt ?? interfaceValue.default_prompt;
  const defaultPrompts = (
    typeof rawDefaultPrompt === "string"
      ? [rawDefaultPrompt]
      : asStringArray(rawDefaultPrompt)
  )
    .slice(0, 3)
    .map((prompt) => prompt.trim().slice(0, 128))
    .filter(Boolean);
  const skillRoots = [
    join(root, "skills"),
    ...asPathList(manifest.skills).flatMap((path) => {
      const resolvedPath = resolvePluginDeclaredPath(
        root,
        path,
        warnings,
        "plugin Skills"
      );
      return resolvedPath ? [resolvedPath] : [];
    }),
  ].filter((path, index, paths) => paths.indexOf(path) === index);
  const mcpDeclaration = manifest.mcpServers ?? manifest.mcp_servers;
  const mcpServers: Record<string, unknown> = {};
  const readMcpFile = (filePath: string): void => {
    if (!existsSync(filePath)) {
      return;
    }
    const parsed = readJson(filePath, warnings);
    if (!parsed) {
      return;
    }
    const nested = parsed.mcpServers ?? parsed.mcp_servers;
    Object.assign(mcpServers, isRecord(nested) ? nested : parsed);
  };

  if (mcpDeclaration === undefined && manifestKind !== "cursor") {
    readMcpFile(join(root, ".mcp.json"));
  } else if (typeof mcpDeclaration === "string") {
    const mcpPath = resolvePluginDeclaredPath(
      root,
      mcpDeclaration,
      warnings,
      "plugin MCP"
    );
    if (mcpPath) {
      readMcpFile(mcpPath);
    }
  } else if (isRecord(mcpDeclaration)) {
    Object.assign(mcpServers, mcpDeclaration);
  }

  return {
    manifestKind,
    id: pluginIdFor(name, root, codexHome),
    name,
    root,
    manifestPath,
    scope,
    ...(project
      ? { projectId: project.directoryId, projectRoot: project.path }
      : {}),
    enabled: pluginIsEnabled(pluginIdFor(name, root, codexHome), name, configs),
    manifest,
    skillRoots,
    mcpServers,
    defaultPrompts,
  };
};

const collectPlugins = async (
  codexHome: string,
  projects: WorkspaceDirectoryRecord[],
  configs: ConfigSource[],
  warnings: string[]
): Promise<PluginDescriptor[]> => {
  // Sort once (longest path first) so projectForPath can match nested roots
  // without re-sorting on every plugin manifest.
  const localProjects = projects
    .filter((project) => project.kind === "local")
    .sort((left, right) => right.path.length - left.path.length);
  const roots = [
    join(codexHome, ".tmp", "marketplaces"),
    join(codexHome, "plugins"),
    join(codexHome, ".agents", "plugins"),
    join(homedir(), ".agents", "plugins"),
    join(homedir(), "plugins"),
    ...localProjects.map((project) => join(project.path, ".agents", "plugins")),
    ...localProjects.map((project) => join(project.path, "plugins")),
    // Most of these roots do not exist (e.g. project "plugins" folders);
    // skip them up front to avoid a worker round-trip per missing directory.
  ].filter((root) => existsSync(root));
  const manifestPaths = (
    await Promise.all(
      roots.map((root) =>
        walkFiles(
          root,
          (filePath) =>
            filePath.endsWith(`${sep}plugin.json`) &&
            pluginManifestFile(filePath)
        )
      )
    )
  ).flat();
  const seen = new Set<string>();
  return manifestPaths
    .map((path) =>
      loadPlugin(path, codexHome, localProjects, configs, warnings)
    )
    .filter((plugin): plugin is PluginDescriptor => {
      if (!plugin || seen.has(plugin.root)) {
        return false;
      }
      seen.add(plugin.root);
      return true;
    });
};

const collectConfigs = async (
  native: NativeBridge,
  codexHome: string,
  warnings: string[]
): Promise<{
  configs: ConfigSource[];
  projects: WorkspaceDirectoryRecord[];
}> => {
  const configs: ConfigSource[] = [];
  const globalConfigPath = join(codexHome, "config.toml");
  const globalValues = readToml(globalConfigPath, warnings);
  if (globalValues) {
    configs.push({
      scope: "global",
      configPath: globalConfigPath,
      values: globalValues,
    });
  }

  const projects = await native.listWorkspaceDirectories();
  for (const project of projects.filter((item) => item.kind === "local")) {
    const configPath = join(project.path, ".codex", "config.toml");
    const values = readToml(configPath, warnings);
    if (values) {
      configs.push({
        scope: "project",
        configPath,
        projectId: project.directoryId,
        projectRoot: project.path,
        values,
      });
    }
  }
  return { configs, projects };
};

const readAgentsPrompt = (
  root: string
): { path: string; content: string } | null => {
  for (const fileName of ["AGENTS.override.md", "AGENTS.md"]) {
    const path = join(root, fileName);
    if (!existsSync(path)) {
      continue;
    }
    try {
      const content = readFileSync(path, "utf8").trim();
      if (content) {
        return { path, content };
      }
    } catch {
      return null;
    }
  }
  return null;
};

const promptId = (source: ConfigSource, kind: string): string =>
  source.scope === "global"
    ? `codex:global:${kind}`
    : `codex:project:${source.projectId ?? "unknown"}:${kind}`;

const profilePromptId = (
  source: ConfigSource,
  profileName: string,
  kind: string
): string =>
  promptId(source, "profile:" + safeSegment(profileName) + ":" + kind);

const collectPrompts = (
  codexHome: string,
  configs: ConfigSource[],
  projects: WorkspaceDirectoryRecord[],
  plugins: PluginDescriptor[],
  warnings: string[]
): ImportedPrompt[] => {
  const prompts = new Map<string, ImportedPrompt>();
  let order = 0;
  const add = (
    id: string,
    name: string,
    content: string,
    scope: ImportScope,
    projectId?: string,
    isActive = true
  ): void => {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }
    prompts.set(id, {
      promptId: id,
      name,
      content: trimmed,
      isActive,
      sortOrder: order++,
      scope,
      ...(scope === "project" && projectId ? { projectId } : {}),
    });
  };

  const globalAgents = readAgentsPrompt(codexHome);
  if (globalAgents) {
    add(
      "codex:global:agents",
      "Codex AGENTS.md",
      globalAgents.content,
      "global"
    );
  }

  const collectConfigPrompts = (
    config: ConfigSource,
    values: Record<string, unknown>,
    idFor: (kind: string) => string,
    labelSuffix: string
  ): void => {
    const labels: Array<[string, string, string]> = [
      ["instructions", "Codex instructions", "instructions"],
      [
        "developer_instructions",
        "Codex developer instructions",
        "developer-instructions",
      ],
      ["compact_prompt", "Codex compact prompt", "compact-prompt"],
    ];
    for (const [key, name, idPart] of labels) {
      const value = nonEmptyString(values[key]);
      if (value) {
        add(
          idFor(idPart),
          name + labelSuffix,
          value,
          config.scope,
          config.projectId
        );
      }
    }
    const filePrompts: Array<[string, string, string]> = [
      [
        "model_instructions_file",
        "Codex model instructions",
        "model-instructions",
      ],
      [
        "experimental_compact_prompt_file",
        "Codex compact prompt file",
        "compact-prompt-file",
      ],
    ];
    for (const [key, name, idPart] of filePrompts) {
      const declaredPath = nonEmptyString(values[key]);
      if (!declaredPath) {
        continue;
      }
      const path = resolveDeclaredPath(
        dirname(config.configPath),
        declaredPath
      );
      try {
        add(
          idFor(idPart),
          name + labelSuffix,
          readFileSync(path, "utf8"),
          config.scope,
          config.projectId
        );
      } catch (error) {
        warnings.push(
          "Unable to read Codex prompt file " +
            path +
            ": " +
            (error instanceof Error ? error.message : String(error))
        );
      }
    }
  };

  for (const config of configs) {
    const suffix =
      config.scope === "global"
        ? ""
        : " (" + (config.projectId ?? "unknown") + ")";
    collectConfigPrompts(
      config,
      config.values,
      (kind) => promptId(config, kind),
      suffix
    );
    const profiles = isRecord(config.values.profiles)
      ? config.values.profiles
      : {};
    for (const [profileName, rawProfile] of Object.entries(profiles)) {
      if (!isRecord(rawProfile)) {
        continue;
      }
      collectConfigPrompts(
        config,
        rawProfile,
        (kind) => profilePromptId(config, profileName, kind),
        suffix + " [" + profileName + "]"
      );
    }
    if (config.projectRoot) {
      const agents = readAgentsPrompt(config.projectRoot);
      if (agents) {
        add(
          promptId(config, "agents"),
          "Codex AGENTS.md (" + (config.projectId ?? "unknown") + ")",
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
  for (const project of projects.filter(
    (item) =>
      item.kind === "local" && !configuredProjectIds.has(item.directoryId)
  )) {
    const agents = readAgentsPrompt(project.path);
    if (agents) {
      add(
        "codex:project:" + project.directoryId + ":agents",
        "Codex AGENTS.md (" + project.directoryId + ")",
        agents.content,
        "project",
        project.directoryId
      );
    }
  }

  for (const plugin of plugins.filter((item) => item.enabled)) {
    for (const [index, content] of plugin.defaultPrompts.entries()) {
      add(
        `codex-plugin:${plugin.id}:prompt:${index}`,
        `${plugin.name} prompt ${index + 1}`,
        content,
        plugin.scope,
        plugin.projectId
      );
    }
  }
  return [...prompts.values()];
};

const toMcpInput = (
  name: string,
  raw: unknown,
  serverId: string,
  source: string,
  sortOrder: number,
  warnings: string[]
): McpServerConfigInput | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const command = nonEmptyString(raw.command) ?? "";
  const url = nonEmptyString(raw.url) ?? "";
  if (!command && !url) {
    return null;
  }
  const startupTimeoutMs =
    typeof raw.startup_timeout_ms === "number"
      ? raw.startup_timeout_ms
      : typeof raw.startup_timeout_sec === "number"
      ? Math.round(raw.startup_timeout_sec * 1000)
      : typeof raw.timeout === "number"
      ? raw.timeout
      : undefined;
  if (typeof raw.tool_timeout_sec === "number") {
    warnings.push(
      "MCP server " +
        name +
        " uses tool_timeout_sec, which is not representable in Snow App MCP settings"
    );
  }
  const headers = asStringRecord(raw.http_headers ?? raw.headers);
  for (const [headerName, envName] of Object.entries(
    asStringRecord(raw.env_http_headers)
  )) {
    const value = process.env[envName];
    if (value) {
      headers[headerName] = value;
    } else {
      warnings.push(
        "MCP server " +
          name +
          " references missing environment variable " +
          envName +
          " for header " +
          headerName
      );
    }
  }
  const bearerTokenEnvVar = nonEmptyString(raw.bearer_token_env_var);
  if (
    bearerTokenEnvVar &&
    !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")
  ) {
    const token = process.env[bearerTokenEnvVar];
    if (token) {
      headers.Authorization = "Bearer " + token;
    } else {
      warnings.push(
        "MCP server " +
          name +
          " references missing bearer token environment variable " +
          bearerTokenEnvVar
      );
    }
  }
  return {
    serverId,
    name,
    transportType: url ? "http" : "stdio",
    url,
    command,
    argsJson: JSON.stringify(asStringArray(raw.args)),
    envJson: JSON.stringify(asStringRecord(raw.env)),
    headersJson: JSON.stringify(headers),
    enabled: toBoolean(raw.enabled, true),
    ...(startupTimeoutMs && startupTimeoutMs > 0
      ? { timeoutMs: Math.round(startupTimeoutMs) }
      : {}),
    sortOrder,
    source,
  };
};

const collectMcpServers = (
  configs: ConfigSource[],
  warnings: string[]
): ImportedMcp[] => {
  const servers: ImportedMcp[] = [];
  for (const config of configs) {
    const declared = isRecord(config.values.mcp_servers)
      ? config.values.mcp_servers
      : {};
    for (const [index, [name, raw]] of Object.entries(declared).entries()) {
      const idPrefix =
        config.scope === "global"
          ? "codex:global"
          : `codex:project:${config.projectId}`;
      const input = toMcpInput(
        name,
        raw,
        `${idPrefix}:${name}`,
        CODEX_MCP_SOURCE,
        index,
        warnings
      );
      if (input) {
        servers.push({
          scope: config.scope,
          projectId: config.projectId,
          input,
        });
      }
    }
  }
  return servers;
};

const collectSkillCopies = async (
  codexHome: string,
  projects: WorkspaceDirectoryRecord[]
): Promise<DiscoveredSkill[]> => {
  const skills: DiscoveredSkill[] = [];
  const sourcePaths = new Set<string>();
  const addSkill = (
    sourceDir: string,
    scope: ImportScope,
    projectId?: string,
    projectRoot?: string,
    plugin = false
  ): void => {
    const key = resolve(sourceDir);
    if (sourcePaths.has(key)) {
      return;
    }
    sourcePaths.add(key);
    skills.push({
      sourceDir,
      scope,
      ...(projectId ? { projectId } : {}),
      ...(projectRoot ? { projectRoot } : {}),
      ...(plugin ? { plugin: true } : {}),
    });
  };
  const localProjects = projects.filter((item) => item.kind === "local");
  // Walk every skills root in parallel. Most project roots do not have a
  // `.codex/skills` / `.agents/skills` folder; the existsSync pre-check
  // avoids a worker round-trip per missing directory. Task order is kept
  // identical to the previous sequential loop so discovery order (and thus
  // sortOrder in later phases) is unchanged.
  const tasks: Array<{
    sourceRoot: string;
    scope: ImportScope;
    projectId?: string;
    projectRoot?: string;
  }> = [];
  for (const sourceRoot of [
    join(codexHome, "skills"),
    join(homedir(), ".agents", "skills"),
  ]) {
    tasks.push({ sourceRoot, scope: "global" });
  }
  for (const project of localProjects) {
    for (const sourceRoot of [
      join(project.path, ".codex", "skills"),
      join(project.path, ".agents", "skills"),
    ]) {
      tasks.push({
        sourceRoot,
        scope: "project",
        projectId: project.directoryId,
        projectRoot: project.path,
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
    for (const skillDir of skillDirs) {
      addSkill(skillDir, task.scope, task.projectId, task.projectRoot);
    }
  }
  return skills;
};

export const buildCodexContext = async (
  native: NativeBridge
): Promise<CodexImportContext> => {
  const codexHome = getCodexHome();
  const warnings: string[] = [];
  const { configs, projects } = await collectConfigs(
    native,
    codexHome,
    warnings
  );
  const plugins = await collectPlugins(codexHome, projects, configs, warnings);
  const mcpServers = collectMcpServers(configs, warnings);
  const prompts = collectPrompts(codexHome, configs, projects, [], warnings);
  const skills = await collectSkillCopies(codexHome, projects);
  const configPath = getCodexConfigPath();
  const globalInstructionsPath = readAgentsPrompt(codexHome)?.path ?? null;
  const source: ImportSource = {
    provider: "codex",
    sourceHome: codexHome,
    sourceFound: existsSync(codexHome) || existsSync(configPath),
    configPaths: [
      { label: "config.toml", path: configPath, found: existsSync(configPath) },
    ],
    instructionPaths: globalInstructionsPath
      ? [{ label: "AGENTS.md", path: globalInstructionsPath, found: true }]
      : [],
    projectConfigCount: configs.filter((config) => config.scope === "project")
      .length,
    warnings,
  };
  const codexHomeFound = existsSync(codexHome);
  if (!codexHomeFound) {
    warnings.push(`Codex home not found: ${codexHome}`);
  }
  return {
    source,
    mcpServers,
    prompts,
    skills,
    plugins,
  };
};

export const discoverCodexImportFromContext = async (
  context: CodexImportContext
): Promise<ImportSourceDiscovery> => {
  const skillCandidates = await Promise.all(
    context.skills.map(async (skill) => ({
      type: "skill" as const,
      provider: "codex" as const,
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
      provider: "codex" as const,
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
      type: "prompt" as const,
      provider: "codex" as const,
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

export const discoverCodexImport = async (
  native: NativeBridge
): Promise<ImportSourceDiscovery> =>
  discoverCodexImportFromContext(await buildCodexContext(native));

export const resolveCodexSelectedImports = async (
  native: NativeBridge,
  selected: SelectedImportCandidate[],
  // Reuse a previously built context (e.g. from discoverAllImportContexts)
  // to avoid re-scanning every Codex directory twice per commit.
  context?: CodexImportContext
): Promise<{ actions: ResolvedImportAction[]; warnings: string[] }> => {
  const ctx = context ?? (await buildCodexContext(native));
  const actions: ResolvedImportAction[] = [];
  for (const server of ctx.mcpServers.filter(
    (item) => item.input.source === CODEX_MCP_SOURCE
  )) {
    const input: ImportCandidateInput = {
      type: "mcp",
      provider: "codex",
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
  for (const prompt of ctx.prompts.filter((item) =>
    item.promptId.startsWith("codex:")
  )) {
    const input: ImportCandidateInput = {
      type: "prompt",
      provider: "codex",
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
  for (const skill of ctx.skills.filter((item) => !item.plugin)) {
    const input: ImportCandidateInput = {
      type: "skill",
      provider: "codex",
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
            "codex",
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

export const previewCodexImport = async (
  native: NativeBridge
): Promise<CodexImportPreview> =>
  buildImportDiscovery([await discoverCodexImport(native)]);

export const importCodex = async (
  native: NativeBridge
): Promise<CodexImportResult> => ({
  ...(await previewCodexImport(native)),
  applied: false,
});
