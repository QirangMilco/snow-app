import {
  HelpCircle,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";

type BtwPanelProps = {
  /** 当前会话 ID。为空时退化为不加载上下文的纯问答。 */
  conversationId?: string;
  /** 把问题发送到主对话（转为主消息）。 */
  onSendToChat?: (message: string) => void;
};

type BtwStatus = "idle" | "streaming" | "error";

type BtwEntry = {
  question: string;
  answer: string;
};

/**
 * BTW 旁路问答：
 * - 基于当前会话上下文（历史 + 全局/项目规则）快速问答
 * - 不写入会话历史（skipPersist；失败的请求同样不落库）
 * - 不带工具（subAgentToolsJson: "[]"）
 * - 不打断主任务流，关闭即取消
 * - 浮层内支持连续追问：后续请求会携带本浮层内的问答历史
 * 注意：请求的 token 用量仍会计入 usage 统计（与普通消息一致）。
 */
export function BtwPanel({
  conversationId,
  onSendToChat,
}: BtwPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState<BtwStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  // 浮层内已完成的问答历史（用于连续追问）。
  const [entries, setEntries] = useState<BtwEntry[]>([]);
  const streamIdRef = useRef<string | null>(null);
  // 用户主动停止的标记：停止轮次不得进入追问历史（避免把半截回答
  // 当作完整回答带到下一轮请求）。
  const stoppedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const abortStream = useCallback((): void => {
    if (streamIdRef.current) {
      void window.snow.abortResponseStream(streamIdRef.current);
      streamIdRef.current = null;
    }
  }, []);

  const open = useCallback((): void => {
    setQuestion("");
    setAnswer("");
    setStatus("idle");
    setErrorMessage("");
    setEntries([]);
    setIsOpen(true);
  }, []);

  const close = useCallback((): void => {
    abortStream();
    setIsOpen(false);
  }, [abortStream]);

  // 快捷键 Cmd/Ctrl+Shift+B 开关
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "b"
      ) {
        event.preventDefault();
        if (isOpen) {
          close();
        } else {
          open();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, open, close]);

  // 打开时聚焦输入框
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Esc 关闭 + 点击外部关闭
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };
    const onPointerDown = (event: MouseEvent): void => {
      if (
        popupRef.current &&
        !popupRef.current.contains(event.target as Node)
      ) {
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [isOpen, close]);

  // 卸载时取消进行中的请求
  useEffect(() => () => abortStream(), [abortStream]);

  const submit = async (): Promise<void> => {
    const trimmed = question.trim();
    if (!trimmed || status === "streaming") {
      return;
    }

    setAnswer("");
    setErrorMessage("");
    setStatus("streaming");
    streamIdRef.current = null;
    stoppedRef.current = false;

    // 连续追问：携带本浮层内已完成的问答历史。
    const threadMessages = entries.flatMap((entry) => [
      { role: "user" as const, content: entry.question },
      { role: "assistant" as const, content: entry.answer },
    ]);

    try {
      const result = await window.snow.createResponseStream(
        {
          messages: [
            ...threadMessages,
            { role: "user" as const, content: trimmed },
          ],
          conversationId: conversationId || undefined,
          // 有会话：加载历史（skipContext 不设置）；无会话：纯问答。
          skipContext: conversationId ? undefined : true,
          // 旁路问答不落库（配合 Rust 侧 skip_persist）。
          skipPersist: true,
          // 空工具白名单：禁止 btw 调用任何工具。
          subAgentToolsJson: "[]",
        },
        (chunk) => {
          if (chunk.contentDelta) {
            setAnswer((previous) => previous + chunk.contentDelta);
          }
        },
        (streamId) => {
          streamIdRef.current = streamId;
        }
      );
      // native 错误路径返回 Ok(status="error")（而非 reject）：错误文本
      // 不得作为回答进入追问历史。
      if (result.status === "error") {
        setErrorMessage(result.content || errorMessage);
        setStatus("error");
        return;
      }
      if (result.content) {
        setAnswer(result.content);
      }
      // 用户主动停止的轮次不进入追问历史（避免半截回答带到下一轮）。
      if (!stoppedRef.current) {
        setEntries((previous) => [
          ...previous,
          { question: trimmed, answer: result.content || answer },
        ]);
        // 回答已存入 entries：清空当前轮与输入框，便于继续追问。
        setAnswer("");
        setQuestion("");
      }
      setStatus("idle");
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : t("btw.error", { defaultValue: "Failed to get an answer." })
      );
      setStatus("error");
    } finally {
      streamIdRef.current = null;
    }
  };

  const handleStop = (): void => {
    stoppedRef.current = true;
    abortStream();
    setStatus("idle");
  };

  const handleSendToChat = (): void => {
    // 转主消息：发送最后一轮的问题（让主任务基于该意图继续执行）。
    const lastQuestion = entries[entries.length - 1]?.question;
    const trimmed = (lastQuestion ?? question).trim();
    if (!trimmed) {
      return;
    }
    onSendToChat?.(trimmed);
    close();
  };

  return (
    <div className="btw-anchor">
      <button
        className={`toolbar-btn btw-trigger${isOpen ? " is-active" : ""}`}
        type="button"
        aria-label={t("btw.trigger", { defaultValue: "Ask by the way" })}
        title={t("btw.trigger", { defaultValue: "Ask by the way" })}
        onClick={() => (isOpen ? close() : open())}
      >
        <HelpCircle size={15} />
      </button>

      {isOpen ? (
        <div className="btw-popup" ref={popupRef}>
          <div className="btw-popup-header">
            <strong>
              {t("btw.title", { defaultValue: "By the way" })}
            </strong>
            <span>
              {t("btw.hint", {
                defaultValue:
                  "Based only on this conversation. Not saved and without tools.",
              })}
            </span>
          </div>

          <input
            ref={inputRef}
            className="btw-input"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={t("btw.placeholder", {
              defaultValue: "Ask a quick question based on this conversation…",
            })}
            disabled={status === "streaming"}
          />

          {status === "error" ? (
            <div className="btw-error" role="alert">
              {errorMessage}
            </div>
          ) : null}

          {entries.length > 0 ? (
            <div className="btw-thread">
              {entries.map((entry, index) => (
                <div className="btw-entry" key={index}>
                  <div className="btw-entry-q">{entry.question}</div>
                  <div className="btw-entry-a">{entry.answer}</div>
                </div>
              ))}
            </div>
          ) : null}

          {answer ? (
            <div className="btw-answer">{answer}</div>
          ) : status === "streaming" ? (
            <div className="btw-waiting">
              <Loader2 className="spin" size={14} />
              <span>
                {t("btw.thinking", { defaultValue: "Thinking…" })}
              </span>
            </div>
          ) : null}

          <div className="btw-actions">
            {status === "streaming" ? (
              <button
                className="api-settings-action-btn secondary"
                onClick={handleStop}
                type="button"
              >
                <Square size={14} />
                <span>{t("btw.stop", { defaultValue: "Stop" })}</span>
              </button>
            ) : null}
            {status === "error" ? (
              <button
                className="api-settings-action-btn secondary"
                onClick={() => void submit()}
                type="button"
              >
                <RefreshCw size={14} />
                <span>{t("btw.retry", { defaultValue: "Retry" })}</span>
              </button>
            ) : null}
            {entries.length > 0 && status === "idle" ? (
              <button
                className="api-settings-action-btn secondary"
                onClick={handleSendToChat}
                type="button"
              >
                <MessageSquarePlus size={14} />
                <span>
                  {t("btw.sendToChat", {
                    defaultValue: "Send to conversation",
                  })}
                </span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
