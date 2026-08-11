import { useMemo, type ReactNode } from "react";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  FileCode2,
  FolderPlus,
  Settings,
  StickyNote,
  ToggleRight,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type AppControlToolCallProps = {
  toolCall: ToolCallInfo;
};

type ParsedResult =
  | { type: "success"; data: Record<string, unknown> }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const parseArgs = (args: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const parseResult = (result: string | undefined): ParsedResult => {
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
    return { type: "success", data: parsed };
  } catch {
    return { type: "raw", text: result };
  }
};

const truncate = (value: string, max = 56): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

/** 定时任务的 schedule 摘要文案。 */
const formatSchedule = (
  schedule: Record<string, unknown> | null | undefined,
  t: (
    key: string,
    options?: { values?: Record<string, string | number> }
  ) => string
): string => {
  if (!isRecord(schedule)) {
    return "";
  }
  const type = asString(schedule.type) ?? "once";
  if (type === "once") {
    const executeAt = asString(schedule.executeAt);
    return executeAt
      ? t("toolCall.appControl.schedule.once", { values: { time: executeAt } })
      : type;
  }
  const mode = asString(schedule.mode) ?? "interval";
  if (mode === "daily") {
    const hour = typeof schedule.hour === "number" ? schedule.hour : 0;
    const minute = typeof schedule.minute === "number" ? schedule.minute : 0;
    return t("toolCall.appControl.schedule.daily", {
      values: {
        hour: String(hour).padStart(2, "0"),
        minute: String(minute).padStart(2, "0"),
      },
    });
  }
  const intervalMs = typeof schedule.intervalMs === "number" ? schedule.intervalMs : 0;
  return t("toolCall.appControl.schedule.interval", {
    values: { interval: formatInterval(intervalMs) },
  });
};

const formatInterval = (intervalMs: number): string => {
  if (intervalMs >= 60 * 60 * 1000) {
    const hours = intervalMs / (60 * 60 * 1000);
    return `${hours}h`;
  }
  if (intervalMs >= 60 * 1000) {
    const minutes = Math.round(intervalMs / (60 * 1000));
    return `${minutes}min`;
  }
  return `${intervalMs}ms`;
};

