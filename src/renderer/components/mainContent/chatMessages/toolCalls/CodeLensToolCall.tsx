import { useMemo } from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  Crosshair,
  FileCode,
  Hash,
  Link2,
  ListTree,
  Loader2,
  MapPin,
  ScanSearch,
  XCircle,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type CodeLensToolCallProps = {
  toolCall: ToolCallInfo;
};

type CodelensOperation =
  | "find_definition"
  | "find_references"
  | "file_outline";

// ---- Args types ----

type PositionArgs = { filePath: string; line: number; column: number };
type OutlineArgs = { filePath: string };
type ParsedArgs = PositionArgs | OutlineArgs | null;

// ---- Result types ----

type SymbolLocation = {
  filePath: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
};

type ReferenceItem = {
  location: SymbolLocation;
  access: string;
};

type OutlineEntry = {
  name: string;
  kind: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  containerName: string | null;
  isExported: boolean;
};

type ParsedResult =
  | {
      type: "definition";
      found: boolean;
      name?: string;
      kind?: string;
      location?: SymbolLocation;
      containerName?: string | null;
      isExported?: boolean;
      searchScope?: "file" | "project";
      message?: string;
    }
  | {
      type: "references";
      found: boolean;
      name?: string;
      definition?: SymbolLocation | null;
      references?: ReferenceItem[];
      totalReferences?: number;
      searchScope?: "file" | "project";
      message?: string;
    }
  | {
      type: "outline";
      filePath: string;
      outline: OutlineEntry[];
      totalSymbols: number;
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const BADGE_KEYS: Record<CodelensOperation, string> = {
  find_definition: "toolCall.codelens.op.find_definition",
  find_references: "toolCall.codelens.op.find_references",
  file_outline: "toolCall.codelens.op.file_outline",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPositionArgs = (args: ParsedArgs): args is PositionArgs =>
  args !== null && "line" in args;

const getOperation = (toolName: string): CodelensOperation | null => {
  switch (toolName) {
    case "codelens-find_definition":
      return "find_definition";
    case "codelens-find_references":
      return "find_references";
    case "codelens-file_outline":
      return "file_outline";
    default:
      return null;
  }
};

const parseString = (
  record: Record<string, unknown>,
  key: string
): string | undefined =>
  typeof record[key] === "string" ? (record[key] as string) : undefined;

const parseNumber = (
  record: Record<string, unknown>,
  key: string
): number | undefined =>
  typeof record[key] === "number" ? (record[key] as number) : undefined;

const parseBoolean = (
  record: Record<string, unknown>,
  key: string
): boolean | undefined =>
  typeof record[key] === "boolean" ? (record[key] as boolean) : undefined;

const getFileName = (filePath: string): string =>
  filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;

const parseLocation = (value: unknown): SymbolLocation | null => {
  if (!isRecord(value)) return null;
  const filePath = parseString(value, "filePath");
  const line = parseNumber(value, "line");
  const column = parseNumber(value, "column");
  if (!filePath || line === undefined || column === undefined) return null;
  return {
    filePath,
    line,
    column,
    endLine: parseNumber(value, "endLine") ?? line,
    endColumn: parseNumber(value, "endColumn") ?? column,
  };
};

const parseArgs = (
  args: string,
  operation: CodelensOperation
): ParsedArgs => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed)) return null;

    const filePath = parseString(parsed, "filePath");
    if (!filePath) return null;

    if (operation === "file_outline") {
      return { filePath };
    }

    const line = parseNumber(parsed, "line");
    const column = parseNumber(parsed, "column");
    if (line === undefined || column === undefined) return null;

    return { filePath, line, column };
  } catch {
    return null;
  }
};

