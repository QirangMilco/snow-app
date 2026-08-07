/**
 * DbxToolCall — 外部 MCP（DBX 桌面数据库应用）的统一渲染器。
 *
 * DBX 是第三方桌面应用（非本仓库内置），通过外部 MCP 协议接入：
 * 工具名统一以 `dbx-` 前缀暴露（如 dbx-execute-query），因此前端
 * 可以按前缀稳定匹配并渲染，与内置工具保持同一套 ToolCallNode 风格。
 *
 * 覆盖操作：list-connections / add-connection / remove-connection /
 * execute-query / execute-and-show / describe-table / list-tables /
 * get-schema-context / open-session / close-session / open-table /
 * execute-redis-command。
 *
 * 注意：外部 MCP 的返回结构可能随 DBX 版本变化，表格解析（parseQueryTable）
 * 做了多格式容错（rows / result / values / queryResult），解析失败时
 * 自动回退为原始 JSON 展示，保证任何情况下都有内容可看。
 */
import { useMemo, type ReactNode } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  KeyRound,
  ListTree,
  Play,
  Table2,
  TerminalSquare,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type DbxToolCallProps = {
  toolCall: ToolCallInfo;
};

type ParsedResult =
  | { type: "success"; data: Record<string, unknown> }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const parseArgs = (args: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const parseResult = (result: string | undefined): ParsedResult => {
  if (!result) {
    return { type: "empty" };
  }
  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return { type: "raw", text: result };
    }
    if (typeof parsed.error === "string") {
      return { type: "error", message: parsed.error };
    }
    return { type: "success", data: parsed };
  } catch {
    return { type: "raw", text: result };
  }
};

const truncate = (value: string, max = 56): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

/** 单元格值显示：null -> NULL，对象/数组 -> JSON，长字符串截断。 */
const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") {
    try {
      return truncate(JSON.stringify(value), 40);
    } catch {
      return String(value);
    }
  }
  return truncate(String(value), 40);
};

/**
 * 从查询结果中提取表格结构。
 *
 * 外部 MCP（DBX）的返回格式不固定，这里做多格式容错：
 *   - `rows` 为对象数组：自动提取首行 keys 作为列名
 *   - `rows` 为二维数组：优先用 `columns` 作为表头，缺失时生成 colN
 *   - 顶层没有 rows 时，依次尝试 `result` / `values` / `queryResult` /
 *     `data.rows` 等常见包装字段
 */
const parseQueryTable = (
  data: Record<string, unknown>
): { columns: string[]; rows: unknown[][] } | null => {
  /** 从候选对象中提取 { rows, columns }，提取不到返回 null。 */
  const extract = (
    candidate: unknown
  ): { rows: unknown[]; columns: unknown[] | null } | null => {
    if (!isRecord(candidate)) {
      return null;
    }
    if (Array.isArray(candidate.rows)) {
      return {
        rows: candidate.rows,
        columns: Array.isArray(candidate.columns) ? candidate.columns : null,
      };
    }
    for (const field of ["result", "values", "queryResult"] as const) {
      if (Array.isArray(candidate[field])) {
        return { rows: candidate[field], columns: null };
      }
    }
    if (isRecord(candidate.data) && Array.isArray(candidate.data.rows)) {
      return {
        rows: candidate.data.rows,
        columns: Array.isArray(candidate.data.columns)
          ? candidate.data.columns
          : null,
      };
    }
    return null;
  };

  // 结果被包在 result 对象里时（如 { result: { rows: [...] } }）再试一层。
  const extracted =
    extract(data) ?? (isRecord(data.result) ? extract(data.result) : null);
  if (!extracted || extracted.rows.length === 0) {
    return null;
  }
  const rawRows = extracted.rows;
  const rawColumns = extracted.columns;

  // 对象数组：自动提取列名。
  if (isRecord(rawRows[0])) {
    const columns = Object.keys(rawRows[0] as Record<string, unknown>);
    const rows = rawRows.map((row) => {
      if (!isRecord(row)) {
        return [row];
      }
      return columns.map((column) => row[column]);
    });
    return { columns, rows };
  }

  // 二维数组：columns 数组作为表头（可能缺失）。
  const firstRow = rawRows[0] as unknown[] | undefined;
  const columns =
    rawColumns && rawColumns.length > 0
      ? rawColumns.map(String)
      : firstRow?.map((_: unknown, index: number) => `col${index + 1}`) ?? [];
  const rows = rawRows.map((row) => (Array.isArray(row) ? row : [row]));
  return { columns, rows };
};

