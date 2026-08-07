import { useMemo } from "react";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  CheckCircle2,
  CircleDot,
  Loader2,
  Wrench,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import { useChatConversationContext } from "../components/ChatConversationContext";
import type { ToolCallInfo } from "../utils/conversationTypes";
import type { ChatConversationMessage } from "../utils/conversationTypes";
import type { HookExecutionRecord } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";
import { HookExecutionUI } from "./HookExecutionUI";

type SubAgentToolCallProps = {
  toolCall: ToolCallInfo;
  /** Hook execution records bound to this tool call (matched by
   *  toolCallInteractionId). beforeSubAgentStart renders as a "pre" step,
   *  onSubAgentComplete as a "post" step inside the card. */
  hookExecutions?: HookExecutionRecord[];
};

type ParsedSubAgentArgs = {
  agentId: string;
  prompt: string;
};

type ParsedSubAgentResult =
  | {
      type: "success";
      conversationId: string;
      agentName: string;
      summary: string;
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseArgs = (args: string): ParsedSubAgentArgs | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed)) {
      return null;
    }
    const agentId = typeof parsed.agentId === "string" ? parsed.agentId : "";
    const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
    if (!agentId || !prompt) {
      return null;
    }
    return { agentId, prompt };
  } catch {
    return null;
  }
};

const parseResult = (result: string | undefined): ParsedSubAgentResult => {
  if (!result) {
    return { type: "empty" };
  }

  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return { type: "raw", text: result };
    }

    if (typeof parsed.error === "string") {
      return { type: "error", message: parsed.error };
    }

    if (
      parsed.success === true &&
      typeof parsed.conversationId === "string" &&
      typeof parsed.agentName === "string"
    ) {
      return {
        type: "success",
        conversationId: parsed.conversationId,
        agentName: parsed.agentName,
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
      };
    }

    return { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};

const PROMPT_PREVIEW_MAX = 120;

const getPromptPreview = (prompt: string): string =>
  prompt.length > PROMPT_PREVIEW_MAX
    ? `${prompt.slice(0, PROMPT_PREVIEW_MAX)}...`
    : prompt;

type SubAgentToolCallEntry = {
  id: string;
  name: string;
  shortName: string;
  status: "pending" | "running" | "completed" | "error";
  summary: string;
};

const getToolSummary = (name: string, args: string): string => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed)) {
      return "";
    }
    const shortName = name.replace(/^.*?-/, "");
    switch (shortName) {
      case "read":
      case "replace_edit":
      case "create":
        return typeof parsed.filePath === "string" ? parsed.filePath : "";
      case "terminal-execute":
        if (typeof parsed.command === "string") {
          const firstLine = parsed.command.split("\n")[0];
          return firstLine.length > 80
            ? `${firstLine.slice(0, 80)}...`
            : firstLine;
        }
        return "";
      case "search":
        return typeof parsed.pattern === "string" ? parsed.pattern : "";
      case "todo-manage":
        return typeof parsed.action === "string" ? parsed.action : "";
      case "askUserQuestion":
        return typeof parsed.question === "string" ? parsed.question : "";
      default:
        return "";
    }
  } catch {
    return "";
  }
};

const extractSubAgentToolCalls = (
  messages: ChatConversationMessage[] | undefined
): SubAgentToolCallEntry[] => {
  const entries: SubAgentToolCallEntry[] = [];

  if (!messages) {
    return entries;
  }

  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls) {
      continue;
    }
    for (const tc of message.toolCalls) {
      const shortName = tc.name.replace(/^.*?-/, "");
      entries.push({
        id: tc.callId ?? `${tc.name}-${entries.length}`,
        name: tc.name,
        shortName,
        status: tc.status,
        summary: getToolSummary(tc.name, tc.arguments),
      });
    }
  }

  return entries;
};

