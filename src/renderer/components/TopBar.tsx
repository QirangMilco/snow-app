import {
  Database,
  GitBranch,
  Globe,
  Maximize2,
  Minimize2,
  Plus,
  SidebarClose,
  SidebarOpen,
  SquarePen,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceDirectoryRecord } from "../../preload";
import { useI18n } from "../i18n";
import { useChatConversationContext } from "./mainContent/chatMessages";
import { CodebaseSyncIndicator } from "./TopBar/CodebaseSyncIndicator";
import { TodoPanelButton } from "./TopBar/TodoPanelButton";
import { useCodebaseWatcher } from "../hooks/useCodebaseWatcher";

type TopBarProps = {
  isSidebarCollapsed: boolean;
  isRightPanelCollapsed: boolean;
  isRightPanelFullscreen: boolean;
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onToggleSidebar: () => void;
  onToggleRightPanel: () => void;
  onToggleRightPanelFullscreen: () => void;
  onOpenTerminal?: () => void;
  onOpenBrowser?: () => void;
  onOpenCodebase?: (projectId: string, projectName: string) => void;
};

export const TopBar = ({
  isSidebarCollapsed,
  isRightPanelCollapsed,
  isRightPanelFullscreen,
  activeDirectory,
  onToggleSidebar,
  onToggleRightPanel,
  onToggleRightPanelFullscreen,
  onOpenTerminal,
  onOpenBrowser,
  onOpenCodebase,
}: TopBarProps): React.JSX.Element => {
  const { t } = useI18n();
  const {
    handleNewChat,
    summary,
    conversationDirectoryId,
    activeConversationId,
    messages,
    isStreaming,
  } = useChatConversationContext();
  const [conversationDirectoryName, setConversationDirectoryName] = useState<
    string | undefined
  >(undefined);
  const [isPlusMenuOpen, setIsPlusMenuOpen] = useState(false);
  const [isTodoPanelOpen, setIsTodoPanelOpen] = useState(false);
  const [isTodoPanelPinned, setIsTodoPanelPinned] = useState(false);
  const [codebaseEnabled, setCodebaseEnabled] = useState(false);
  const [codebaseIndexed, setCodebaseIndexed] = useState(false);
  // Error message of the last failed embedding for the active project.
  // Shown as a red error state on the codebase sync indicator (see #16/#17).
  const [codebaseEmbedError, setCodebaseEmbedError] = useState<string | null>(
    null
  );
  // Track which projectId the codebaseEnabled state corresponds to. This is
  // used to detect stale enabled values during project switches — when the
  // active project changes, codebaseEnabled may still hold the previous
  // project's value for one render cycle (React state updates are async).
  // By comparing enabledProjectIdRef with activeProjectId, we can force
  // enabled=false until the new project's scope is confirmed.
  const enabledProjectIdRef = useRef<string | undefined>(undefined);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  // Guards against stale index-stats responses: every project switch (or
  // effect re-run) bumps the generation, so in-flight responses from the
  // previous project are discarded.
  const statsGenerationRef = useRef(0);

  // Resolve the active project id / path for the codebase watcher. Follow the
  // active workspace directory (the "current project" the user sees in the
  // sidebar) so that switching projects immediately re-evaluates the codebase
  // state: projects without a codebase must not keep showing the indicator,
  // and a stale conversation-bound project must not keep the watcher pinned
  // to the previous project. Fall back to the conversation's directory only
  // when no workspace directory is active.
  const activeProjectId =
    activeDirectory?.directoryId ?? conversationDirectoryId;
  const activeProjectPath = activeDirectory?.path;

  // Load the codebase scope settings for the active project to determine
  // whether the watcher should be active.
  //
  // When the active project changes, we immediately reset codebaseEnabled to
  // false and clear enabledProjectIdRef BEFORE the async fetch resolves. This
  // prevents the useCodebaseWatcher from briefly starting a watcher for the
  // new project using the stale `true` value from the previous project.
  useEffect(() => {
    if (!activeProjectId) {
      setCodebaseEnabled(false);
      setCodebaseEmbedError(null);
      enabledProjectIdRef.current = undefined;
      return;
    }

    // Reset to false immediately so the watcher stops while we fetch the
    // new project's scope. Also clear the ref so that even if the state
    // update hasn't flushed yet, the derived `effectiveEnabled` below
    // will be false.
    setCodebaseEnabled(false);
    setCodebaseEmbedError(null);
    enabledProjectIdRef.current = undefined;

    let cancelled = false;
    void window.snow
      .getCodebaseProjectScopeSettings(activeProjectId)
      .then((scope) => {
        if (!cancelled) {
          enabledProjectIdRef.current = activeProjectId;
          setCodebaseEnabled(scope.enabled ?? false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          enabledProjectIdRef.current = activeProjectId;
          setCodebaseEnabled(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  // Listen for codebase scope changes broadcast by the backend (e.g. when
  // the user toggles the enabled switch in ProjectCodebasePanel). This keeps
  // the TopBar indicator in sync without requiring a manual refresh.
  useEffect(() => {
    const dispose = window.snow.onCodebaseScopeChanged((payload) => {
      if (payload.key === "enabled" && payload.projectId === activeProjectId) {
        enabledProjectIdRef.current = activeProjectId;
        setCodebaseEnabled(payload.enabled);
      }
    });
    return () => {
      dispose();
    };
  }, [activeProjectId]);

  // Derive the effective enabled state: only treat codebaseEnabled as true
  // if it was confirmed for the currently active project. This guards against
  // the React state batch-update race where activeProjectId changes but
  // codebaseEnabled still holds the previous project's value.
  const effectiveEnabled =
    codebaseEnabled && enabledProjectIdRef.current === activeProjectId;

  // Load the index stats for the active project and update `codebaseIndexed`.
  // Generation-guarded so a slow response for a previously active project
  // never overwrites the current project's state.
  const loadCodebaseIndexed = useCallback((): void => {
    if (!activeProjectId) {
      setCodebaseIndexed(false);
      return;
    }
    const generation = statsGenerationRef.current;
    void window.snow
      .getCodebaseIndexStats(activeProjectId)
      .then((stats) => {
        if (statsGenerationRef.current === generation) {
          setCodebaseIndexed(stats.isIndexed);
        }
      })
      .catch(() => {
        if (statsGenerationRef.current === generation) {
          setCodebaseIndexed(false);
        }
      });
  }, [activeProjectId]);

  const { syncStatus, watchedProjectId } = useCodebaseWatcher({
    projectId: activeProjectId,
    projectPath: activeProjectPath,
    enabled: effectiveEnabled,
    // Fallback refresh: whenever an incremental sync finishes for the watched
    // project, re-read the index stats. This guarantees the indicator moves
    // off the "syncing" state even if a broadcast progress event was missed.
    onSyncFinished: loadCodebaseIndexed,
  });

  // Load index stats to determine whether the codebase has been indexed.
  // The indicator uses this to distinguish "watching with an existing index"
  // (green dot) from "enabled but never embedded" (amber pulsing dot).
  // Reload when the project changes or when a sync/embed completes.
  useEffect(() => {
    if (!activeProjectId) {
      setCodebaseIndexed(false);
      return;
    }

    // Bump the generation so any in-flight stats response from a previous
    // project/effect run is discarded.
    statsGenerationRef.current += 1;

    loadCodebaseIndexed();

    // Refresh stats after a sync completes (done / no_changes) so the
    // indicator updates from "pending" to "watching" once the first embed
    // finishes, or stays current after incremental syncs.
    const disposeSync = window.snow.onCodebaseSyncProgress(
      (progress, changedProjectId) => {
        if (
          changedProjectId === activeProjectId &&
          (progress.phase === "done" || progress.phase === "no_changes")
        ) {
          loadCodebaseIndexed();
        }
      }
    );

    // Refresh stats when the initial (full) embedding finishes. The embed
    // progress broadcast ("done" phase) is the only signal the TopBar
    // receives for a first-time embedding — the incremental sync channel
    // (`codebase:sync:progress`) is not emitted for it. Without this, the
    // indicator stays amber ("enabled but never embedded") until the user
    // switches projects and back, which re-runs the stats load.
    // The same broadcast also drives the indicator's error state: an "error"
    // phase turns the dot red (with the message as tooltip), and a "done"
    // phase clears any previous error (see #16/#17).
    const disposeEmbed = window.snow.onCodebaseEmbedProgress(
      (progress, changedProjectId) => {
        if (changedProjectId !== activeProjectId) {
          return;
        }
        if (progress.phase === "done") {
          setCodebaseEmbedError(null);
          loadCodebaseIndexed();
        } else if (progress.phase === "error") {
          setCodebaseEmbedError(progress.error || null);
        }
      }
    );

    return () => {
      statsGenerationRef.current += 1;
      disposeSync();
      disposeEmbed();
    };
  }, [activeProjectId, loadCodebaseIndexed]);

  useEffect(() => {
    if (!conversationDirectoryId) {
      setConversationDirectoryName(undefined);
      return;
    }

    if (conversationDirectoryId === activeDirectory?.directoryId) {
      setConversationDirectoryName(activeDirectory.name);
      return;
    }

    let cancelled = false;

    void window.snow
      .listWorkspaceDirectories()
      .then((directories) => {
        if (cancelled) {
          return;
        }
        const matched = directories.find(
          (directory) => directory.directoryId === conversationDirectoryId
        );
        setConversationDirectoryName(matched?.name);
      })
      .catch(() => {
        // Silent fail
      });

    return () => {
      cancelled = true;
    };
  }, [conversationDirectoryId, activeDirectory]);

  const SidebarToggleIcon = isSidebarCollapsed ? SidebarOpen : SidebarClose;
  const sidebarToggleLabel = isSidebarCollapsed
    ? "Expand sidebar"
    : "Collapse sidebar";
  const RightPanelToggleIcon = isRightPanelCollapsed
    ? SidebarClose
    : SidebarOpen;
  const rightPanelToggleLabel = isRightPanelCollapsed
    ? "Expand right panel"
    : "Collapse right panel";
  const FullscreenToggleIcon = isRightPanelFullscreen ? Minimize2 : Maximize2;
  const fullscreenToggleLabel = isRightPanelFullscreen
    ? "Exit right panel fullscreen"
    : "Right panel fullscreen";

  const displayDirectoryName = conversationDirectoryId
    ? conversationDirectoryName
    : activeDirectory?.name;

  const headerTitle = summary || displayDirectoryName || "New Chat";
  const headerSubtitle = displayDirectoryName || "";

  useEffect(() => {
    if (!isPlusMenuOpen) {
      return undefined;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (
        plusMenuRef.current &&
        !plusMenuRef.current.contains(event.target as Node)
      ) {
        setIsPlusMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handleClickOutside, true);
    return () => {
      document.removeEventListener("pointerdown", handleClickOutside, true);
    };
  }, [isPlusMenuOpen]);

  // 代码库功能已开启且当前项目嵌入完毕后，才在 Plus 菜单中提供“代码库”项。
  const canOpenCodebase = effectiveEnabled && codebaseIndexed && activeProjectId;

  const plusMenuItems = [
    { id: "terminal", label: "终端", icon: Terminal },
    { id: "browser", label: "浏览器", icon: Globe },
    ...(canOpenCodebase
      ? [{ id: "codebase", label: t("topBar.plusMenu.codebase"), icon: Database }]
      : []),
  ];

  const handlePlusMenuAction = (actionId: string): void => {
    if (actionId === "terminal") {
      onOpenTerminal?.();
    } else if (actionId === "browser") {
      onOpenBrowser?.();
    } else if (actionId === "codebase" && activeProjectId) {
      onOpenCodebase?.(
        activeProjectId,
        activeDirectory?.name ?? activeProjectId
      );
    }
    setIsPlusMenuOpen(false);
  };

  const isTodoPanelInteractive = isTodoPanelOpen && !isTodoPanelPinned;

  return (
    <header
      className={`top-bar${isPlusMenuOpen ? " plus-menu-open" : ""}${
        isTodoPanelOpen ? " todo-panel-open" : ""
      }${isTodoPanelInteractive ? " todo-panel-interactive" : ""}`}
    >
      <div className="top-bar-left">
        <div className="top-bar-sidebar-actions" aria-label="Sidebar actions">
          <button
            className="icon-btn sidebar-toggle-btn"
            type="button"
            aria-label={sidebarToggleLabel}
            title={sidebarToggleLabel}
            onClick={onToggleSidebar}
          >
            <SidebarToggleIcon size={16} strokeWidth={1.8} />
          </button>
          <button
            className="icon-btn new-chat-btn"
            type="button"
            aria-label="New chat"
            title="New chat"
            onClick={handleNewChat}
          >
            <SquarePen size={16} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      <div className="top-bar-main">
        <div className="header-title-group">
          <h2 className="header-title">{headerTitle}</h2>
          {headerSubtitle ? (
            <span className="header-subtitle">{headerSubtitle}</span>
          ) : null}
        </div>
        <TodoPanelButton
          messages={messages}
          conversationId={activeConversationId}
          projectId={conversationDirectoryId ?? activeDirectory?.directoryId}
          isRunning={isStreaming}
          onOpenChange={setIsTodoPanelOpen}
          onPinnedChange={setIsTodoPanelPinned}
        />
        <CodebaseSyncIndicator
          syncStatus={syncStatus}
          watchedProjectId={watchedProjectId}
          activeProjectId={activeProjectId}
          isIndexed={codebaseIndexed}
          embedError={codebaseEmbedError}
          onClick={() => {
            if (activeProjectId) {
              onOpenCodebase?.(
                activeProjectId,
                activeDirectory?.name ?? activeProjectId
              );
            }
          }}
        />
      </div>

      <div className="top-bar-right">
        <div className="top-bar-branch-info">
          {activeDirectory && (
            <span className="top-bar-branch-label">
              <GitBranch size={13} strokeWidth={1.8} />
              <span>{activeDirectory.name}</span>
            </span>
          )}
        </div>
        <div className="top-bar-right-actions">
          <div className="top-bar-plus-menu" ref={plusMenuRef}>
            <button
              className={`icon-btn ghost top-bar-plus-btn${
                isPlusMenuOpen ? " active" : ""
              }`}
              type="button"
              aria-label="New tab"
              title="New tab"
              aria-expanded={isPlusMenuOpen}
              onClick={() => setIsPlusMenuOpen((open) => !open)}
            >
              <Plus size={16} strokeWidth={1.8} />
            </button>
            {isPlusMenuOpen && (
              <div className="top-bar-plus-dropdown">
                {plusMenuItems.map((item) => {
                  const ItemIcon = item.icon;
                  return (
                    <button
                      key={item.id}
                      className="top-bar-plus-dropdown-item"
                      type="button"
                      onClick={() => handlePlusMenuAction(item.id)}
                    >
                      <ItemIcon size={13} strokeWidth={1.8} />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {!isRightPanelFullscreen && (
            <button
              className="icon-btn ghost right-panel-toggle-btn"
              type="button"
              aria-label={rightPanelToggleLabel}
              title={rightPanelToggleLabel}
              onClick={onToggleRightPanel}
            >
              <RightPanelToggleIcon size={16} strokeWidth={1.8} />
            </button>
          )}
          <button
            className="icon-btn ghost right-panel-fullscreen-btn"
            type="button"
            aria-label={fullscreenToggleLabel}
            title={fullscreenToggleLabel}
            onClick={onToggleRightPanelFullscreen}
          >
            <FullscreenToggleIcon size={16} strokeWidth={1.8} />
          </button>
        </div>
      </div>
    </header>
  );
};
