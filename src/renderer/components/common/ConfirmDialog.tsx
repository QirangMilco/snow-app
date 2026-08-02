import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  /** When omitted, the cancel button is hidden (single-button alert mode). */
  cancelLabel?: string;
  /** Optional third button (e.g. "minimize to tray" in the close reminder). */
  extraLabel?: string;
  onExtra?: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: "default" | "warning" | "danger";
};

export const ConfirmDialog = ({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  extraLabel,
  onExtra,
  onConfirm,
  onCancel,
  variant = "default",
}: ConfirmDialogProps): React.JSX.Element | null => {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    dialogRef.current?.focus();
  }, [open]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className="confirm-dialog-overlay"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
        if (e.key === "Enter" && e.target === dialogRef.current) {
          e.preventDefault();
          onConfirm();
        }
      }}
    >
      <div
        className={`confirm-dialog confirm-dialog-${variant}`}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="confirm-dialog-header">
          <div className="confirm-dialog-title">
            <AlertTriangle size={16} />
            <span>{title}</span>
          </div>
        </div>
        <div className="confirm-dialog-body">
          <p>{message}</p>
        </div>
        <div className="confirm-dialog-actions">
          {cancelLabel && (
            <button
              type="button"
              className="confirm-dialog-btn cancel"
              onClick={onCancel}
            >
              {cancelLabel}
            </button>
          )}
          {extraLabel && onExtra && (
            <button
              type="button"
              className="confirm-dialog-btn cancel"
              onClick={onExtra}
            >
              {extraLabel}
            </button>
          )}
          <button
            type="button"
            className="confirm-dialog-btn confirm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
