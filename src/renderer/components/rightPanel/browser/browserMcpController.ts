export type BrowserMcpCommandArgs = Record<string, unknown>;

export type BrowserMcpCommandHandler = (
  operation: string,
  args: BrowserMcpCommandArgs
) => Promise<unknown>;

type InstanceWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const instances = new Map<string, BrowserMcpCommandHandler>();
const instanceWaiters = new Map<string, Set<InstanceWaiter>>();
let focusedInstanceId: string | null = null;

const parseCommandArgs = (argsJson: string): BrowserMcpCommandArgs => {
  const value = JSON.parse(argsJson) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Browser command arguments must be a JSON object");
  }
  return value as BrowserMcpCommandArgs;
};

const getFallbackInstanceId = (): string | null => {
  if (focusedInstanceId && instances.has(focusedInstanceId)) {
    return focusedInstanceId;
  }

  const registeredInstanceIds = [...instances.keys()];
  return registeredInstanceIds.at(-1) ?? null;
};

export const createBrowserInstanceId = (): string =>
  `browser-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export const focusBrowserMcpInstance = (instanceId: string): void => {
  if (instances.has(instanceId)) {
    focusedInstanceId = instanceId;
  }
};

export const registerBrowserMcpInstance = (
  instanceId: string,
  handler: BrowserMcpCommandHandler
): (() => void) => {
  instances.set(instanceId, handler);
  focusedInstanceId = instanceId;
  const waiters = instanceWaiters.get(instanceId);
  if (waiters) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    instanceWaiters.delete(instanceId);
  }

  return () => {
    if (instances.get(instanceId) === handler) {
      instances.delete(instanceId);
      if (focusedInstanceId === instanceId) {
        focusedInstanceId = getFallbackInstanceId();
      }
      // 实例在就绪前被关闭(如 create 命令等待期间用户关掉 tab):
      // 立即 reject 挂起的 waiter 并清掉其超时定时器,避免定时器
      // 悬挂到超时(多实例反复 create/close 会累积残留定时器)。
      const waiters = instanceWaiters.get(instanceId);
      if (waiters) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.reject(
            new Error(`Browser instance was closed before it became ready: ${instanceId}`)
          );
        }
        instanceWaiters.delete(instanceId);
      }
    }
  };
};

export const waitForBrowserMcpInstance = (
  instanceId: string,
  timeoutMs = 10_000
): Promise<void> => {
  if (instances.has(instanceId)) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const waiters = instanceWaiters.get(instanceId);
      waiters?.delete(waiter);
      if (waiters?.size === 0) {
        instanceWaiters.delete(instanceId);
      }
      reject(new Error(`Browser instance did not become ready: ${instanceId}`));
    }, timeoutMs);
    const waiter: InstanceWaiter = { resolve, reject, timer };
    const waiters =
      instanceWaiters.get(instanceId) ?? new Set<InstanceWaiter>();
    waiters.add(waiter);
    instanceWaiters.set(instanceId, waiters);
  });
};

export const executeBrowserMcpCommand = async (
  operation: string,
  argsJson: string
): Promise<string> => {
  const args = parseCommandArgs(argsJson);
  const requestedInstanceId =
    typeof args.instanceId === "string" ? args.instanceId.trim() : "";
  const useFocusedInstance =
    !requestedInstanceId || requestedInstanceId.toLowerCase() === "current";
  const instanceId = useFocusedInstance
    ? getFallbackInstanceId()
    : requestedInstanceId;
  if (!instanceId) {
    throw new Error(
      `No embedded browser is available for browser ${operation}; open and focus a browser tab first`
    );
  }

  const handler = instances.get(instanceId);
  if (!handler) {
    throw new Error(`Browser instance was not found: ${instanceId}`);
  }
  const result = await handler(operation, { ...args, instanceId });
  return JSON.stringify(result);
};

export const parseBrowserMcpCommandArgs = parseCommandArgs;

export const getFocusedBrowserInstanceId = (): string | null =>
  getFallbackInstanceId();

export const hasBrowserMcpInstance = (instanceId: string): boolean =>
  instances.has(instanceId);