export const SubAgentToolCall = ({
  toolCall,
  hookExecutions,
}: SubAgentToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const {
    sessions,
    handleSelectConversation,
    activeConversationId,
    subAgentSessionEvents,
  } = useChatConversationContext();

  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments]
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result]
  );

  // Match the sub-agent session event to this tool call so the sub-agent
  // conversation id is available while the tool is still running (before the
  // result is available). Multiple sub-agents can run in parallel with the
  // same agentId, so the unique toolCallInteractionId is the primary key; the
  // agentId match only serves as a fallback for legacy events.
  const matchedEvent = useMemo(() => {
    if (!parsedArgs) {
      return null;
    }
    const events = Object.values(subAgentSessionEvents);

    const byInteractionId = events.find(
      (event) =>
        event.toolCallInteractionId === toolCall.interactionId &&
        event.parentConversationId === activeConversationId
    );
    if (byInteractionId) {
      return byInteractionId;
    }

    const byAgentId = events.find(
      (event) =>
        event.agentId === parsedArgs.agentId &&
        event.parentConversationId === activeConversationId
    );
    return byAgentId ?? null;
  }, [
    subAgentSessionEvents,
    parsedArgs,
    activeConversationId,
    toolCall.interactionId,
  ]);

  // The sub-agent conversation id may come from the parsed result (once the
  // activation call resolves) or from the live session event (while running).
  const subConversationId =
    parsedResult.type === "success"
      ? parsedResult.conversationId
      : matchedEvent?.conversationId;

  // Live session state for the sub-agent conversation. While the sub-agent is
  // running, this provides real-time message and tool-call progress.
  const subSession = subConversationId
    ? sessions[subConversationId]
    : undefined;

  const isRunning = toolCall.status === "running";
  const isError = parsedResult.type === "error" || toolCall.status === "error";

  const toolCallEntries = useMemo(
    () => extractSubAgentToolCalls(subSession?.messages),
    [subSession?.messages]
  );

  const completedCount = toolCallEntries.filter(
    (e) => e.status === "completed"
  ).length;
  const totalCount = toolCallEntries.length;

  // Hooks bound to this tool call (recorded with toolCallInteractionId).
  // beforeSubAgentStart runs before the sub-agent session is created →
  // rendered at the top of the card; onSubAgentComplete runs when the
  // sub-agent finishes → rendered at the bottom.  The executedActions /
  // pendingDecision filter mirrors HookExecutionUI's own visibility rule.
  const preHooks = useMemo(
    () =>
      (hookExecutions ?? []).filter(
        (record) =>
          record.hookType === "beforeSubAgentStart" &&
          (record.executedActions > 0 || record.pendingDecision)
      ),
    [hookExecutions]
  );
  const postHooks = useMemo(
    () =>
      (hookExecutions ?? []).filter(
        (record) =>
          record.hookType === "onSubAgentComplete" &&
          (record.executedActions > 0 || record.pendingDecision)
      ),
    [hookExecutions]
  );

  const effectiveStatus = isError ? "error" : toolCall.status;

  const agentName =
    parsedResult.type === "success"
      ? parsedResult.agentName
      : matchedEvent?.agentName ?? parsedArgs?.agentId ?? "";

  const promptPreview = parsedArgs ? getPromptPreview(parsedArgs.prompt) : "";

  const displayAgentName =
    agentName ||
    t("toolCall.subAgent.unknownAgent", { defaultValue: "Sub-agent" });

  // Determine whether the sub-agent conversation is currently active so we
  // can highlight the jump button.
  const isSubAgentActive =
    subConversationId !== undefined &&
    activeConversationId === subConversationId;

  const handleJumpToSubAgent = (): void => {
    if (subConversationId) {
      void handleSelectConversation(subConversationId);
    }
  };

  const renderActivityIcon = (
    status: SubAgentToolCallEntry["status"]
  ): React.ReactNode => {
    if (status === "running") {
      return (
        <Loader2
          size={11}
          className="tool-call-icon-spinning"
          aria-hidden="true"
        />
      );
    }
    if (status === "completed") {
      return <CheckCircle2 size={11} aria-hidden="true" />;
    }
    if (status === "error") {
      return <AlertCircle size={11} aria-hidden="true" />;
    }
    return <CircleDot size={11} aria-hidden="true" />;
  };

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={t("toolCall.subAgent.name")}
      category="agent"
      displayName={displayAgentName}
      status={effectiveStatus}
      meta={
        totalCount > 0 ? (
          <span className="tool-call-sub-agent-count">
            {t("toolCall.subAgent.toolProgress", {
              values: {
                completed: completedCount,
                total: totalCount,
              },
            })}
          </span>
        ) : null
      }
      className="tool-call-sub-agent"
    >
      <div className="tool-call-body tool-call-sub-agent-body">
        {/* Pre-step: beforeSubAgentStart hook ran before the sub-agent session
            was created — show it at the top of the card. */}
        {preHooks.length > 0 ? (
          <div className="tool-call-sub-agent-hooks tool-call-sub-agent-hooks--pre">
            <HookExecutionUI executions={preHooks} />
          </div>
        ) : null}

        {/* Agent identity row */}
        <div className="tool-call-sub-agent-identity">
          <span className="tool-call-sub-agent-identity-badge">
            <Bot size={12} aria-hidden="true" />
            {displayAgentName}
          </span>
          {parsedArgs ? (
            <span className="tool-call-sub-agent-agent-id">
              {parsedArgs.agentId}
            </span>
          ) : null}
        </div>

        {/* Prompt preview */}
        {promptPreview ? (
          <div className="tool-call-sub-agent-prompt">
            <span className="tool-call-sub-agent-prompt-label">
              {t("toolCall.subAgent.prompt")}
            </span>
            <pre className="tool-call-sub-agent-prompt-value">
              {promptPreview}
            </pre>
          </div>
        ) : null}

        {/* Live tool activity list */}
        {toolCallEntries.length > 0 ? (
          <div className="tool-call-sub-agent-activity">
            <span className="tool-call-sub-agent-activity-label">
              {t("toolCall.subAgent.activity")}
            </span>
            <div className="tool-call-sub-agent-activity-list">
              {toolCallEntries.map((entry) => (
                <div
                  key={entry.id}
                  className="tool-call-sub-agent-activity-item"
                >
                  {renderActivityIcon(entry.status)}
                  <span className="tool-call-sub-agent-activity-name">
                    {entry.shortName}
                  </span>
                  {entry.summary ? (
                    <span
                      className="tool-call-sub-agent-activity-summary"
                      title={entry.summary}
                    >
                      {entry.summary}
                    </span>
                  ) : null}
                  <span
                    className={`tool-call-sub-agent-activity-status tool-call-sub-agent-activity-status-${entry.status}`}
                  >
                    {t(`toolCall.subAgent.status.${entry.status}`)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Pending state - only when no activity yet */}
        {parsedResult.type === "empty" && toolCallEntries.length === 0 ? (
          <div
            className={`tool-call-sub-agent-pending ${
              isRunning ? "tool-call-sub-agent-pending-running" : ""
            }`}
          >
            {isRunning ? (
              <Loader2
                className="tool-call-icon-spinning"
                size={14}
                aria-hidden="true"
              />
            ) : (
              <Wrench size={14} aria-hidden="true" />
            )}
            <span>
              {isRunning
                ? t("toolCall.subAgent.activating")
                : t("toolCall.subAgent.waiting")}
            </span>
          </div>
        ) : null}

        {/* Summary on success */}
        {parsedResult.type === "success" && parsedResult.summary ? (
          <div className="tool-call-sub-agent-summary">
            <span className="tool-call-sub-agent-summary-label">
              {t("toolCall.subAgent.summary")}
            </span>
            <pre className="tool-call-sub-agent-summary-value">
              {parsedResult.summary}
            </pre>
          </div>
        ) : null}

        {/* Error */}
        {parsedResult.type === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
          </div>
        ) : null}

        {/* Raw result fallback */}
        {parsedResult.type === "raw" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.subAgent.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}

        {/* Post-step: onSubAgentComplete hook ran when the sub-agent finished
            — show it at the bottom of the card, before the jump button. */}
        {postHooks.length > 0 ? (
          <div className="tool-call-sub-agent-hooks tool-call-sub-agent-hooks--post">
            <HookExecutionUI executions={postHooks} />
          </div>
        ) : null}

        {/* Jump to sub-agent conversation - available even while running */}
        {subConversationId ? (
          <button
            type="button"
            className={`tool-call-sub-agent-jump ${
              isSubAgentActive ? "active" : ""
            }`}
            onClick={handleJumpToSubAgent}
          >
            <ArrowRight size={12} aria-hidden="true" />
            {t("toolCall.subAgent.jumpToConversation")}
          </button>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
