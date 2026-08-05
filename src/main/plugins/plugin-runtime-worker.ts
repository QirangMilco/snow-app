import { pathToFileURL } from "node:url";

type StartMessage = {
  type: "start";
  pluginId: string;
  entryPath: string;
  storagePath: string;
  permissions: string[];
};

type StopMessage = {
  type: "stop";
};

type RuntimeModule = {
  activate?: (context: PluginRuntimeContext) => unknown;
  default?: unknown;
};

type PluginRuntimeContext = Readonly<{
  pluginId: string;
  storagePath: string;
  permissions: readonly string[];
  log: (message: string) => void;
}>;

let deactivate: (() => unknown) | undefined;

const send = (message: Record<string, unknown>): void => {
  process.parentPort?.postMessage(message);
};

const messageFrom = (error: unknown): string =>
  error instanceof Error ? error.stack || error.message : String(error);

const activate = async (message: StartMessage): Promise<void> => {
  try {
    const loaded = await import(pathToFileURL(message.entryPath).href) as RuntimeModule;
    const handler = typeof loaded.activate === "function"
      ? loaded.activate
      : typeof loaded.default === "function"
        ? loaded.default as (context: PluginRuntimeContext) => unknown
        : undefined;
    if (!handler) {
      throw new Error("Plugin runtime entry must export activate(context) or a default function");
    }
    const cleanup = await handler(Object.freeze({
      pluginId: message.pluginId,
      storagePath: message.storagePath,
      permissions: Object.freeze([...message.permissions]),
      log: (value: string) => send({ type: "log", message: String(value).slice(0, 500) }),
    }));
    if (typeof cleanup === "function") deactivate = cleanup as () => unknown;
    send({ type: "ready" });
  } catch (error) {
    send({ type: "failed", message: messageFrom(error) });
  }
};

const stop = async (): Promise<void> => {
  try {
    await deactivate?.();
  } catch (error) {
    send({ type: "log", message: `Plugin runtime cleanup failed: ${messageFrom(error)}` });
  }
  process.exit(0);
};

process.parentPort?.on("message", (messageEvent: Electron.MessageEvent) => {
  const message = messageEvent.data as StartMessage | StopMessage;
  if (message?.type === "start") void activate(message);
  if (message?.type === "stop") void stop();
});
