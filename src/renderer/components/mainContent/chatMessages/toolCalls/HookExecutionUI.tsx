import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  ShieldQuestion,
  X,
  XCircle,
  Webhook,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type {
  HookExecutionRecord,
  HookExecutionStatus,
} from "../utils/conversationTypes";
import type { ToolCategory } from "./shared/ToolNameBadge";
import { ToolNameBadge } from "./shared/ToolNameBadge";

export type { HookExecutionRecord, HookExecutionStatus };

type HookExecutionUIProps = {
  executions: HookExecutionRecord[];
};

type HookActionResult = HookExecutionRecord["results"][number];


const getHookCategory = (hookType: string): ToolCategory => {
  if (hookType.includes("Tool")) return "generic";
  if (hookType.includes("User")) return "interaction";
  if (hookType.includes("SubAgent")) return "agent";
  return "generic";
};

const hasText = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.length > 0;

const StatusIcon = ({ status }: { status: HookExecutionStatus }) => {
  if (status === "pass") {
    return (
      <CheckCircle2
        size={13}
        className="hook-exec-status-icon hook-exec-status-pass"
        aria-hidden="true"
      />
    );
  }
  if (status === "warn") {
    return (
      <AlertTriangle
        size={13}
        className="hook-exec-status-icon hook-exec-status-warn"
        aria-hidden="true"
      />
    );
  }
  if (status === "needsDecision") {
    return (
      <ShieldQuestion
        size={13}
        className="hook-exec-status-icon hook-exec-status-decision"
        aria-hidden="true"
      />
    );
  }
  return (
    <XCircle
      size={13}
      className="hook-exec-status-icon hook-exec-status-abort"
      aria-hidden="true"
    />
  );
};

type HookActionDisplay = {
  command: string | null;
  output: string | null;
  error: string | null;
  additionalContext: string | null;
  outputWasInjected: boolean;
};

const normalizeText = (value: string | null | undefined): string =>
  value?.trim() ?? "";

const getActionDisplay = (record: HookActionResult): HookActionDisplay => {
  const command = hasText(record.command) ? record.command : null;
  const output = hasText(record.output) ? record.output : null;
  const error = hasText(record.error) ? record.error : null;
  const context = hasText(record.additionalContext)
    ? record.additionalContext
    : null;
  const outputWasInjected =
    output !== null &&
    context !== null &&
    normalizeText(output) === normalizeText(context);

  return {
    command,
    output,
    error,
    additionalContext: outputWasInjected ? null : context,
    outputWasInjected,
  };
};

const buildActionCopyText = (display: HookActionDisplay): string => {
  const parts: string[] = [];
  if (display.command) parts.push(`$ ${display.command}`);
  if (display.output) parts.push(display.output);
  if (display.error) parts.push(display.error);
  if (display.additionalContext) {
    parts.push(`[Context]\n${display.additionalContext}`);
  }
  return parts.join("\n\n");
};

