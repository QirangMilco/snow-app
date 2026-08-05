import { useMemo } from "react";
import {
  AlertCircle,
  Loader2,
  Search,
  Hash,
  FileCode,
  Filter,
  CheckCircle,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type GrepToolCallProps = {
  toolCall: ToolCallInfo;
};

type ParsedGrepArgs = {
  pattern: string;
  path?: string;
  fileGlob?: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
};

type GrepMatch = {
  file: string;
  line: number;
  content: string;
};

type ParsedGrepResult =
  | {
      type: "success";
      backend: string;
      matches: GrepMatch[];
      totalMatches: number;
      truncated: boolean;
      rawOutput: string;
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseArgs = (args: string): ParsedGrepArgs | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed) || typeof parsed.pattern !== "string") {
      return null;
    }

    const result: ParsedGrepArgs = { pattern: parsed.pattern };

    if (typeof parsed.path === "string") {
      result.path = parsed.path;
    }
    if (typeof parsed.fileGlob === "string") {
      result.fileGlob = parsed.fileGlob;
    }
    if (typeof parsed.isRegex === "boolean") {
      result.isRegex = parsed.isRegex;
    }
    if (typeof parsed.caseSensitive === "boolean") {
      result.caseSensitive = parsed.caseSensitive;
    }
    if (typeof parsed.maxResults === "number") {
      result.maxResults = parsed.maxResults;
    }

    return result;
  } catch {
    return null;
  }
};

