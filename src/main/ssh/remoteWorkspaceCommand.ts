import { dirname } from "node:path/posix";
import { processFileContent } from "../utils/fileReader";
import {
  connectSsh,
  disconnectSsh,
  executeSshCommand,
  listSshDirectory,
  parseSshUrl,
  readSshFile,
  writeSshFile,
  type SshConnectParams,
} from "./sshManager";
import { getDecryptedSecret, getSshCredential } from "./sshCredentials";

const REMOTE_SEARCH_MAX_DEPTH = 15;
const REMOTE_SEARCH_MAX_RESULTS = 200;
// Mirrors the local ripgrep timeout in native/src/mcp/servers/grep.rs so the
// SSH branch cannot hang the tool card forever when the remote side stalls.
const REMOTE_GREP_TIMEOUT_MS = 30_000;

export type RemoteWorkspaceCommand = {
  operation: string;
  argsJson: string;
};

type RemoteWorkspaceCommandArgs = {
  filePath?: unknown;
  startLine?: unknown;
  endLine?: unknown;
  searchContent?: unknown;
  replaceContent?: unknown;
  occurrence?: unknown;
  content?: unknown;
  overwrite?: unknown;
  allowIgnored?: unknown;
  pattern?: unknown;
  path?: unknown;
  fileGlob?: unknown;
  isRegex?: unknown;
  caseSensitive?: unknown;
  maxResults?: unknown;
  command?: unknown;
  workingDirectory?: unknown;
  timeout?: unknown;
};

/**
 * 远程低价值目录清单：与 Rust 端 LOW_VALUE_DIR_COMPONENTS 对齐。
 * 远程 node_modules / target 等目录同样会撑爆上下文，需在 SSH 链路上拦截。
 */
const REMOTE_LOW_VALUE_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "target", "dist", "out",
  "build", ".next", ".nuxt", ".cache", ".turbo", "__pycache__",
  ".pytest_cache", ".venv", "venv", ".idea", ".vscode", "coverage",
  ".nyc_output", "release",
]);

/**
 * 判断 ssh:// 远程路径是否位于低价值目录，返回命中的目录名（无则 null）。
 * 只匹配 ssh:// 之后的路径部分（host 不参与匹配）；大小写精确匹配
 * （Linux 远程主机常见；macOS 大小写不敏感远程上的变体可绕过，风险低，
 * 与本地的大小写不敏感策略有意不一致，避免误伤 Linux 上的大写目录）。
 */
const remoteLowValueDir = (sshPath: string): string | null => {
  const schemeEnd = sshPath.indexOf("://");
  const pathStart =
    schemeEnd >= 0 ? sshPath.indexOf("/", schemeEnd + 3) : -1;
  const remotePart = pathStart >= 0 ? sshPath.slice(pathStart + 1) : "";
  for (const part of remotePart.split("/")) {
    if (REMOTE_LOW_VALUE_DIRS.has(part)) {
      return part;
    }
  }
  return null;
};

type RemoteWorkspaceSearchMatch = {
  file: string;
  line: number;
  content: string;
};

export const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'"'"'`)}'`;

export const normalizeRemotePath = (path: string): string => {
  const normalized = path.replace(/\/+$/, "");
  return normalized || "/";
};

const validateSshWorkspacePath = (path: unknown, fieldName: string): string => {
  if (typeof path !== "string" || !path.trim().startsWith("ssh://")) {
    throw new Error(`${fieldName} must be an SSH workspace path`);
  }
  return path.trim();
};

const getRemotePathName = (path: string): string => {
  const normalizedPath = normalizeRemotePath(path);
  const separatorIndex = normalizedPath.lastIndexOf("/");
  return normalizedPath.slice(separatorIndex + 1) || "/";
};

const getRemoteRelativePath = (path: string, rootPath: string): string => {
  const normalizedPath = normalizeRemotePath(path);
  const normalizedRoot = normalizeRemotePath(rootPath);

  if (normalizedPath === normalizedRoot) {
    return ".";
  }
  if (normalizedRoot === "/") {
    return normalizedPath.replace(/^\/+/, "");
  }
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }

  return normalizedPath.replace(/^\/+/, "");
};