const HookCopyButton = ({ value }: { value: string }): React.JSX.Element => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    },
    []
  );

  const handleCopy = (): void => {
    void window.snow
      .writeClipboardText(value)
      .then(() => {
        setCopied(true);
        if (resetTimerRef.current !== null) {
          window.clearTimeout(resetTimerRef.current);
        }
        resetTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  };

  return (
    <button
      type="button"
      className={`hook-exec-copy${copied ? " hook-exec-copy--copied" : ""}`}
      aria-label={t(copied ? "hookExecution.copied" : "hookExecution.copy", {
        defaultValue: copied ? "Copied" : "Copy",
      })}
      title={t(copied ? "hookExecution.copied" : "hookExecution.copy", {
        defaultValue: copied ? "Copied" : "Copy",
      })}
      onClick={handleCopy}
    >
      {copied ? (
        <Check size={12} aria-hidden="true" />
      ) : (
        <Copy size={12} aria-hidden="true" />
      )}
    </button>
  );
};

const HookOutputSection = ({
  label,
  value,
  meta,
  tone = "default",
}: {
  label: string;
  value: string;
  meta?: string;
  tone?: "default" | "error" | "context";
}): React.JSX.Element => (
  <section className={`hook-exec-output-section hook-exec-output-section--${tone}`}>
    <div className="hook-exec-output-header">
      <span>{label}</span>
      {meta ? <span className="hook-exec-output-meta">{meta}</span> : null}
      <HookCopyButton value={value} />
    </div>
    <pre className="hook-exec-output-content">{value}</pre>
  </section>
);

const HookActionDetails = ({
  record,
  index,
}: {
  record: HookActionResult;
  index: number;
}): React.JSX.Element => {
  const { t } = useI18n();
  const display = useMemo(() => getActionDisplay(record), [record]);
  const copyText = useMemo(() => buildActionCopyText(display), [display]);
  const hasPayload = Boolean(copyText);
  const outputLabel =
    record.actionType === "command"
      ? t("hookExecution.stdout", { defaultValue: "Output" })
      : t("hookExecution.output", { defaultValue: "Output" });

  return (
    <article
      className={`hook-exec-action ${
        record.success ? "hook-exec-action--success" : "hook-exec-action--error"
      }`}
    >
      <header className="hook-exec-action-header">
        {record.success ? (
          <CheckCircle2 size={13} aria-hidden="true" />
        ) : (
          <XCircle size={13} aria-hidden="true" />
        )}
        <span className="hook-exec-action-index">
          {t("hookExecution.action", {
            defaultValue: "Action {{index}}",
            values: { index: index + 1 },
          })}
        </span>
        <span className="hook-exec-action-type">
          {t(`hookExecution.actionType.${record.actionType}`, {
            defaultValue: record.actionType || "action",
          })}
        </span>
        {record.exitCode != null ? (
          <span
            className={`hook-exec-exit-code ${
              record.exitCode === 0
                ? "hook-exec-exit-code--success"
                : "hook-exec-exit-code--error"
            }`}
          >
            {t("hookExecution.exitCode", {
              defaultValue: "Exit {{code}}",
              values: { code: record.exitCode },
            })}
          </span>
        ) : null}
        {hasPayload ? <HookCopyButton value={copyText} /> : null}
      </header>

      <div className="hook-exec-action-body">
        {display.command ? (
          <HookOutputSection
            label={t("hookExecution.command", { defaultValue: "Command" })}
            value={display.command}
          />
        ) : null}
        {display.output ? (
          <HookOutputSection
            label={outputLabel}
            value={display.output}
            meta={
              display.outputWasInjected
                ? t("hookExecution.injectedContext", {
                    defaultValue: "Injected context",
                  })
                : ""
            }
          />
        ) : null}
        {display.error ? (
          <HookOutputSection
            label={t("hookExecution.errorOutput", {
              defaultValue: "Error / stderr",
            })}
            value={display.error}
            tone="error"
          />
        ) : null}
        {display.additionalContext ? (
          <HookOutputSection
            label={t("hookExecution.injectedContext", {
              defaultValue: "Injected context",
            })}
            value={display.additionalContext}
            tone="context"
          />
        ) : null}
        {!hasPayload ? (
          <div className="hook-exec-empty-output">
            {t("hookExecution.noOutput", {
              defaultValue: "Completed without output.",
            })}
          </div>
        ) : null}
      </div>
    </article>
  );
};

export const HookExecutionItem = ({
  record,
}: {
  record: HookExecutionRecord;
}): React.JSX.Element => {
  const { t } = useI18n();
  const shouldAutoExpand =
    Boolean(record.pendingDecision) || record.status !== "pass";
  const [expanded, setExpanded] = useState(shouldAutoExpand);

  useEffect(() => {
    if (shouldAutoExpand) setExpanded(true);
  }, [shouldAutoExpand]);

  const displayName = t(`hookTypes.${record.hookType}`, {
    defaultValue: record.hookType,
  });
  const category = getHookCategory(record.hookType);
  const hasDetails = record.results.length > 0 || Boolean(record.blockMessage);
  const actionSummary =
    record.executedActions > 0 || record.skippedActions > 0
      ? `${record.executedActions}/${
          record.executedActions + record.skippedActions
        }`
      : null;

  return (
    <details
      className={`hook-exec-item hook-exec-item--${record.status}`}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="hook-exec-item-header">
        <StatusIcon status={record.status} />
        <ToolNameBadge name={displayName} category={category} />
        <span className="hook-exec-item-sep" aria-hidden="true">
          /
        </span>
        <span className="hook-exec-item-label">
          {t(`hookExecution.status.${record.status}`, {
            defaultValue: record.status,
          })}
        </span>
        {actionSummary ? (
          <span className="hook-exec-item-actions">
            {t("hookExecution.actionsExecuted", {
              defaultValue: "{{count}} actions",
              values: { count: actionSummary },
            })}
          </span>
        ) : null}
        {hasDetails ? (
          <ChevronRight
            className={`hook-exec-item-chevron ${
              expanded ? "hook-exec-item-chevron--open" : ""
            }`}
            size={12}
            aria-hidden="true"
          />
        ) : null}
      </summary>

      {record.pendingDecision && record.decisionMessage ? (
        <div className="hook-exec-decision">
          <p className="hook-exec-decision-message">{record.decisionMessage}</p>
          <div className="hook-exec-decision-buttons">
            <button
              type="button"
              className="hook-exec-decision-btn hook-exec-decision-approve"
              onClick={() => record._resolveDecision?.(true)}
            >
              <Check size={13} aria-hidden="true" />
              {t("hookExecution.approve", { defaultValue: "Approve" })}
            </button>
            <button
              type="button"
              className="hook-exec-decision-btn hook-exec-decision-reject"
              onClick={() => record._resolveDecision?.(false)}
            >
              <X size={13} aria-hidden="true" />
              {t("hookExecution.reject", { defaultValue: "Reject" })}
            </button>
          </div>
        </div>
      ) : null}

      {hasDetails ? (
        <div className="hook-exec-item-body">
          {record.blockMessage ? (
            <div className="hook-exec-block-message" role="alert">
              <div className="hook-exec-block-message-header">
                <XCircle size={13} aria-hidden="true" />
                <span>
                  {t("hookExecution.blockReason", {
                    defaultValue: "Block reason",
                  })}
                </span>
                <HookCopyButton value={record.blockMessage} />
              </div>
              <p>{record.blockMessage}</p>
            </div>
          ) : null}
          {record.results.length > 0 ? (
            <div className="hook-exec-actions-list">
              {record.results.map((result, index) => (
                <HookActionDetails
                  key={`${result.actionType}-${index}`}
                  record={result}
                  index={index}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
};

export const HookExecutionUI = ({
  executions,
}: HookExecutionUIProps): React.JSX.Element | null => {
  const { t } = useI18n();

  // Records with no executed actions carry no useful outcome information and
  // would otherwise add empty "0/0 actions" rows to the conversation.
  const visibleExecutions = executions.filter(
    (execution) => execution.executedActions > 0 || execution.pendingDecision
  );

  if (visibleExecutions.length === 0) return null;

  const hasFailure = visibleExecutions.some(
    (execution) =>
      execution.status === "abort" || execution.status === "error"
  );
  const hasWarning = visibleExecutions.some(
    (execution) =>
      execution.status === "warn" || execution.status === "needsDecision"
  );
  const toneClass = hasFailure
    ? "hook-exec-group--has-failure"
    : hasWarning
    ? "hook-exec-group--has-warning"
    : "";

  return (
    <div className={`hook-exec-group ${toneClass}`}>
      <div className="hook-exec-group-header">
        <Webhook size={12} aria-hidden="true" />
        <span className="hook-exec-group-title">
          {t("hookExecution.title", { defaultValue: "Hooks" })}
        </span>
        <span className="hook-exec-group-count">
          {t("hookExecution.count", {
            defaultValue: "{{count}} hooks",
            values: { count: visibleExecutions.length },
          })}
        </span>
      </div>
      <div className="hook-exec-group-list">
        {visibleExecutions.map((record, index) => (
          <HookExecutionItem
            key={`${record.hookType}-${record.timestamp}-${index}`}
            record={record}
          />
        ))}
      </div>
    </div>
  );
};
