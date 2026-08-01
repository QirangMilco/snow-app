import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Diff,
  GitCommitHorizontal,
  GitGraph as GitGraphIcon,
  Loader2,
  Sparkles,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import type {
  GitFileStatus,
  GitRepoInfo,
  GitStatusResult,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { useGitStatus } from "./useGitStatus";
import { useRemotePolling } from "./useRemotePolling";
import { BranchSelector } from "./BranchSelector";
import { GitFileList } from "./GitFileList";
import { GitGraph } from "./GitGraph";
import { RepoSelector } from "./RepoSelector";

type GitControlProps = {
  repoPath: string | undefined | null;
  repos?: GitRepoInfo[];
  onRepoSelect?: (path: string) => void;
  onFileSelect: (file: GitFileStatus | null) => void;
  onStatusChange?: (status: GitStatusResult | null) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
};

const isSelectedKey = (section: "staged" | "unstaged", path: string) =>
  `${section}:${path}`;

export const GitControl = ({
  repoPath,
  repos,
  onRepoSelect,
  onFileSelect,
  onStatusChange,
  onOpenFile,
}: GitControlProps): React.JSX.Element => {
  const { t } = useI18n();
  const { status, isLoading, error, refresh } = useGitStatus(repoPath);
  // Keep ahead/behind counts fresh by periodically fetching from the
  // remote; a successful fetch refreshes the status so the pull button
  // badge reflects the latest remote state.
  useRemotePolling(repoPath, refresh);
  const [commitMessage, setCommitMessage] = useState("");
  const [actionInProgress, setActionInProgress] = useState<
    | "commit"
    | "push"
    | "pull"
    | "stage"
    | "unstage"
    | "stageAll"
    | "unstageAll"
    | "discard"
    | null
  >(null);
  const [isGeneratingCommitMsg, setIsGeneratingCommitMsg] = useState(false);
  const commitMsgStreamIdRef = useRef<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [discardTarget, setDiscardTarget] = useState<GitFileStatus[]>([]);
  const [operationError, setOperationError] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const lastClickedPathRef = useRef<string | null>(null);
  const lastClickedSectionRef = useRef<"staged" | "unstaged" | null>(null);
  const prevStatusRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Set to true after a commit succeeds; the effect below resets scroll
  // to top once the refreshed status has been applied to the DOM.
  const commitPendingRef = useRef(false);
  const [viewMode, setViewMode] = useState<"changes" | "graph">("changes");

  // Propagate status changes upward via ref to avoid render-cycle side effects
  useEffect(() => {
    if (!onStatusChange) {
      return;
    }
    const serialized = status ? JSON.stringify(status) : null;
    if (serialized !== prevStatusRef.current) {
      prevStatusRef.current = serialized;
      onStatusChange(status);
    }
  }, [status, onStatusChange]);

  // After a commit, the staged file list shrinks which can leave a large
  // empty gap if the user had scrolled down. When commitPendingRef is set,
  // reset scroll to top once the refreshed status has rendered.
  useEffect(() => {
    if (!commitPendingRef.current) {
      return;
    }
    commitPendingRef.current = false;
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: 0 });
    }
  }, [status]);

  // Prune selectedPaths that are no longer present in the current status.
  // Keys are stored as "section:path" composite keys.
  useEffect(() => {
    if (!status) {
      return;
    }
    const stagedPaths = new Set(
      status.files
        .filter(
          (f) =>
            f.indexStatus !== " " &&
            f.indexStatus !== "?" &&
            f.indexStatus !== ""
        )
        .map((f) => f.path)
    );
    const unstagedPaths = new Set(
      status.files
        .filter(
          (f) =>
            f.workdirStatus === "?" ||
            (f.workdirStatus !== " " && f.workdirStatus !== "")
        )
        .map((f) => f.path)
    );
    setSelectedPaths((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      let changed = false;
      const next = new Set<string>();
      for (const key of prev) {
        const colonIdx = key.indexOf(":");
        if (colonIdx === -1) {
          changed = true;
          continue;
        }
        const sec = key.slice(0, colonIdx);
        const path = key.slice(colonIdx + 1);
        const valid =
          (sec === "staged" && stagedPaths.has(path)) ||
          (sec === "unstaged" && unstagedPaths.has(path));
        if (valid) {
          next.add(key);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [status]);

  const handleStatusChange = useCallback(() => {
    refresh();
  }, [refresh]);

  const handleFileSelect = useCallback(
    (
      file: GitFileStatus,
      e: React.MouseEvent,
      section: "staged" | "unstaged"
    ) => {
      const isMulti = e.metaKey || e.ctrlKey;
      const isRange = e.shiftKey;
      const fileLists = status?.files ?? [];
      const key = isSelectedKey(section, file.path);

      setSelectedPaths((prev) => {
        const next = new Set(prev);

        if (isRange && lastClickedPathRef.current !== null) {
          // Range select: select all files between last clicked and current.
          // Only operate within the same section to avoid cross-section leakage.
          const lastKey = lastClickedPathRef.current;
          const sameSection = lastClickedSectionRef.current === section;
          const lastKeyPath = lastKey.includes(":")
            ? lastKey.slice(lastKey.indexOf(":") + 1)
            : lastKey;
          const sectionFiles = fileLists.filter((f) =>
            section === "staged"
              ? f.indexStatus !== " " &&
                f.indexStatus !== "?" &&
                f.indexStatus !== ""
              : f.workdirStatus === "?" ||
                (f.workdirStatus !== " " && f.workdirStatus !== "")
          );
          const lastIndex = sameSection
            ? sectionFiles.findIndex((f) => f.path === lastKeyPath)
            : -1;
          const currentIndex = sectionFiles.findIndex(
            (f) => f.path === file.path
          );
          if (lastIndex !== -1 && currentIndex !== -1) {
            const start = Math.min(lastIndex, currentIndex);
            const end = Math.max(lastIndex, currentIndex);
            // If not multi-selecting, clear previous selection first
            if (!isMulti) {
              next.clear();
            }
            for (let i = start; i <= end; i++) {
              next.add(isSelectedKey(section, sectionFiles[i].path));
            }
          } else if (!isMulti) {
            next.clear();
            next.add(key);
          } else {
            next.add(key);
          }
          lastClickedPathRef.current = key;
          lastClickedSectionRef.current = section;
          return next;
        }

        if (isMulti) {
          if (next.has(key)) {
            next.delete(key);
          } else {
            next.add(key);
          }
        } else {
          next.clear();
          next.add(key);
        }

        lastClickedPathRef.current = key;
        lastClickedSectionRef.current = section;
        return next;
      });

      // Notify parent for diff display - send the clicked file
      onFileSelect(file);
    },
    [status, onFileSelect]
  );

  const handleOpenFile = useCallback(
    (file: GitFileStatus) => {
      if (!repoPath || !onOpenFile) {
        return;
      }
      const base = repoPath.replace(/[\\/]+$/, "");
      const absolutePath = `${base}/${file.path}`;
      const lastSep = Math.max(
        file.path.lastIndexOf("/"),
        file.path.lastIndexOf("\\")
      );
      const fileName =
        lastSep === -1 ? file.path : file.path.slice(lastSep + 1);
      onOpenFile(absolutePath, fileName);
    },
    [repoPath, onOpenFile]
  );

  const handleStageToggle = useCallback(
    (files: GitFileStatus[], section: "staged" | "unstaged") => {
      if (!repoPath || files.length === 0) {
        return;
      }

      const isStaged = section === "staged";
      const paths = files.map((f) => f.path);

      setActionInProgress(isStaged ? "unstage" : "stage");
      if (isStaged) {
        window.snow
          .gitUnstage(repoPath, paths)
          .then((result) => {
            if (result.success) {
              setSelectedPaths(new Set());
              refresh();
            }
          })
          .finally(() => setActionInProgress(null));
      } else {
        window.snow
          .gitStage(repoPath, paths)
          .then((result) => {
            if (result.success) {
              setSelectedPaths(new Set());
              refresh();
            }
          })
          .finally(() => setActionInProgress(null));
      }
    },
    [repoPath, refresh]
  );

  const handleStageAll = useCallback(() => {
    if (!repoPath) {
      return;
    }
    setActionInProgress("stageAll");
    window.snow
      .gitStageAll(repoPath)
      .then(() => {
        setSelectedPaths(new Set());
        refresh();
      })
      .finally(() => setActionInProgress(null));
  }, [repoPath, refresh]);

  const handleUnstageAll = useCallback(() => {
    if (!repoPath) {
      return;
    }
    setActionInProgress("unstageAll");
    window.snow
      .gitUnstageAll(repoPath)
      .then(() => {
        setSelectedPaths(new Set());
        refresh();
      })
      .finally(() => setActionInProgress(null));
  }, [repoPath, refresh]);

  const handleCommit = useCallback(() => {
    if (!repoPath || !commitMessage.trim()) {
      return;
    }
    setActionInProgress("commit");
    window.snow
      .gitCommit(repoPath, commitMessage)
      .then(() => {
        setCommitMessage("");
        commitPendingRef.current = true;
        refresh();
      })
      .finally(() => setActionInProgress(null));
  }, [repoPath, commitMessage, refresh]);

  const handlePush = useCallback(() => {
    if (!repoPath) {
      return;
    }
    setActionInProgress("push");
    window.snow
      .gitPush(repoPath)
      .then((result) => {
        if (result.success) {
          refresh();
        } else {
          setOperationError({
            title: t("git.pushFailed"),
            message: result.message,
          });
        }
      })
      .catch((err: unknown) => {
        setOperationError({
          title: t("git.pushFailed"),
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setActionInProgress(null));
  }, [repoPath, refresh, t]);

  const handlePull = useCallback(() => {
    if (!repoPath) {
      return;
    }
    setActionInProgress("pull");
    window.snow
      .gitPull(repoPath)
      .then((result) => {
        if (result.success) {
          refresh();
        } else {
          setOperationError({
            title: t("git.pullFailed"),
            message: result.message,
          });
        }
      })
      .catch((err: unknown) => {
        setOperationError({
          title: t("git.pullFailed"),
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setActionInProgress(null));
  }, [repoPath, refresh, t]);

  const handleDiscardRequest = useCallback((files: GitFileStatus[]) => {
    if (files.length === 0) {
      return;
    }
    setDiscardTarget(files);
  }, []);

  const handleDiscardConfirm = useCallback(() => {
    if (!repoPath || discardTarget.length === 0) {
      return;
    }
    const paths = discardTarget.map((f) => f.path);
    setDiscardTarget([]);
    setActionInProgress("discard");
    window.snow
      .gitDiscardChanges(repoPath, paths)
      .then(() => {
        setSelectedPaths(new Set());
        refresh();
      })
      .finally(() => setActionInProgress(null));
  }, [repoPath, discardTarget, refresh]);

  const handleDiscardCancel = useCallback(() => {
    setDiscardTarget([]);
  }, []);

  const handleDismissError = useCallback(() => {
    setOperationError(null);
  }, []);

  const handleGenerateCommitMessage = useCallback(() => {
    if (!repoPath || isGeneratingCommitMsg) {
      return;
    }

    setIsGeneratingCommitMsg(true);
    setCommitMessage("");

    window.snow
      .generateCommitMessage(
        repoPath,
        (chunk) => {
          if (chunk.contentDelta) {
            setCommitMessage((prev) => prev + chunk.contentDelta);
          }
        },
        (streamId) => {
          commitMsgStreamIdRef.current = streamId;
        }
      )
      .then((result) => {
        if (result.status === "error") {
          // 流式请求以 error 状态返回：展示具体原因，不再静默吞掉。
          setCommitMessage("");
          setOperationError({
            title: t("git.generateCommitMessageFailed"),
            message: t("git.generateCommitMessageFailedDetail", {
              defaultValue:
                "The AI could not generate a commit message. Check your API settings and make sure changes are staged.",
            }),
          });
        } else if (result.content) {
          setCommitMessage(result.content);
        }
      })
      .catch((err: unknown) => {
        // 取消（abort）在 Rust 侧返回 Ok(status="cancelled")，不会走到这里；
        // 走到 catch 的都是真实失败（网关 403、API key 无效、无暂存变更等），
        // 弹出错误对话框透出具体原因，便于用户自我排查。
        setOperationError({
          title: t("git.generateCommitMessageFailed"),
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        setIsGeneratingCommitMsg(false);
        commitMsgStreamIdRef.current = null;
      });
  }, [repoPath, isGeneratingCommitMsg, t]);

  const handleAbortCommitMessage = useCallback(() => {
    const streamId = commitMsgStreamIdRef.current;
    if (streamId) {
      void window.snow.abortCommitMessage(streamId);
    }
  }, []);

  if (!repoPath) {
    return (
      <div className="git-control">
        <div className="git-control-empty">{t("git.noWorkspaceDirectory")}</div>
      </div>
    );
  }

  if (isLoading && !status) {
    return (
      <div className="git-control">
        <div className="git-control-loading">{t("git.loadingStatus")}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="git-control">
        <div className="git-control-error">{t(error)}</div>
      </div>
    );
  }

  if (!status || !status.isRepo) {
    return (
      <div className="git-control">
        <div className="git-control-empty">{t("git.notARepo")}</div>
      </div>
    );
  }

  const stagedFiles = status.files.filter(
    (f) =>
      f.indexStatus !== " " && f.indexStatus !== "?" && f.indexStatus !== ""
  );
  const unstagedFiles = status.files.filter(
    (f) =>
      f.workdirStatus === "?" ||
      (f.workdirStatus !== " " && f.workdirStatus !== "")
  );

  return (
    <div className="git-control" ref={scrollRef}>
      {repos && repos.length > 1 && onRepoSelect && (
        <div className="git-repo-selector-bar">
          <RepoSelector
            repos={repos}
            selectedRepoPath={repoPath ?? null}
            onSelect={onRepoSelect}
          />
        </div>
      )}
      <div className="git-control-header">
        <BranchSelector
          repoPath={repoPath}
          currentBranch={status.currentBranch}
          onBranchChanged={handleStatusChange}
        />
        <div className="git-control-actions">
          <button
            type="button"
            className="icon-btn git-action-btn"
            onClick={handlePull}
            disabled={actionInProgress !== null}
            title={
              status.behind > 0
                ? t("git.pullBehind", { values: { count: status.behind } })
                : t("git.pull")
            }
          >
            {actionInProgress === "pull" ? (
              <Loader2 size={14} strokeWidth={1.8} className="spin" />
            ) : (
              <ArrowDownToLine size={14} strokeWidth={1.8} />
            )}
            {status.behind > 0 && (
              <span className="git-pull-badge" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="icon-btn git-action-btn"
            onClick={handlePush}
            disabled={actionInProgress !== null}
            title={t("git.push")}
          >
            {actionInProgress === "push" ? (
              <Loader2 size={14} strokeWidth={1.8} className="spin" />
            ) : (
              <ArrowUpFromLine size={14} strokeWidth={1.8} />
            )}
          </button>
          <button
            type="button"
            className={`icon-btn git-action-btn${
              viewMode === "graph" ? " active" : ""
            }`}
            onClick={() =>
              setViewMode(viewMode === "graph" ? "changes" : "graph")
            }
            title={viewMode === "graph" ? t("git.changes") : t("git.graph")}
          >
            {viewMode === "graph" ? (
              <Diff size={14} strokeWidth={1.8} />
            ) : (
              <GitGraphIcon size={14} strokeWidth={1.8} />
            )}
          </button>
        </div>
      </div>

      {(status.ahead > 0 || status.behind > 0) && (
        <div className="git-sync-status">
          {status.ahead > 0 && (
            <span className="git-sync-ahead">
              {t("git.ahead", { values: { count: status.ahead } })}
            </span>
          )}
          {status.behind > 0 && (
            <span className="git-sync-behind">
              {t("git.behind", { values: { count: status.behind } })}
            </span>
          )}
        </div>
      )}

      {viewMode === "changes" ? (
        <>
          <GitFileList
            repoPath={repoPath}
            files={unstagedFiles}
            section="unstaged"
            selectedPaths={selectedPaths}
            actionInProgress={actionInProgress}
            onFileSelect={handleFileSelect}
            onStageToggle={handleStageToggle}
            onStageAll={handleStageAll}
            onDiscard={handleDiscardRequest}
            onOpenFile={handleOpenFile}
          />

          <GitFileList
            repoPath={repoPath}
            files={stagedFiles}
            section="staged"
            selectedPaths={selectedPaths}
            actionInProgress={actionInProgress}
            onFileSelect={handleFileSelect}
            onStageToggle={handleStageToggle}
            onUnstageAll={handleUnstageAll}
            onOpenFile={handleOpenFile}
          />

          <div className="git-commit-section">
            <div className="git-commit-input-wrapper">
              <textarea
                className="git-commit-input"
                placeholder={t("git.commitMessagePlaceholder")}
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                rows={2}
              />
              <div className="git-commit-input-actions">
                <button
                  type="button"
                  className="git-commit-btn git-ai-commit-btn"
                  onClick={
                    isGeneratingCommitMsg
                      ? handleAbortCommitMessage
                      : handleGenerateCommitMessage
                  }
                  disabled={
                    !isGeneratingCommitMsg &&
                    (actionInProgress !== null || stagedFiles.length === 0)
                  }
                >
                  {isGeneratingCommitMsg ? (
                    <Square size={14} strokeWidth={1.8} />
                  ) : (
                    <Sparkles size={14} strokeWidth={1.8} />
                  )}
                </button>
              </div>
            </div>
            <div className="git-commit-actions">
              <button
                type="button"
                className="git-commit-btn"
                onClick={handleCommit}
                disabled={
                  actionInProgress !== null ||
                  isGeneratingCommitMsg ||
                  !commitMessage.trim() ||
                  stagedFiles.length === 0
                }
              >
                {actionInProgress === "commit" ? (
                  <Loader2 size={14} strokeWidth={1.8} className="spin" />
                ) : (
                  <GitCommitHorizontal size={14} strokeWidth={1.8} />
                )}
                <span>{t("git.commit")}</span>
              </button>
            </div>
          </div>
        </>
      ) : (
        <GitGraph repoPath={repoPath} />
      )}

      <ConfirmDialog
        open={discardTarget.length > 0}
        title={t("git.discardTitle")}
        message={t("git.discardConfirm", {
          values: { count: discardTarget.length },
        })}
        confirmLabel={t("git.discardConfirmBtn")}
        cancelLabel={t("git.discardCancelBtn")}
        onConfirm={handleDiscardConfirm}
        onCancel={handleDiscardCancel}
      />

      <ConfirmDialog
        open={operationError !== null}
        variant="danger"
        title={operationError?.title ?? ""}
        message={operationError?.message ?? ""}
        confirmLabel={t("git.errorDismiss")}
        onConfirm={handleDismissError}
        onCancel={handleDismissError}
      />
    </div>
  );
};