export const AppControlToolCall = ({
  toolCall,
}: AppControlToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const operation = toolCall.name.startsWith("app-control-")
    ? toolCall.name.slice("app-control-".length)
    : toolCall.name;

  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments]
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result]
  );

  const effectiveStatus =
    parsedResult.type === "error" ? "error" : toolCall.status;

  /* 折叠态头部摘要。 */
  let displayName: string | undefined;
  let meta: ReactNode = null;

  switch (operation) {
    case "createMemo": {
      const content = asString(parsedArgs?.content);
      displayName = content ? truncate(content) : undefined;
      meta = parsedResult.type === "success" ? (
        <span className="tool-call-app-meta tool-call-app-meta-ok">
          <CheckCircle2 size={10} aria-hidden="true" />
          {t("toolCall.appControl.created")}
        </span>
      ) : null;
      break;
    }
    case "setMode": {
      const mode = asString(parsedArgs?.mode);
      const enabled = parsedArgs?.enabled === true;
      displayName = mode
        ? enabled
          ? t("toolCall.appControl.modeEnabled", { values: { mode } })
          : t("toolCall.appControl.modeDisabled", { values: { mode } })
        : undefined;
      meta = parsedResult.type === "success" ? (
        <span className="tool-call-app-meta tool-call-app-meta-ok">
          <CheckCircle2 size={10} aria-hidden="true" />
          {t("toolCall.appControl.applied")}
        </span>
      ) : null;
      break;
    }
    case "openSettings": {
      const page = asString(parsedArgs?.page);
      displayName = page;
      meta = parsedResult.type === "success" ? (
        <span className="tool-call-app-meta tool-call-app-meta-ok">
          <CheckCircle2 size={10} aria-hidden="true" />
          {t("toolCall.appControl.opened")}
        </span>
      ) : null;
      break;
    }
    case "createScheduledTask": {
      const name = asString(parsedArgs?.name);
      displayName = name ? truncate(name) : undefined;
      const scheduleText = formatSchedule(
        isRecord(parsedArgs?.schedule) ? parsedArgs.schedule : null,
        t
      );
      meta = scheduleText ? (
        <span className="tool-call-app-meta">
          <CalendarClock size={10} aria-hidden="true" />
          {scheduleText}
        </span>
      ) : null;
      break;
    }
    case "createProject": {
      const name = asString(parsedArgs?.name);
      displayName = name ? truncate(name) : undefined;
      meta = parsedResult.type === "success" ? (
        <span className="tool-call-app-meta tool-call-app-meta-ok">
          <CheckCircle2 size={10} aria-hidden="true" />
          {t("toolCall.appControl.created")}
        </span>
      ) : null;
      break;
    }
    case "listMemos": {
      const count =
        parsedResult.type === "success"
          ? parsedResult.data.total
          : undefined;
      const countNumber = typeof count === "number" ? count : 0;
      displayName = t("toolCall.appControl.memoListed", {
        values: { count: countNumber },
      });
      meta = parsedResult.type === "success" ? (
        <span className="tool-call-app-meta tool-call-app-meta-ok">
          <CheckCircle2 size={10} aria-hidden="true" />
          {t("toolCall.appControl.memoListed", {
            values: { count: countNumber },
          })}
        </span>
      ) : null;
      break;
    }
    case "getMemo": {
      const memoId = asString(parsedArgs?.memoId);
      displayName = memoId ? truncate(memoId) : undefined;
      meta = parsedResult.type === "success" ? (
        <span className="tool-call-app-meta tool-call-app-meta-ok">
          <CheckCircle2 size={10} aria-hidden="true" />
          {t("toolCall.appControl.memoRead")}
        </span>
      ) : null;
      break;
    }
    case "updateMemoStatus": {
      const memoId = asString(parsedArgs?.memoId);
      const status = asString(parsedArgs?.status);
      displayName = memoId ? truncate(memoId) : undefined;
      meta = parsedResult.type === "success" ? (
        <span className="tool-call-app-meta tool-call-app-meta-ok">
          <CheckCircle2 size={10} aria-hidden="true" />
          {t("toolCall.appControl.memoStatusUpdated", {
            values: {
              status:
                status === "done"
                  ? t("toolCall.appControl.memoStatusDone")
                  : t("toolCall.appControl.memoStatusPending"),
            },
          })}
        </span>
      ) : null;
      break;
    }
  }

  const resultText =
    parsedResult.type === "success"
      ? JSON.stringify(parsedResult.data, null, 2)
      : parsedResult.type === "raw"
      ? parsedResult.text
      : "";

  /* 展开后 body：操作专属信息行 + 结果 JSON。 */
  const renderDetail = (): ReactNode => {
    switch (operation) {
      case "createMemo": {
        const content = asString(parsedArgs?.content);
        return content ? (
          <div className="tool-call-app-detail">
            <StickyNote size={12} aria-hidden="true" />
            <span>{truncate(content, 240)}</span>
          </div>
        ) : null;
      }
      case "setMode": {
        const mode = asString(parsedArgs?.mode);
        const enabled = parsedArgs?.enabled === true;
        return mode ? (
          <div className="tool-call-app-detail">
            <ToggleRight size={12} aria-hidden="true" />
            <span>
              {enabled
                ? t("toolCall.appControl.modeEnabled", { values: { mode } })
                : t("toolCall.appControl.modeDisabled", { values: { mode } })}
            </span>
          </div>
        ) : null;
      }
      case "openSettings": {
        const page = asString(parsedArgs?.page);
        return page ? (
          <div className="tool-call-app-detail">
            <Settings size={12} aria-hidden="true" />
            <code>{page}</code>
          </div>
        ) : null;
      }
      case "createScheduledTask": {
        const name = asString(parsedArgs?.name);
        const scheduleText = formatSchedule(
          isRecord(parsedArgs?.schedule) ? parsedArgs.schedule : null,
          t
        );
        const preScript = asString(parsedArgs?.preScript);
        return (
          <div className="tool-call-app-detail tool-call-app-detail-col">
            {name ? (
              <div className="tool-call-app-detail">
                <CalendarClock size={12} aria-hidden="true" />
                <span>{name}</span>
              </div>
            ) : null}
            {scheduleText ? (
              <div className="tool-call-app-detail">
                <span className="tool-call-app-detail-label">
                  {t("toolCall.appControl.scheduleLabel")}
                </span>
                <span>{scheduleText}</span>
              </div>
            ) : null}
            {preScript ? (
              <div className="tool-call-app-detail">
                <FileCode2 size={12} aria-hidden="true" />
                <span>{truncate(preScript, 120)}</span>
              </div>
            ) : null}
          </div>
        );
      }
      case "createProject": {
        const name = asString(parsedArgs?.name);
        const parentPath = asString(parsedArgs?.parentPath);
        const resultPath = asString(parsedResult.type === "success" ? parsedResult.data.path : undefined);
        const path = resultPath ?? parentPath;
        return (
          <div className="tool-call-app-detail tool-call-app-detail-col">
            {name ? (
              <div className="tool-call-app-detail">
                <FolderPlus size={12} aria-hidden="true" />
                <span>{name}</span>
              </div>
            ) : null}
            {path ? (
              <div className="tool-call-app-detail">
                <span className="tool-call-app-detail-label">
                  {t("toolCall.appControl.projectPath")}
                </span>
                <code>{path}</code>
              </div>
            ) : null}
          </div>
        );
      }
      case "listMemos": {
        const status = asString(parsedArgs?.status);
        return status ? (
          <div className="tool-call-app-detail">
            <StickyNote size={12} aria-hidden="true" />
            <code>{status}</code>
          </div>
        ) : null;
      }
      case "getMemo": {
        const memoId = asString(parsedArgs?.memoId);
        return memoId ? (
          <div className="tool-call-app-detail">
            <StickyNote size={12} aria-hidden="true" />
            <code>{memoId}</code>
          </div>
        ) : null;
      }
      case "updateMemoStatus": {
        const memoId = asString(parsedArgs?.memoId);
        const status = asString(parsedArgs?.status);
        return (
          <div className="tool-call-app-detail">
            <StickyNote size={12} aria-hidden="true" />
            <code>{memoId ?? ""}</code>
            {status ? <span>→ {status}</span> : null}
          </div>
        );
      }
      default:
        return null;
    }
  };

  return (
    <ToolCallNode
      toolName={toolCall.name}
      displayName={displayName}
      displayNameTitle={toolCall.arguments}
      status={effectiveStatus}
      meta={meta}
      className="tool-call-app"
    >
      <div className="tool-call-body tool-call-app-body">
        {renderDetail()}

        {parsedResult.type === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
          </div>
        ) : null}

        {resultText ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.common.result")}
            </span>
            <pre className="tool-call-section-pre">{resultText}</pre>
          </section>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
