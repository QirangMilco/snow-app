import { ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../../../../../i18n";
import type { ToolCategory } from "./ToolNameBadge";
import { ToolNameBadge } from "./ToolNameBadge";

type ToolCallNodeProps = {
  /** Raw MCP tool name (e.g. "filesystem-read") or short name. */
  toolName: string;
  /** Badge display name (e.g. "read", "edit"). Falls back to parsed short name. */
  badgeName?: string;
  /** Badge category. Inferred from toolName if omitted. */
  category?: ToolCategory;
  /** Context label shown after the badge (e.g. filename, command). Accepts ReactNode for rich content like file icons. */
  displayName?: ReactNode;
  /** Tooltip text for the displayName area. Only used when displayName is set. */
  displayNameTitle?: string;
  /** 显式文件路径；提供后 displayName 支持 Ctrl+点击打开。 */
  displayNameDataPath?: string;
  /** Current status of the tool call. */
  status: "pending" | "running" | "completed" | "error";
  /** Whether the node is expanded by default. */
  defaultOpen?: boolean;
  /** Extra metadata rendered inline in the header (badges, counts, etc.). */
  meta?: ReactNode;
  /** Additional CSS class on the outer <details>. */
  className?: string;
  /** Body content shown when expanded. */
  children?: ReactNode;
};

/**
 * 提取工具短名：去掉 `prefix-`（内置工具）或 `prefix_`（外部 MCP 规范化名，
 * 如 dbx_list_tables -> list_tables），未匹配时返回原名。
 */
const shortName = (name: string): string => name.replace(/^.*?[-_]/, "");

export const ToolCallNode = ({
  toolName,
  badgeName,
  category,
  displayName,
  displayNameTitle,
  displayNameDataPath,
  status,
  defaultOpen = false,
  meta,
  className,
  children,
}: ToolCallNodeProps): React.JSX.Element => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const isRunning = status === "running";

  // When defaultOpen changes from false to true (e.g. an interactive
  // session starts), automatically expand the node so the body — and
  // therefore the interactive input area — becomes visible without the
  // user having to click the summary manually.
  useEffect(() => {
    if (defaultOpen) {
      setIsOpen(true);
    }
  }, [defaultOpen]);

  // Resolve the badge name: explicit badgeName wins; otherwise look up the
  // full tool name in the i18n `toolNames` table (e.g. "browser-create" →
  // "创建浏览器"); finally fall back to the parsed short name.
  // 注意：使用 `||` 而非 `??`——i18n 查找可能返回空字符串（defaultValue: ""），
  // 空字符串应视为"未提供"并继续走 fallback 链，避免徽章只显示图标没有文字。
  const localizedToolName = t(`toolNames.${toolName}`, { defaultValue: "" });
  const resolvedBadgeName =
    badgeName || (localizedToolName || shortName(toolName));

  const dotClass =
    status === "completed"
      ? "tcn-dot--completed"
      : status === "running"
      ? "tcn-dot--running"
      : status === "error"
      ? "tcn-dot--error"
      : "tcn-dot--pending";

  return (
    <details
      className={`tcn ${className ?? ""}`}
      open={isOpen}
      onToggle={(e) => setIsOpen(e.currentTarget.open)}
    >
      <summary className="tcn-header">
        <span className={`tcn-dot ${dotClass}`} aria-hidden="true" />
        <ToolNameBadge name={resolvedBadgeName} category={category} />
        {displayName ? (
          <>
            <span className="tcn-sep" aria-hidden="true">
              /
            </span>
            <span
              className="tcn-name"
              title={displayNameTitle}
              data-path={displayNameDataPath}
            >
              {displayName}
            </span>
          </>
        ) : null}
        {isRunning ? (
          <Loader2
            size={13}
            className="tcn-icon-spin tcn-running-spinner"
            aria-hidden="true"
          />
        ) : null}
        {meta ? <span className="tcn-meta">{meta}</span> : null}
        <ChevronRight className="tcn-chevron" size={12} aria-hidden="true" />
      </summary>
      {children ? <div className="tcn-body">{children}</div> : null}
    </details>
  );
};
