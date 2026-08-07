import { Loader2 } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import { AiResponseActions } from "./AiResponseActions";
import { StreamCursor } from "./StreamCursor";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallItem } from "./ToolCallItem";
import { ToolCallGroup } from "./ToolCallGroup";
import { ImageGenGallery } from "../toolCalls/ImageGenGallery";
import { ToolAuthorizationDialog } from "../dialogs/ToolAuthorizationDialog";
import { SensitiveCommandConfirmDialog } from "../toolCalls/SensitiveCommandConfirmDialog";
import { MarkdownBlock } from "./markdownRenderer";
import type { AiResponseProps } from "../utils/types";
import type { ToolCallInfo } from "../utils/conversationTypes";
import type { HookExecutionRecord } from "../utils/conversationTypes";

/** 工具调用渲染单元：连续的 imagegen-generate 调用合并为画廊，其余逐个渲染。 */
type ToolCallRenderItem =
  | { type: "gallery"; key: string; toolCalls: ToolCallInfo[] }
  | { type: "single"; key: string; toolCall: ToolCallInfo };

/** 把 toolCalls 分组：相邻的 imagegen-generate（≥2 个）合并为一组画廊，
 *  避免并行生图结果纵向堆叠为多个单张卡片；其余调用保持单卡渲染。 */
const groupToolCalls = (toolCalls: ToolCallInfo[]): ToolCallRenderItem[] => {
  const groups: ToolCallRenderItem[] = [];
  for (let i = 0; i < toolCalls.length; ) {
    if (toolCalls[i].name === "imagegen-generate") {
      let j = i;
      while (
        j < toolCalls.length &&
        toolCalls[j].name === "imagegen-generate"
      ) {
        j += 1;
      }
      if (j - i >= 2) {
        groups.push({
          type: "gallery",
          key: `imagegen-gallery-${i}`,
          toolCalls: toolCalls.slice(i, j),
        });
      } else {
        groups.push({
          type: "single",
          key: `${toolCalls[i].name}-${i}`,
          toolCall: toolCalls[i],
        });
      }
      i = j;
    } else {
      groups.push({
        type: "single",
        key: `${toolCalls[i].name}-${i}`,
        toolCall: toolCalls[i],
      });
      i += 1;
    }
  }
  return groups;
};

