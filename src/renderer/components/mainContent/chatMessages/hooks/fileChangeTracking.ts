import type { FileChangeRecord } from "../utils/conversationTypes";

/** Tools whose successful execution counts as a file modification. */
const FILE_MODIFYING_TOOLS = new Set([
  "filesystem-create",
  "filesystem-replace_edit",
]);

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
): Pick<FileChangeRecord, "filePath" | "kind"> | null {
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

  const filePath = (args as Record<string, unknown>).filePath as string;
  if (!filePath.trim()) {
    return null;
  }

  return {
    filePath,
    kind: toolName === "filesystem-create" ? "create" : "edit",
  };
}

/**
 * Collect the file-change records for a conversation. Main-agent changes are
 * stored under the conversation's own key (agent: "main"); sub-agent changes
 * are stored under both the sub-agent's key and the parent conversation's key
 * (agent: "sub", tagged with the sub-agent name) at record time — so a single
 * lookup here yields the full picture for display, in chronological order.
 */
export function collectConversationFileChanges(
  fileChangeStats: Record<string, FileChangeRecord[]>,
  conversationId: string
): FileChangeRecord[] {
  const changes = fileChangeStats[conversationId] ?? [];
  // Stable chronological order: creation time is monotonic per renderer
  // session, so a plain sort by timestamp is deterministic.
  return [...changes].sort(
    (left, right) => left.timestamp - right.timestamp
  );
}

/** Count of unique file paths in a list of change records. */
export function countUniqueFiles(changes: FileChangeRecord[]): number {
  return new Set(changes.map((change) => change.filePath)).size;
}