const parseResult = (
  result: string | undefined,
  operation: CodelensOperation
): ParsedResult => {
  if (!result) return { type: "empty" };

  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) return { type: "raw", text: result };

    // napi errors are wrapped as { "error": "..." }
    const errorStr = parseString(parsed, "error");
    if (errorStr) return { type: "error", message: errorStr };

    if (
      operation === "find_definition" &&
      typeof parsed.found === "boolean"
    ) {
      if (parsed.found) {
        return {
          type: "definition",
          found: true,
          name: parseString(parsed, "name"),
          kind: parseString(parsed, "kind"),
          location: parseLocation(parsed.location) ?? undefined,
          containerName: parseString(parsed, "containerName") ?? null,
          isExported: parseBoolean(parsed, "isExported"),
          searchScope:
            parseString(parsed, "searchScope") === "project"
              ? "project"
              : "file",
        };
      }
      return {
        type: "definition",
        found: false,
        message: parseString(parsed, "message"),
      };
    }

    if (
      operation === "find_references" &&
      typeof parsed.found === "boolean"
    ) {
      if (parsed.found) {
        const references: ReferenceItem[] = Array.isArray(parsed.references)
          ? parsed.references.filter(isRecord).map((r) => {
              const loc = parseLocation(r);
              return {
                location: loc ?? {
                  filePath: "",
                  line: 0,
                  column: 0,
                  endLine: 0,
                  endColumn: 0,
                },
                access: parseString(r, "access") ?? "read",
              };
            })
          : [];

        return {
          type: "references",
          found: true,
          name: parseString(parsed, "name"),
          definition: parseLocation(parsed.definition),
          references,
          totalReferences:
            parseNumber(parsed, "totalReferences") ?? references.length,
          searchScope:
            parseString(parsed, "searchScope") === "project"
              ? "project"
              : "file",
        };
      }
      return {
        type: "references",
        found: false,
        message: parseString(parsed, "message"),
      };
    }

    if (operation === "file_outline" && Array.isArray(parsed.outline)) {
      const outline: OutlineEntry[] = parsed.outline
        .filter(isRecord)
        .map((e) => ({
          name: parseString(e, "name") ?? "",
          kind: parseString(e, "kind") ?? "unknown",
          line: parseNumber(e, "line") ?? 0,
          column: parseNumber(e, "column") ?? 0,
          endLine: parseNumber(e, "endLine") ?? 0,
          endColumn: parseNumber(e, "endColumn") ?? 0,
          containerName: parseString(e, "containerName") ?? null,
          isExported: parseBoolean(e, "isExported") ?? false,
        }));

      return {
        type: "outline",
        filePath: parseString(parsed, "filePath") ?? "",
        outline,
        totalSymbols: parseNumber(parsed, "totalSymbols") ?? outline.length,
      };
    }

    // Some errors arrive as { "message": "..." } without the expected fields
    const messageStr = parseString(parsed, "message");
    if (messageStr) return { type: "error", message: messageStr };

    return { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};