export const AiResponse = memo(
  ({
    title,
    summary,
    thinking,
    sections = [],
    isStreaming = false,
    isAborting = false,
    isRetrying = false,
    retryAttempt,
    retryError,
    showActions = true,
    toolCalls = [],
    hookExecutions = [],
    pendingToolAuthorizations = [],
    onApproveToolAuthorization,
    onApproveToolAuthorizationAlways,
    onRejectToolAuthorization,
    conversationId,
    responseId,
    onFork,
  }: AiResponseProps): React.JSX.Element => {
    const { t } = useI18n();
    const [showRawMarkdown, setShowRawMarkdown] = useState(false);
    const normalizedThinking = thinking?.trim();
    const normalizedSummary = summary.trim();
    const summaryClassName = "ai-message-summary";
    const hasToolCalls = toolCalls.length > 0;

    const sensitiveCommandAuthorizations = useMemo(
      () =>
        pendingToolAuthorizations.filter(
          (tc) =>
            tc.sensitiveCommandMatches && tc.sensitiveCommandMatches.length > 0
        ),
      [pendingToolAuthorizations]
    );
    const normalAuthorizations = useMemo(
      () =>
        pendingToolAuthorizations.filter(
          (tc) =>
            !tc.sensitiveCommandMatches ||
            tc.sensitiveCommandMatches.length === 0
        ),
      [pendingToolAuthorizations]
    );

    // 相邻的并行 imagegen 调用合并为统一画廊（生成中占位 → 逐个填充）
    const groupedToolCalls = useMemo(
      () => groupToolCalls(toolCalls),
      [toolCalls]
    );

    // Records bound to a specific tool call (toolCallInteractionId) are
    // rendered attached to that tool card (e.g. beforeSubAgentStart above
    // the sub-agent card).  Unbound records stay in the message footer.
    const hooksByInteractionId = useMemo(() => {
      const map = new Map<string, HookExecutionRecord[]>();
      for (const record of hookExecutions) {
        if (!record.toolCallInteractionId) {
          continue;
        }
        const list = map.get(record.toolCallInteractionId);
        if (list) {
          list.push(record);
        } else {
          map.set(record.toolCallInteractionId, [record]);
        }
      }
      return map;
    }, [hookExecutions]);

    return (
      <article className="ai-message" aria-label="AI response">
        <div className="ai-message-content">
          {title ? <h2>{title}</h2> : null}

          {/* 1. Thinking */}
          {normalizedThinking ? (
            <ThinkingBlock
              content={normalizedThinking}
              isStreaming={isStreaming}
            />
          ) : null}

          {/* 2. Body / Summary */}
          {normalizedSummary ? (
            showRawMarkdown ? (
              <pre className="ai-message-raw">{normalizedSummary}</pre>
            ) : (
              <MarkdownBlock
                className={summaryClassName}
                content={normalizedSummary}
                streaming={isStreaming}
              />
            )
          ) : null}

          {/* 3. Sections */}
          {sections.map((section) => (
            <section className="ai-message-section" key={section.title}>
              <h3>{section.title}</h3>
              {showRawMarkdown ? (
                <pre className="ai-message-raw">{section.body}</pre>
              ) : (
                <MarkdownBlock
                  className="ai-message-section-body"
                  content={section.body}
                  streaming={isStreaming}
                />
              )}
            </section>
          ))}

          {/* 4. Tool calls */}
          {hasToolCalls ? (
            <ToolCallGroup
              count={toolCalls.length}
              isRunning={toolCalls.some((tc) => tc.status === "running")}
            >
              {groupedToolCalls.map((item) =>
                item.type === "gallery" ? (
                  <ImageGenGallery
                    key={item.key}
                    toolCalls={item.toolCalls}
                  />
                ) : (
                  <ToolCallItem
                    key={item.key}
                    toolCall={item.toolCall}
                    hookExecutions={hooksByInteractionId.get(
                      item.toolCall.interactionId
                    )}
                  />
                )
              )}
            </ToolCallGroup>
          ) : null}

          {onApproveToolAuthorization &&
          onApproveToolAuthorizationAlways &&
          onRejectToolAuthorization ? (
            <>
              <SensitiveCommandConfirmDialog
                toolCalls={sensitiveCommandAuthorizations}
                onApprove={onApproveToolAuthorization}
                onReject={onRejectToolAuthorization}
              />
              <ToolAuthorizationDialog
                toolCalls={normalAuthorizations}
                onApprove={onApproveToolAuthorization}
                onApproveAlways={onApproveToolAuthorizationAlways}
                onReject={onRejectToolAuthorization}
              />
            </>
          ) : null}

          {/* 5. Loading indicator — persists throughout the entire AI loop */}
          {isAborting ? (
            <span className="stream-stopping">
              <Loader2 size={12} className="spin" />
              <span>{t("chat.stopping", { defaultValue: "Stopping..." })}</span>
            </span>
          ) : isRetrying ? (
            <span className="stream-retrying">
              <Loader2 size={12} className="spin" />
              <span>
                {t("chat.retrying", {
                  defaultValue: "Retrying",
                })}
                {retryAttempt != null ? ` (${retryAttempt})` : ""}
                ...
              </span>
              {retryError ? (
                <span className="stream-retrying-error" title={retryError}>
                  {retryError.length > 120
                    ? `${retryError.slice(0, 120)}...`
                    : retryError}
                </span>
              ) : null}
            </span>
          ) : isStreaming ? (
            <StreamCursor />
          ) : null}
        </div>

        {/* 6. Actions */}
        {showActions && conversationId && onFork ? (
          <AiResponseActions
            content={normalizedSummary}
            conversationId={conversationId}
            responseId={responseId}
            showRawMarkdown={showRawMarkdown}
            onToggleRawMarkdown={() => setShowRawMarkdown((prev) => !prev)}
            onFork={onFork}
          />
        ) : null}
      </article>
    );
  }
);

AiResponse.displayName = "AiResponse";
