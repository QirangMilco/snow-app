import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import * as posixPath from "node:path/posix";
import type { ImportEnvironmentKind } from "../../shared/importDiscovery";
import type { NativeBridge, WorkspaceDirectoryRecord } from "../native/types";
import {
  IMPORT_SCAN_LIMITS,
  hashImportPathInWorker,
  walkImportFilesInWorker,
} from "./discoveryWorker";
import { buildSshConnectParams, withSshSession } from "../ssh/remoteWorkspaceCommand";
import {
  connectSsh,
  disconnectSsh,
  executeSshCommand,
  getSshProfileKey,
  listSshDirectory,
  parseSshUrl,
  readSshFile,
  statSshEntry,
} from "../ssh/sshManager";

export type ImportDirEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

/**
 * Filesystem facade of one import environment. Local and WSL environments
 * are backed by node:fs (WSL through `\\wsl$\` UNC paths); SSH environments
 * are backed by an open SFTP session.
 */
export type ImportEnvironmentFs = {
  sep: "\\" | "/";
  join: (...segments: string[]) => string;
  dirname: (value: string) => string;
  basename: (value: string) => string;
  /**
   * Resolve a path declared inside an external configuration file (absolute
   * or relative) against the directory that contains the configuration.
   */
  resolveDeclared: (baseDir: string, declared: string) => string;
  exists: (target: string) => Promise<boolean>;
  /** Read a UTF-8 text file; null when missing or unreadable. */
  readText: (target: string) => Promise<string | null>;
  /** List directory entries; null when missing or unreadable. */
  readDir: (target: string) => Promise<ImportDirEntry[] | null>;
  /** Recursively list files under a directory (bounded by scan limits). */
  walkFiles: (root: string, maxDepth?: number) => Promise<string[]>;
  /** Content hash compatible with the local discovery worker hash. */
  hashPath: (target: string) => Promise<string>;
};

export type McpStdioAdaptation =
  | { command: string; args: string[] }
  | { unsupportedReason: string };

export type ImportEnvironment = {
  readonly id: string;
  readonly kind: ImportEnvironmentKind;
  readonly label: string;
  /** Home directory in environment-native notation (for display). */
  readonly displayHome: string;
  /** Home directory addressable by this environment's fs facade. */
  readonly home: string;
  readonly projects: WorkspaceDirectoryRecord[];
  readonly warnings: string[];
  readonly fs: ImportEnvironmentFs;
  /** SSH workspace URL used to reopen a connection at commit time (ssh only). */
  readonly sshWorkspaceUrl?: string;
  /** Environment-native root path of a registered project. */
  projectRoot: (project: WorkspaceDirectoryRecord) => string;
  /**
   * Whether a project key declared by an external tool (environment-native
   * path) refers to the given registered project.
   */
  projectMatches: (project: WorkspaceDirectoryRecord, declaredPath: string) => boolean;
  /** Adapt a stdio MCP command so it can run on this machine. */
  adaptStdioMcp: (command: string, args: string[]) => McpStdioAdaptation;
  dispose: () => void;
};

export const LOCAL_ENVIRONMENT_ID = "local";

/** Safe segment of an environment id for embedding into logical ids. */
export const environmentIdSegment = (environment: ImportEnvironment): string =>
  environment.kind === "local"
    ? ""
    : "env-" + environment.id.replace(/[^A-Za-z0-9._]+/g, "-");

/* ------------------------------------------------------------------------ */
/* Local (node:fs) filesystem facade, shared by local and WSL environments  */
/* ------------------------------------------------------------------------ */

const localFs: ImportEnvironmentFs = {
  sep: path.sep === "/" ? "/" : "\\",
  join: (...segments) => path.join(...segments),
  dirname: (value) => path.dirname(value),
  basename: (value) => path.basename(value),
  resolveDeclared: (baseDir, declared) =>
    path.isAbsolute(declared) ? path.resolve(declared) : path.resolve(baseDir, declared),
  exists: async (target) => {
    try {
      await fsp.access(target);
      return true;
    } catch {
      return false;
    }
  },
  readText: async (target) => {
    try {
      return (await fsp.readFile(target, "utf8")).trim() || null;
    } catch {
      return null;
    }
  },
  readDir: async (target) => {
    try {
      const entries = await fsp.readdir(target, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        path: path.join(target, entry.name),
        isDirectory: entry.isDirectory(),
        size: 0,
      }));
    } catch {
      return null;
    }
  },
  walkFiles: (root, maxDepth) =>
    walkImportFilesInWorker(root, Math.min(maxDepth ?? IMPORT_SCAN_LIMITS.maxDepth, IMPORT_SCAN_LIMITS.maxDepth)),
  hashPath: (target) => hashImportPathInWorker(target),
};

