import { X } from "lucide-react";
import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { useI18n } from "../i18n";
import { GitPanelContent } from "./rightPanel/GitPanelContent";
import { DiffViewer } from "./rightPanel/DiffViewer";
import { FileDiffPreview } from "./common/FileDiffPreview";
import { RightPanelTabContextMenu } from "./rightPanel/RightPanelTabContextMenu";
import {
  useBrowserMcpCommandBridge,
  type BrowserMcpTabCallbacks,
} from "./rightPanel/browser/useBrowserMcpCommandBridge";
import { focusBrowserMcpInstance } from "./rightPanel/browser/browserMcpController";
import {
  rightPanelEvents,
  type OpenBrowserTabPayload,
  type FocusBrowserTabPayload,
  type OpenFileDiffPreviewPayload,
} from "./rightPanel/rightPanelEvents";
import { generateComparePatch } from "../utils/generateComparePatch";
import { getFileTypeIcon } from "../utils/fileIcons";
import type {
  BrowserTabData,
  CodebaseTabData,
  DiffTabData,
  FileDiffPreviewTabData,
  FileViewerTabData,
  OpenDiffTabCallback,
  RightPanelContentProps,
  RightPanelTab,
  TerminalTabData,
} from "./rightPanel/types";

// 非默认 tab 的重组件按需加载，避免 xterm / highlight.js 等重型依赖打入首屏 chunk。
const FileViewerContent = lazy(() =>
  import("./rightPanel/FileViewerContent").then((m) => ({
    default: m.FileViewerContent,
  }))
);
const TerminalPanelContent = lazy(() =>
  import("./rightPanel/TerminalPanelContent").then((m) => ({
    default: m.TerminalPanelContent,
  }))
);
const BrowserPanelContent = lazy(() =>
  import("./rightPanel/BrowserPanelContent").then((m) => ({
    default: m.BrowserPanelContent,
  }))
);
const CodebasePanelContent = lazy(() =>
  import("./rightPanel/CodebasePanelContent").then((m) => ({
    default: m.CodebasePanelContent,
  }))
);

const GIT_TAB_ID = "git";
const CODEBASE_TAB_ID = "codebase";

// 文件类 tab(diff / file / file-diff-preview)在标题前显示对应的文件类型图标。
const getTabFileIcon = (tab: RightPanelTab): React.ReactNode => {
  if (tab.type === "diff") {
    const filePath = (tab.data as DiffTabData)?.selectedFile?.path;
    return filePath
      ? getFileTypeIcon(filePath.split("/").pop() ?? filePath, false, false, {
          size: 13,
          className: "right-panel-tab-icon",
        })
      : null;
  }
  if (tab.type === "file") {
    const fileName = (tab.data as FileViewerTabData)?.fileName;
    return fileName
      ? getFileTypeIcon(fileName, false, false, {
          size: 13,
          className: "right-panel-tab-icon",
        })
      : null;
  }
  if (tab.type === "file-diff-preview") {
    const fileName = (tab.data as FileDiffPreviewTabData)?.fileName;
    return fileName
      ? getFileTypeIcon(fileName, false, false, {
          size: 13,
          className: "right-panel-tab-icon",
        })
      : null;
  }
  return null;
};

export type RightPanelRef = {
  openTerminal: (cwd: string) => void;
  openBrowser: (url?: string) => void;
  openCodebase: (projectId: string, projectName: string) => void;
  openFile: (
    filePath: string,
    fileName: string,
    isSsh?: boolean,
    sshSessionId?: string | null,
    focusLine?: number
  ) => void;
};

type RightPanelProps = RightPanelContentProps & {
  isCollapsed: boolean;
  isFullscreen: boolean;
};

