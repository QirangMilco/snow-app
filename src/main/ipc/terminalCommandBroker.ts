import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import type {
  TerminalCommand,
  TerminalCommandRequest,
  TerminalCommandResponse,
} from "../native/types";
import { safeSend } from "../utils/safeSend";

const TERMINAL_COMMAND_CHANNEL = "terminal:command";
const TERMINAL_COMMAND_RESPONSE_CHANNEL = "terminal:command-response";
const TERMINAL_COMMAND_TIMEOUT_MS = 125_000;

const terminalRenderers = new Map<number, WebContents>();
const pendingCommands = new Map<
  string,
  {
    resolve: (resultJson: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

const failPendingCommandsForRenderer = (rendererId: number): void => {
  for (const [commandId, pending] of pendingCommands) {
    if (!commandId.startsWith(`${rendererId}:`)) {
      continue;
    }
    clearTimeout(pending.timer);
    pending.reject(new Error("Terminal renderer was destroyed"));
    pendingCommands.delete(commandId);
  }
};

export const registerTerminalRenderer = (webContents: WebContents): void => {
  const rendererId = webContents.id;
  terminalRenderers.set(rendererId, webContents);
  webContents.once("destroyed", () => {
    terminalRenderers.delete(rendererId);
    failPendingCommandsForRenderer(rendererId);
  });
};

export const unregisterTerminalRenderer = (webContents: WebContents): void => {
  terminalRenderers.delete(webContents.id);
  failPendingCommandsForRenderer(webContents.id);
};

export const dispatchTerminalCommand = async (
  source: WebContents,
  command: TerminalCommand
): Promise<string> => {
  const renderer = terminalRenderers.get(source.id);
  if (!renderer || renderer.isDestroyed()) {
    throw new Error("Terminal renderer is not available");
  }

  const commandId = `${source.id}:${randomUUID()}`;
  const request: TerminalCommandRequest = {
    commandId,
    operation: command.operation,
    argsJson: command.argsJson,
  };

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(commandId);
      reject(new Error(`Terminal command timed out: ${command.operation}`));
    }, TERMINAL_COMMAND_TIMEOUT_MS);

    pendingCommands.set(commandId, { resolve, reject, timer });
    safeSend(renderer, TERMINAL_COMMAND_CHANNEL, request);
  });
};

export const resolveTerminalCommand = (
  source: WebContents,
  response: TerminalCommandResponse
): void => {
  const expectedPrefix = `${source.id}:`;
  if (!response.commandId.startsWith(expectedPrefix)) {
    return;
  }

  const pending = pendingCommands.get(response.commandId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timer);
  pendingCommands.delete(response.commandId);
  if (response.error) {
    pending.reject(new Error(response.error));
    return;
  }
  if (typeof response.resultJson !== "string") {
    pending.reject(
      new Error("Terminal command response is missing result JSON")
    );
    return;
  }
  pending.resolve(response.resultJson);
};

export {
  TERMINAL_COMMAND_CHANNEL,
  TERMINAL_COMMAND_RESPONSE_CHANNEL,
};
