import { useMemo } from "react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type SkillToolCallProps = {
  toolCall: ToolCallInfo;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Extract the skill id from the tool arguments (e.g. "pdf", "helloagents/analyze"). */
const parseSkillId = (args: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed) || typeof parsed.skill !== "string") {
      return undefined;
    }
    const skillId = parsed.skill.trim();
    return skillId.length > 0 ? skillId : undefined;
  } catch {
    return undefined;
  }
};

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

export const SkillToolCall = ({
  toolCall,
}: SkillToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const skillId = useMemo(
    () => parseSkillId(toolCall.arguments),
    [toolCall.arguments]
  );

  const effectiveStatus = hasResultError(toolCall.result)
    ? "error"
    : toolCall.status;
  const formattedArgs = formatArguments(toolCall.arguments);
  const hasBody = Boolean(formattedArgs || toolCall.result);

  return (
    <ToolCallNode
      toolName={toolCall.name}
      category="agent"
      displayName={skillId ? <code>{skillId}</code> : undefined}
      displayNameTitle={skillId}
      status={effectiveStatus}
      className="tool-call-skill"
    >
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
};