export const RightPanel = forwardRef<RightPanelRef, RightPanelProps>(
  ({ isCollapsed, isFullscreen, activeDirectory }, ref): React.JSX.Element => {
    const { t } = useI18n();
    const [tabs, setTabs] = useState<RightPanelTab[]>([
      { id: GIT_TAB_ID, type: "git", title: t("rightPanel.gitTab") },
    ]);
    const [activeTabId, setActiveTabId] = useState<string>(GIT_TAB_ID);
    const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
    // tab 右键菜单：记录触发位置与目标 tab（Git 固定 tab 无关闭项）。
    const [tabContextMenu, setTabContextMenu] = useState<{
      x: number;
      y: number;
      tabId: string;
    } | null>(null);

    const handleOpenDiffTab = useCallback<OpenDiffTabCallback>(
      (file, diffResult, diffLoading) => {
        const tabId = `diff:${file.path}`;
        setTabs((prev) => {
          const existing = prev.find((t) => t.id === tabId);
          if (existing) {
            return prev.map((t) =>
              t.id === tabId
                ? {
                    ...t,
                    data: {
                      filePath: file.path,
                      selectedFile: file,
                      diffResult,
                      diffLoading,
                    },
                  }
                : t
            );
          }
          const newTab: RightPanelTab = {
            id: tabId,
            type: "diff",
            title: file.path.split("/").pop() ?? file.path,
            data: {
              filePath: file.path,
              selectedFile: file,
              diffResult,
              diffLoading,
            },
          };
          return [...prev, newTab];
        });
        setActiveTabId(tabId);
      },
      []
    );

    const handleOpenTerminalTab = useCallback(
      (cwd: string) => {
        const tabId = `terminal-${Date.now()}`;
        const terminalData: TerminalTabData = { cwd };
        setTabs((prev) => [
          ...prev,
          {
            id: tabId,
            type: "terminal",
            title: t("rightPanel.terminalTab"),
            data: terminalData,
          },
        ]);
        setActiveTabId(tabId);
      },
      [t]
    );

    const handleTerminalTitleChange = useCallback(
      (tabId: string, title: string) => {
        setTabs((prev) =>
          prev.map((tab) => (tab.id === tabId ? { ...tab, title } : tab))
        );
      },
      []
    );

    const handleOpenBrowserTab = useCallback(
      (url?: string, requestedInstanceId?: string): string => {
        const instanceId =
          requestedInstanceId ??
          `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const browserData: BrowserTabData = {
          instanceId,
          url: url ?? "",
        };
        setTabs((prev) => [
          ...prev,
          {
            id: instanceId,
            type: "browser",
            title: t("rightPanel.browserTab"),
            data: browserData,
          },
        ]);
        setActiveTabId(instanceId);
        return instanceId;
      },
      [t]
    );

    const handleBrowserTitleChange = useCallback(
      (tabId: string, title: string) => {
        setTabs((prev) =>
          prev.map((tab) => (tab.id === tabId ? { ...tab, title } : tab))
        );
      },
      []
    );

    // 打开（或切换到已存在的）代码库数据 tab。tab id 固定，避免同一时间
    // 存在多个代码库 tab；切换项目时通过更新 data 复用同一个 tab。
    const handleOpenCodebaseTab = useCallback(
      (projectId: string, projectName: string) => {
        setTabs((prev) => {
          const existing = prev.find((t) => t.id === CODEBASE_TAB_ID);
          if (existing) {
            return prev.map((t) =>
              t.id === CODEBASE_TAB_ID
                ? {
                    ...t,
                    data: { projectId, projectName } as CodebaseTabData,
                  }
                : t
            );
          }
          const codebaseData: CodebaseTabData = { projectId, projectName };
          return [
            ...prev,
            {
              id: CODEBASE_TAB_ID,
              type: "codebase",
              title: t("rightPanel.codebaseTab"),
              data: codebaseData,
            },
          ];
        });
        setActiveTabId(CODEBASE_TAB_ID);
      },
      [t]
    );

    // 项目切换后重新判断代码库 tab：
    // - 新项目有索引（totalChunks > 0）：更新 tab 数据，触发列表重新加载。
    // - 新项目没有索引：自动关闭代码库 tab。
    const handleCodebaseProjectChanged = useCallback(
      (projectId: string) => {
        const hasCodebaseTab = tabs.some((t) => t.type === "codebase");
        if (!hasCodebaseTab) {
          return;
        }
        let cancelled = false;
        void window.snow
          .getCodebaseIndexStats(projectId)
          .then((stats) => {
            if (cancelled) {
              return;
            }
            if (stats.totalChunks > 0) {
              setTabs((prev) =>
                prev.map((tab) =>
                  tab.type === "codebase"
                    ? {
                        ...tab,
                        data: {
                          projectId,
                          projectName: activeDirectory?.name ?? tab.title,
                        } as CodebaseTabData,
                      }
                    : tab
                )
              );
            } else {
              setTabs((prev) => prev.filter((t) => t.type !== "codebase"));
              setActiveTabId((currentActive) => {
                if (currentActive !== CODEBASE_TAB_ID) {
                  return currentActive;
                }
                // 回退到左侧相邻 tab；没有则回到 Git tab。
                const currentIndex = tabs.findIndex(
                  (t) => t.id === CODEBASE_TAB_ID
                );
                if (currentIndex > 0) {
                  return tabs[currentIndex - 1].id;
                }
                const gitTab = tabs.find((t) => t.id === GIT_TAB_ID);
                return gitTab ? GIT_TAB_ID : (tabs[1]?.id ?? currentActive);
              });
            }
          })
          .catch(() => {
            // 查询失败时保守处理：保留 tab，由用户手动关闭。
          });
        return () => {
          cancelled = true;
        };
      },
      [tabs, activeDirectory]
    );

    useEffect(() => {
      if (!activeDirectory?.directoryId) {
        return;
      }
      return handleCodebaseProjectChanged(activeDirectory.directoryId);
    }, [activeDirectory?.directoryId, handleCodebaseProjectChanged]);

    const handleOpenFileTab = useCallback(
      (
        filePath: string,
        fileName: string,
        isSsh: boolean,
        sshSessionId?: string | null,
        focusLine?: number
      ) => {
        const tabId = `file:${filePath}`;
        setTabs((prev) => {
          const existing = prev.find((t) => t.id === tabId);
          if (existing) {
            // 已存在 tab：仅更新 focusLine，不重建（避免重载文件内容）。
            return prev.map((t) =>
              t.id === tabId
                ? {
                    ...t,
                    data: {
                      ...(t.data as FileViewerTabData),
                      focusLine,
                    },
                  }
                : t
            );
          }
          const fileData: FileViewerTabData = {
            filePath,
            fileName,
            isSsh,
            sshSessionId: sshSessionId ?? undefined,
            focusLine,
          };
          const newTab: RightPanelTab = {
            id: tabId,
            type: "file",
            title: fileName,
            data: fileData,
          };
          return [...prev, newTab];
        });
        setActiveTabId(tabId);
      },
      []
    );

    // Git 变更/暂存区文件「打开文件」按钮：以本地仓库文件（isSsh=false）
    // 在右侧面板新建 file tab，通过 FileViewerContent 显示文件原文。
    const handleOpenFileFromGit = useCallback(
      (filePath: string, fileName: string) => {
        handleOpenFileTab(filePath, fileName, false);
      },
      [handleOpenFileTab]
    );

    const handleOpenFileDiffPreviewTab = useCallback(
      (payload: OpenFileDiffPreviewPayload) => {
        const tabId = `file-diff-preview:${payload.filePath}`;
        const patch = generateComparePatch(
          payload.fileName,
          payload.oldContent,
          payload.newContent,
          payload.oldStartLine,
          payload.newStartLine
        );
        const data: FileDiffPreviewTabData = {
          fileName: payload.fileName,
          filePath: payload.filePath,
          patch,
          oldStartLine: payload.oldStartLine,
          newStartLine: payload.newStartLine,
          changeType: payload.changeType,
        };
        setTabs((prev) => {
          const existing = prev.find((t) => t.id === tabId);
          if (existing) {
            return prev.map((t) => (t.id === tabId ? { ...t, data } : t));
          }
          const newTab: RightPanelTab = {
            id: tabId,
            type: "file-diff-preview",
            title: payload.fileName,
            data,
          };
          return [...prev, newTab];
        });
        setActiveTabId(tabId);
        rightPanelEvents.emit("request-expand");
      },
      []
    );

    useEffect(() => {
      return rightPanelEvents.on(
        "open-file-diff-preview",
        handleOpenFileDiffPreviewTab
      );
    }, [handleOpenFileDiffPreviewTab]);

    // 工具调用组件（如 WebSearch）请求在应用内浏览器新建 tab 打开链接。
    // 带短时去抖：同一 URL 600ms 内的重复触发（双击）只创建一个 tab。
    const lastBrowserOpenRef = useRef<{ url: string; at: number }>({
      url: "",
      at: 0,
    });

    const handleOpenBrowserTabEvent = useCallback(
      (payload: OpenBrowserTabPayload) => {
        const url = payload.url.trim();
        if (!url) {
          return;
        }
        const now = Date.now();
        const last = lastBrowserOpenRef.current;
        if (last.url === url && now - last.at < 600) {
          return;
        }
        lastBrowserOpenRef.current = { url, at: now };
        handleOpenBrowserTab(url);
        rightPanelEvents.emit("request-expand");
      },
      [handleOpenBrowserTab]
    );

    useEffect(() => {
      return rightPanelEvents.on("open-browser-tab", handleOpenBrowserTabEvent);
    }, [handleOpenBrowserTabEvent]);

    useImperativeHandle(
      ref,
      () => ({
        openTerminal: (cwd: string) => {
          handleOpenTerminalTab(cwd);
        },
        openBrowser: (url?: string) => {
          handleOpenBrowserTab(url);
        },
        openCodebase: (projectId: string, projectName: string) => {
          handleOpenCodebaseTab(projectId, projectName);
        },
        openFile: (
          filePath: string,
          fileName: string,
          isSsh?: boolean,
          sshSessionId?: string | null,
          focusLine?: number
        ) => {
          handleOpenFileTab(
            filePath,
            fileName,
            isSsh ?? false,
            sshSessionId,
            focusLine
          );
        },
      }),
      [
        handleOpenTerminalTab,
        handleOpenBrowserTab,
        handleOpenCodebaseTab,
        handleOpenFileTab,
      ]
    );

    const handleCloseTab = useCallback(
      (tabId: string) => {
        setTabs((prev) => {
          if (tabId === GIT_TAB_ID) {
            return prev;
          }
          const filtered = prev.filter((t) => t.id !== tabId);
          if (filtered.length === 0) {
            return prev;
          }
          return filtered;
        });
        setDirtyTabs((prev) => {
          if (!prev.has(tabId)) {
            return prev;
          }
          const next = new Set(prev);
          next.delete(tabId);
          return next;
        });
        setActiveTabId((currentActive) => {
          if (currentActive !== tabId) {
            return currentActive;
          }
          // 关闭当前激活的 tab：优先向左顺延选择相邻 tab，
          // 仅当左侧没有其他 tab 时才回退到 Git tab。
          const currentIndex = tabs.findIndex((t) => t.id === tabId);
          if (currentIndex > 0) {
            return tabs[currentIndex - 1].id;
          }
          // currentIndex === 0：左侧无 tab，回退到 Git tab（若存在）
          const gitTab = tabs.find((t) => t.id === GIT_TAB_ID);
          return gitTab ? GIT_TAB_ID : tabs[1]?.id ?? currentActive;
        });
      },
      [tabs]
    );

    const handleCloseBrowserTab = useCallback(
      (instanceId: string): boolean => {
        const tab = tabs.find(
          (t) => t.id === instanceId && t.type === "browser"
        );
        if (!tab) {
          return false;
        }
        handleCloseTab(instanceId);
        return true;
      },
      [tabs, handleCloseTab]
    );

    const handleFocusBrowserTab = useCallback(
      (instanceId: string): boolean => {
        const tab = tabs.find(
          (t) => t.id === instanceId && t.type === "browser"
        );
        if (!tab) {
          return false;
        }
        setActiveTabId(instanceId);
        focusBrowserMcpInstance(instanceId);
        return true;
      },
      [tabs]
    );

    // 工具调用组件（BrowserToolCall）请求切换到指定浏览器实例的 tab。
    const handleFocusBrowserTabEvent = useCallback(
      (payload: FocusBrowserTabPayload) => {
        const instanceId = payload.instanceId.trim();
        if (!instanceId) {
          return;
        }
        if (handleFocusBrowserTab(instanceId)) {
          rightPanelEvents.emit("request-expand");
        }
      },
      [handleFocusBrowserTab]
    );

    useEffect(() => {
      return rightPanelEvents.on(
        "focus-browser-tab",
        handleFocusBrowserTabEvent
      );
    }, [handleFocusBrowserTabEvent]);

    const handleListBrowserTabs = useCallback(() => {
      return tabs
        .filter((t) => t.type === "browser")
        .map((t) => ({
          instanceId: t.id,
          title: t.title,
          isActive: t.id === activeTabId,
        }));
    }, [tabs, activeTabId]);

    const browserMcpCallbacks = useMemo<BrowserMcpTabCallbacks>(
      () => ({
        openTab: handleOpenBrowserTab,
        closeTab: handleCloseBrowserTab,
        focusTab: handleFocusBrowserTab,
        listTabs: handleListBrowserTabs,
      }),
      [
        handleOpenBrowserTab,
        handleCloseBrowserTab,
        handleFocusBrowserTab,
        handleListBrowserTabs,
      ]
    );

    useBrowserMcpCommandBridge(browserMcpCallbacks);

    const tabListRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const el = tabListRef.current;
      if (!el) {
        return;
      }
      const onWheel = (e: WheelEvent) => {
        if (e.deltaY === 0) {
          return;
        }
        const canScroll = el.scrollWidth > el.clientWidth;
        if (!canScroll) {
          return;
        }
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      return () => el.removeEventListener("wheel", onWheel);
    }, [tabs.length]);

    const panelClasses = [
      "right-panel",
      isCollapsed ? "collapsed" : "",
      isFullscreen ? "fullscreen" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const renderTabContent = (tab: RightPanelTab): React.ReactNode => {
      if (tab.type === "git") {
        return (
          <GitPanelContent
            activeDirectory={activeDirectory}
            onOpenInTab={handleOpenDiffTab}
            onOpenFile={handleOpenFileFromGit}
          />
        );
      }

      // 非 Git tab 均为懒加载组件，需要 Suspense 包裹。
      return (
        <Suspense fallback={null}>
          {tab.type === "terminal" ? (
            <TerminalPanelContent
              cwd={(tab.data as TerminalTabData).cwd}
              isActive={activeTabId === tab.id}
              onTitleChange={(title) =>
                handleTerminalTitleChange(tab.id, title)
              }
            />
          ) : tab.type === "browser" ? (
            <BrowserPanelContent
              instanceId={(tab.data as BrowserTabData).instanceId}
              initialUrl={(tab.data as BrowserTabData).url}
              isActive={activeTabId === tab.id}
              onTitleChange={(title) => handleBrowserTitleChange(tab.id, title)}
            />
          ) : tab.type === "codebase" ? (
            (tab.data as CodebaseTabData) ? (
              <CodebasePanelContent
                projectId={(tab.data as CodebaseTabData).projectId}
                projectName={(tab.data as CodebaseTabData).projectName}
              />
            ) : null
          ) : tab.type === "diff" ? (
            (tab.data as DiffTabData) ? (
              <DiffViewer
                selectedFile={(tab.data as DiffTabData).selectedFile}
                diffResult={(tab.data as DiffTabData).diffResult}
                diffLoading={(tab.data as DiffTabData).diffLoading}
              />
            ) : null
          ) : tab.type === "file" ? (
            (tab.data as FileViewerTabData) ? (
              <FileViewerContent
                filePath={(tab.data as FileViewerTabData).filePath}
                fileName={(tab.data as FileViewerTabData).fileName}
                isSsh={(tab.data as FileViewerTabData).isSsh}
                sshSessionId={(tab.data as FileViewerTabData).sshSessionId}
                focusLine={(tab.data as FileViewerTabData).focusLine}
                onDirtyChange={(dirty) =>
                  setDirtyTabs((prev) => {
                    const next = new Set(prev);
                    if (dirty) {
                      next.add(tab.id);
                    } else {
                      next.delete(tab.id);
                    }
                    return next;
                  })
                }
              />
            ) : null
          ) : tab.type === "file-diff-preview" ? (
            (tab.data as FileDiffPreviewTabData) ? (
              <FileDiffPreview
                diffs={[
                  {
                    path: (tab.data as FileDiffPreviewTabData).filePath,
                    changeType: (tab.data as FileDiffPreviewTabData).changeType,
                    content: (tab.data as FileDiffPreviewTabData).patch ?? "",
                    isBinary: false,
                  },
                ]}
                isLoading={false}
                hasError={(tab.data as FileDiffPreviewTabData).patch == null}
                labels={{
                  loading: t("rightPanel.loadingDiff"),
                  error: t("rightPanel.diffPreviewError"),
                  empty: t("rightPanel.noChangesToDisplay"),
                  selectFile: t("rightPanel.selectFileToViewDiff"),
                }}
              />
            ) : null
          ) : null}
        </Suspense>
      );
    };

    return (
      <aside className={panelClasses}>
        {tabs.length > 1 && (
          <div className="right-panel-tabs">
            <div ref={tabListRef} className="right-panel-tab-list">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`right-panel-tab-item ${
                    activeTabId === tab.id ? "active" : ""
                  }`}
                  onClick={() => setActiveTabId(tab.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setActiveTabId(tab.id);
                    setTabContextMenu({
                      x: event.clientX,
                      y: event.clientY,
                      tabId: tab.id,
                    });
                  }}
                >
                  {getTabFileIcon(tab)}
                  <span className="right-panel-tab-title" title={tab.title}>
                    {dirtyTabs.has(tab.id) && (
                      <span
                        className="right-panel-tab-dirty-dot"
                        aria-hidden="true"
                      />
                    )}
                    {tab.title}
                  </span>
                  {tab.id !== GIT_TAB_ID && (
                    <button
                      type="button"
                      className="right-panel-tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCloseTab(tab.id);
                      }}
                      aria-label={t("rightPanel.closeTab")}
                    >
                      <X size={12} strokeWidth={1.8} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="right-panel-content-wrapper">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`right-panel-tab-pane ${
                activeTabId === tab.id ? "active" : ""
              }`}
            >
              {renderTabContent(tab)}
            </div>
          ))}
        </div>
        {tabContextMenu && (
          <RightPanelTabContextMenu
            x={tabContextMenu.x}
            y={tabContextMenu.y}
            isClosable={tabContextMenu.tabId !== GIT_TAB_ID}
            onNewTerminal={() => {
              setTabContextMenu(null);
              handleOpenTerminalTab(activeDirectory?.path ?? "");
            }}
            onNewBrowser={() => {
              setTabContextMenu(null);
              handleOpenBrowserTab();
            }}
            onCloseTab={() => {
              setTabContextMenu(null);
              handleCloseTab(tabContextMenu.tabId);
            }}
            onClose={() => setTabContextMenu(null)}
          />
        )}
      </aside>
    );
  }
);

RightPanel.displayName = "RightPanel";
