import { useMemo, useState } from "react";
import { ArrowLeft, Eye, FilePlus2, FilePen } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { Modal } from "../../../common/Modal";
import { getFileTypeIcon } from "../../../../utils/fileIcons";
import {
  FileDiffPreview,
  type FileDiffPreviewItem,
} from "../../../common/FileDiffPreview";
import { useChatConversationContext } from "../../chatMessages/components/ChatConversationContext";
import {
  collectConversationFileChanges,
  countUniqueFiles,
} from "../../chatMessages/hooks/fileChangeTracking";
import type { FileChangeRecord } from "../../chatMessages/utils/conversationTypes";

type FileChangesPanelProps = {
  /** Whether the panel is visible. Controlled by the /changes command. */
  open: boolean;
  onClose: () => void;
};

/**
 * Modal listing every file modified by the main agent and its sub-agents
 * during the active conversation, with a "view changes" action that switches
 * to a diff preview (same FileDiffPreview used by the rollback dialog).
 * Opened via the /changes slash command.
 *
 * Data comes from fileChangeStats, which the tool-execution pipeline fills in
 * live: filesystem-create / filesystem-replace_edit calls that completed
 * successfully. Records are keyed by conversationId — the main conversation
 * collects its own changes (agent: "main"), each sub-agent collects its own
 * under its conversationId (agent: "sub"), and this panel merges them via the
 * parent's childSubAgentIds set.
 *
 * Stats survive restarts: when a conversation is opened, its persisted
 * history (tool calls + results) is scanned to re-hydrate the records, so
 * historical conversations show the same file-change summary as live ones.
 */
export const FileChangesPanel = ({
  open,
  onClose,
}: FileChangesPanelProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const { fileChangeStats, activeConversationId } =
    useChatConversationContext();
  const [isDiffView, setIsDiffView] = useState(false);

  const changes = useMemo(() => {
    if (!activeConversationId) {
      return [];
    }
    return collectConversationFileChanges(
      fileChangeStats,
      activeConversationId
    );
  }, [activeConversationId, fileChangeStats]);

  const summary = useMemo(() => {
    const mainCount = changes.filter(
      (change) => change.agent === "main"
    ).length;
    return {
      uniqueFiles: countUniqueFiles(changes),
      mainCount,
      subCount: changes.length - mainCount,
    };
  }, [changes]);

  // Records without a diff payload (e.g. tool arguments carried no content)
  // stay in the list but are excluded from the diff preview.
  const diffItems = useMemo<FileDiffPreviewItem[]>(
    () =>
      changes
        .filter((change) => change.diff?.patch)
        .map((change) => ({
          path: change.filePath,
          changeType: change.kind === "create" ? "added" : "modified",
          content: change.diff?.patch ?? "",
          isBinary: change.diff?.isBinary ?? false,
        })),
    [changes]
  );

  const isSubChange = (change: FileChangeRecord): boolean =>
    change.agent === "sub";

  const handleClose = (): void => {
    setIsDiffView(false);
    onClose();
  };

  const handleBackToList = (): void => {
    setIsDiffView(false);
  };

  return (
    <Modal
      className="file-changes-modal"
      closeLabel={t("chat.fileChanges.close")}
      description={t("chat.fileChanges.description")}
      onClose={handleClose}
      open={open}
      size="large"
      title={
        isDiffView
          ? t("chat.fileChanges.diffTitle")
          : t("chat.fileChanges.title")
      }
      footer={
        !isDiffView && changes.length > 0 && diffItems.length > 0 ? (
          <button
            type="button"
            className="file-changes-view-diff-btn"
            onClick={() => setIsDiffView(true)}
          >
            <Eye size={14} />
            {t("chat.fileChanges.viewDiff")}
          </button>
        ) : undefined
      }
    >
      {isDiffView ? (
        <div className="file-changes-diff-view">
          <div className="file-changes-diff-toolbar">
            <button
              type="button"
              className="rollback-preview-back"
              onClick={handleBackToList}
              aria-label={t("chat.fileChanges.backToList")}
              title={t("chat.fileChanges.backToList")}
            >
              <ArrowLeft size={15} />
            </button>
            <span className="file-changes-diff-toolbar-title">
              {t("chat.fileChanges.diffTitle")}
            </span>
          </div>
          <FileDiffPreview
            diffs={diffItems}
            isLoading={false}
            hasError={false}
            labels={{
              loading: "",
              error: "",
              empty: t("chat.fileChanges.diffEmpty"),
              selectFile: t("chat.fileChanges.selectFile"),
            }}
          />
        </div>
      ) : changes.length === 0 ? (
        <div className="file-changes-empty">
          <span className="file-changes-empty-title">
            {t("chat.fileChanges.emptyTitle")}
          </span>
          <span className="file-changes-empty-hint">
            {t("chat.fileChanges.emptyHint")}
          </span>
        </div>
      ) : (
        <div className="file-changes-body">
          <div className="file-changes-summary">
            <span className="file-changes-summary-text">
              {t("chat.fileChanges.summary", {
                values: { count: summary.uniqueFiles },
              })}
            </span>
            <span className="file-changes-badges">
              <span className="file-changes-badge is-main">
                {t("chat.fileChanges.agentMain", {
                  values: { count: summary.mainCount },
                })}
              </span>
              {summary.subCount > 0 ? (
                <span className="file-changes-badge is-sub">
                  {t("chat.fileChanges.agentSub", {
                    values: { count: summary.subCount },
                  })}
                </span>
              ) : null}
            </span>
          </div>

          <ul className="file-changes-list">
            {changes.map((change, index) => {
              const fileName =
                change.filePath.split(/[\\/]/).pop() || change.filePath;
              return (
                <li
                  className="file-changes-row"
                  key={`${change.filePath}-${change.timestamp}-${index}`}
                  title={change.filePath}
                >
                  <span className="file-changes-row-icon" aria-hidden="true">
                    {change.kind === "create" ? (
                      <FilePlus2 size={13} strokeWidth={2} />
                    ) : (
                      <FilePen size={13} strokeWidth={2} />
                    )}
                  </span>
                  <span className="file-changes-path">
                    {getFileTypeIcon(fileName, false, false, {
                      size: 13,
                      "aria-hidden": true,
                    })}
                    <span className="file-changes-path-text">
                      {change.filePath}
                    </span>
                  </span>
                  <span className={`file-changes-kind is-${change.kind}`}>
                    {change.kind === "create"
                      ? t("chat.fileChanges.kindCreate")
                      : t("chat.fileChanges.kindEdit")}
                  </span>
                  <span
                    className={`file-changes-agent${
                      isSubChange(change) ? " is-sub" : ""
                    }`}
                  >
                    {isSubChange(change)
                      ? change.subAgentName ??
                        t("chat.fileChanges.agentSubName")
                      : t("chat.fileChanges.agentMainName")}
                  </span>
                  {change.diff?.patch ? (
                    <button
                      type="button"
                      className="file-changes-row-diff-btn"
                      onClick={() => setIsDiffView(true)}
                      aria-label={t("chat.fileChanges.viewDiff")}
                      title={t("chat.fileChanges.viewDiff")}
                    >
                      <Eye size={12} />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Modal>
  );
};
