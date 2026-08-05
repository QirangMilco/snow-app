import { useCallback, useEffect, useRef, useState } from "react";

import { useChatConversationContext } from "../components/mainContent/chatMessages";
import {
  scheduledTasksStore,
  validateSchedule,
} from "./scheduledTasksStore";
import type {
  CreateScheduledTaskInput,
  ScheduledTaskRecord,
} from "../../preload";

/**
 * React bridge for the in-memory scheduled task scheduler.
 *
 * This hook does two jobs:
 *  1. Registers the AI Loop executor. When a task fires, its configured prompt
 *     is sent to buildFromContent, which creates a new chat conversation and
 *     auto-sends it — giving the task full access to every tool (the existing
 *     AI Loop). This is the core of requirement #2.
 *  2. Subscribes to the store so the component tree re-renders on task changes.
 *
 * The hook MUST be mounted inside a ChatConversationProvider (App.tsx mounts
 * it around the main content) so that buildFromContent is available. It is a
 * singleton concern, so it should be mounted exactly once for the lifetime of
 * the app (e.g. in MainSidebarContent, which is always rendered).
 *
 * Process-lifetime guarantee (requirement #4): the store and its timers live
 * only while this renderer process is alive. Closing/ quitting the app
 * destroys everything; nothing is persisted.
 */
export const useScheduledTasks = (directoryId: string): {
  tasks: ScheduledTaskRecord[];
  createTask: (input: Omit<CreateScheduledTaskInput, "directoryId">) => ScheduledTaskRecord;
  removeTask: (id: string) => void;
  clearTasks: () => void;
  togglePauseTask: (id: string) => void;
  runTaskNow: (id: string) => Promise<void>;
  isExecutorReady: boolean;
} => {
  const { buildFromContent } = useChatConversationContext();
  const [tasks, setTasks] = useState<ScheduledTaskRecord[]>(() =>
    scheduledTasksStore.list(directoryId)
  );
  const [isExecutorReady, setIsExecutorReady] = useState(false);

  // Keep the latest directoryId in a ref so the store subscription callback
  // always reads the current value without re-subscribing on every switch.
  const directoryIdRef = useRef(directoryId);
  useEffect(() => {
    directoryIdRef.current = directoryId;
  }, [directoryId]);

  // Subscribe to store changes (pub/sub singleton). Re-list whenever the
  // store notifies OR the active directory changes.
  useEffect(() => {
    const unsubscribe = scheduledTasksStore.subscribe(() => {
      setTasks(scheduledTasksStore.list(directoryIdRef.current));
    });
    // Ensure the list reflects the current directory immediately on mount/switch.
    setTasks(scheduledTasksStore.list(directoryId));
    return unsubscribe;
  }, [directoryId]);

  // Register buildFromContent as the AI Loop executor.
  useEffect(() => {
    const unregister = scheduledTasksStore.setExecutor((prompt) => {
      // buildFromContent creates a NEW conversation and auto-sends the prompt,
      // which kicks off the existing AI Loop with all tools available.
      buildFromContent(prompt);
    });
    setIsExecutorReady(true);
    return () => {
      unregister();
      setIsExecutorReady(false);
    };
  }, [buildFromContent]);

  const createTask = useCallback(
    (input: Omit<CreateScheduledTaskInput, "directoryId">): ScheduledTaskRecord => {
      return scheduledTasksStore.create({
        ...input,
        directoryId,
      });
    },
    [directoryId]
  );

  const removeTask = useCallback((id: string): void => {
    scheduledTasksStore.remove(id);
  }, []);

  const clearTasks = useCallback((): void => {
    scheduledTasksStore.clear(directoryId);
  }, [directoryId]);

  const togglePauseTask = useCallback((id: string): void => {
    scheduledTasksStore.togglePause(id);
  }, []);

  const runTaskNow = useCallback((id: string): Promise<void> => {
    return scheduledTasksStore.runNow(id);
  }, []);

  return {
    tasks,
    createTask,
    removeTask,
    clearTasks,
    togglePauseTask,
    runTaskNow,
    isExecutorReady,
  };
};

export { validateSchedule };
