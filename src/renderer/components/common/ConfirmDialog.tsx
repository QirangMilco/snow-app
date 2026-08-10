import { useEffect, useRef, type ReactNode } from "react";
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
  className?: string;
  children?: ReactNode;
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
  className,
  children,
}: ConfirmDialogProps): React.JSX.Element => {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    dialogRef.current?.focus();
  }, [open]);

  return createPortal(
    open && (
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
          className={`confirm-dialog confirm-dialog-${variant}${className ? ` ${className}` : ""}`}
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
              {message ? <p>{message}</p> : null}
              {children}
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
        </div>
    ),
    document.body
  );
};
