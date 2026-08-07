import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import type {
  BrowserCommand,
  BrowserCommandRequest,
  BrowserCommandResponse,
} from "../native/types";
import { safeSend } from "../utils/safeSend";

const BROWSER_COMMAND_CHANNEL = "browser:command";
const BROWSER_COMMAND_RESPONSE_CHANNEL = "browser:command-response";
const BROWSER_COMMAND_TIMEOUT_MS = 125_000;

const browserRenderers = new Map<number, WebContents>();
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
    pending.reject(new Error("Browser renderer was destroyed"));
    pendingCommands.delete(commandId);
  }
};

export const registerBrowserRenderer = (webContents: WebContents): void => {
  const rendererId = webContents.id;
  browserRenderers.set(rendererId, webContents);
  webContents.once("destroyed", () => {
    browserRenderers.delete(rendererId);
    failPendingCommandsForRenderer(rendererId);
  });
};

export const unregisterBrowserRenderer = (webContents: WebContents): void => {
  browserRenderers.delete(webContents.id);
  failPendingCommandsForRenderer(webContents.id);
};

export const dispatchBrowserCommand = async (
  source: WebContents,
  command: BrowserCommand
): Promise<string> => {
  const renderer = browserRenderers.get(source.id);
  if (!renderer || renderer.isDestroyed()) {
    throw new Error("Browser renderer is not available");
  }

  const commandId = `${source.id}:${randomUUID()}`;
  const request: BrowserCommandRequest = {
    commandId,
    operation: command.operation,
    argsJson: command.argsJson,
  };

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(commandId);
      reject(new Error(`Browser command timed out: ${command.operation}`));
    }, BROWSER_COMMAND_TIMEOUT_MS);

    pendingCommands.set(commandId, { resolve, reject, timer });
    safeSend(renderer, BROWSER_COMMAND_CHANNEL, request);
  });
};

export const resolveBrowserCommand = (
  source: WebContents,
  response: BrowserCommandResponse
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
      new Error("Browser command response is missing result JSON")
    );
    return;
  }
  pending.resolve(response.resultJson);
};

export { BROWSER_COMMAND_CHANNEL, BROWSER_COMMAND_RESPONSE_CHANNEL };
