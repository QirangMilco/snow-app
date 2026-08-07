import { useMemo } from "react";
import { AlertCircle, Hash } from "lucide-react";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { getFileTypeIcon } from "../../../../utils/fileIcons";
import { ToolCallNode } from "./shared/ToolCallNode";

type ParsedPathItem = {
  path: string;
  startLine?: number;
  endLine?: number;
};

type ParsedArgs = {
  isMulti: boolean;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  paths?: ParsedPathItem[];
};

type SingleFileResult =
  | {
      type: "file";
      content: string;
      totalLines: number;
      startLine: number;
      endLine: number;
    }
  | { type: "directory"; entries: string[] }
  | { type: "image"; content: string; mediaType: string }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

type ParsedResult =
  | SingleFileResult
  | { type: "multi"; files: { filePath: string; result: SingleFileResult }[] };

const parsePathItems = (
  items: unknown[],
  defaultStartLine?: number,
  defaultEndLine?: number
): ParsedPathItem[] => {
  return items
    .map((item): ParsedPathItem | null => {
      if (typeof item === "string") {
        if (!item) return null;
        return {
          path: item,
          startLine: defaultStartLine,
          endLine: defaultEndLine,
        };
      }
      if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as { path?: unknown }).path === "string"
      ) {
        const obj = item as {
          path: string;
          startLine?: number;
          endLine?: number;
        };
        if (!obj.path) return null;
        return {
          path: obj.path,
          startLine:
            typeof obj.startLine === "number"
              ? obj.startLine
              : defaultStartLine,
          endLine:
            typeof obj.endLine === "number" ? obj.endLine : defaultEndLine,
        };
      }
      return null;
    })
    .filter((item): item is ParsedPathItem => item !== null);
};

const parseArgs = (args: string): ParsedArgs | null => {
  try {
    const parsed = JSON.parse(args);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const filePath = parsed.filePath;
    const defaultStartLine =
      typeof parsed.startLine === "number" ? parsed.startLine : undefined;
    const defaultEndLine =
      typeof parsed.endLine === "number" ? parsed.endLine : undefined;

    // Array case: multi-file
    if (Array.isArray(filePath)) {
      const paths = parsePathItems(filePath, defaultStartLine, defaultEndLine);
      if (paths.length === 0) {
        return null;
      }
      return { isMulti: true, paths };
    }

    // String case: single file (or JSON array string for multi-file)
    if (typeof filePath === "string") {
      if (!filePath) {
        return null;
      }

      // Check if it's a JSON array string (matching Rust's try_parse_as_json_array)
      const trimmed = filePath.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const arr = JSON.parse(trimmed);
          if (Array.isArray(arr)) {
            const paths = parsePathItems(arr, defaultStartLine, defaultEndLine);
            if (paths.length > 0) {
              return { isMulti: true, paths };
            }
          }
        } catch {
          // Not a valid JSON array, treat as single file path
        }
      }

      return {
        isMulti: false,
        filePath,
        startLine: defaultStartLine,
        endLine: defaultEndLine,
      };
    }

    return null;
  } catch {
    return null;
  }
};

const parseSingleResultValue = (
  parsed: unknown,
  resultText: string
): SingleFileResult => {
  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;

    if (typeof obj.error === "string") {
      return { type: "error", message: obj.error };
    }

    if (typeof obj.content === "string") {
      if (obj.isImage === true) {
        return {
          type: "image",
          content: obj.content,
          mediaType:
            typeof obj.mediaType === "string" ? obj.mediaType : "image",
        };
      }

      if (
        typeof obj.totalLines === "number" &&
        typeof obj.startLine === "number" &&
        typeof obj.endLine === "number"
      ) {
        return {
          type: "file",
          content: obj.content,
          totalLines: obj.totalLines,
          startLine: obj.startLine,
          endLine: obj.endLine,
        };
      }

      // No line metadata -> directory listing
      const entries = (obj.content as string)
        .split("\n")
        .filter((line: string) => line.length > 0);
      return { type: "directory", entries };
    }
  }

  return { type: "raw", text: resultText };
};