/* ------------------------------------------------------------------------ */
/* WSL                                                                      */
/* ------------------------------------------------------------------------ */

type WslUncInfo = { distro: string; linuxPath: string };

/**
 * Parse `\\wsl$\<distro>\...` / `\\wsl.localhost\<distro>\...` UNC paths.
 */
export const parseWslUncPath = (value: string): WslUncInfo | null => {
  const match = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\/]+)([\\/].*)?$/.exec(value);
  if (!match) {
    return null;
  }
  const linuxPath = (match[2] ?? "\\").replaceAll("\\", "/") || "/";
  return { distro: match[1], linuxPath };
};

const linuxToWslUnc = (distro: string, linuxPath: string): string =>
  `\\\\wsl$\\${distro}${linuxPath.replaceAll("/", "\\")}`;

/**
 * Resolve the default user's Linux home of a distro by reading `/etc/passwd`
 * through the 9P UNC mount. Avoids launching any process inside the distro.
 */
const resolveWslHome = async (distro: string): Promise<string | null> => {
  try {
    const passwd = await fsp.readFile(linuxToWslUnc(distro, "/etc/passwd"), "utf8");
    let fallbackUser: string | null = null;
    for (const line of passwd.split("\n")) {
      const fields = line.trim().split(":");
      if (fields.length < 6) {
        continue;
      }
      const [name, , uidText, , , home] = fields;
      const uid = Number.parseInt(uidText, 10);
      if (!Number.isFinite(uid) || name === "nobody") {
        continue;
      }
      if (uid >= 1000) {
        return home.trim() || `/home/${name}`;
      }
      if (uid === 0) {
        fallbackUser = home.trim() || "/root";
      }
    }
    return fallbackUser;
  } catch {
    return null;
  }
};

const createWslEnvironment = async (
  distro: string,
  distroProjects: WorkspaceDirectoryRecord[]
): Promise<ImportEnvironment | null> => {
  const linuxHome = await resolveWslHome(distro);
  const warnings: string[] = [];
  if (!linuxHome) {
    return null;
  }
  const home = linuxToWslUnc(distro, linuxHome);
  const wslProjects = distroProjects.filter((project) => {
    const info = project.kind === "local" ? parseWslUncPath(project.path) : null;
    return info !== null && info.distro.toLowerCase() === distro.toLowerCase();
  });
  const fs: ImportEnvironmentFs = {
    ...localFs,
    resolveDeclared: (baseDir, declared) => {
      const trimmed = declared.trim();
      if (trimmed.startsWith("/")) {
        return linuxToWslUnc(distro, trimmed);
      }
      return path.isAbsolute(trimmed)
        ? path.resolve(trimmed)
        : path.resolve(baseDir, trimmed);
    },
  };
  return {
    id: `wsl:${distro}`,
    kind: "wsl",
    label: `WSL · ${distro}`,
    displayHome: linuxHome,
    home,
    projects: wslProjects,
    warnings,
    fs,
    projectRoot: (project) => project.path,
    projectMatches: (project, declaredPath) => {
      const info = parseWslUncPath(project.path);
      if (!info) {
        return false;
      }
      const projectLinux = posixPath.resolve(info.linuxPath);
      const declaredLinux = posixPath.resolve(declaredPath.trim());
      return (
        declaredLinux === projectLinux ||
        declaredLinux.startsWith(`${projectLinux}/`)
      );
    },
    adaptStdioMcp: (command, args) => ({
      command: "wsl.exe",
      args: ["-d", distro, "--", command, ...args],
    }),
    dispose: () => {},
  };
};

/* ------------------------------------------------------------------------ */
/* SSH                                                                      */
/* ------------------------------------------------------------------------ */

const SSH_IGNORED_DIRECTORIES = new Set([".git", "node_modules", "sessions"]);
const SSH_EXEC_TIMEOUT_MS = 10_000;

