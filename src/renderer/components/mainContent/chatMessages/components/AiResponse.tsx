import { Loader2 } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import { AiResponseActions } from "./AiResponseActions";
import { StreamCursor } from "./StreamCursor";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallItem } from "./ToolCallItem";
import { ToolCallGroup } from "./ToolCallGroup";
import { ToolAuthorizationDialog } from "../dialogs/ToolAuthorizationDialog";
import { SensitiveCommandConfirmDialog } from "../toolCalls/SensitiveCommandConfirmDialog";
import { MarkdownBlock } from "./markdownRenderer";
import type { AiResponseProps } from "../utils/types";

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
              {toolCalls.map((toolCall, index) => (
                <ToolCallItem
                  key={`${toolCall.name}-${index}`}
                  toolCall={toolCall}
                />
              ))}
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