const parseResult = (result: string | undefined): ParsedGrepResult => {
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

    if (Array.isArray(parsed.matches)) {
      const matches: GrepMatch[] = parsed.matches
        .filter(isRecord)
        .filter(
          (m) =>
            typeof m.file === "string" &&
            typeof m.line === "number" &&
            typeof m.content === "string"
        )
        .map((m) => ({
          file: m.file as string,
          line: m.line as number,
          content: m.content as string,
        }));

      return {
        type: "success",
        backend:
          typeof parsed.backend === "string" ? parsed.backend : "unknown",
        matches,
        totalMatches:
          typeof parsed.totalMatches === "number"
            ? parsed.totalMatches
            : matches.length,
        truncated: parsed.truncated === true,
        rawOutput: typeof parsed.rawOutput === "string" ? parsed.rawOutput : "",
      };
    }

    if (typeof parsed.message === "string") {
      return { type: "error", message: parsed.message };
    }

    return { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};

const getFileName = (filePath: string): string =>
  filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;

export const GrepToolCall = ({
  toolCall,
}: GrepToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments]
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result]
  );

  const isRunning = toolCall.status === "running";

  const pattern = parsedArgs?.pattern ?? "search";
  const searchPath = parsedArgs?.path ?? ".";
  const hasError = parsedResult.type === "error";
  const effectiveStatus = hasError ? "error" : toolCall.status;

  const matchCount =
    parsedResult.type === "success" ? parsedResult.totalMatches : 0;
  const hasMatches = matchCount > 0;

  // Group matches by file for display.
  const groupedMatches = useMemo(() => {
    if (parsedResult.type !== "success") return null;

    const groups = new Map<string, GrepMatch[]>();
    for (const match of parsedResult.matches) {
      const existing = groups.get(match.file) ?? [];
      existing.push(match);
      groups.set(match.file, existing);
    }

    return Array.from(groups.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
  }, [parsedResult]);

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={t("toolCall.grep.name")}
      category="search"
      displayName={pattern.length > 60 ? `${pattern.slice(0, 60)}...` : pattern}
      status={effectiveStatus}
      meta={
        parsedResult.type === "success" ? (
          <span
            className={`tool-call-grep-match-count ${
              hasMatches
                ? "tool-call-grep-has-matches"
                : "tool-call-grep-no-matches"
            }`}
          >
            {t("toolCall.grep.matchCount", { values: { count: matchCount } })}
          </span>
        ) : null
      }
      className="tool-call-grep"
    >
      <div className="tool-call-body tool-call-grep-body">
        {/* Search parameters */}
        {parsedArgs ? (
          <div className="tool-call-grep-params">
            <div className="tool-call-grep-param-item">
              <Search size={11} aria-hidden="true" />
              <span className="tool-call-grep-param-label">
                {t("toolCall.grep.pattern")}
              </span>
              <code className="tool-call-grep-param-value">{pattern}</code>
            </div>

            <div className="tool-call-grep-param-item">
              <FileCode size={11} aria-hidden="true" />
              <span className="tool-call-grep-param-label">
                {t("toolCall.grep.path")}
              </span>
              <span className="tool-call-grep-param-value">{searchPath}</span>
            </div>

            {parsedArgs.fileGlob ? (
              <div className="tool-call-grep-param-item">
                <Filter size={11} aria-hidden="true" />
                <span className="tool-call-grep-param-label">
                  {t("toolCall.grep.fileGlob")}
                </span>
                <code className="tool-call-grep-param-value">
                  {parsedArgs.fileGlob}
                </code>
              </div>
            ) : null}

            <div className="tool-call-grep-param-meta">
              {parsedArgs.isRegex !== undefined ? (
                <span className="tool-call-grep-param-tag">
                  {parsedArgs.isRegex
                    ? t("toolCall.grep.regex")
                    : t("toolCall.grep.literal")}
                </span>
              ) : null}
              {parsedArgs.caseSensitive !== undefined ? (
                <span className="tool-call-grep-param-tag">
                  {parsedArgs.caseSensitive
                    ? t("toolCall.grep.caseSensitive")
                    : t("toolCall.grep.caseInsensitive")}
                </span>
              ) : null}
              {parsedArgs.maxResults !== undefined ? (
                <span className="tool-call-grep-param-tag">
                  {t("toolCall.grep.maxResults")}: {parsedArgs.maxResults}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Backend badge */}
        {parsedResult.type === "success" ? (
          <div className="tool-call-grep-backend">
            <CheckCircle size={11} aria-hidden="true" />
            <span>
              {t("toolCall.grep.backend")}: {parsedResult.backend}
            </span>
            {parsedResult.truncated ? (
              <span className="tool-call-grep-truncated">
                {t("toolCall.grep.truncated")}
              </span>
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

        {/* Match results grouped by file */}
        {groupedMatches && groupedMatches.length > 0 ? (
          <div className="tool-call-grep-results">
            {groupedMatches.map(([filePath, fileMatches], groupIdx) => {
              const fileName = getFileName(filePath);
              return (
                <div
                  key={`${filePath}-${groupIdx}`}
                  className="tool-call-grep-file-group"
                >
                  <div
                    className="tool-call-grep-file-header"
                    title={filePath}
                    data-path={filePath}
                  >
                    <FileCode size={12} aria-hidden="true" />
                    <span
                      className="tool-call-grep-file-name"
                      data-path={filePath}
                    >
                      {fileName}
                    </span>
                    <span
                      className="tool-call-grep-file-path"
                      data-path={filePath}
                    >
                      {filePath}
                    </span>
                    <span className="tool-call-grep-file-count">
                      {fileMatches.length}
                    </span>
                  </div>
                  <div className="tool-call-grep-match-list">
                    {fileMatches.map((match, matchIdx) => (
                      <div
                        key={`${match.line}-${matchIdx}`}
                        className="tool-call-grep-match-line"
                        data-path={filePath}
                        data-line={match.line}
                      >
                        <span className="tool-call-grep-line-num">
                          <Hash size={9} aria-hidden="true" />
                          {match.line}
                        </span>
                        <code className="tool-call-grep-line-content">
                          {match.content}
                        </code>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        {/* No matches */}
        {parsedResult.type === "success" && !hasMatches ? (
          <div className="tool-call-grep-no-results">
            <Search size={14} aria-hidden="true" />
            <span>{t("toolCall.grep.noMatches")}</span>
          </div>
        ) : null}

        {/* Raw result fallback */}
        {parsedResult.type === "raw" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.grep.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}

        {/* Pending state */}
        {parsedResult.type === "empty" ? (
          <div
            className={`tool-call-grep-pending ${
              isRunning ? "tool-call-grep-pending-running" : ""
            }`}
          >
            {isRunning ? (
              <Loader2
                className="tool-call-icon-spinning"
                size={14}
                aria-hidden="true"
              />
            ) : (
              <Search size={14} aria-hidden="true" />
            )}
            <span>
              {isRunning
                ? t("toolCall.grep.running")
                : t("toolCall.grep.waiting")}
            </span>
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