const remoteRelative = (root: string, target: string): string => {
  const rootSegments = root.split("/").filter(Boolean);
  const targetSegments = target.split("/").filter(Boolean);
  return targetSegments.slice(rootSegments.length).join("\\");
};

type SshScanResult = { files: string[] };

/**
 * Depth-first walk over SFTP mirroring the local discovery worker: sorted
 * entries per directory, ignored directories skipped, bounded by the same
 * file/byte/depth/time limits.
 */
const scanSshTree = async (
  sessionId: string,
  root: string,
  maxDepth: number
): Promise<SshScanResult> => {
  const files: string[] = [];
  const startedAt = Date.now();
  let byteCount = 0;
  const visit = async (current: string, depth: number): Promise<void> => {
    if (
      depth > maxDepth ||
      files.length >= IMPORT_SCAN_LIMITS.maxFiles ||
      Date.now() - startedAt > IMPORT_SCAN_LIMITS.timeoutMs
    ) {
      return;
    }
    let entries;
    try {
      entries = await listSshDirectory(sessionId, current);
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        files.length >= IMPORT_SCAN_LIMITS.maxFiles ||
        Date.now() - startedAt > IMPORT_SCAN_LIMITS.timeoutMs
      ) {
        return;
      }
      if (entry.isDirectory) {
        if (!SSH_IGNORED_DIRECTORIES.has(entry.name)) {
          await visit(entry.path, depth + 1);
        }
        continue;
      }
      if (byteCount + entry.size > IMPORT_SCAN_LIMITS.maxBytes) {
        continue;
      }
      byteCount += entry.size;
      files.push(entry.path);
    }
  };
  await visit(root, 0);
  return { files };
};

const hashSshPath = async (sessionId: string, root: string): Promise<string> => {
  const stats = await statSshEntry(sessionId, root);
  if (!stats) {
    return createHash("sha256")
      .update(JSON.stringify({ missing: root }))
      .digest("hex");
  }
  const hasher = createHash("sha256");
  if (!stats.isDirectory()) {
    try {
      hasher.update("");
      hasher.update(await readSshFile(sessionId, root));
    } catch {
      hasher.update(JSON.stringify({ unreadable: root }));
    }
    return hasher.digest("hex");
  }
  const normalizedRoot = root.replace(/\/+$/, "") || "/";
  const { files } = await scanSshTree(sessionId, normalizedRoot, IMPORT_SCAN_LIMITS.maxDepth);
  for (const file of files) {
    // Join relative segments with the Windows separator so the hash matches
    // the local worker hash of the same tree once it has been downloaded.
    hasher.update(
      normalizedRoot === "/"
        ? file.replace(/^\/+/, "").split("/").join("\\")
        : remoteRelative(normalizedRoot, file)
    );
    try {
      hasher.update(await readSshFile(sessionId, file));
    } catch {
      hasher.update(JSON.stringify({ unreadable: file }));
    }
  }
  return hasher.digest("hex");
};

const createSshFs = (sessionId: string): ImportEnvironmentFs => ({
  sep: "/",
  join: (...segments) => posixPath.join(...segments),
  dirname: (value) => posixPath.dirname(value),
  basename: (value) => posixPath.basename(value),
  resolveDeclared: (baseDir, declared) =>
    posixPath.isAbsolute(declared.trim())
      ? posixPath.resolve(declared.trim())
      : posixPath.resolve(baseDir, declared.trim()),
  exists: async (target) => (await statSshEntry(sessionId, target)) !== null,
  readText: async (target) => {
    try {
      const content = (await readSshFile(sessionId, target)).toString("utf8").trim();
      return content || null;
    } catch {
      return null;
    }
  },
  readDir: async (target) => {
    try {
      const entries = await listSshDirectory(sessionId, target);
      return entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        isDirectory: entry.isDirectory,
        size: entry.size,
      }));
    } catch {
      return null;
    }
  },
  walkFiles: async (root, maxDepth) =>
    (
      await scanSshTree(
        sessionId,
        root,
        Math.min(maxDepth ?? IMPORT_SCAN_LIMITS.maxDepth, IMPORT_SCAN_LIMITS.maxDepth)
      )
    ).files,
  hashPath: (target) => hashSshPath(sessionId, target),
});

