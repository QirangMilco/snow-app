import type { NativeBridge, SystemPromptItemInput } from "../native/types";
import type { ImportSource, ReadonlyImportResult } from "../../shared/importDiscovery";
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

const SOURCE = "opencode" as const;

type ConfigSource = {
  scope: "global" | "project";
  path: string;
  root: string;
  values: Record<string, unknown>;
  projectId?: string;
  projectRoot?: string;
  environmentId: string;
  environmentLabel: string;
};

export type OpenCodeImportContext = {
  source: ImportSource;
  mcpServers: ImportedMcp[];
  unsupportedMcpServers: UnsupportedImportedMcp[];
  prompts: SystemPromptItemInput[];
  skills: EnvironmentDiscoveredSkill[];
  scans: ProviderScannerResult[];
};

const envSegment = (environment: ImportEnvironment): string =>
  environment.kind === "local" ? "" : `:${environment.id.replace(/[^A-Za-z0-9._-]+/g, "-")}`;

const resolveDeclaredPath = (
  environment: ImportEnvironment,
  root: string,
  declaredPath: string
): string => environment.fs.resolveDeclared(root, declaredPath);

const readJson = async (
  environment: ImportEnvironment,
  filePath: string,
  warnings: string[],
  allowComments = false
): Promise<Record<string, unknown> | null> => {
  if (!(await environment.fs.exists(filePath))) {
    return null;
  }
  const text = await environment.fs.readText(filePath);
  if (text === null) {
    return null;
  }
  try {
    let processed = text;
    if (allowComments) {
      processed = removeJsonComments(processed);
      processed = removeTrailingCommas(processed);
    }
    const parsed: unknown = JSON.parse(processed);
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

const removeJsonComments = (input: string): string => {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < input.length && input[index] !== "\n") {
        index += 1;
      }
      if (index < input.length) {
        result += "\n";
      }
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) {
        if (input[index] === "\n") {
          result += "\n";
        }
        index += 1;
      }
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
};

const removeTrailingCommas = (input: string): string => {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let cursor = index + 1;
      while (/\s/.test(input[cursor] ?? "")) {
        cursor += 1;
      }
      if (input[cursor] === "}" || input[cursor] === "]") {
        continue;
      }
    }
    result += char;
  }
  return result;
};

const configCandidates = (root: string, fs: ImportEnvironment["fs"]): string[] => [
  fs.join(root, "config.json"),
  fs.join(root, "opencode.json"),
  fs.join(root, "opencode.jsonc"),
];

const collectConfigSources = async (
  environment: ImportEnvironment,
  configHome: string,
  warnings: string[]
): Promise<ConfigSource[]> => {
  const sources: ConfigSource[] = [];
  for (const path of configCandidates(configHome, environment.fs)) {
    const values = await readJson(environment, path, warnings, true);
    if (values) {
      sources.push({
        scope: "global",
        path,
        root: configHome,
        values,
        environmentId: environment.id,
        environmentLabel: environment.label,
      });
    }
  }
  const legacyHome = environment.fs.join(environment.home, ".opencode");
  for (const path of [
    environment.fs.join(legacyHome, "opencode.json"),
    environment.fs.join(legacyHome, "opencode.jsonc"),
  ]) {
    const values = await readJson(environment, path, warnings, true);
    if (values) {
      sources.push({
        scope: "global",
        path,
        root: legacyHome,
        values,
        environmentId: environment.id,
        environmentLabel: environment.label,
      });
    }
  }
  for (const project of environment.projects) {
    const projectRoot = environment.projectRoot(project);
    for (const path of [
      environment.fs.join(projectRoot, "opencode.json"),
      environment.fs.join(projectRoot, "opencode.jsonc"),
      environment.fs.join(projectRoot, ".opencode", "opencode.json"),
      environment.fs.join(projectRoot, ".opencode", "opencode.jsonc"),
    ]) {
      const values = await readJson(environment, path, warnings, true);
      if (values) {
        sources.push({
          scope: "project",
          path,
          root: environment.fs.dirname(path),
          values,
          projectId: project.directoryId,
          projectRoot,
          environmentId: environment.id,
          environmentLabel: environment.label,
        });
      }
    }
  }
  return sources;
};

