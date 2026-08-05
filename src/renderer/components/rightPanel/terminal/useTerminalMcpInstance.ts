import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import {
  focusTerminalTab,
  registerTerminalMcpInstance,
} from "./terminalMcpController";

/**
 * Register a terminal tab's xterm.js instance with the terminal MCP
 * controller so that MCP commands (send, read, resize, wait) can reach it.
 *
 * The handler performs PTY-level operations using the PTY id and the
 * xterm.js Terminal instance:
 *
 * - send: writes input to the PTY via the IPC bridge
 * - read: serializes the xterm buffer (visible screen) to plain text
 * - resize: resizes both the xterm display and the PTY process
 * - wait: polls for output quiescence and returns text produced during wait
 */
export const useTerminalMcpInstance = (
  tabId: string,
  cwd: string,
  isActive: boolean,
  termRef: React.RefObject<Terminal | null>,
  ptyIdRef: React.RefObject<string | null>
): void => {
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  useEffect(() => {
    const unregister = registerTerminalMcpInstance(
      tabId,
      async (operation, args) => {
        const term = termRef.current;
        const ptyId = ptyIdRef.current;

        switch (operation) {
          case "send": {
            if (!ptyId) {
              throw new Error("Terminal PTY is not ready yet");
            }
            const input =
              typeof args.input === "string" ? args.input : "";
            await window.snow.ptyWrite(ptyId, input);
            return { sent: true, length: input.length };
          }

          case "read": {
            if (!term) {
              throw new Error("Terminal display is not ready yet");
            }
            const waitMs =
              typeof args.waitMs === "number" && args.waitMs > 0
                ? Math.min(args.waitMs, 60000)
                : 0;
            if (waitMs > 0) {
              await new Promise<void>((resolve) =>
                setTimeout(resolve, waitMs)
              );
            }
            const text = serializeTerminalBuffer(term);
            return { text, read: true };
          }

          case "resize": {
            if (!term) {
              throw new Error("Terminal display is not ready yet");
            }
            const cols =
              typeof args.cols === "number" ? Math.max(1, Math.floor(args.cols)) : 80;
            const rows =
              typeof args.rows === "number" ? Math.max(1, Math.floor(args.rows)) : 24;
            try {
              term.resize(cols, rows);
            } catch {
              // xterm may throw if dimensions are the same
            }
            if (ptyId) {
              await window.snow.ptyResize(ptyId, cols, rows);
            }
            return { cols, rows, resized: true };
          }

          case "wait": {
            if (!term) {
              throw new Error("Terminal display is not ready yet");
            }
            const timeoutMs =
              typeof args.timeoutMs === "number"
                ? Math.max(args.timeoutMs, 1000)
                : 10000;
            const idleMs =
              typeof args.idleMs === "number"
                ? Math.min(Math.max(args.idleMs, 100), 5000)
                : 500;

            const beforeText = serializeTerminalBuffer(term);
            const result = await waitForTerminalIdle(term, timeoutMs, idleMs);
            const afterText = serializeTerminalBuffer(term);
            return {
              idle: result.idle,
              elapsedMs: result.elapsedMs,
              beforeText,
              afterText,
            };
          }

          default:
            throw new Error(`Unknown terminal operation: ${operation}`);
        }
      },
      { title: cwd || "Terminal", cwd: cwd || "" }
    );

    return () => {
      unregister();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // Update focused tab when this tab becomes active.
  useEffect(() => {
    if (isActive) {
      focusTerminalTab(tabId);
    }
  }, [isActive, tabId]);
};

/**
 * Serialize the visible xterm.js buffer to plain text.
 *
 * Reads each line from the terminal buffer, trims trailing whitespace,
 * and joins with newlines. ANSI escape codes are not present in the
 * buffer API output (they are processed during rendering), so the
 * result is clean text.
 */
const serializeTerminalBuffer = (term: Terminal): string => {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  const length = buffer.length;
  for (let i = 0; i < length; i++) {
    const line = buffer.getLine(i);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }
  // Trim trailing empty lines.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
};

/**
 * Wait for the terminal to become idle (no new output for idleMs).
 *
 * Polls the buffer cursor position periodically. When the cursor
 * hasn't moved for idleMs, the terminal is considered idle. Returns
 * when either idle is detected or timeoutMs elapses.
 */
const waitForTerminalIdle = (
  term: Terminal,
  timeoutMs: number,
  idleMs: number
): Promise<{ idle: boolean; elapsedMs: number }> => {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let lastCursorX = term.buffer.active.cursorX;
    let lastCursorY = term.buffer.active.cursorY;
    let lastChangeTime = Date.now();
    const pollInterval = Math.min(idleMs / 2, 200);

    const check = () => {
      const now = Date.now();
      const elapsed = now - startTime;

      const currentX = term.buffer.active.cursorX;
      const currentY = term.buffer.active.cursorY;
      if (currentX !== lastCursorX || currentY !== lastCursorY) {
        lastCursorX = currentX;
        lastCursorY = currentY;
        lastChangeTime = now;
      }

      if (now - lastChangeTime >= idleMs) {
        resolve({ idle: true, elapsedMs: elapsed });
        return;
      }

      if (elapsed >= timeoutMs) {
        resolve({ idle: false, elapsedMs: elapsed });
        return;
      }

      setTimeout(check, pollInterval);
    };

    setTimeout(check, pollInterval);
  });
};
