import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";

type AutoDismissNoticeTone = "success" | "error" | "info" | "warning";

type AutoDismissNoticeProps = {
  message: string;
  tone?: AutoDismissNoticeTone;
  durationMs?: number;
  onDismiss?: () => void;
};

const noticeIcons: Record<AutoDismissNoticeTone, ReactNode> = {
  success: <CheckCircle2 size={15} strokeWidth={2} />,
  error: <AlertCircle size={15} strokeWidth={2} />,
  info: <Info size={15} strokeWidth={2} />,
  warning: <AlertTriangle size={15} strokeWidth={2} />,
};

export function AutoDismissNotice({
  message,
  tone = "info",
  durationMs = 2000,
  onDismiss,
}: AutoDismissNoticeProps): React.JSX.Element | null {
  useEffect(() => {
    if (!message || !onDismiss) {
      return;
    }

    const timeoutId = window.setTimeout(onDismiss, durationMs);

    return () => window.clearTimeout(timeoutId);
  }, [durationMs, message, onDismiss]);

  if (!message) {
    return null;
  }

  return createPortal(
    <div
      className={`auto-dismiss-notice ${tone}`}
      role="status"
      aria-live="polite"
    >
      <span className="auto-dismiss-notice-icon">{noticeIcons[tone]}</span>
      <span className="auto-dismiss-notice-message">{message}</span>
    </div>,
    document.body
  );
}
