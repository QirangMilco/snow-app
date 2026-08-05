import {
  FolderGit2,
  ChevronDown,
  GitBranch as GitBranchIcon,
  Copy,
  FolderOpen,
  Terminal as TerminalIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { GitRepoInfo } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { ContextMenu, type ContextMenuItem } from "../../common/ContextMenu";

type RepoSelectorProps = {
  repos: GitRepoInfo[];
  selectedRepoPath: string | null;
  onSelect: (path: string) => void;
  /** 在仓库目录打开终端。 */
  onOpenTerminal?: (cwd: string) => void;
};

export const RepoSelector = ({
  repos,
  selectedRepoPath,
  onSelect,
  onOpenTerminal,
}: RepoSelectorProps): React.JSX.Element => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedRepo = repos.find((r) => r.path === selectedRepoPath);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleClickOutside = (e: MouseEvent): void => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleSelect = (path: string): void => {
    onSelect(path);
    setIsOpen(false);
  };

  /** 右键菜单：复制仓库路径 / 在文件管理器中显示 / 在终端中打开。 */
  const buildMenuItems = (): ContextMenuItem[] => {
    const repoPath = selectedRepo?.path ?? "";
    return [
      {
        id: "copy-repo-path",
        label: t("git.copyRepoPath", {
          defaultValue: "Copy Repository Path",
        }),
        icon: <Copy size={13} strokeWidth={1.8} />,
        disabled: !repoPath,
        onClick: () => {
          setContextMenu(null);
          void window.snow.writeClipboardText(repoPath).catch(() => {
            // 剪贴板写入失败时静默忽略。
          });
        },
      },
      {
        id: "reveal-repo",
        separator: true,
        label: t("git.revealInExplorer", {
          defaultValue: "Show in Explorer",
        }),
        icon: <FolderOpen size={13} strokeWidth={1.8} />,
        disabled: !repoPath,
        onClick: () => {
          setContextMenu(null);
          void window.snow.showItemInFolder(repoPath).catch(() => {
            // 打开文件管理器失败时静默忽略。
          });
        },
      },
      {
        id: "open-repo-terminal",
        label: t("git.openInTerminal", {
          defaultValue: "Open in Terminal",
        }),
        icon: <TerminalIcon size={13} strokeWidth={1.8} />,
        disabled: !repoPath || !onOpenTerminal,
        onClick: () => {
          setContextMenu(null);
          if (repoPath && onOpenTerminal) {
            onOpenTerminal(repoPath);
          }
        },
      },
    ];
  };

  return (
    <div className="repo-selector" ref={containerRef}>
      <button
        type="button"
        className="repo-selector-btn"
        onClick={() => setIsOpen(!isOpen)}
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <FolderGit2 size={14} strokeWidth={1.8} />
        <span className="repo-selector-name">
          {selectedRepo?.name ?? t("git.selectRepo")}
        </span>
        {selectedRepo?.currentBranch && (
          <span className="repo-selector-branch">
            <GitBranchIcon size={11} strokeWidth={1.8} />
            {selectedRepo.currentBranch}
          </span>
        )}
        <ChevronDown size={12} strokeWidth={1.8} />
      </button>
      {isOpen && (
        <div className="repo-dropdown">
          {repos.map((repo) => (
            <button
              key={repo.path}
              type="button"
              className={`repo-dropdown-item${
                repo.path === selectedRepoPath ? " active" : ""
              }`}
              onClick={() => handleSelect(repo.path)}
            >
              <FolderGit2 size={13} strokeWidth={1.8} />
              <div className="repo-dropdown-info">
                <span className="repo-dropdown-name">{repo.name}</span>
                {repo.currentBranch && (
                  <span className="repo-dropdown-branch">
                    {repo.currentBranch}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildMenuItems()}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};
