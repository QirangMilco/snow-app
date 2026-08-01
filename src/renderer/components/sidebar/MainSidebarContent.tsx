import {
  CalendarClock,
  NotebookText,
  Search,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import { useChatConversationContext } from "../mainContent/chatMessages";
import { shortcutEvents } from "../shortcutEvents";
import { APP_CONTROL_MEMO_CREATED_EVENT } from "../../hooks/useAppControl";
import { useScheduledTasks } from "../../hooks/useScheduledTasks";
import type { MainContentView } from "../mainContent/types";
import { ChatsSection } from "./mainSidebar/ChatsSection";
import { PinnedSection } from "./mainSidebar/PinnedSection";
import { ProjectsSection } from "./mainSidebar/ProjectsSection";
import { GlobalSearchModal } from "./GlobalSearchModal";
import { MemoModal } from "./MemoModal";
import { ScheduledTasksModal } from "./ScheduledTasksModal";
import type { SidebarContentProps } from "./types";
import type {
  ConversationSearchResult,
  WorkspaceDirectoryRecord,
} from "../../../preload";

export function MainSidebarContent({
  activeDirectory,
  onActiveDirectoryChange,
  onSelectMainView,
  onSwitchContent,
  onSwitchToExplorer,
  onOpenSshWizard,
}: SidebarContentProps): React.JSX.Element {
  const { t } = useI18n();
  const { handleSelectConversation } = useChatConversationContext();
  const [isSwitchingDirectory, setIsSwitchingDirectory] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isMemoOpen, setIsMemoOpen] = useState(false);
  const [isScheduledTasksOpen, setIsScheduledTasksOpen] = useState(false);
  const [pendingMemoCount, setPendingMemoCount] = useState(0);

  // Scheduled tasks: the hook registers buildFromContent as the AI Loop
  // executor and subscribes to the in-memory store. Mounted here (always
  // rendered inside ChatConversationProvider) so the executor is available
  // for the whole app lifetime. Tasks only live while the process is alive.
  const { tasks: scheduledTasks } = useScheduledTasks();

  // Load the pending memo count for the sidebar badge. It is refreshed
  // whenever the memo modal closes (the modal calls onPendingCountChange
  // while open) and once on mount, and whenever the active project changes
  // since memos are scoped per directory.
  const activeDirectoryId = activeDirectory?.directoryId ?? "";

  const refreshPendingMemoCount = useCallback(() => {
    if (!activeDirectoryId) {
      setPendingMemoCount(0);
      return;
    }
    window.snow
      .getMemoCountSummary(activeDirectoryId)
      .then((summary) => setPendingMemoCount(summary.pending))
      .catch(() => undefined);
  }, [activeDirectoryId]);

  useEffect(() => {
    refreshPendingMemoCount();
  }, [refreshPendingMemoCount]);

  useEffect(() => {
    const handler = () => {
      refreshPendingMemoCount();
    };
    window.addEventListener(APP_CONTROL_MEMO_CREATED_EVENT, handler);
    return () => {
      window.removeEventListener(APP_CONTROL_MEMO_CREATED_EVENT, handler);
    };
  }, [refreshPendingMemoCount]);

  // 订阅快捷键事件：Ctrl/Cmd+F 切换搜索 modal，Ctrl/Cmd+B 切换备忘录 modal。
  // 快捷键引擎通过 shortcutEvents 总线触发，此组件持有 modal open 状态。
  useEffect(() => {
    const unsubSearch = shortcutEvents.on("toggle-search", () => {
      setIsSearchOpen((prev) => !prev);
    });
    const unsubMemo = shortcutEvents.on("toggle-memo", () => {
      setIsMemoOpen((prev) => !prev);
    });
    return () => {
      unsubSearch();
      unsubMemo();
    };
  }, []);

  const handleSearchSelectConversation = (
    conversation: ConversationSearchResult
  ): void => {
    void handleSelectConversation(
      conversation.conversationId,
      conversation.summary || conversation.title,
      {
        inputTokens: conversation.inputTokens,
        outputTokens: conversation.outputTokens,
        cacheCreationInputTokens: conversation.cacheCreationInputTokens,
        cacheReadInputTokens: conversation.cacheReadInputTokens,
      },
      conversation.directoryId
    );
  };

  const handleSearchSelectDirectory = useCallback(
    (directory: WorkspaceDirectoryRecord): void => {
      onActiveDirectoryChange?.(directory);
      onSwitchContent?.("main");
    },
    [onActiveDirectoryChange, onSwitchContent]
  );

  const handleSearchSelectSetting = useCallback(
    (view: MainContentView): void => {
      onSwitchContent?.("settings");
      onSelectMainView(view);
    },
    [onSwitchContent, onSelectMainView]
  );

  return (
    <>
      <div className="sidebar-search-bar">
        <button
          className="nav-item sidebar-search-btn"
          onClick={() => setIsSearchOpen(true)}
          type="button"
        >
          <Search size={16} strokeWidth={1.8} />
          <span>
            {t("sidebar.search", {
              defaultValue: "Search",
            })}
          </span>
        </button>
        <button
          className="nav-item sidebar-memo-btn"
          disabled={!activeDirectoryId}
          onClick={() => setIsMemoOpen(true)}
          title={t("memo.sidebarEntry", { defaultValue: "Memos" })}
          type="button"
        >
          <NotebookText size={16} strokeWidth={1.8} />
          <span>{t("memo.sidebarEntry", { defaultValue: "Memos" })}</span>
          {pendingMemoCount > 0 && (
            <span className="sidebar-memo-badge">{pendingMemoCount}</span>
          )}
        </button>
        <button
          className="nav-item sidebar-scheduled-tasks-btn"
          onClick={() => setIsScheduledTasksOpen(true)}
          title={t("scheduledTask.sidebarEntry", { defaultValue: "Scheduled Tasks" })}
          type="button"
        >
          <CalendarClock size={16} strokeWidth={1.8} />
          <span>
            {t("scheduledTask.sidebarEntry", { defaultValue: "Scheduled Tasks" })}
          </span>
          {scheduledTasks.length > 0 && (
            <span className="sidebar-memo-badge">{scheduledTasks.length}</span>
          )}
        </button>
      </div>
      <PinnedSection
        activeDirectory={activeDirectory}
        isSwitchingDirectory={isSwitchingDirectory}
      />
      <ProjectsSection
        activeDirectory={activeDirectory}
        onActiveDirectoryChange={onActiveDirectoryChange}
        onSwitchingDirectoryChange={setIsSwitchingDirectory}
        onSwitchContent={onSwitchContent}
        onSwitchToExplorer={onSwitchToExplorer}
        onOpenSshWizard={onOpenSshWizard}
      />
      <ChatsSection
        activeDirectory={activeDirectory}
        isSwitchingDirectory={isSwitchingDirectory}
      />

      <div className="sidebar-footer">
        <div className="sidebar-footer-row">
          <button
            className="nav-item"
            onClick={() => onSwitchContent("settings")}
            type="button"
          >
            <Settings size={18} strokeWidth={1.8} />
            <span>{t("sidebar.settings", { defaultValue: "Settings" })}</span>
          </button>
        </div>
      </div>
      <GlobalSearchModal
        open={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onSelectConversation={handleSearchSelectConversation}
        onSelectDirectory={handleSearchSelectDirectory}
        onSelectSetting={handleSearchSelectSetting}
      />
      <MemoModal
        directoryId={activeDirectoryId}
        open={isMemoOpen}
        onClose={() => {
          setIsMemoOpen(false);
          refreshPendingMemoCount();
        }}
        onPendingCountChange={setPendingMemoCount}
      />
      <ScheduledTasksModal
        open={isScheduledTasksOpen}
        onClose={() => setIsScheduledTasksOpen(false)}
      />
    </>
  );
}