export const CodeLensToolCall = ({
  toolCall,
}: CodeLensToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const operation = getOperation(toolCall.name);

  const parsedArgs = useMemo(
    () => (operation ? parseArgs(toolCall.arguments, operation) : null),
    [toolCall.arguments, operation]
  );
  const parsedResult = useMemo(
    () =>
      operation
        ? parseResult(toolCall.result, operation)
        : ({ type: "empty" } as ParsedResult),
    [toolCall.result, operation]
  );

  const isRunning = toolCall.status === "running";
  const hasError = parsedResult.type === "error";
  const effectiveStatus = hasError ? "error" : toolCall.status;

  const badgeName = operation
    ? t(BADGE_KEYS[operation])
    : t("toolCall.codelens.name");

  const filePath = parsedArgs?.filePath ?? "";
  const displayName = filePath ? getFileName(filePath) : undefined;
  const position = isPositionArgs(parsedArgs) ? parsedArgs : null;

  // Group references by file so project-scope results stay readable.
  const groupedReferences = useMemo(() => {
    if (
      parsedResult.type !== "references" ||
      !parsedResult.found ||
      !parsedResult.references
    ) {
      return null;
    }
    const groups = new Map<string, ReferenceItem[]>();
    for (const ref of parsedResult.references) {
      const key = ref.location.filePath;
      const existing = groups.get(key) ?? [];
      existing.push(ref);
      groups.set(key, existing);
    }
    return Array.from(groups.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
  }, [parsedResult]);

  // Meta badge rendered inline in the header.
  const meta = useMemo(() => {
    if (parsedResult.type === "definition") {
      return (
        <span
          className={`tool-call-codelens-count ${
            parsedResult.found
              ? "tool-call-codelens-count-ok"
              : "tool-call-codelens-count-muted"
          }`}
        >
          {parsedResult.found
            ? t("toolCall.codelens.found")
            : t("toolCall.codelens.notFound")}
        </span>
      );
    }
    if (parsedResult.type === "references") {
      const count = parsedResult.found
        ? parsedResult.totalReferences ?? 0
        : 0;
      return (
        <span
          className={`tool-call-codelens-count ${
            count > 0
              ? "tool-call-codelens-count-info"
              : "tool-call-codelens-count-muted"
          }`}
        >
          {t("toolCall.codelens.referenceCount", { values: { count } })}
        </span>
      );
    }
    if (parsedResult.type === "outline") {
      const count = parsedResult.totalSymbols;
      return (
        <span
          className={`tool-call-codelens-count ${
            count > 0
              ? "tool-call-codelens-count-info"
              : "tool-call-codelens-count-muted"
          }`}
        >
          {t("toolCall.codelens.symbolCount", { values: { count } })}
        </span>
      );
    }
    return null;
  }, [parsedResult, t]);

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={badgeName}
      category="lens"
      displayName={displayName}
      displayNameTitle={filePath}
      status={effectiveStatus}
      meta={meta}
      className="tool-call-codelens"
    >
      <div className="tool-call-body tool-call-codelens-body">
        {/* Parameters */}
        {parsedArgs ? (
          <div className="tool-call-codelens-params">
            <div className="tool-call-codelens-param-item">
              <FileCode size={11} aria-hidden="true" />
              <span className="tool-call-codelens-param-label">
                {t("toolCall.codelens.filePath")}
              </span>
              <span
                className="tool-call-codelens-param-value"
                title={filePath}
              >
                {filePath}
              </span>
            </div>
            {position ? (
              <div className="tool-call-codelens-param-item">
                <Crosshair size={11} aria-hidden="true" />
                <span className="tool-call-codelens-param-label">
                  {t("toolCall.codelens.position")}
                </span>
                <code className="tool-call-codelens-param-value">
                  {position.line}:{position.column}
                </code>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Error */}
        {hasError ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
          </div>
        ) : null}

        {/* Definition view */}
        {parsedResult.type === "definition" ? (
          parsedResult.found ? (
            <div className="tool-call-codelens-symbol-card">
              <div className="tool-call-codelens-symbol-header">
                <ArrowDownToLine size={12} aria-hidden="true" />
                {parsedResult.name ? (
                  <code className="tool-call-codelens-symbol-name">
                    {parsedResult.name}
                  </code>
                ) : null}
                {parsedResult.kind ? (
                  <span className="tool-call-codelens-kind-badge">
                    {parsedResult.kind}
                  </span>
                ) : null}
                {parsedResult.isExported !== undefined ? (
                  <span
                    className={`tool-call-codelens-export-badge ${
                      parsedResult.isExported
                        ? "tool-call-codelens-exported"
                        : "tool-call-codelens-not-exported"
                    }`}
                  >
                    {parsedResult.isExported
                      ? t("toolCall.codelens.exported")
                      : t("toolCall.codelens.notExported")}
                  </span>
                ) : null}
                {parsedResult.searchScope ? (
                  <span className="tool-call-codelens-scope-badge">
                    {parsedResult.searchScope === "project"
                      ? t("toolCall.codelens.scopeProject")
                      : t("toolCall.codelens.scopeFile")}
                  </span>
                ) : null}
              </div>
              {parsedResult.location ? (
                <div className="tool-call-codelens-loc-row">
                  <MapPin size={11} aria-hidden="true" />
                  <span
                    className="tool-call-codelens-loc-text"
                    title={parsedResult.location.filePath}
                  >
                    {parsedResult.location.filePath}:
                    {parsedResult.location.line}:
                    {parsedResult.location.column}
                  </span>
                </div>
              ) : null}
              {parsedResult.containerName ? (
                <div className="tool-call-codelens-detail-row">
                  <span className="tool-call-codelens-detail-label">
                    {t("toolCall.codelens.container")}
                  </span>
                  <code className="tool-call-codelens-detail-value">
                    {parsedResult.containerName}
                  </code>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="tool-call-codelens-no-results">
              <XCircle size={14} aria-hidden="true" />
              <span>
                {parsedResult.message ??
                  t("toolCall.codelens.noSymbolFound")}
              </span>
            </div>
          )
        ) : null}

        {/* References view */}
        {parsedResult.type === "references" ? (
          parsedResult.found ? (
            <>
              <div className="tool-call-codelens-ref-header">
                <Link2 size={12} aria-hidden="true" />
                {parsedResult.name ? (
                  <code className="tool-call-codelens-symbol-name">
                    {parsedResult.name}
                  </code>
                ) : null}
                {parsedResult.searchScope ? (
                  <span className="tool-call-codelens-scope-badge">
                    {parsedResult.searchScope === "project"
                      ? t("toolCall.codelens.scopeProject")
                      : t("toolCall.codelens.scopeFile")}
                  </span>
                ) : null}
              </div>

              {parsedResult.definition ? (
                <div className="tool-call-codelens-def-section">
                  <span className="tool-call-codelens-section-label">
                    <ArrowDownToLine size={11} aria-hidden="true" />
                    {t("toolCall.codelens.definition")}
                  </span>
                  <div className="tool-call-codelens-loc-row">
                    <MapPin size={11} aria-hidden="true" />
                    <span
                      className="tool-call-codelens-loc-text"
                      title={parsedResult.definition.filePath}
                    >
                      {parsedResult.definition.filePath}:
                      {parsedResult.definition.line}:
                      {parsedResult.definition.column}
                    </span>
                  </div>
                </div>
              ) : null}

              {groupedReferences && groupedReferences.length > 0 ? (
                <div className="tool-call-codelens-ref-list">
                  <span className="tool-call-codelens-section-label">
                    {t("toolCall.codelens.references")}
                  </span>
                  {groupedReferences.map(
                    ([refFilePath, refs], groupIdx) => (
                      <div
                        key={`${refFilePath}-${groupIdx}`}
                        className="tool-call-codelens-ref-group"
                      >
                        <div
                          className="tool-call-codelens-ref-file-header"
                          title={refFilePath}
                          data-path={refFilePath}
                        >
                          <FileCode size={12} aria-hidden="true" />
                          <span
                            className="tool-call-codelens-ref-file-name"
                            data-path={refFilePath}
                          >
                            {getFileName(refFilePath)}
                          </span>
                          <span
                            className="tool-call-codelens-ref-file-path"
                            data-path={refFilePath}
                          >
                            {refFilePath}
                          </span>
                          <span className="tool-call-codelens-ref-file-count">
                            {refs.length}
                          </span>
                        </div>
                        <div className="tool-call-codelens-ref-match-list">
                          {refs.map((ref, refIdx) => (
                            <div
                              key={`${ref.location.line}-${refIdx}`}
                              className="tool-call-codelens-ref-match"
                              data-path={refFilePath}
                              data-line={ref.location.line}
                            >
                              <span className="tool-call-codelens-ref-loc">
                                <Hash size={9} aria-hidden="true" />
                                {ref.location.line}:{ref.location.column}
                              </span>
                              <span className="tool-call-codelens-ref-access">
                                {ref.access}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  )}
                </div>
              ) : (
                <div className="tool-call-codelens-no-results">
                  <XCircle size={14} aria-hidden="true" />
                  <span>{t("toolCall.codelens.noReferences")}</span>
                </div>
              )}
            </>
          ) : (
            <div className="tool-call-codelens-no-results">
              <XCircle size={14} aria-hidden="true" />
              <span>
                {parsedResult.message ??
                  t("toolCall.codelens.noSymbolFound")}
              </span>
            </div>
          )
        ) : null}

        {/* Outline view */}
        {parsedResult.type === "outline" ? (
          parsedResult.outline.length > 0 ? (
            <div className="tool-call-codelens-outline">
              {parsedResult.outline.map((entry, idx) => (
                <div
                  key={`${entry.name}-${idx}`}
                  className="tool-call-codelens-outline-entry"
                >
                  <span className="tool-call-codelens-outline-kind">
                    {entry.kind}
                  </span>
                  <code className="tool-call-codelens-outline-name">
                    {entry.name}
                  </code>
                  {entry.containerName ? (
                    <span className="tool-call-codelens-outline-container">
                      {entry.containerName}
                    </span>
                  ) : null}
                  {entry.isExported ? (
                    <span className="tool-call-codelens-export-badge tool-call-codelens-exported">
                      {t("toolCall.codelens.exported")}
                    </span>
                  ) : null}
                  <span className="tool-call-codelens-outline-line">
                    <Hash size={9} aria-hidden="true" />
                    {entry.line}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="tool-call-codelens-no-results">
              <ListTree size={14} aria-hidden="true" />
              <span>{t("toolCall.codelens.noSymbols")}</span>
            </div>
          )
        ) : null}

        {/* Raw result fallback */}
        {parsedResult.type === "raw" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.codelens.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}

        {/* Pending / running state */}
        {parsedResult.type === "empty" ? (
          <div
            className={`tool-call-codelens-pending ${
              isRunning ? "tool-call-codelens-pending-running" : ""
            }`}
          >
            {isRunning ? (
              <Loader2
                className="tool-call-icon-spinning"
                size={14}
                aria-hidden="true"
              />
            ) : (
              <ScanSearch size={14} aria-hidden="true" />
            )}
            <span>
              {isRunning
                ? t("toolCall.codelens.running")
                : t("toolCall.codelens.waiting")}
            </span>
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
