/**
 * Registry mapping in-flight tool execution ids (the UUIDs emitted by the
 * Rust `tool_execution` stream chunks) to the AbortController that cancels
 * their SSH commands. When the UI stops a conversation it calls
 * `abortToolExecution(id)`; the Electron main process consults this registry
 * so the SSH exec channel is closed in the same synchronous step, instead of
 * relying only on the Rust-side cancellation token (which cannot reach the
 * still-pending Electron promise).
 */
const sshCommandAbortControllers = new Map<string, AbortController>();

export const registerSshCommandAbort = (
  executionId: string,
  controller: AbortController
): void => {
  sshCommandAbortControllers.set(executionId, controller);
};

export const abortSshCommand = (executionId: string): void => {
  const controller = sshCommandAbortControllers.get(executionId);
  if (controller) {
    controller.abort();
    sshCommandAbortControllers.delete(executionId);
  }
};

export const unregisterSshCommandAbort = (executionId: string): void => {
  sshCommandAbortControllers.delete(executionId);
};
