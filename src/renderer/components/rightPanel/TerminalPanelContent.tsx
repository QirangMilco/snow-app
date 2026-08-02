import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { useTerminalSettings } from "./useTerminalSettings";

export type TerminalPanelContentProps = {
  cwd: string;
  isActive: boolean;
  onTitleChange?: (title: string) => void;
};

const darkTerminalTheme: ITheme = {
  background: "#0E0E0E",
  foreground: "#e0e0e0",
  cursor: "#e0e0e0",
  selectionBackground: "rgba(255, 255, 255, 0.18)",
};

const lightTerminalTheme: ITheme = {
  background: "#FBFCFD",
  foreground: "#333333",
  cursor: "#333333",
  selectionBackground: "rgba(0, 0, 0, 0.12)",
};

const getTerminalTheme = (): ITheme => {
  if (
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "dark"
  ) {
    return darkTerminalTheme;
  }
  return lightTerminalTheme;
};

const DEFAULT_FONT_FAMILY =
  "'SF Mono', 'Menlo', 'Consolas', 'Liberation Mono', monospace";

export const TerminalPanelContent = ({
  cwd,
  isActive,
  onTitleChange,
}: TerminalPanelContentProps): React.JSX.Element => {
  const settings = useTerminalSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Only shellPath triggers PTY recreation; font settings update live.
  const { shellPath } = settings;

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let disposeOutput: (() => void) | null = null;
    let disposeExit: (() => void) | null = null;
    let exited = false;

    const fontFamily = settings.fontFamily.trim() || DEFAULT_FONT_FAMILY;

    const term = new Terminal({
      fontFamily,
      fontSize: settings.fontSize,
      fontWeight: settings.fontWeight as "normal" | "bold" | number,
      lineHeight: settings.lineHeight,
      cursorBlink: true,
      theme: getTerminalTheme(),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    // Synchronously fit so PTY is created with correct cols/rows.
    // Without this, initPty() reads default 80x24 dimensions, the PTY
    // starts with wrong size, and the subsequent resize causes zsh to
    // emit PROMPT_EOL_MARK (%) at the end of the prompt line.
    try {
      fit.fit();
    } catch {
      // ignore
    }

    if (disposed) {
      term.dispose();
      return;
    }

    termRef.current = term;
    fitRef.current = fit;

    resizeObserver = new ResizeObserver(() => {
      if (!disposed) {
        try {
          fit.fit();
        } catch {
          // ignore
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    const themeObserver = new MutationObserver(() => {
      if (!disposed) {
        term.options.theme = getTerminalTheme();
      }
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    const initPty = async () => {
      try {
        const cols = term.cols > 0 ? term.cols : 80;
        const rows = term.rows > 0 ? term.rows : 24;
        const id = await window.snow.ptyCreate({
          cwd,
          cols,
          rows,
          shellPath: shellPath || undefined,
        });
        if (disposed) {
          void window.snow.ptyKill(id);
          return;
        }
        ptyIdRef.current = id;

        disposeOutput = window.snow.onPtyOutput((payload) => {
          if (payload.id === id && !disposed) {
            term.write(payload.data);
          }
        });

        disposeExit = window.snow.onPtyExit((payload) => {
          if (payload.id === id && !disposed) {
            exited = true;
            term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
            disposeOutput?.();
            disposeExit?.();
          }
        });

        term.onData((data) => {
          if (!exited && ptyIdRef.current) {
            void window.snow.ptyWrite(id, data);
          }
        });

        term.onResize(({ cols, rows }) => {
          if (!exited && ptyIdRef.current) {
            void window.snow.ptyResize(id, cols, rows);
          }
        });

        term.onTitleChange((title) => {
          if (!disposed && onTitleChange) {
            onTitleChange(title);
          }
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Failed to initialize PTY:", err);
      }
    };

    void initPty();

    cleanupRef.current = () => {
      disposed = true;
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      disposeOutput?.();
      disposeExit?.();
      if (ptyIdRef.current) {
        void window.snow.ptyKill(ptyIdRef.current);
        ptyIdRef.current = null;
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, shellPath]);

  // Live-update font settings without recreating the terminal / PTY.
  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    term.options.fontFamily = settings.fontFamily.trim() || DEFAULT_FONT_FAMILY;
    term.options.fontSize = settings.fontSize;
    term.options.fontWeight = settings.fontWeight as "normal" | "bold" | number;
    term.options.lineHeight = settings.lineHeight;
    try {
      fitRef.current?.fit();
    } catch {
      // ignore
    }
  }, [
    settings.fontFamily,
    settings.fontSize,
    settings.fontWeight,
    settings.lineHeight,
  ]);

  useEffect(() => {
    if (!isActive || !termRef.current || !fitRef.current) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        termRef.current?.focus();
      } catch {
        // ignore
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive]);

  // 右键粘贴：阻止默认菜单，将剪贴板文本通过 xterm 的 paste 送入 PTY。
  // term.paste 会正确触发 onData（含 bracketed paste 处理），无需直接写 pty。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const handleContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      const term = termRef.current;
      if (!term) {
        return;
      }
      term.focus();
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) {
            term.paste(text);
          }
        })
        .catch(() => {
          // 剪贴板读取失败时静默忽略（如无权限或无可读文本）。
        });
    };
    container.addEventListener("contextmenu", handleContextMenu);
    return () => container.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  return (
    <div className="terminal-panel">
      <div
        ref={containerRef}
        className="terminal-container"
        style={{
          width: "100%",
          height: "100%",
          minHeight: "200px",
        }}
      />
    </div>
  );
};