const SSH_HOME_COMMAND =
  'printf %s "${HOME:-$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)}"';

type SshProjectGroup = {
  profileKey: string;
  workspaceUrl: string;
  projects: WorkspaceDirectoryRecord[];
};

const groupSshProjects = (
  projects: WorkspaceDirectoryRecord[]
): SshProjectGroup[] => {
  const groups = new Map<string, SshProjectGroup>();
  for (const project of projects) {
    if (project.kind !== "ssh" || !project.path.startsWith("ssh://")) {
      continue;
    }
    let parsed;
    try {
      parsed = parseSshUrl(project.path);
    } catch {
      continue;
    }
    const profileKey = getSshProfileKey(parsed);
    const existing = groups.get(profileKey);
    if (existing) {
      existing.projects.push(project);
    } else {
      groups.set(profileKey, {
        profileKey,
        workspaceUrl: project.path,
        projects: [project],
      });
    }
  }
  return [...groups.values()];
};

const openSshEnvironment = async (
  group: SshProjectGroup
): Promise<ImportEnvironment> => {
  const sessionId = await connectSsh(buildSshConnectParams(group.workspaceUrl));
  const warnings: string[] = [];
  let home = "";
  try {
    const output = (
      await executeSshCommand(sessionId, SSH_HOME_COMMAND, {
        timeoutMs: SSH_EXEC_TIMEOUT_MS,
      })
    ).trim();
    if (output.startsWith("/") && !/\s/.test(output)) {
      home = output;
    }
  } catch {
    home = "";
  }
  if (!home) {
    const username = parseSshUrl(group.workspaceUrl).username;
    home = `/home/${username}`;
    if (!(await statSshEntry(sessionId, home))) {
      home = "";
    }
    warnings.push(
      `Unable to resolve the remote home directory of ${group.profileKey}; ` +
        (home ? `falling back to ${home}` : "global configuration is skipped")
    );
  }
  const fs = createSshFs(sessionId);
  return {
    id: `ssh:${group.profileKey}`,
    kind: "ssh",
    label: `SSH · ${group.profileKey}`,
    displayHome: home || "~",
    home,
    projects: group.projects,
    warnings,
    fs,
    sshWorkspaceUrl: group.workspaceUrl,
    projectRoot: (project) => {
      try {
        return parseSshUrl(project.path).remotePath.replace(/\/+$/, "") || "/";
      } catch {
        return "/";
      }
    },
    projectMatches: (project, declaredPath) => {
      let remoteRoot;
      try {
        remoteRoot = parseSshUrl(project.path).remotePath.replace(/\/+$/, "") || "/";
      } catch {
        return false;
      }
      const projectLinux = posixPath.resolve(remoteRoot);
      const declaredLinux = posixPath.resolve(declaredPath.trim());
      return (
        declaredLinux === projectLinux ||
        declaredLinux.startsWith(`${projectLinux}/`)
      );
    },
    adaptStdioMcp: () => ({
      unsupportedReason:
        "Stdio MCP commands declared on an SSH remote host cannot run locally",
    }),
    dispose: () => disconnectSsh(sessionId),
  };
};

/**
 * Download a remote skill directory into a local staging directory so the
 * regular directory commit machinery can copy it into place. Returns the
 * staging directory plus a cleanup callback for the caller.
 */