export const buildRemoteWorkspaceUri = (
  workspacePath: string,
  remotePath: string,
  remoteRootPath: string
): string => {
  const relativePath = getRemoteRelativePath(remotePath, remoteRootPath);
  const normalizedWorkspacePath = workspacePath.replace(/\/+$/, "");

  return relativePath === "."
    ? normalizedWorkspacePath
    : `${normalizedWorkspacePath}/${relativePath}`;
};

export const buildSshConnectParams = (workspacePath: string): SshConnectParams => {
  const parsed = parseSshUrl(workspacePath);
  const credential = getSshCredential(
    parsed.host,
    parsed.port,
    parsed.username
  );
  const connectParams: SshConnectParams = {
    host: parsed.host,
    port: parsed.port,
    username: parsed.username,
    authMethod: credential?.authMethod ?? "password",
  };

  if (credential?.privateKeyPath) {
    connectParams.privateKeyPath = credential.privateKeyPath;
  }

  const secret = credential?.encryptedSecret
    ? getDecryptedSecret(parsed.host, parsed.port, parsed.username)
    : null;
  if (secret) {
    if (connectParams.authMethod === "password") {
      connectParams.password = secret;
    } else {
      connectParams.passphrase = secret;
    }
  }

  return connectParams;
};

export const withSshSession = async <T>(
  workspacePath: string,
  action: (
    sessionId: string,
    remotePath: string,
    parsedPath: ReturnType<typeof parseSshUrl>
  ) => Promise<T>
): Promise<T> => {
  const parsedPath = parseSshUrl(workspacePath);
  const sessionId = await connectSsh(buildSshConnectParams(workspacePath));
  try {
    return await action(sessionId, parsedPath.remotePath, parsedPath);
  } finally {
    disconnectSsh(sessionId);
  }
};

const readTextFile = async (
  workspacePath: string,
  startLine: number | undefined,
  endLine: number | undefined
): Promise<Record<string, unknown>> => {
  return withSshSession(workspacePath, async (sessionId, remotePath) => {
    const file = processFileContent(
      remotePath,
      await readSshFile(sessionId, remotePath)
    );
    if (file.isBinary || file.isImage) {
      throw new Error("Remote filesystem edit operations require a text file");
    }

    const lines = file.content.split("\n");
    const totalLines = lines.length;
    const requestedStart = Math.max(1, Math.floor(startLine ?? 1));
    const requestedEnd = Math.max(
      requestedStart,
      Math.floor(endLine ?? totalLines)
    );
    const selected = lines.slice(requestedStart - 1, requestedEnd);

    return {
      content: selected
        .map(
          (line, index) =>
            `${String(requestedStart + index).padStart(6, " ")}: ${line}`
        )
        .join("\n"),
      totalLines,
      startLine: requestedStart,
      endLine: Math.min(requestedEnd, totalLines),
    };
  });
};

const readRemoteText = async (workspacePath: string): Promise<string> =>
  withSshSession(workspacePath, async (sessionId, remotePath) => {
    const file = processFileContent(
      remotePath,
      await readSshFile(sessionId, remotePath)
    );
    if (file.isBinary || file.isImage) {
      throw new Error("Remote filesystem edit operations require a text file");
    }
    return file.content;
  });

const writeRemoteText = async (
  workspacePath: string,
  content: string
): Promise<void> => {
  await withSshSession(workspacePath, async (sessionId, remotePath) =>
    writeSshFile(sessionId, remotePath, content)
  );
};

/**
 * Read the project ROLE.md from a remote SSH workspace.
 *
 * Mirrors RoleEditorPanel's SSH access path (`<remotePath>/ROLE.md`) so the
 * Rust prompt builder can inject the project role even for `ssh://`
 * workspaces. Returns `null` when the file does not exist, is binary, or SSH
 * is unavailable — callers then fall back to the global ROLE.md.
 */
export type RemoteRoleContext = {
  content: string | null;
  includeGlobalRules: boolean;
};

