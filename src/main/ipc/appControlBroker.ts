import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import type { AppControlCommand } from "../native/types";
import { safeSend } from "../utils/safeSend";

const APP_CONTROL_CHANNEL = "app-control:request";
const APP_CONTROL_RESPONSE_CHANNEL = "app-control:response";

type AppControlRequest = {
  requestId: string;
  action: string;
  payloadJson: string;
};

type AppControlResponse = {
  requestId: string;
  resultJson?: string;
  error?: string;
};

const pendingRequests = new Map<
  string,
  {
    rendererId: number;
    resolve: (resultJson: string) => void;
    reject: (error: Error) => void;
  }
>();
const watchedRendererIds = new Set<number>();

const failPendingForRenderer = (rendererId: number): void => {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.rendererId !== rendererId) {
      continue;
    }
    pending.reject(new Error("App control renderer was destroyed"));
    pendingRequests.delete(requestId);
  }
};

const watchRenderer = (renderer: WebContents): void => {
  if (watchedRendererIds.has(renderer.id)) {
    return;
  }
  const rendererId = renderer.id;
  watchedRendererIds.add(rendererId);
  renderer.once("destroyed", () => {
    watchedRendererIds.delete(rendererId);
    failPendingForRenderer(rendererId);
  });
};

export const dispatchAppControl = async (
  source: WebContents,
  command: AppControlCommand
): Promise<string> => {
  if (source.isDestroyed()) {
    throw new Error("App control renderer is not available");
  }

  watchRenderer(source);
  const requestId = `${source.id}:${randomUUID()}`;
  const request: AppControlRequest = {
    requestId,
    action: command.action,
    payloadJson: command.payloadJson,
  };

  return new Promise<string>((resolve, reject) => {
    pendingRequests.set(requestId, {
      rendererId: source.id,
      resolve,
      reject,
    });

    try {
      safeSend(source, APP_CONTROL_CHANNEL, request);
    } catch (error) {
      pendingRequests.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
};

export const resolveAppControl = (
  source: WebContents,
  response: AppControlResponse
): void => {
  if (!response.requestId.startsWith(`${source.id}:`)) {
    return;
  }

  const pending = pendingRequests.get(response.requestId);
  if (!pending || pending.rendererId !== source.id) {
    return;
  }

  pendingRequests.delete(response.requestId);
  if (response.error) {
    pending.reject(new Error(response.error));
    return;
  }
  if (typeof response.resultJson !== "string") {
    pending.reject(new Error("App control response is missing result JSON"));
    return;
  }

  pending.resolve(response.resultJson);
};

export { APP_CONTROL_CHANNEL, APP_CONTROL_RESPONSE_CHANNEL };