export const downloadSshSkillSource = async (
  sshWorkspaceUrl: string,
  sourceDir: string
): Promise<{ stagingRoot: string; localDir: string; cleanup: () => void }> => {
  const stagingRoot = await fsp.mkdtemp(path.join(tmpdir(), "snow-import-ssh-skill-"));
  const localDir = path.join(stagingRoot, posixPath.basename(sourceDir.replace(/\/+$/, "")) || "skill");
  const cleanup = (): void => {
    fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  };
  try {
    await withSshSession(sshWorkspaceUrl, async (sessionId, _remoteRoot) => {
      const stats = await statSshEntry(sessionId, sourceDir);
      if (!stats || !stats.isDirectory()) {
        throw new Error(`Remote skill source no longer exists: ${sourceDir}`);
      }
      const download = async (remoteDir: string, targetDir: string, depth: number): Promise<void> => {
        if (depth > IMPORT_SCAN_LIMITS.maxDepth) {
          return;
        }
        await fsp.mkdir(targetDir, { recursive: true });
        const entries = await listSshDirectory(sessionId, remoteDir);
        for (const entry of entries) {
          if (entry.isDirectory) {
            if (!SSH_IGNORED_DIRECTORIES.has(entry.name)) {
              await download(entry.path, path.join(targetDir, entry.name), depth + 1);
            }
            continue;
          }
          if (entry.size > IMPORT_SCAN_LIMITS.maxBytes) {
            continue;
          }
          const content = await readSshFile(sessionId, entry.path);
          await fsp.writeFile(path.join(targetDir, entry.name), content);
        }
      };
      await download(sourceDir, localDir, 0);
    });
    return { stagingRoot, localDir, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
};

/* ------------------------------------------------------------------------ */
/* Environment discovery lifecycle                                          */
/* ------------------------------------------------------------------------ */

export type ImportEnvironmentsResult = {
  environments: ImportEnvironment[];
  warnings: string[];
};

/**
 * Open the import environments needed by the currently active project. When
 * `activeDirectoryId` is provided, only that project's environment is opened
 * (plus the local environment for global config). When omitted, the local
 * environment is opened alone — the global settings view never reaches into
 * WSL or SSH.
 *
 * - A Windows path → local environment (always opened; holds global config).
 * - A `\\wsl$\` path → a WSL environment for that distro.
 * - An `ssh://` path → an SSH environment for that host.
 *
 * SSH sessions stay open until `closeImportEnvironments` is called.
 */
export const openImportEnvironments = async (
  native: NativeBridge,
  activeDirectoryId?: string
): Promise<ImportEnvironmentsResult> => {
  const allProjects = await native.listWorkspaceDirectories();
  const warnings: string[] = [];

  // The active project — only environments derived from it are opened.
  const activeProject = activeDirectoryId
    ? allProjects.find((item) => item.directoryId === activeDirectoryId)
    : undefined;

  const localEnvironment = (
    projects: WorkspaceDirectoryRecord[] = []
  ): ImportEnvironment => ({
    id: LOCAL_ENVIRONMENT_ID,
    kind: "local",
    label: "Local",
    displayHome: homedir(),
    home: homedir(),
    projects,
    warnings: [],
    fs: localFs,
    projectRoot: (project) => project.path,
    projectMatches: (project, declaredPath) => {
      const declared = path.resolve(declaredPath.trim());
      const root = path.resolve(project.path);
      return declared === root || declared.startsWith(`${root}${path.sep}`);
    },
    adaptStdioMcp: (command, args) => ({ command, args }),
    dispose: () => {},
  });

  // No active project (or active project is local) → just scan local.
  if (!activeProject || activeProject.kind === "local") {
    if (activeProject) {
      const wslInfo = parseWslUncPath(activeProject.path);
      if (wslInfo) {
        // Active project is a `\\wsl$\` path → open that distro + local.
        try {
          const wslEnv = await createWslEnvironment(wslInfo.distro, [activeProject]);
          if (wslEnv) {
            return { environments: [localEnvironment(), wslEnv], warnings };
          }
          warnings.push(
            `Unable to read the home directory of WSL distribution ${wslInfo.distro}; it was skipped`
          );
        } catch (error) {
          warnings.push(
            `Failed to scan WSL distribution ${wslInfo.distro}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        return { environments: [localEnvironment()], warnings };
      }
    }
    // Active project is a plain Windows path, or no active project at all.
    return {
      environments: [localEnvironment(activeProject ? [activeProject] : [])],
      warnings,
    };
  }

  // Active project is SSH → open that host + local.
  if (activeProject.kind === "ssh") {
    const group = groupSshProjects([activeProject])[0];
    if (group) {
      try {
        const sshEnv = await openSshEnvironment(group);
        return { environments: [localEnvironment(), sshEnv], warnings };
      } catch (error) {
        warnings.push(
          `Unable to connect SSH host ${group.profileKey}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    return { environments: [localEnvironment()], warnings };
  }

  return { environments: [localEnvironment()], warnings };
};

export const closeImportEnvironments = (
  environments: ImportEnvironment[]
): void => {
  for (const environment of environments) {
    try {
      environment.dispose();
    } catch {
      // Disposal is best-effort; sessions time out on their own.
    }
  }
};
