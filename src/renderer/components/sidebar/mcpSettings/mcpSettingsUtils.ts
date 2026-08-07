import type { McpServerConfigInput } from "../../../../preload";
import type {
  McpKeyValuePair,
  McpServerConfigLike,
  McpServerDraft,
  McpStringItem,
} from "./types";

const createMcpItemId = (): string =>
  `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const createMcpPair = (key = "", value = ""): McpKeyValuePair => ({
  id: createMcpItemId(),
  key,
  value,
});

export const createMcpStringItem = (value = ""): McpStringItem => ({
  id: createMcpItemId(),
  value,
});

export const EMPTY_MCP_SERVER_DRAFT: McpServerDraft = {
  serverId: "",
  name: "",
  transportType: "stdio",
  url: "",
  command: "",
  args: [],
  env: [],
  headers: [],
  enabled: true,
  timeoutMs: "",
  sortOrder: 0,
  source: "manual",
};

const parseJsonObject = (value: string): Record<string, string> => {
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.entries(parsed).reduce<Record<string, string>>(
      (result, [key, item]) => {
        if (typeof item === "string") {
          result[key] = item;
        }
        return result;
      },
      {}
    );
  } catch {
    return {};
  }
};

const pairsFromJson = (value: string): McpKeyValuePair[] =>
  Object.entries(parseJsonObject(value)).map(([key, item]) =>
    createMcpPair(key, item)
  );

export const pairsToJson = (pairs: McpKeyValuePair[]): string => {
  const result: Record<string, string> = {};

  pairs.forEach((pair) => {
    const key = pair.key.trim();
    if (key) {
      result[key] = pair.value.trim();
    }
  });

  return JSON.stringify(result);
};

export const argsToJson = (args: McpStringItem[]): string => {
  const values = args.map((item) => item.value.trim()).filter(Boolean);

  return JSON.stringify(values);
};

export const argsFromJson = (value: string): McpStringItem[] => {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? parsed
          .filter((item) => typeof item === "string")
          .map((item) => createMcpStringItem(item))
      : [];
  } catch {
    return [];
  }
};

export const hasDuplicatePairKey = (pairs: McpKeyValuePair[]): boolean => {
  const keys = pairs.map((pair) => pair.key.trim()).filter(Boolean);
  return keys.some((key, index) => keys.indexOf(key) !== index);
};

export const toDraft = (server: McpServerConfigLike): McpServerDraft => ({
  serverId: server.serverId,
  name: server.name,
  transportType: server.transportType,
  url: server.url,
  command: server.command,
  args: argsFromJson(server.argsJson),
  env: pairsFromJson(server.envJson),
  headers: pairsFromJson(server.headersJson),
  enabled: server.enabled,
  timeoutMs: server.timeoutMs ? String(server.timeoutMs) : "",
  sortOrder: server.sortOrder,
  source: server.source,
});

const toScopedInput = (
  draft: McpServerDraft,
  fallbackSortOrder: number,
  serverId: string,
  source: string
): McpServerConfigInput => ({
  serverId,
  name: draft.name.trim(),
  transportType: draft.transportType,
  url: draft.url.trim(),
  command: draft.command.trim(),
  argsJson: argsToJson(draft.args),
  envJson: pairsToJson(draft.env),
  headersJson: pairsToJson(draft.headers),
  enabled: draft.enabled,
  ...(draft.timeoutMs.trim() ? { timeoutMs: Number(draft.timeoutMs) } : {}),
  sortOrder: draft.serverId ? draft.sortOrder : fallbackSortOrder,
  source,
});

export const toInput = (
  draft: McpServerDraft,
  fallbackSortOrder: number
): McpServerConfigInput =>
  toScopedInput(
    draft,
    fallbackSortOrder,
    draft.serverId || `global:${draft.name.trim()}`,
    draft.source || "manual"
  );

export const toProjectInput = (
  draft: McpServerDraft,
  fallbackSortOrder: number
): McpServerConfigInput =>
  toScopedInput(draft, fallbackSortOrder, draft.serverId, "project");

export const getMcpServerEndpoint = (server: McpServerConfigLike): string =>
  server.transportType === "http" ? server.url : server.command;

/**
 * 将 draft 序列化为可读的 JSON 文本（用于 JSON 编辑模式）。
 * 输出 `{ "<name>": {...} }` 单条目映射格式（即 `servers` 对象的内容，可直接用于
 * VS Code mcp.json 等配置），忽略内部字段（serverId/sortOrder/source）与 UI 控件 id。
 */
export const draftToJson = (draft: McpServerDraft): string => {
  const pairsToObject = (pairs: McpKeyValuePair[]): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const pair of pairs) {
      const key = pair.key.trim();
      if (key) {
        result[key] = pair.value;
      }
    }
    return result;
  };

  const server: Record<string, unknown> = {
    type: draft.transportType,
  };

  if (draft.transportType === "http") {
    if (draft.url.trim()) {
      server.url = draft.url;
    }
  } else {
    if (draft.command.trim()) {
      server.command = draft.command;
    }
    const args = draft.args
      .map((item) => item.value.trim())
      .filter((item) => item.length > 0);
    if (args.length > 0) {
      server.args = args;
    }
  }

  const env = pairsToObject(draft.env);
  if (Object.keys(env).length > 0) {
    server.env = env;
  }

  const headers = pairsToObject(draft.headers);
  if (Object.keys(headers).length > 0) {
    server.headers = headers;
  }

  if (!draft.enabled) {
    server.enabled = false;
  }

  if (draft.timeoutMs.trim()) {
    const timeout = Number(draft.timeoutMs);
    if (Number.isInteger(timeout) && timeout > 0) {
      server.timeout = timeout;
    }
  }

  return JSON.stringify({ [draft.name]: server }, null, 2);
};

const isRecordLike = (
  value: unknown
): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const SERVER_CONFIG_KEYS = new Set([
  "type",
  "transportType",
  "url",
  "command",
  "args",
  "env",
  "environment",
  "headers",
  "enabled",
  "timeout",
  "timeoutMs",
  "name",
]);

/**
 * 解析 JSON 编辑模式中的 draft 文本。支持以下格式：
 * - `{ "<name>": {...} }`（draftToJson 输出，单条目映射，字段
 *   type/url/command/args/env/environment/headers/enabled/timeout；type 省略时按 url 推断 http）
 * - `{ "servers": { "<name>": {...} } }` / `{ "mcpServers": { "<name>": {...} } }`（兼容容器格式）
 * - 单个服务器对象（旧格式，字段 name/transportType/url/command/args/env/headers/enabled/timeoutMs）
 *
 * 映射/容器格式存在多台服务器时，优先取与 base.name 匹配的条目，否则取第一条。
 * 解析失败时抛出 Error；成功时返回完整 draft（内部字段取 base 值）。
 */
export const parseDraftJson = (
  jsonText: string,
  base: McpServerDraft
): McpServerDraft => {
  const raw: unknown = JSON.parse(jsonText);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("JSON must be an object");
  }

  const root = raw as Record<string, unknown>;
  const container = isRecordLike(root.servers)
    ? root.servers
    : isRecordLike(root.mcpServers)
      ? root.mcpServers
      : null;

  let serverName = "";
  let source: Record<string, unknown>;
  if (container) {
    const entries = Object.entries(container);
    if (entries.length === 0) {
      throw new Error("servers must contain at least one server");
    }
    const [key, value] =
      entries.find(([entryKey]) => entryKey === base.name) ?? entries[0];
    serverName = key.trim();
    source = isRecordLike(value) ? value : {};
  } else {
    const entries = Object.entries(root);
    const looksLikeFlatConfig = entries.some(([key]) =>
      SERVER_CONFIG_KEYS.has(key)
    );
    if (looksLikeFlatConfig) {
      // 单个服务器对象（旧格式）
      source = root;
    } else if (entries.length === 1 && isRecordLike(entries[0][1])) {
      // 单条目映射 { "<name>": {...} }
      serverName = entries[0][0].trim();
      source = entries[0][1];
    } else {
      throw new Error(
        'JSON must be a server config object or a single-entry map like { "context7": { ... } }'
      );
    }
  }

  const name =
    serverName ||
    (typeof source.name === "string" ? source.name.trim() : "") ||
    base.name;
  if (!name) {
    throw new Error("name is required");
  }

  const transportType =
    source.type === "http" || source.transportType === "http"
      ? "http"
      : source.type === "stdio" ||
          source.type === "local" ||
          source.transportType === "stdio"
        ? "stdio"
        : typeof source.url === "string" && source.url.trim()
          ? "http"
          : "stdio";

  const asString = (value: unknown): string =>
    typeof value === "string" ? value : "";

  const asStringArray = (value: unknown): McpStringItem[] => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => createMcpStringItem(item));
  };

  const asPairs = (value: unknown): McpKeyValuePair[] => {
    if (!isRecordLike(value)) {
      return [];
    }
    return Object.entries(value)
      .filter(([, item]) => typeof item === "string")
      .map(([key, item]) => createMcpPair(key, item as string));
  };

  const envSource =
    isRecordLike(source.environment) && isRecordLike(source.env)
      ? { ...source.environment, ...source.env }
      : isRecordLike(source.environment)
        ? source.environment
        : source.env;

  const timeoutRaw = source.timeout ?? source.timeoutMs;
  const timeoutValue =
    typeof timeoutRaw === "number" &&
    Number.isInteger(timeoutRaw) &&
    timeoutRaw > 0
      ? String(timeoutRaw)
      : typeof timeoutRaw === "string" && timeoutRaw.trim()
        ? timeoutRaw.trim()
        : "";

  return {
    ...base,
    name,
    transportType,
    url: asString(source.url),
    command: asString(source.command),
    args: asStringArray(source.args),
    env: asPairs(envSource),
    headers: asPairs(source.headers),
    enabled: source.enabled !== false,
    timeoutMs: timeoutValue,
  };
};