export const readRemoteRoleContext = async (
  workspacePath: string
): Promise<RemoteRoleContext> => {
  try {
    return await withSshSession(
      workspacePath,
      async (sessionId, remotePath) => {
        const projectRoot = remotePath.replace(/\/+$/, "");
        const rolePath = `${projectRoot}/ROLE.md`;
        let content: string | null = null;
        try {
          const file = processFileContent(
            rolePath,
            await readSshFile(sessionId, rolePath)
          );
          if (!file.isBinary && !file.isImage) {
            content = file.content.trim() || null;
          }
        } catch {
          content = null;
        }

        let includeGlobalRules = true;
        try {
          const settingsPath = `${projectRoot}/.snow/settings.json`;
          const settingsFile = processFileContent(
            settingsPath,
            await readSshFile(sessionId, settingsPath)
          );
          if (!settingsFile.isBinary && !settingsFile.isImage) {
            const settings = JSON.parse(settingsFile.content) as {
              role?: { includeGlobalRules?: unknown };
            };
            if (typeof settings.role?.includeGlobalRules === "boolean") {
              includeGlobalRules = settings.role.includeGlobalRules;
            }
          }
        } catch {
          includeGlobalRules = true;
        }

        return { content, includeGlobalRules };
      }
    );
  } catch {
    return { content: null, includeGlobalRules: true };
  }
};

const buildRemoteMkdirCommand = (remotePath: string): string =>
  `mkdir -p -- ${shellQuote(remotePath)}`;

const buildRemoteStatCommand = (remotePath: string): string =>
  `if [ -e ${shellQuote(remotePath)} ]; then printf present; fi`;

const ensureString = (value: unknown, fieldName: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  return value;
};

const ensureOptionalPositiveInteger = (value: unknown): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Line range values must be finite numbers");
  }
  return Math.max(1, Math.floor(value));
};

const replaceContent = (
  content: string,
  searchContent: string,
  replacement: string,
  occurrence: number
): { content: string; matchedLineStart: number; matchedLineEnd: number } => {
  if (occurrence < 1) {
    throw new Error("occurrence must be greater than zero");
  }

  let offset = 0;
  let foundIndex = -1;
  for (let index = 0; index < occurrence; index += 1) {
    foundIndex = content.indexOf(searchContent, offset);
    if (foundIndex < 0) {
      throw new Error("searchContent not found in remote file");
    }
    offset = foundIndex + Math.max(1, searchContent.length);
  }

  const prefix = content.slice(0, foundIndex);
  const matchedLineStart = prefix.split("\n").length;
  const matchedLineEnd =
    matchedLineStart + searchContent.split("\n").length - 1;
  return {
    content: `${prefix}${replacement}${content.slice(
      foundIndex + searchContent.length
    )}`,
    matchedLineStart,
    matchedLineEnd,
  };
};

const shellGlobExpression = (fileGlob: string | undefined): string => {
  if (!fileGlob) {
    return "*";
  }
  return fileGlob;
};

const buildRemoteGrepCommand = (
  remotePath: string,
  pattern: string,
  fileGlob: string | undefined,
  isRegex: boolean,
  caseSensitive: boolean,
  maxResults: number
): string => {
  const flags = ["-nH"];
  if (!isRegex) {
    flags.push("-F");
  }
  if (!caseSensitive) {
    flags.push("-i");
  }
  flags.push(
    ...[...REMOTE_LOW_VALUE_DIRS].map((dir) => `--exclude-dir=${dir}`)
  );
  const glob = shellGlobExpression(fileGlob);
  const script = [
    `root=${shellQuote(remotePath)}`,
    `pattern=${shellQuote(pattern)}`,
    `glob=${shellQuote(glob)}`,
    `limit=${Math.max(1, maxResults)}`,
    `grep ${flags.map(shellQuote).join(" ")} -- ${shellQuote(
      pattern
    )} $(find "$root" -type f -path "$root/$glob" -print) 2>/dev/null | head -n "$limit" || true`,
  ].join("\n");

  return `sh -lc ${shellQuote(script)}`;
};