/**
 * 解析 Markdown 表格文本（DBX execute-query 的实际返回格式）：
 *   | id | username |
 *   |----|----------|
 *   | 1  | root     |
 * 返回 { columns, rows }；不是表格则返回 null。
 */
const parseMarkdownTable = (
  text: string
): { columns: string[]; rows: unknown[][] } | null => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));
  if (lines.length < 2) {
    return null;
  }
  const splitRow = (line: string): string[] =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());

  const header = splitRow(lines[0]);
  // 分隔行（|----|----|）跳过。
  const bodyLines = lines
    .slice(1)
    .filter((line) => !/^\|[\s\-:|]+\|$/.test(line));
  if (header.length === 0) {
    return null;
  }
  const rows = bodyLines.map((line) => splitRow(line));
  return { columns: header, rows };
};

/** 提取 MCP 标准 content 包装（{ content: [{ text, type }] }）中的首个文本。 */
const contentText = (data: Record<string, unknown>): string | undefined => {
  const content = Array.isArray(data.content) ? data.content : [];
  for (const part of content) {
    if (isRecord(part)) {
      const text = asString(part.text);
      if (text) {
        return text;
      }
    }
  }
  return undefined;
};

/** 从 content 包装中提取 Markdown 表格（DBX 实际返回格式）。 */
const parseContentTable = (
  data: Record<string, unknown>
): { columns: string[]; rows: unknown[][] } | null => {
  const text = contentText(data);
  return text ? parseMarkdownTable(text) : null;
};

const MAX_TABLE_ROWS = 8;

