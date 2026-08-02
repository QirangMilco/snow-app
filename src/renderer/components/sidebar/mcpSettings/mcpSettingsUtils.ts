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
 * 忽略内部字段（serverId/sortOrder/source）与 UI 控件 id。
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

  const payload: Record<string, unknown> = {
    name: draft.name,
    transportType: draft.transportType,
    url: draft.url,
    command: draft.command,
    args: draft.args.map((item) => item.value),
    env: pairsToObject(draft.env),
    headers: pairsToObject(draft.headers),
    enabled: draft.enabled,
  };
  if (draft.timeoutMs.trim()) {
    payload.timeoutMs = Number(draft.timeoutMs);
  }

  return JSON.stringify(payload, null, 2);
};

/**
 * 解析 JSON 编辑模式中的 draft 文本。支持两种格式：
 * - 单个服务器对象（draftToJson 输出，字段 name/transportType/url/command/args/env/headers/enabled/timeoutMs）
 * - `{ "mcpServers": { name: {...} } }` / `{ "servers": { name: {...} } }` 批量格式中的单个条目
 *
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

  const source = raw as Record<string, unknown>;
  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name) {
    throw new Error("name is required");
  }

  const transportType =
    source.transportType === "http"
      ? "http"
      : source.transportType === "stdio" || source.transportType === undefined
        ? "stdio"
        : typeof source.transportType === "string"
          ? source.transportType
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
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }
    return Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => typeof item === "string")
      .map(([key, item]) => createMcpPair(key, item as string));
  };

  const timeoutMs = source.timeoutMs;
  const timeoutValue =
    typeof timeoutMs === "number" && Number.isInteger(timeoutMs) && timeoutMs > 0
      ? String(timeoutMs)
      : typeof timeoutMs === "string" && timeoutMs.trim()
        ? timeoutMs.trim()
        : "";

  return {
    ...base,
    name,
    transportType,
    url: asString(source.url),
    command: asString(source.command),
    args: asStringArray(source.args),
    env: asPairs(source.env),
    headers: asPairs(source.headers),
    enabled: source.enabled !== false,
    timeoutMs: timeoutValue,
  };
};

/**
 * 解析批量导入 JSON（全局作用域）。支持顶层结构：
 * - `{ "mcpServers": { name: {...} } }`（Snow CLI settings.json 格式）
 * - `{ "servers": { name: {...} } }`（Claude 风格 mcp.json 格式）
 * - 直接是 `{ name: {...} }` 服务器映射
 * 返回每个服务器的输入配置（serverId 为 `global:{name}`）。
 */
export const parseMcpServersImportJson = (
  jsonText: string
): McpServerConfigInput[] => {
  const raw: unknown = JSON.parse(jsonText);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("JSON must be an object");
  }

  const root = raw as Record<string, unknown>;
  const serversValue =
    root.mcpServers ?? root.servers ?? root;

  if (
    !serversValue ||
    typeof serversValue !== "object" ||
    Array.isArray(serversValue)
  ) {
    throw new Error("mcpServers must be an object");
  }

  const inputs: McpServerConfigInput[] = [];
  for (const [name, rawServer] of Object.entries(
    serversValue as Record<string, unknown>
  )) {
    if (!name.trim() || !rawServer || typeof rawServer !== "object") {
      continue;
    }
    const server = rawServer as Record<string, unknown>;
    const transportType =
      server.type === "http" ? "http" : "stdio";
    const env = server.env ?? server.environment ?? {};
    const args = Array.isArray(server.args)
      ? server.args.filter((item): item is string => typeof item === "string")
      : [];
    const timeoutMs =
      typeof server.timeoutMs === "number" && server.timeoutMs > 0
        ? server.timeoutMs
        : undefined;

    inputs.push({
      serverId: `global:${name.trim()}`,
      name: name.trim(),
      transportType,
      url: typeof server.url === "string" ? server.url.trim() : "",
      command: typeof server.command === "string" ? server.command.trim() : "",
      argsJson: JSON.stringify(args),
      envJson: JSON.stringify(env),
      headersJson: JSON.stringify(server.headers ?? {}),
      enabled: server.enabled !== false,
      ...(timeoutMs ? { timeoutMs } : {}),
      sortOrder: 0,
      source: "manual",
    });
  }

  if (inputs.length === 0) {
    throw new Error("No MCP servers found in JSON");
  }

  return inputs;
};