const parseGrepLines = (
  output: string,
  workspacePath: string,
  remoteRootPath: string
): RemoteWorkspaceSearchMatch[] =>
  output.split("\n").flatMap((line) => {
    // Parse from the LEFT: `path:line:content` with the FIRST `:<digits>:`
    // pair as the separator. Content may contain colons (e.g. `case "x": y`),
    // so splitting from the last two colons would misparse the line number
    // and silently drop the match. File paths with embedded colons are
    // extremely rare on POSIX, and the lazy quantifier still skips them when
    // a `:<digits>:` separator exists later in the line.
    const parsed = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!parsed) {
      return [];
    }
    const lineNumber = Number(parsed[2]);
    if (!Number.isInteger(lineNumber)) {
      return [];
    }
    return [
      {
        file: buildRemoteWorkspaceUri(
          workspacePath,
          parsed[1],
          remoteRootPath
        ),
        line: lineNumber,
        content: parsed[3],
      },
    ];
  });

const executeFilesystemRead = async (
  args: RemoteWorkspaceCommandArgs
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.filePath, "filePath");
  const startLine = ensureOptionalPositiveInteger(args.startLine);
  const endLine = ensureOptionalPositiveInteger(args.endLine);

  return withSshSession(workspacePath, async (sessionId, remotePath) => {
    try {
      const entries = await listSshDirectory(sessionId, remotePath);
      // 确认为目录后才做低价值拦截（与本地 is_dir 对称：名为 build 等的
      // 文件不误拦）。allowIgnored=true 时列出全部条目。
      if (args.allowIgnored !== true) {
        const lowValue = remoteLowValueDir(workspacePath);
        if (lowValue) {
          return {
            content: `Path is inside a "${lowValue}" directory. Reading dependency/build/cache files is skipped by default to protect the context window. If you genuinely need this file (e.g. debugging a dependency), call filesystem-read again with allowIgnored=true and only read the specific file you need.`,
            skipped: true,
            reason: `inside a "${lowValue}" directory`,
          };
        }
      }
      return {
        content: entries
          .map((entry) => `${entry.name}${entry.isDirectory ? "/" : ""}`)
          .join("\n"),
      };
    } catch {
      // 文件：直接读取（单文件读取由 readTextFile 的大小上限兜底）
      return readTextFile(workspacePath, startLine, endLine);
    }
  });
};

const executeFilesystemReplaceEdit = async (
  args: RemoteWorkspaceCommandArgs
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.filePath, "filePath");
  const searchContent = ensureString(args.searchContent, "searchContent");
  const replacement = ensureString(args.replaceContent, "replaceContent");
  const occurrence =
    typeof args.occurrence === "number" && Number.isFinite(args.occurrence)
      ? Math.floor(args.occurrence)
      : 1;
  const content = await readRemoteText(workspacePath);
  const result = replaceContent(
    content,
    searchContent,
    replacement,
    occurrence
  );
  await writeRemoteText(workspacePath, result.content);

  return {
    success: true,
    occurrence,
    matchType: "exact",
    matchedLineStart: result.matchedLineStart,
    matchedLineEnd: result.matchedLineEnd,
  };
};

const executeFilesystemCreate = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.filePath, "filePath");
  const content = ensureString(args.content, "content");
  const overwrite = args.overwrite === true;

  await withSshSession(workspacePath, async (sessionId, remotePath) => {
    const exists = (
      await executeSshCommand(sessionId, buildRemoteStatCommand(remotePath), {
        signal,
      })
    ).trim();
    if (exists && !overwrite) {
      throw new Error(
        "Remote file already exists. To overwrite this file, set overwrite=true."
      );
    }
    const parentPath = dirname(remotePath);
    if (parentPath && parentPath !== ".") {
      await executeSshCommand(sessionId, buildRemoteMkdirCommand(parentPath), {
        signal,
      });
    }
    await writeSshFile(sessionId, remotePath, content);
  });

  return {
    success: true,
    path: workspacePath,
    bytes: Buffer.byteLength(content, "utf8"),
    lines: content.split("\n").length,
  };
};