const parseResult = (result: string | undefined): ParsedResult => {
  if (!result) {
    return { type: "empty" };
  }

  try {
    const parsed = JSON.parse(result);

    // Multi-file result: { "files": [...] }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as Record<string, unknown>).files)
    ) {
      const files = (parsed as { files: Record<string, unknown>[] }).files.map(
        (file, index) => {
          const filePath =
            typeof file.filePath === "string"
              ? file.filePath
              : `file[${index}]`;
          return {
            filePath,
            result: parseSingleResultValue(file, JSON.stringify(file)),
          };
        }
      );
      return { type: "multi", files };
    }

    // Single file result
    return parseSingleResultValue(parsed, result);
  } catch {
    return { type: "raw", text: result };
  }
};

const getFileName = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).pop() || path;

const getSingleFileRangeLabel = (result: SingleFileResult): string => {
  if (result.type === "directory") {
    return "directory";
  }
  if (result.type === "file") {
    const { startLine, endLine, totalLines } = result;
    if (endLine - startLine + 1 >= totalLines) {
      return `${totalLines} lines`;
    }
    return `L${startLine}-${endLine}`;
  }
  return "";
};

const getLineRangeLabel = (
  parsedArgs: ParsedArgs | null,
  parsedResult: ParsedResult
): string => {
  if (parsedResult.type === "multi") {
    return `${parsedResult.files.length} files`;
  }

  if (parsedResult.type === "directory") {
    return "directory";
  }

  if (parsedResult.type === "file") {
    const { startLine, endLine, totalLines } = parsedResult;
    if (endLine - startLine + 1 >= totalLines) {
      return `${totalLines} lines`;
    }
    return `L${startLine}-${endLine}`;
  }

  if (parsedArgs && !parsedArgs.isMulti) {
    if (parsedArgs.startLine || parsedArgs.endLine) {
      const start = parsedArgs.startLine ?? 1;
      const end = parsedArgs.endLine ?? start;
      return end > start ? `L${start}-${end}` : `L${start}`;
    }
  }

  return "";
};

const renderFileContent = (
  result: SingleFileResult
): React.JSX.Element | null => {
  switch (result.type) {
    case "error":
      return (
        <div className="tool-call-error">
          <AlertCircle size={12} aria-hidden="true" />
          <span>{result.message}</span>
        </div>
      );
    case "directory":
      return (
        <div className="tool-call-dir-listing">
          {result.entries.map((entry, i) => {
            const isDir = entry.endsWith("/");
            return (
              <div key={i} className="tool-call-dir-entry">
                {getFileTypeIcon(
                  isDir ? entry.slice(0, -1) : entry,
                  isDir,
                  false,
                  { size: 12, "aria-hidden": true }
                )}
                <span>{isDir ? entry.slice(0, -1) : entry}</span>
              </div>
            );
          })}
        </div>
      );
    case "file":
      return (
        <div className="tool-call-file-result">
          <div className="tool-call-file-meta">
            <span>
              Lines {result.startLine}-{result.endLine} of {result.totalLines}
            </span>
          </div>
          <pre className="tool-call-section-pre tool-call-file-content">
            {result.content}
          </pre>
        </div>
      );
    case "image":
      return (
        <div className="tool-call-image-result">
          <div className="tool-call-file-meta">
            <span>{result.mediaType}</span>
          </div>
          <img
            src={
              result.content.match(/@@image:([^@]+)@@/)?.[1] ?? result.content
            }
            alt={`Image preview (${result.mediaType})`}
            className="tool-call-image-preview"
          />
        </div>
      );
    case "raw":
      return <pre className="tool-call-section-pre">{result.text}</pre>;
    case "empty":
      return null;
  }
};

