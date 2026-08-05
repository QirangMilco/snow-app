import { memo } from "react";
import type { ToolCallInfo } from "../utils/conversationTypes";
import {
  AskUserQuestionToolCall,
  PlanModeApprovalToolCall,
  BashToolCall,
  FilesystemReadToolCall,
  FilesystemEditToolCall,
  FilesystemCreateToolCall,
  TodoToolCall,
  GrepToolCall,
  SubAgentToolCall,
  CodebaseToolCall,
  CodeLensToolCall,
  WebSearchToolCall,
  ImageGenToolCall,
  BrowserToolCall,
  TerminalToolCall,
} from "../toolCalls";
import { ToolCallNode } from "../toolCalls/shared/ToolCallNode";
import { useI18n } from "../../../../i18n";

type ToolCallItemProps = {
  toolCall: ToolCallInfo;
};

/** Pretty-print JSON arguments if possible, otherwise return raw string. */
const formatArguments = (args: string): string => {
  if (!args || args === "{}") {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Detect whether the tool result JSON carries an error. */
const hasResultError = (result: string | undefined): boolean => {
  if (!result) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return false;
    }
    return typeof parsed.error === "string";
  } catch {
    return false;
  }
};

export const ToolCallItem = memo(
  ({ toolCall }: ToolCallItemProps): React.JSX.Element => {
    const { t } = useI18n();
    // Delegate to specialized renderers based on tool name
    if (toolCall.name === "user-interaction-askUserQuestion") {
      return <AskUserQuestionToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "app-control-requestApproval") {
      return <PlanModeApprovalToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "filesystem-read") {
      return <FilesystemReadToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "filesystem-replace_edit") {
      return <FilesystemEditToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "filesystem-create") {
      return <FilesystemCreateToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "bash-terminal-execute") {
      return <BashToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "todo-todo-manage") {
      return <TodoToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "grep-search") {
      return <GrepToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "sub-agents-activate") {
      return <SubAgentToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "codebase-search") {
      return <CodebaseToolCall toolCall={toolCall} />;
    }

    if (
      toolCall.name === "codelens-diagnose" ||
      toolCall.name === "codelens-find_definition" ||
      toolCall.name === "codelens-find_references" ||
      toolCall.name === "codelens-file_outline"
    ) {
      return <CodeLensToolCall toolCall={toolCall} />;
    }

    if (
      toolCall.name === "websearch-websearch-search" ||
      toolCall.name === "websearch-websearch-fetch"
    ) {
      return <WebSearchToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "imagegen-generate") {
      return <ImageGenToolCall toolCall={toolCall} />;
    }

    if (toolCall.name.startsWith("browser-")) {
      return <BrowserToolCall toolCall={toolCall} />;
    }

    if (toolCall.name.startsWith("terminal-")) {
      return <TerminalToolCall toolCall={toolCall} />;
    }

    const effectiveStatus = hasResultError(toolCall.result)
      ? "error"
      : toolCall.status;
    const formattedArgs = formatArguments(toolCall.arguments);
    const hasBody = Boolean(formattedArgs || toolCall.result);

    return (
      <ToolCallNode toolName={toolCall.name} status={effectiveStatus}>
        {hasBody ? (
          <>
            {formattedArgs ? (
              <div className="tool-call-section">
                <span className="tool-call-section-label">
                  {t("toolCall.common.arguments")}
                </span>
                <pre className="tool-call-section-pre">{formattedArgs}</pre>
              </div>
            ) : null}
            {toolCall.result ? (
              <div className="tool-call-section">
                <span className="tool-call-section-label">
                  {t("toolCall.common.result")}
                </span>
                <pre className="tool-call-section-pre">{toolCall.result}</pre>
              </div>
            ) : null}
          </>
        ) : null}
      </ToolCallNode>
    );
  }
);

ToolCallItem.displayName = "ToolCallItem";