export const DbxToolCall = ({
  toolCall,
}: DbxToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  // 外部 MCP 工具名可能为连字符（dbx-execute-query）或下划线（dbx_execute_query），
  // 且 DBX MCP 工具名本身自带 dbx_ 前缀（完整 MCP 名如 dbx-dbx_execute_query），
  // 需连续剥掉 server 前缀与工具名自带前缀，统一归一为连字符后提取操作名，
  // 保证与下方 switch 的 case 匹配。
  // 另外 DBX server 自身拼写缺失的 execute_redis_comman 映射到标准名（execute-redis-command）。
  const operation = toolCall.name
    .replace(/^dbx[-_](.+)$/, "$1")
    .replace(/^dbx[-_]/, "")
    .replace(/_/g, "-")
    .replace(/^execute-redis-comman$/, "execute-redis-command");

  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments]
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result]
  );

  const effectiveStatus =
    parsedResult.type === "error" ? "error" : toolCall.status;

  const data = parsedResult.type === "success" ? parsedResult.data : null;

  /*
   * 查询表格：优先解析 JSON 结构（rows/result/values 等），其次从 MCP content
   * 包装中提取 Markdown 表格文本（DBX 实际返回格式），最后回退 raw 文本。
   * 不限定操作：任何返回 Markdown 表格的结果（execute-query/describe-table
   * 等）都能渲染成表格，非表格文本自然解析失败保持原样。
   */
  const queryTable = data
    ? parseQueryTable(data) ?? parseContentTable(data)
    : parsedResult.type === "raw"
    ? parseMarkdownTable(parsedResult.text)
    : null;
  const queryRowCount = queryTable?.rows.length;

  /* 折叠态头部摘要。 */
  let displayName: string | undefined;
  let meta: ReactNode = null;

  switch (operation) {
    case "execute-query":
    case "execute-and-show": {
      const sql = asString(parsedArgs?.sql);
      displayName = sql ? truncate(sql.replace(/\s+/g, " ").trim()) : undefined;
      if (data) {
        // content 包装下无 data.rowCount/data.rows，回退到表格解析的行数。
        const rowCount =
          typeof data.rowCount === "number"
            ? data.rowCount
            : Array.isArray(data.rows)
            ? data.rows.length
            : queryRowCount;
        meta =
          rowCount !== undefined ? (
            <span className="tool-call-dbx-meta tool-call-dbx-meta-ok">
              <Table2 size={10} aria-hidden="true" />
              {t("toolCall.dbx.rowCount", { values: { count: rowCount } })}
            </span>
          ) : (
            <span className="tool-call-dbx-meta tool-call-dbx-meta-ok">
              <CheckCircle2 size={10} aria-hidden="true" />
              {t("toolCall.dbx.done")}
            </span>
          );
      }
      break;
    }
    case "execute-redis-command": {
      const command = asString(parsedArgs?.command);
      displayName = command ? truncate(command) : undefined;
      // content 包装下结果在 text 中（如 PONG），截断展示。
      const text = data ? contentText(data) : undefined;
      meta = text ? (
        <span className="tool-call-dbx-meta tool-call-dbx-meta-ok">
          <KeyRound size={10} aria-hidden="true" />
          {truncate(text, 40)}
        </span>
      ) : null;
      break;
    }
    case "describe-table": {
      const table = asString(parsedArgs?.table);
      displayName = table;
      // 表结构返回 Markdown 表格（content 包装），列数取自解析结果。
      const columnCount = queryTable?.columns.length;
      meta = columnCount ? (
        <span className="tool-call-dbx-meta tool-call-dbx-meta-ok">
          <ListTree size={10} aria-hidden="true" />
          {t("toolCall.dbx.columnCount", { values: { count: columnCount } })}
        </span>
      ) : null;
      break;
    }
    case "list-tables": {
      const database = asString(parsedArgs?.database);
      displayName = database ?? t("toolCall.dbx.allTables");
      // content 包装下返回 `- name (TYPE)` 文本行，按行统计表数量。
      const tableText = data ? contentText(data) : undefined;
      const tableCount = tableText
        ? tableText
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("- ")).length
        : undefined;
      meta = tableCount ? (
        <span className="tool-call-dbx-meta tool-call-dbx-meta-ok">
          <Table2 size={10} aria-hidden="true" />
          {t("toolCall.dbx.tableCount", { values: { count: tableCount } })}
        </span>
      ) : null;
      break;
    }
    case "list-connections": {
      displayName = t("toolCall.dbx.connections");
      // content 包装下返回 Markdown 表格（| ID | Name | ...），行数即连接数。
      const connectionCount = queryTable?.rows.length;
      meta = connectionCount ? (
        <span className="tool-call-dbx-meta tool-call-dbx-meta-ok">
          <Database size={10} aria-hidden="true" />
          {t("toolCall.dbx.connectionCount", {
            values: { count: connectionCount },
          })}
        </span>
      ) : null;
      break;
    }
    case "get-schema-context": {
      const tables = Array.isArray(parsedArgs?.tables)
        ? parsedArgs.tables.map(String)
        : [];
      displayName = tables.length > 0 ? tables.join(", ") : undefined;
      // content 包装下为 `## table` 标题 + `- col type` 行，按标题数统计。
      const contextText = data ? contentText(data) : undefined;
      const contextCount = contextText
        ? contextText
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("## ")).length
        : undefined;
      meta = contextCount ? (
        <span className="tool-call-dbx-meta tool-call-dbx-meta-ok">
          <Table2 size={10} aria-hidden="true" />
          {t("toolCall.dbx.tableCount", {
            values: { count: contextCount },
          })}
        </span>
      ) : null;
      break;
    }
    case "open-session": {
      const database = asString(parsedArgs?.database);
      displayName = database ? truncate(database, 32) : undefined;
      // content 包装下 session_id 在 "session_id: mcp-session-xxx" 文本行中。
      const openText = data ? contentText(data) : undefined;
      const sessionId =
        openText
          ?.split("\n")
          .map((line) => line.trim())
          .find((line) => line.startsWith("session_id:"))
          ?.slice("session_id:".length)
          .trim() ?? undefined;
      meta = sessionId ? (
        <span className="tool-call-dbx-meta tool-call-dbx-meta-ok">
          <TerminalSquare size={10} aria-hidden="true" />
          {truncate(sessionId, 20)}
        </span>
      ) : null;
      break;
    }
    case "close-session": {
      const sessionId = asString(parsedArgs?.session_id);
      displayName = sessionId ? truncate(sessionId, 32) : undefined;
      meta =
        data && data.closed !== false ? (
          <span className="tool-call-dbx-meta tool-call-dbx-meta-ok">
            <CheckCircle2 size={10} aria-hidden="true" />
            {t("toolCall.dbx.closed")}
          </span>
        ) : null;
      break;
    }
    case "add-connection": {
      const name = asString(parsedArgs?.name);
      displayName = name;
      // content 包装下无结构化字段，成功（无 error）即显示已添加。
      meta =
        data && parsedResult.type === "success" ? (
          <span className="tool-call-dbx-meta tool-call-dbx-meta-ok">
            <CheckCircle2 size={10} aria-hidden="true" />
            {t("toolCall.dbx.added")}
          </span>
        ) : null;
      break;
    }
    case "remove-connection": {
      const name = asString(parsedArgs?.connection_name);
      displayName = name;
      meta =
        data && data.removed !== false ? (
          <span className="tool-call-dbx-meta tool-call-dbx-meta-ok">
            <CheckCircle2 size={10} aria-hidden="true" />
            {t("toolCall.dbx.removed")}
          </span>
        ) : null;
      break;
    }
    case "open-table": {
      const table = asString(parsedArgs?.table);
      displayName = table;
      meta =
        data && data.opened !== false ? (
          <span className="tool-call-dbx-meta tool-call-dbx-meta-ok">
            <CheckCircle2 size={10} aria-hidden="true" />
            {t("toolCall.dbx.opened")}
          </span>
        ) : null;
      break;
    }
    default: {
      // 防御：DBX 未来新增工具（未列入 switch）时至少展示操作名摘要，
      // 表格/文本结果仍走通用渲染。
      displayName = operation ? truncate(operation, 48) : undefined;
      break;
    }
  }

  /* SQL / Redis 命令行。 */
  const commandText =
    operation === "execute-query" || operation === "execute-and-show"
      ? asString(parsedArgs?.sql)
      : operation === "execute-redis-command"
      ? asString(parsedArgs?.command)
      : undefined;

  const resultText =
    parsedResult.type === "success"
      ? // content 包装优先取原始文本（保留真实换行，如 list-tables 的表名列表），
        // 无 content 时才回退 JSON 序列化。
        (data ? contentText(data) : undefined) ??
        JSON.stringify(parsedResult.data, null, 2)
      : parsedResult.type === "raw"
      ? parsedResult.text
      : "";

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={
        // i18n 未命中时 t 返回空字符串（defaultValue: ""），转成 undefined
        // 让 ToolCallNode 走 toolNames/shortName fallback，避免徽章空白。
        t(`toolCall.dbx.op.${operation}`, { defaultValue: "" }) || undefined
      }
      displayName={displayName}
      displayNameTitle={toolCall.arguments}
      status={effectiveStatus}
      meta={meta}
      className="tool-call-dbx"
    >
      <div className="tool-call-body tool-call-dbx-body">
        {commandText ? (
          <div className="tool-call-dbx-command">
            <Play size={11} aria-hidden="true" />
            <code>{commandText}</code>
          </div>
        ) : null}

        {queryTable ? (
          <div className="tool-call-dbx-table-wrap">
            <table className="tool-call-dbx-table">
              <thead>
                <tr>
                  {queryTable.columns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {queryTable.rows.slice(0, MAX_TABLE_ROWS).map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, cellIndex) => {
                      const text = cellText(cell);
                      const isNull = cell === null || cell === undefined;
                      return (
                        <td
                          key={cellIndex}
                          title={text}
                          className={
                            isNull ? "tool-call-dbx-cell-null" : undefined
                          }
                        >
                          {text}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {queryTable.rows.length > MAX_TABLE_ROWS ? (
              <div className="tool-call-dbx-table-more">
                {t("toolCall.dbx.moreRows", {
                  values: {
                    shown: MAX_TABLE_ROWS,
                    total: queryTable.rows.length,
                  },
                })}
              </div>
            ) : null}
          </div>
        ) : data && Array.isArray(data.rows) && data.rows.length === 0 ? (
          <div className="tool-call-dbx-empty">
            <Database size={14} aria-hidden="true" />
            <span>{t("toolCall.dbx.emptyResult")}</span>
          </div>
        ) : null}

        {parsedResult.type === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
          </div>
        ) : null}

        {resultText && !queryTable ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.common.result")}
            </span>
            <pre className="tool-call-section-pre">{resultText}</pre>
          </section>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