type FilesystemReadToolCallProps = {
  toolCall: ToolCallInfo;
};

export const FilesystemReadToolCall = ({
  toolCall,
}: FilesystemReadToolCallProps): React.JSX.Element => {
  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments]
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result]
  );

  const isMulti = parsedArgs?.isMulti === true || parsedResult.type === "multi";

  const rangeLabel = getLineRangeLabel(parsedArgs, parsedResult);

  const filePath = parsedArgs?.filePath ?? "read";
  const fileName = getFileName(filePath);

  const fileCount = isMulti
    ? parsedArgs?.paths?.length ??
      (parsedResult.type === "multi" ? parsedResult.files.length : 0)
    : 0;
  const displayName = isMulti ? `${fileCount} files` : fileName;

  const hasError = parsedResult.type === "error";
  const effectiveStatus = hasError ? "error" : toolCall.status;

  return (
    <ToolCallNode
      toolName={toolCall.name}
      category="read"
      displayName={
        isMulti ? (
          displayName
        ) : (
          <>
            {getFileTypeIcon(
              fileName,
              parsedResult.type === "directory",
              false,
              {
                size: 13,
                "aria-hidden": true,
              }
            )}
            {fileName}
          </>
        )
      }
      displayNameTitle={isMulti ? undefined : filePath}
      displayNameDataPath={isMulti ? undefined : filePath}
      status={effectiveStatus}
      meta={
        rangeLabel ? (
          <span className="tool-call-line-range">
            <Hash size={10} aria-hidden="true" />
            {rangeLabel}
          </span>
        ) : null
      }
      className="tool-call-filesystem-read"
    >
      <div className="tool-call-body">
        {parsedResult.type === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
          </div>
        ) : parsedResult.type === "multi" ? (
          <div className="tool-call-multi-files">
            {parsedResult.files.map((file, i) => {
              const subFileName = getFileName(file.filePath);
              const subIsDir = file.result.type === "directory";
              const subRange = getSingleFileRangeLabel(file.result);
              return (
                <div key={i} className="tool-call-multi-file-section">
                  <div className="tool-call-multi-file-header">
                    {getFileTypeIcon(subFileName, subIsDir, false, {
                      size: 12,
                      "aria-hidden": true,
                    })}
                    <span
                      className="tool-call-multi-file-name"
                      title={file.filePath}
                      data-path={file.filePath}
                    >
                      {subFileName}
                    </span>
                    {subRange ? (
                      <span className="tool-call-line-range">
                        <Hash size={10} aria-hidden="true" />
                        {subRange}
                      </span>
                    ) : null}
                  </div>
                  <div
                    className="tool-call-multi-file-path"
                    data-path={file.filePath}
                  >
                    {file.filePath}
                  </div>
                  {renderFileContent(file.result)}
                </div>
              );
            })}
          </div>
        ) : parsedResult.type === "empty" ? (
          <div className="tool-call-pending">
            {isMulti ? (
              parsedArgs?.paths ? (
                <div className="tool-call-dir-listing">
                  {parsedArgs.paths.map((p, i) => (
                    <div key={i} className="tool-call-dir-entry">
                      {getFileTypeIcon(getFileName(p.path), false, false, {
                        size: 12,
                        "aria-hidden": true,
                      })}
                      <span data-path={p.path}>{p.path}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="tool-call-section-label">No arguments</span>
              )
            ) : parsedArgs ? (
              <pre className="tool-call-section-pre">
                {JSON.stringify(parsedArgs, null, 2)}
              </pre>
            ) : (
              <span className="tool-call-section-label">No arguments</span>
            )}
          </div>
        ) : (
          <>
            <div className="tool-call-file-path" data-path={filePath}>
              {filePath}
            </div>
            {renderFileContent(parsedResult)}
          </>
        )}
      </div>
    </ToolCallNode>
  );
};
