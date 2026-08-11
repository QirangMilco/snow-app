import type {
  ChatMessageRecord,
  FileChangeDiff,
  ToolCallInfo,
} from "../utils/conversationTypes";
import type { FileChangeRecord } from "../utils/conversationTypes";
import { parseToolCalls } from "../utils/conversationHelpers";
import { resolveResponseDisposition } from "../utils/responseDisposition";
import { generateComparePatch } from "../../../../utils/generateComparePatch";

/** Tools whose successful execution counts as a file modification. */
const FILE_MODIFYING_TOOLS = new Set([
  "filesystem-create",
  "filesystem-replace_edit",
]);

/**
 * Build the diff patch for a successful file-modifying tool call so the
 * file-changes panel can show what actually changed:
 *   - filesystem-create: full file content (empty file -> content)
 *   - filesystem-replace_edit: the searchContent -> replaceContent
 *     replacement region with context lines
 * Both payloads live in the tool call arguments, which are persisted in
 * history, so the same patch can be rebuilt after a restart.
 */
const buildFileChangeDiff = (
  toolName: string,
  args: Record<string, unknown>,
  filePath: string
): FileChangeDiff | undefined => {
  try {
    if (toolName === "filesystem-create") {
      const content =
        typeof args.content === "string" ? args.content : "";
      if (!content) {
        return undefined;
      }
      const patch = generateComparePatch(filePath, "", content);
      return patch ? { patch } : undefined;
    }

    const searchContent =
      typeof args.searchContent === "string" ? args.searchContent : "";
    const replaceContent =
      typeof args.replaceContent === "string" ? args.replaceContent : "";
    if (!searchContent && !replaceContent) {
      return undefined;
    }
    const patch = generateComparePatch(
      filePath,
      searchContent,
      replaceContent
    );
    return patch ? { patch } : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Extract a file-change record from a completed tool call, or null when the
 * tool call did not modify a file (different tool, missing filePath, or the
 * tool result indicates failure).
 *
 * Only the two dedicated filesystem write tools are tracked:
 *   - filesystem-create:        success = { "success": true, "path": ... }
 *   - filesystem-replace_edit:  success = { "success": true, ... }
 * Both carry the target path in the `filePath` argument, which is where we
 * read it from (the create result also echoes it, but the argument is the
 * single source of truth for both).
 *
 * The result JSON is parsed defensively: hooks may append context to the
 * result string, so a parse failure simply means "no record".
 */
export function extractFileChangeFromTool(
  toolName: string,
  argsJson: string,
  resultJson: string
): Pick<FileChangeRecord, "filePath" | "kind" | "diff"> | null {
  if (!FILE_MODIFYING_TOOLS.has(toolName)) {
    return null;
  }

  let args: unknown;
  let result: unknown;
  try {
    args = JSON.parse(argsJson);
    result = JSON.parse(resultJson);
  } catch {
    return null;
  }

  if (
    typeof args !== "object" ||
    args === null ||
    typeof (args as Record<string, unknown>).filePath !== "string"
  ) {
    return null;
  }

  // A successful tool result carries "success": true. Anything else
  // (error JSON, plain text error, hook-abort JSON) is not a modification.
  if (
    typeof result !== "object" ||
    result === null ||
    (result as Record<string, unknown>).success !== true
  ) {
    return null;
  }

  const argsRecord = args as Record<string, unknown>;
  const filePath = argsRecord.filePath as string;
  if (!filePath.trim()) {
    return null;
  }

  return {
    filePath,
    kind: toolName === "filesystem-create" ? "create" : "edit",
    diff: buildFileChangeDiff(toolName, argsRecord, filePath),
  };
}

/**
 * Collect the file-change records for a conversation. Main-agent changes are
 * stored under the conversation's own key (agent: "main"); sub-agent changes
 * are stored under both the sub-agent's key and the parent conversation's key
 * (agent: "sub", tagged with the sub-agent name) at record time — so a single
 * lookup here yields the full picture for display.
 *
 * Repeated edits to the same file are normalized to a single entry: only the
 * latest change (highest timestamp) survives, carrying the final diff, so the
 * stats list never shows multiple rows for one file path. Records are
 * returned in chronological order of their last modification.
 */
export function collectConversationFileChanges(
  fileChangeStats: Record<string, FileChangeRecord[]>,
  conversationId: string
): FileChangeRecord[] {
  const changes = fileChangeStats[conversationId] ?? [];
  const latestByPath = new Map<string, FileChangeRecord>();
  for (const change of changes) {
    const existing = latestByPath.get(change.filePath);
    if (!existing || change.timestamp >= existing.timestamp) {
      latestByPath.set(change.filePath, change);
    }
  }
  return [...latestByPath.values()].sort(
    (left, right) => left.timestamp - right.timestamp
  );
}

/** Count of unique file paths in a list of change records. */
export function countUniqueFiles(changes: FileChangeRecord[]): number {
  return new Set(changes.map((change) => change.filePath)).size;
}

export type FileChangeLineStats = {
  additions: number;
  deletions: number;
};

/**
 * Sum added and deleted lines from the unified diffs captured for file tools.
 * The first two lines are diff headers and are intentionally excluded.
 */
export function countFileChangeLines(
  changes: FileChangeRecord[]
): FileChangeLineStats {
  let additions = 0;
  let deletions = 0;

  for (const change of changes) {
    if (!change.diff?.patch || change.diff.isBinary) {
      continue;
    }

    const lines = change.diff.patch.split("\n").slice(2);
    for (const line of lines) {
      if (line.startsWith("+")) {
        additions += 1;
      } else if (line.startsWith("-")) {
        deletions += 1;
      }
    }
  }

  return { additions, deletions };
}

/** A file change extracted from persisted history, without agent attribution
 *  (the caller decides whether it belongs to the main agent or a sub-agent). */
export type ExtractedFileChange = Pick<
  FileChangeRecord,
  "filePath" | "kind" | "timestamp" | "diff"
>;

/**
 * Strip hook-appended sections from a persisted tool result so the raw
 * success JSON (which lives before the "[Hook Context]" marker) can be
 * parsed. Mirrors how toolExecution.ts appends hook context at runtime.
 */
const stripHookSuffix = (result: string): string =>
  result.split("\n\n[Hook Context]")[0] ?? result;

/**
 * Rebuild file-change records from persisted history records. The database
 * stores each assistant message's tool calls in `toolCallsJson` and each
 * tool result as `[Tool: name#callId]\n<result>` segments inside tool-message
 * content — the same pairing logic `buildConversationMessages` uses for the
 * live message list, so this reconstruction matches what the runtime stats
 * would have recorded.
 *
 * Timestamps come from the message's persisted `createdAt` so re-running this
 * extraction (e.g. after switching conversations) yields stable keys that the
 * merge step can de-duplicate against.
 */
export function extractFileChangesFromRecords(
  records: ChatMessageRecord[]
): ExtractedFileChange[] {
  const toolResultQueues = new Map<string, string[]>();
  for (const record of records) {
    if (record.role !== "tool" || !record.content) {
      continue;
    }
    for (const segment of record.content.split("\n\n")) {
      const match = segment.match(/^\[Tool:\s*(.+?)\]\n([\s\S]*)$/);
      if (!match) {
        continue;
      }
      const queue = toolResultQueues.get(match[1]) ?? [];
      queue.push(match[2]);
      toolResultQueues.set(match[1], queue);
    }
  }

  const consumeToolResult = (toolCall: ToolCallInfo): string | undefined => {
    const identifiers = toolCall.callId
      ? [`${toolCall.name}#${toolCall.callId}`, toolCall.name]
      : [toolCall.name];
    for (const identifier of identifiers) {
      const queue = toolResultQueues.get(identifier);
      if (queue && queue.length > 0) {
        return queue.shift();
      }
    }
    return undefined;
  };

  const changes: ExtractedFileChange[] = [];
  for (const record of records) {
    if (
      record.role !== "assistant" ||
      resolveResponseDisposition(record).kind !== "complete"
    ) {
      continue;
    }
    for (const toolCall of parseToolCalls(record.toolCallsJson)) {
      const result = consumeToolResult(toolCall);
      if (result === undefined) {
        continue;
      }
      const change = extractFileChangeFromTool(
        toolCall.name,
        toolCall.arguments,
        stripHookSuffix(result)
      );
      if (!change) {
        continue;
      }
      const parsedTimestamp = Date.parse(record.createdAt);
      changes.push({
        ...change,
        timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now(),
      });
    }
  }
  return changes;
}
