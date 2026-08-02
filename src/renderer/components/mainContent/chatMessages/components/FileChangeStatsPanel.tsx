import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FilePlus2, FilePen } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { getFileTypeIcon } from "../../../../utils/fileIcons";
import { useChatConversationContext } from "./ChatConversationContext";
import {
  collectConversationFileChanges,
  countUniqueFiles,
} from "../hooks/fileChangeTracking";
import type { FileChangeRecord } from "../utils/conversationTypes";

type FileChangeStatsPanelProps = {
  /** The conversation whose stats should be displayed. When it is a main
   *  conversation, sub-agent changes are merged in automatically. */
  conversationId: string | undefined;
};

/**
 * Collapsible panel above the message list showing every file modified by the
 * main agent and its sub-agents during this conversation session.
 *
 * Data comes from fileChangeStats, which the tool-execution pipeline fills in
 * live: filesystem-create / filesystem-replace_edit calls that completed
 * successfully. Records are keyed by conversationId — the main conversation
 * collects its own changes (agent: "main"), each sub-agent collects its own
 * under its conversationId (agent: "sub"), and this panel merges them via the
 * parent's childSubAgentIds set.
 *
 * The panel is intentionally renderer-session scoped: stats are collected at
 * runtime and reset when the app restarts. Historical tool calls remain
 * browsable in the message list itself.
 */
export const FileChangeStatsPanel = ({
  conversationId,
}: FileChangeStatsPanelProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const { fileChangeStats } = useChatConversationContext();
  const [expanded, setExpanded] = useState(false);

  const changes = useMemo(() => {
    if (!conversationId) {
      return [];
    }
    return collectConversationFileChanges(fileChangeStats, conversationId);
  }, [conversationId, fileChangeStats]);

  const summary = useMemo(() => {
    const mainCount = changes.filter(
      (change) => change.agent === "main"
    ).length;
    const subCount = changes.length - mainCount;
    const subAgentNames = Array.from(
      new Set(
        changes
          .map((change) => change.subAgentName)
          .filter((name): name is string => Boolean(name))
      )
    );
    return {
      uniqueFiles: countUniqueFiles(changes),
      mainCount,
      subCount,
      subAgentNames,
    };
  }, [changes]);

  if (changes.length === 0) {
    return null;
  }

  const isSubChange = (change: FileChangeRecord): boolean =>
    change.agent === "sub";

  return (
    <div className={`file-change-stats${expanded ? " is-expanded" : ""}`}>
      <button
        type="button"
        className="file-change-stats-header"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-label={t("chat.fileChanges.toggle")}
      >
        <span className="file-change-stats-toggle" aria-hidden="true">
          {expanded ? (
            <ChevronDown size={14} strokeWidth={2} />
          ) : (
            <ChevronRight size={14} strokeWidth={2} />
          )}
        </span>
        <span className="file-change-stats-title">
          {t("chat.fileChanges.summary", {
            values: { count: summary.uniqueFiles },
          })}
        </span>
        <span className="file-change-stats-badges">
          <span className="file-change-stats-badge is-main">
            {t("chat.fileChanges.agentMain", {
              values: { count: summary.mainCount },
            })}
          </span>
          {summary.subCount > 0 ? (
            <span className="file-change-stats-badge is-sub">
              {t("chat.fileChanges.agentSub", {
                values: { count: summary.subCount },
              })}
            </span>
          ) : null}
        </span>
      </button>

      {expanded ? (
        <ul className="file-change-stats-list">
          {changes.map((change, index) => {
            const fileName = change.filePath.split(/[\\/]/).pop() || change.filePath;
            return (
              <li
                className="file-change-stats-item"
                key={`${change.filePath}-${change.timestamp}-${index}`}
                title={change.filePath}
              >
                <span className="file-change-stats-icon" aria-hidden="true">
                  {change.kind === "create" ? (
                    <FilePlus2 size={13} strokeWidth={2} />
                  ) : (
                    <FilePen size={13} strokeWidth={2} />
                  )}
                </span>
                <span className="file-change-stats-file">
                  {getFileTypeIcon(fileName, false, false, {
                    size: 13,
                    "aria-hidden": true,
                  })}
                  <span className="file-change-stats-path">
                    {change.filePath}
                  </span>
                </span>
                <span
                  className={`file-change-stats-kind is-${change.kind}`}
                >
                  {change.kind === "create"
                    ? t("chat.fileChanges.kindCreate")
                    : t("chat.fileChanges.kindEdit")}
                </span>
                <span
                  className={`file-change-stats-agent${
                    isSubChange(change) ? " is-sub" : ""
                  }`}
                >
                  {isSubChange(change)
                    ? change.subAgentName ?? t("chat.fileChanges.agentSubName")
                    : t("chat.fileChanges.agentMainName")}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
};
