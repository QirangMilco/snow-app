import { useEffect, useRef } from "react";
import type { MainContentView } from "../components/mainContent/types";
import type { WorkspaceDirectoryRecord } from "../../preload";
import type {
  CreateScheduledTaskInput,
  ScheduledTaskSchedule,
} from "../../preload";
import { scheduledTasksStore } from "./scheduledTasksStore";

export const APP_CONTROL_OPEN_SETTINGS_EVENT = "app-control:open-settings";
export const APP_CONTROL_MEMO_CREATED_EVENT = "app-control:memo-created";
export const APP_CONTROL_SCHEDULED_TASK_CREATED_EVENT =
  "app-control:scheduled-task-created";
export const APP_CONTROL_PROJECT_CREATED_EVENT = "app-control:project-created";
/** Dispatched after app-control-setMode writes the global settings. The
 *  conversation layer listens for it and replays the change through the
 *  session-aware path (session ref + global defaults + per-conversation DB
 *  record) so AI-driven mode switches behave exactly like user toggles. */
export const APP_CONTROL_MODE_CHANGED_EVENT = "app-control:mode-changed";

type AppControlHandlers = {
  activeDirectory: WorkspaceDirectoryRecord | null;
  setActiveMainView: (view: MainContentView) => void;
};

export const useAppControl = ({
  activeDirectory,
  setActiveMainView,
}: AppControlHandlers): void => {
  const activeDirectoryRef = useRef(activeDirectory);
  const setActiveMainViewRef = useRef(setActiveMainView);

  useEffect(() => {
    activeDirectoryRef.current = activeDirectory;
  }, [activeDirectory]);

  useEffect(() => {
    setActiveMainViewRef.current = setActiveMainView;
  }, [setActiveMainView]);

  useEffect(() => {
    const unregister = window.snow.registerAppControlHandler(
      async (request) => {
        const payload = JSON.parse(request.payloadJson) as Record<
          string,
          unknown
        >;

        switch (request.action) {
          case "create_memo": {
            const directory = activeDirectoryRef.current;
            if (!directory) {
              throw new Error("No active project directory");
            }
            const content = (payload.content as string) ?? "";
            const memo = await window.snow.createMemo(
              directory.directoryId,
              content
            );
            window.dispatchEvent(
              new CustomEvent(APP_CONTROL_MEMO_CREATED_EVENT)
            );
            return JSON.stringify({
              success: true,
              memoId: memo.memoId,
              content: memo.content,
              status: memo.status,
            });
          }

          case "set_mode": {
            const mode = payload.mode as string;
            const enabled = payload.enabled as boolean;
            // Plan/Goal Mode is strictly per-conversation: the persisted
            // global settings are never written here. Replaying through the
            // session-aware path applies the change to the ACTIVE
            // conversation only (its session ref + per-conversation DB
            // record) — other conversations never inherit the toggle.
            window.dispatchEvent(
              new CustomEvent(APP_CONTROL_MODE_CHANGED_EVENT, {
                detail: { mode, enabled },
              })
            );
            return JSON.stringify({ success: true, mode, enabled });
          }

          case "open_settings": {
            const page = payload.page as string;
            setActiveMainViewRef.current(page as MainContentView);
            window.dispatchEvent(
              new CustomEvent(APP_CONTROL_OPEN_SETTINGS_EVENT)
            );
            return JSON.stringify({ success: true, page });
          }

          case "create_scheduled_task": {
            const directory = activeDirectoryRef.current;
            if (!directory) {
              throw new Error("No active project directory");
            }
            const name = (payload.name as string) ?? "";
            const prompt = (payload.prompt as string) ?? "";
            const schedule = payload.schedule as
              | ScheduledTaskSchedule
              | undefined;
            if (!name.trim()) {
              throw new Error("name is required");
            }
            if (!prompt.trim()) {
              throw new Error("prompt is required");
            }
            if (!schedule) {
              throw new Error("schedule is required");
            }
            // The store validates the schedule strictly; an invalid schedule
            // throws here and the error propagates back to the MCP tool caller.
            const input: CreateScheduledTaskInput = {
              directoryId: directory.directoryId,
              name,
              prompt,
              schedule,
            };
            const created = scheduledTasksStore.create(input);
            window.dispatchEvent(
              new CustomEvent(APP_CONTROL_SCHEDULED_TASK_CREATED_EVENT, {
                detail: { taskId: created.id, name: created.name },
              })
            );
            return JSON.stringify({
              success: true,
              taskId: created.id,
              name: created.name,
              status: created.status,
              nextRunAt: created.nextRunAt,
            });
          }

          case "create_project": {
            const name = (payload.name as string) ?? "";
            if (!name.trim()) {
              throw new Error("name is required");
            }
            const providedParentPath = (
              payload.parentPath as string | undefined
            )?.trim();
            // 未提供父目录时弹出目录选择框，让用户指定保存位置。
            const parentPath =
              providedParentPath ??
              (await window.snow.selectWorkspaceDirectory(
                "Choose a folder to save the new project"
              ));
            if (!parentPath) {
              return JSON.stringify({ success: false, cancelled: true });
            }
            const directories = await window.snow.createWorkspaceProject(
              parentPath,
              name.trim()
            );
            const created = directories.find(
              (directory) => directory.isActive
            );
            window.dispatchEvent(
              new CustomEvent(APP_CONTROL_PROJECT_CREATED_EVENT, {
                detail: created
                  ? {
                      directoryId: created.directoryId,
                      name: created.name,
                      path: created.path,
                    }
                  : undefined,
              })
            );
            return JSON.stringify({
              success: true,
              directoryId: created?.directoryId,
              name: created?.name,
              path: created?.path,
            });
          }

          default:
            throw new Error(`Unknown app control action: ${request.action}`);
        }
      }
    );

    return () => {
      unregister();
    };
  }, []);
};
