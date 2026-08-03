import { AlertCircle, Bot, CheckCircle2, Loader2 } from "lucide-react";

import { useI18n } from "../../../i18n";
import type { ChatConversationRecord } from "../../../../preload";

type SubAgentListPanelProps = {
  conversations: ChatConversationRecord[];
  activeConversationId?: string;
  onSelect?: (conversationId: string) => void;
};

function renderStatusIcon(status: string): React.ReactNode {
  if (status === "running") {
    return <Loader2 size={11} className="spin" />;
  }
  if (status === "failed") {
    return <AlertCircle size={11} className="sub-agent-failed" />;
  }
  if (status === "completed") {
    return <CheckCircle2 size={11} className="sub-agent-completed" />;
  }
  return <Bot size={11} />;
}

/**
 * 子代理列表面板：独立的自包含面板，拥有自己的表面背景，
 * 不依赖父级会话项的选中/悬停状态，避免嵌套背景互相冲突。
 */
export function SubAgentListPanel({
  conversations,
  activeConversationId,
  onSelect,
}: SubAgentListPanelProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="sub-agent-list-panel">
      {conversations.map((subAgent) => (
        <div
          key={subAgent.conversationId}
          className={`sub-agent-list-item${
            subAgent.conversationId === activeConversationId ? " active" : ""
          }`}
          onClick={(event) => {
            // 面板是独立交互区域，阻止点击事件继续冒泡
            event.stopPropagation();
            onSelect?.(subAgent.conversationId);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              onSelect?.(subAgent.conversationId);
            }
          }}
        >
          <span className="sub-agent-list-icon">
            {renderStatusIcon(subAgent.subAgentStatus)}
          </span>
          <span className="sub-agent-list-name">
            {subAgent.subAgentName ||
              subAgent.title ||
              t("sidebar.subAgent", { defaultValue: "Sub-agent" })}
          </span>
        </div>
      ))}
    </div>
  );
}