const executeGrepSearch = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.path, "path");
  const pattern = ensureString(args.pattern, "pattern");

  // 低价值路径拦截：与本地 grep-search 一致，显式搜索依赖/缓存目录时
  // 返回引导提示（默认搜索根不受影响——远程 grep 在递归时由
  // --exclude-dir 跳过这些目录）。
  const rawPath = typeof args.path === "string" ? args.path : ".";
  if (rawPath !== "." && rawPath !== "") {
    const lowValue = remoteLowValueDir(workspacePath);
    if (lowValue) {
      return {
        content: `Search path is inside a "${lowValue}" directory. Searching dependency/build/cache directories is skipped by default to protect the context window. Search the project source directory instead, or consult official documentation for third-party code. If you genuinely need to inspect a specific dependency file, use filesystem-read with allowIgnored=true on that file.`,
        skipped: true,
        reason: `inside a "${lowValue}" directory`,
      };
    }
  }

  const fileGlob =
    typeof args.fileGlob === "string" && args.fileGlob.trim()
      ? args.fileGlob.trim()
      : undefined;
  const isRegex = args.isRegex !== false;
  const caseSensitive = args.caseSensitive !== false;
  const maxResults =
    typeof args.maxResults === "number" && Number.isFinite(args.maxResults)
      ? Math.max(1, Math.floor(args.maxResults))
      : 100;

  return withSshSession(workspacePath, async (sessionId, remotePath) => {
    const output = await executeSshCommand(
      sessionId,
      buildRemoteGrepCommand(
        remotePath,
        pattern,
        fileGlob,
        isRegex,
        caseSensitive,
        maxResults
      ),
      { timeoutMs: REMOTE_GREP_TIMEOUT_MS, signal }
    );
    const matches = parseGrepLines(output, workspacePath, remotePath);
    return {
      backend: "remote-grep",
      pattern,
      path: workspacePath,
      fileGlob,
      matches,
      totalMatches: matches.length,
      truncated: matches.length >= maxResults,
      rawOutput: output.slice(0, 50_000),
    };
  });
};

const executeBashCommand = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(
    args.workingDirectory,
    "workingDirectory"
  );
  const command = ensureString(args.command, "command");
  const timeout =
    typeof args.timeout === "number" && Number.isFinite(args.timeout)
      ? Math.max(1, Math.floor(args.timeout))
      : 30_000;

  return withSshSession(workspacePath, async (sessionId, remotePath) => {
    const wrappedCommand = `cd -- ${shellQuote(remotePath)} && ${command}`;
    // The timeout lives inside executeSshCommand so a timed-out command also
    // closes the exec channel and signals the remote process instead of
    // merely racing the promise and leaking the underlying process.
    const output = await executeSshCommand(sessionId, wrappedCommand, {
      timeoutMs: timeout,
      signal,
    });

    return {
      stdout: output,
      stderr: "",
      exitCode: 0,
      command,
      executedAt: new Date().toISOString(),
    };
  });
};

export const dispatchRemoteWorkspaceCommand = async (
  command: RemoteWorkspaceCommand,
  options?: { signal?: AbortSignal }
): Promise<string> => {
  const signal = options?.signal;
  let args: RemoteWorkspaceCommandArgs;
  try {
    args = JSON.parse(command.argsJson) as RemoteWorkspaceCommandArgs;
  } catch {
    throw new Error("Remote workspace command arguments must be valid JSON");
  }

  let result: Record<string, unknown>;
  switch (command.operation) {
    case "filesystem-read":
      result = await executeFilesystemRead(args);
      break;
    case "filesystem-replace_edit":
      result = await executeFilesystemReplaceEdit(args);
      break;
    case "filesystem-create":
      result = await executeFilesystemCreate(args, signal);
      break;
    case "grep-search":
      result = await executeGrepSearch(args, signal);
      break;
    case "bash-terminal-execute":
      result = await executeBashCommand(args, signal);
      break;
    default:
      throw new Error(
        `Unsupported remote workspace operation: ${command.operation}`
      );
  }

  return JSON.stringify(result);
};