const toMcpServer = (
  environment: ImportEnvironment,
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
      `Skipping OpenCode MCP server ${name}: unsupported type ${String(raw.type)}`
    );
    return null;
  }
  const serverId =
    source.scope === "global"
      ? `${SOURCE}:global${envSegment(environment)}:${name}`
      : `${SOURCE}:project:${source.projectId}${envSegment(environment)}:${name}`;
  if (type === "local") {
    const command = asStringArray(raw.command);
    if (command.length > 0) {
      const adaptation = environment.adaptStdioMcp(command[0], command.slice(1));
      if ("unsupportedReason" in adaptation) {
        return null;
      }
      const input = createMcpInput({
        serverId,
        name,
        source: SOURCE,
        sortOrder,
        transportType: "stdio",
        command: adaptation.command,
        args: adaptation.args,
        env: asStringRecord(raw.environment),
        enabled: raw.enabled,
        timeoutMs: typeof raw.timeout === "number" ? raw.timeout : undefined,
      });
      if (input) {
        return {
          scope: source.scope,
          ...(source.projectId ? { projectId: source.projectId } : {}),
          input,
          originPath: source.path,
          environmentId: environment.id,
          environmentLabel: environment.label,
        };
      }
    }
  } else {
    const input = createMcpInput({
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
    if (input) {
      return {
        scope: source.scope,
        ...(source.projectId ? { projectId: source.projectId } : {}),
        input,
        originPath: source.path,
        environmentId: environment.id,
        environmentLabel: environment.label,
      };
    }
  }
  warnings.push(`Skipping OpenCode MCP server ${name}: incomplete ${type} configuration`);
  return null;
};

const toUnsupportedMcp = (
  environment: ImportEnvironment,
  name: string,
  raw: unknown,
  source: ConfigSource
): UnsupportedImportedMcp | null => {
  if (!isRecord(raw) || raw.type === undefined) return null;
  const type = nonEmptyString(raw.type);
  if (type !== "local") return null;
  const command = asStringArray(raw.command);
  if (command.length === 0) return null;
  return {
    name,
    scope: source.scope,
    ...(source.projectId ? { projectId: source.projectId } : {}),
    reason: "Stdio MCP commands declared on an SSH remote host cannot run locally",
    originPath: source.path,
    environmentId: environment.id,
    environmentLabel: environment.label,
  };
};

const collectMcpServers = (
  environment: ImportEnvironment,
  sources: ConfigSource[],
  warnings: string[]
): { servers: ImportedMcp[]; unsupported: UnsupportedImportedMcp[] } => {
  const servers = new Map<string, ImportedMcp>();
  const unsupported: UnsupportedImportedMcp[] = [];
  for (const source of sources) {
    const declared = isRecord(source.values.mcp) ? source.values.mcp : null;
    if (!declared) continue;
    for (const [index, [name, raw]] of Object.entries(declared).entries()) {
      if (environment.kind === "ssh") {
        const unsupportedEntry = toUnsupportedMcp(environment, name, raw, source);
        if (unsupportedEntry) {
          unsupported.push(unsupportedEntry);
          continue;
        }
      }
      const server = toMcpServer(environment, name, raw, source, index, warnings);
      if (server) {
        servers.set(server.input.serverId, server);
        continue;
      }
      if (isRecord(raw) && typeof raw.enabled === "boolean") {
        const existing = servers.get(
          source.scope === "global"
            ? `${SOURCE}:global${envSegment(environment)}:${name}`
            : `${SOURCE}:project:${source.projectId}${envSegment(environment)}:${name}`
        );
        if (existing) {
          servers.set(existing.input.serverId, {
            ...existing,
            input: { ...existing.input, enabled: raw.enabled },
          });
        }
      }
    }
  }
  return { servers: [...servers.values()], unsupported };
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
  environment: ImportEnvironment,
  source: ConfigSource,
  declaredPath: string
): Promise<string[]> => {
  const root = environment.fs.dirname(source.path);
  if (!/[?*]/.test(declaredPath)) {
    return [resolveDeclaredPath(environment, root, declaredPath)];
  }
  const normalizedPattern = declaredPath.replaceAll("\\", "/").replace(/^\.\//, "");
  const matches = globPatternToRegExp(normalizedPattern);
  const sep = environment.fs.sep;
  return environment.fs.walkFiles(root, 20).then((files) =>
    files.filter((file) => matches.test(file.split(sep).join("/")))
  );
};

const collectPrompts = async (
  environment: ImportEnvironment,
  sources: ConfigSource[],
  configHome: string,
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
  const addDirectoryPrompts = async (
    source: ConfigSource,
    kind: "agent" | "command",
    root: string
  ): Promise<void> => {
    if (!(await environment.fs.exists(root))) return;
    for (const path of await environment.fs.walkFiles(root)) {
      if (!path.endsWith(".md")) continue;
      const id =
        source.scope === "global"
          ? `${SOURCE}:global${envSegment(environment)}:${kind}:${safeSegment(path)}`
          : `${SOURCE}:project:${source.projectId}${envSegment(environment)}:${kind}:${safeSegment(path)}`;
      await addFile(id, `OpenCode ${kind}`, path, source.scope, source.projectId, false);
    }
  };

  for (const source of sources) {
    const idPrefix =
      source.scope === "global"
        ? `${SOURCE}:global${envSegment(environment)}`
        : `${SOURCE}:project:${source.projectId}${envSegment(environment)}`;
    const instructions = asStringArray(source.values.instructions);
    for (const [index, instruction] of instructions.entries()) {
      for (const [pathIndex, path] of (await resolveInstructionPaths(environment, source, instruction)).entries()) {
        await addFile(
          `${idPrefix}:instruction:${index}:${pathIndex}`,
          "OpenCode instruction",
          path,
          source.scope,
          source.projectId
        );
      }
    }
    const commands = isRecord(source.values.command) ? source.values.command : {};
    for (const [name, command] of Object.entries(commands)) {
      if (isRecord(command) && typeof command.template === "string") {
        const prompt = createPrompt(
          `${idPrefix}:command:${safeSegment(name)}`,
          `OpenCode command ${name}`,
          command.template,
          prompts.size
        );
        if (prompt) {
          prompts.set(prompt.promptId, {
            ...prompt,
            isActive: false,
            scope: source.scope,
            ...(source.scope === "project" && source.projectId ? { projectId: source.projectId } : {}),
          });
        }
      }
    }
    const agents = isRecord(source.values.agent) ? source.values.agent : {};
    for (const [name, agent] of Object.entries(agents)) {
      if (isRecord(agent) && typeof agent.prompt === "string") {
        const prompt = createPrompt(
          `${idPrefix}:agent:${safeSegment(name)}`,
          `OpenCode agent ${name}`,
          agent.prompt,
          prompts.size
        );
        if (prompt) {
          prompts.set(prompt.promptId, {
            ...prompt,
            isActive: false,
            scope: source.scope,
            ...(source.scope === "project" && source.projectId ? { projectId: source.projectId } : {}),
          });
        }
      }
    }
    await addDirectoryPrompts(source, "agent", environment.fs.join(source.root, "agent"));
    await addDirectoryPrompts(source, "agent", environment.fs.join(source.root, "agents"));
    await addDirectoryPrompts(source, "command", environment.fs.join(source.root, "command"));
    await addDirectoryPrompts(source, "command", environment.fs.join(source.root, "commands"));
  }

  const instructionsRoot = environment.fs.join(configHome, "instructions");
  if (await environment.fs.exists(instructionsRoot)) {
    for (const path of await environment.fs.walkFiles(instructionsRoot)) {
      if (!path.endsWith(".md")) continue;
      await addFile(
        `${SOURCE}:global${envSegment(environment)}:instruction:${safeSegment(path)}`,
        "OpenCode instruction",
        path,
        "global"
      );
    }
  }

  return { prompts: [...prompts.values()], instructionPaths: uniquePaths(instructionPaths) };
};

const collectSkills = async (
  environment: ImportEnvironment,
  sources: ConfigSource[]
): Promise<EnvironmentDiscoveredSkill[]> => {
  const skills: EnvironmentDiscoveredSkill[] = [];
  const sourcePaths = new Set<string>();
  const tasks: Array<{ source: ConfigSource; sourceRoot: string }> = [];
  for (const source of sources) {
    tasks.push({ source, sourceRoot: environment.fs.join(source.root, "skills") });
    const declaredSkills = isRecord(source.values.skills) ? source.values.skills : {};
    for (const path of asStringArray(declaredSkills.paths)) {
      tasks.push({
        source,
        sourceRoot: resolveDeclaredPath(environment, environment.fs.dirname(source.path), path),
      });
    }
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
    for (const sourceDir of skillDirs) {
      if (sourcePaths.has(sourceDir)) continue;
      sourcePaths.add(sourceDir);
      skills.push({
        sourceDir,
        scope: task.source.scope,
        ...(task.source.projectId ? { projectId: task.source.projectId } : {}),
        ...(task.source.projectRoot ? { projectRoot: task.source.projectRoot } : {}),
        environmentId: environment.id,
        environmentLabel: environment.label,
        contentHash: "",
        ...(environment.sshWorkspaceUrl ? { sshWorkspaceUrl: environment.sshWorkspaceUrl } : {}),
      });
    }
  }
  for (const skill of skills) {
    skill.contentHash = await hashSkillForEnvironment(environment, skill.sourceDir);
  }
  return skills;
};

const scanOpenCodeEnvironment = async (
  environment: ImportEnvironment,
  warnings: string[]
): Promise<ProviderScannerResult> => {
  const configHome = environment.fs.join(environment.home, ".config", "opencode");
  const envWarnings = [...environment.warnings];
  const sources = await collectConfigSources(environment, configHome, envWarnings);
  const { servers, unsupported } = collectMcpServers(environment, sources, envWarnings);
  const { prompts, instructionPaths } = await collectPrompts(environment, sources, configHome, envWarnings);
  const skills = await collectSkills(environment, sources);

  const configPaths = [
    ...configCandidates(configHome, environment.fs),
    environment.fs.join(environment.home, ".opencode", "opencode.json"),
    environment.fs.join(environment.home, ".opencode", "opencode.jsonc"),
  ].map((path) => ({
    label: "Global configuration",
    path,
    found: environment.fs.exists(path),
  }));
  const found =
    (await environment.fs.exists(configHome)) ||
    (await environment.fs.exists(environment.fs.join(environment.home, ".opencode")));
  if (!found) {
    envWarnings.push(`OpenCode configuration not found: ${configHome}`);
  }
  warnings.push(...envWarnings);
  return {
    environment,
    home: configHome,
    found,
    configPaths: await Promise.all(
      configPaths.map(async (configPath) => ({
        ...configPath,
        found: await configPath.found,
      }))
    ),
    instructionPaths: instructionPaths.map((path) => ({
      label: "Imported instruction",
      path,
      found: true,
    })),
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
): OpenCodeImportContext => {
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

export const buildOpenCodeContext = async (
  native: NativeBridge,
  activeDirectoryId?: string
): Promise<OpenCodeImportContext> => {
  const { scans, warnings } = await scanProviderStandalone(native, scanOpenCodeEnvironment, activeDirectoryId);
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
  type: prompt.promptId.includes(":command:")
    ? "command"
    : prompt.promptId.includes(":agent:")
    ? "agent"
    : "prompt",
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

export const discoverOpenCodeImportFromContext = async (
  context: OpenCodeImportContext
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

export const discoverOpenCodeImport = async (
  native: NativeBridge
): Promise<ImportSourceDiscovery> =>
  discoverOpenCodeImportFromContext(await buildOpenCodeContext(native));

export const resolveOpenCodeSelectedImports = async (
  native: NativeBridge,
  selected: SelectedImportCandidate[],
  context?: OpenCodeImportContext
): Promise<{ actions: ResolvedImportAction[]; warnings: string[] }> => {
  const ctx = context ?? (await buildOpenCodeContext(native));
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
