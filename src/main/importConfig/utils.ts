import {
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type {
  McpServerConfigInput,
  SystemPromptItemInput,
} from "../native/types";
import { isRecord, toBoolean } from "../utils/value";
import { IMPORT_SCAN_LIMITS, walkImportFilesInWorker } from "./discoveryWorker";

export type ImportScope = "global" | "project";

export type ImportedMcp = {
  scope: ImportScope;
  projectId?: string;
  input: McpServerConfigInput;
  /** Provider home of the environment this server was declared in. */
  originPath?: string;
  environmentId?: string;
  environmentLabel?: string;
};

/**
 * An MCP server that was declared in an environment whose stdio commands
 * cannot run on this machine (e.g. an SSH remote host). Surfaced as an
 * unsupported import candidate so the user can see why it was skipped.
 */
export type UnsupportedImportedMcp = {
  name: string;
  scope: ImportScope;
  projectId?: string;
  reason: string;
  originPath: string;
  environmentId?: string;
  environmentLabel?: string;
};

export const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

export const asStringRecord = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, item]) => key.trim().length > 0 && typeof item === "string"
    )
  ) as Record<string, string>;
};

export const nonEmptyString = (value: unknown): string | null => {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
};

export const safeSegment = (value: string): string =>
  value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\.\.+/g, ".") || "imported";

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
      while (
        index < input.length &&
        !(input[index] === "*" && input[index + 1] === "/")
      ) {
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

export const readJson = (
  filePath: string,
  warnings: string[],
  allowComments = false
): Record<string, unknown> | null => {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const text = readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(
      allowComments ? removeTrailingCommas(removeJsonComments(text)) : text
    );
    if (isRecord(parsed)) {
      return parsed;
    }
    warnings.push("Ignoring non-object configuration file: " + filePath);
    return null;
  } catch (error) {
    warnings.push(
      "Unable to parse " +
        filePath +
        ": " +
        (error instanceof Error ? error.message : String(error))
    );
    return null;
  }
};

export const readText = (
  filePath: string,
  warnings: string[]
): string | null => {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const content = readFileSync(filePath, "utf8").trim();
    return content || null;
  } catch (error) {
    warnings.push(
      "Unable to read " +
        filePath +
        ": " +
        (error instanceof Error ? error.message : String(error))
    );
    return null;
  }
};

export const walkFiles = (
  root: string,
  predicate: (filePath: string) => boolean,
  maxDepth = 10
): Promise<string[]> =>
  walkImportFilesInWorker(root, Math.min(maxDepth, IMPORT_SCAN_LIMITS.maxDepth))
    .then((files) => files.filter(predicate));

export const collectSkillDirectories = async (root: string): Promise<string[]> =>
  (await walkFiles(root, (filePath) => filePath.endsWith(`${sep}SKILL.md`))).map(dirname);

export const createPrompt = (
  promptId: string,
  name: string,
  content: string,
  sortOrder: number
): SystemPromptItemInput | null => {
  const trimmed = content.trim();
  return trimmed
    ? { promptId, name, content: trimmed, isActive: true, sortOrder }
    : null;
};

export const createMcpInput = (input: {
  serverId: string;
  name: string;
  source: string;
  sortOrder: number;
  transportType: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: unknown;
  timeoutMs?: number;
}): McpServerConfigInput | null => {
  const url = input.url?.trim() ?? "";
  const command = input.command?.trim() ?? "";
  if ((input.transportType === "http" && !url) || (input.transportType === "stdio" && !command)) {
    return null;
  }
  return {
    serverId: input.serverId,
    name: input.name,
    transportType: input.transportType,
    url,
    command,
    argsJson: JSON.stringify(input.args ?? []),
    envJson: JSON.stringify(input.env ?? {}),
    headersJson: JSON.stringify(input.headers ?? {}),
    enabled: toBoolean(input.enabled, true),
    ...(input.timeoutMs && input.timeoutMs > 0
      ? { timeoutMs: Math.round(input.timeoutMs) }
      : {}),
    sortOrder: input.sortOrder,
    source: input.source,
  };
};

export const projectPathMatches = (path: string, candidate: string): boolean =>
  path === candidate || path.startsWith(`${candidate}${sep}`);

export const uniquePaths = (paths: string[]): string[] =>
  [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
