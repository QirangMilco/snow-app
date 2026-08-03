import { AlertCircle, Database, Loader2 } from "lucide-react";
import { useI18n } from "../../i18n";
import type { CodebaseSyncStatus } from "../../hooks/useCodebaseWatcher";

type CodebaseSyncIndicatorProps = {
  /** Current sync status from the codebase watcher hook. */
  syncStatus: CodebaseSyncStatus;
  /** The project id the status reflects. */
  watchedProjectId: string | undefined;
  /** The currently active project id (used to decide visibility). */
  activeProjectId: string | undefined;
  /** Whether the project has an existing index (totalChunks > 0). */
  isIndexed: boolean;
  /** Error message of the last failed embedding, or null when healthy. */
  embedError: string | null;
  /** Opens the project codebase management panel for the active project. */
  onClick?: () => void;
};

/**
 * A compact indicator shown in the TopBar next to the codebase panel button.
 *
 * Visibility rules:
 * - Only shown when `watchedProjectId` matches `activeProjectId` (i.e. the
 *   watcher is active for the currently selected project).
 * - Hidden when `syncStatus` is `idle` (codebase disabled or no project).
 *
 * Visual states:
 * - `embedError` set: Database icon in red with a red dot — the last
 *   embedding failed. Clicking opens the codebase management panel, which
 *   shows the error details and retry actions (see #16).
 * - `watching` + indexed: Database icon with a green dot — index is up to
 *   date, watching for file changes.
 * - `watching` + not indexed: Database icon with an amber pulsing dot —
 *   codebase is enabled but embedding has not been started yet.
 * - `syncing`: Loader2 icon (spinning) with a blue dot — incremental sync
 *   in progress (embedding new/changed files, deleting removed files).
 *
 * The indicator is clickable and opens the project codebase management
 * panel (see #17).
 */
export const CodebaseSyncIndicator = ({
  syncStatus,
  watchedProjectId,
  activeProjectId,
  isIndexed,
  embedError,
  onClick,
}: CodebaseSyncIndicatorProps): React.JSX.Element | null => {
  const { t } = useI18n();

  // Don't render if there's no active watcher or it's for a different project.
  if (!watchedProjectId || watchedProjectId !== activeProjectId) {
    return null;
  }

  if (syncStatus === "idle") {
    return null;
  }

  const hasError = embedError !== null && embedError !== "";
  const isSyncing = syncStatus === "syncing";
  const isPending = !isSyncing && !isIndexed;

  const label = hasError
    ? t("topBar.codebaseSync.error")
    : isSyncing
      ? t("topBar.codebaseSync.syncing")
      : isPending
        ? t("topBar.codebaseSync.pending")
        : t("topBar.codebaseSync.watching");

  const className = hasError
    ? "is-error"
    : isSyncing
      ? "is-syncing"
      : isPending
        ? "is-pending"
        : "is-watching";

  return (
    <button
      className={`icon-btn ghost top-bar-codebase-sync ${className}`}
      type="button"
      aria-label={label}
      title={hasError && embedError ? `${label}: ${embedError}` : label}
      onClick={onClick}
    >
      {hasError ? (
        <AlertCircle size={14} strokeWidth={1.8} />
      ) : isSyncing ? (
        <Loader2 size={14} strokeWidth={1.8} className="spin" />
      ) : (
        <Database size={14} strokeWidth={1.8} />
      )}
      <span className="top-bar-codebase-sync-dot" aria-hidden="true" />
    </button>
  );
};
