/**
 * In-memory scheduled task scheduler (renderer singleton).
 *
 * This is a process-lifetime store: tasks and their timers live only while the
 * Snow App process is alive. Nothing is persisted to disk. When the process
 * exits, all timers are destroyed and the tasks vanish — matching requirement
 * #4 ("tasks only execute while the Snow App process exists").
 *
 * Execution is delegated to a registered "executor" callback. The renderer
 * (which lives inside the ChatConversationProvider) registers buildFromContent
 * as the executor, so every task fires a fresh AI Loop with access to all
 * tools. If no executor is registered when a task fires, the run is marked as
 * error and retried on the next tick (for recurring tasks).
 *
 * The store is a tiny pub/sub singleton so React components can subscribe to
 * task-list changes. All mutation methods return the affected record (or void)
 * and notify subscribers synchronously.
 */

import type {
  CreateScheduledTaskInput,
  ScheduledTaskRecord,
  ScheduledTaskSchedule,
} from "../../preload";

/** Minimum interval for interval-mode recurring tasks. */
const MIN_INTERVAL_MS = 60_000;
/** Coarse tick used to wake the scheduler and check for due tasks. This keeps
 *  drift bounded and avoids one setTimeout per task (which would also leak if
 *  the renderer is throttled in the background). */
const TICK_MS = 5_000;

type Executor = (prompt: string, taskName: string) => void | Promise<void>;
type Listener = () => void;

const isBrowser =
  typeof window !== "undefined" && typeof window.crypto !== "undefined";

const generateId = (): string => {
  if (isBrowser && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `st_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
};

/** Validates and normalizes a schedule, throwing on invalid input. */
export const validateSchedule = (schedule: ScheduledTaskSchedule): void => {
  if (schedule.type !== "once" && schedule.type !== "recurring") {
    throw new Error(
      `Invalid schedule type: "${schedule.type}". Must be "once" or "recurring".`
    );
  }

  if (schedule.type === "once") {
    if (!schedule.executeAt) {
      throw new Error("executeAt is required for a once schedule");
    }
    const ms = Date.parse(schedule.executeAt);
    if (Number.isNaN(ms)) {
      throw new Error(`Invalid executeAt timestamp: "${schedule.executeAt}"`);
    }
    return;
  }

  // recurring
  if (schedule.mode !== "interval" && schedule.mode !== "daily") {
    throw new Error(
      `Invalid recurring mode: "${schedule.mode}". Must be "interval" or "daily".`
    );
  }

  if (schedule.mode === "interval") {
    const interval =
      typeof schedule.intervalMs === "number" ? schedule.intervalMs : NaN;
    if (!Number.isFinite(interval) || interval < MIN_INTERVAL_MS) {
      throw new Error(
        `intervalMs must be a number >= ${MIN_INTERVAL_MS} (1 minute), received ${schedule.intervalMs}`
      );
    }
  } else {
    // daily
    const hour =
      typeof schedule.hour === "number" ? schedule.hour : Number.NaN;
    const minute =
      typeof schedule.minute === "number" ? schedule.minute : Number.NaN;
    if (
      !Number.isInteger(hour) ||
      hour < 0 ||
      hour > 23 ||
      !Number.isInteger(minute) ||
      minute < 0 ||
      minute > 59
    ) {
      throw new Error(
        `hour (0-23) and minute (0-59) are required for a daily schedule, received hour=${schedule.hour}, minute=${schedule.minute}`
      );
    }
  }
};

/** Computes the next fire time (ms epoch) for a schedule, relative to "now". */
const computeNextRunMs = (
  schedule: ScheduledTaskSchedule,
  now: number
): number | null => {
  if (schedule.type === "once") {
    if (!schedule.executeAt) return null;
    const ms = Date.parse(schedule.executeAt);
    return Number.isNaN(ms) ? null : ms;
  }

  if (schedule.mode === "interval") {
    const interval = schedule.intervalMs ?? MIN_INTERVAL_MS;
    // next run = now + interval (aligned from creation for steadiness)
    return now + interval;
  }

  // daily: next occurrence of hour:minute today (or tomorrow if already passed)
  const hour = schedule.hour ?? 0;
  const minute = schedule.minute ?? 0;
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  let target = candidate.getTime();
  if (target <= now) {
    target += 24 * 60 * 60 * 1000;
  }
  return target;
};

class ScheduledTasksStore {
  private tasks = new Map<string, ScheduledTaskRecord>();
  private listeners = new Set<Listener>();
  private executor: Executor | null = null;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /** Currently in-flight execution task ids, to prevent overlapping runs. */
  private runningIds = new Set<string>();

  /** Starts the coarse tick loop. Safe to call multiple times. */
  private ensureTick = (): void => {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      void this.dueTasks();
    }, TICK_MS);
    // Don't keep the Node/Electron process alive solely for the scheduler.
    if (this.tickTimer && typeof this.tickTimer.unref === "function") {
      this.tickTimer.unref();
    }
  };

  private stopTick = (): void => {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  };

  /** Registers the AI Loop executor (buildFromContent). */
  setExecutor = (executor: Executor): (() => void) => {
    this.executor = executor;
    return () => {
      if (this.executor === executor) {
        this.executor = null;
      }
    };
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify = (): void => {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Listener errors must not break the scheduler.
      }
    }
  };

  list = (directoryId?: string): ScheduledTaskRecord[] => {
    return Array.from(this.tasks.values())
      .filter(
        (task) =>
          directoryId === undefined || task.directoryId === directoryId
      )
      .sort((a, b) => {
        // Sort: running/pending first, then by nextRunAt, then createdAt
        const aRank =
          a.status === "running" ? 0 : a.status === "pending" ? 1 : 2;
        const bRank =
          b.status === "running" ? 0 : b.status === "pending" ? 1 : 2;
        if (aRank !== bRank) return aRank - bRank;
        const aNext = a.nextRunAt ? Date.parse(a.nextRunAt) : Number.MAX_SAFE_INTEGER;
        const bNext = b.nextRunAt ? Date.parse(b.nextRunAt) : Number.MAX_SAFE_INTEGER;
        if (aNext !== bNext) return aNext - bNext;
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      });
  };

  create = (input: CreateScheduledTaskInput): ScheduledTaskRecord => {
    const directoryId = (input.directoryId ?? "").trim();
    if (!directoryId) {
      throw new Error("directoryId is required");
    }
    const name = (input.name ?? "").trim();
    if (!name) {
      throw new Error("name is required");
    }
    const prompt = (input.prompt ?? "").trim();
    if (!prompt) {
      throw new Error("prompt is required");
    }
    validateSchedule(input.schedule);

    const now = Date.now();
    const nextRunMs = computeNextRunMs(input.schedule, now);
    const record: ScheduledTaskRecord = {
      id: generateId(),
      directoryId,
      name,
      prompt,
      schedule: input.schedule,
      status: "pending",
      paused: false,
      createdAt: new Date(now).toISOString(),
      nextRunAt:
        nextRunMs != null ? new Date(nextRunMs).toISOString() : undefined,
      runCount: 0,
    };
    this.tasks.set(record.id, record);
    this.ensureTick();
    this.notify();
    return record;
  };

  remove = (id: string): void => {
    if (this.tasks.delete(id)) {
      this.runningIds.delete(id);
      if (this.tasks.size === 0) {
        this.stopTick();
      }
      this.notify();
    }
  };

  clear = (directoryId?: string): void => {
    if (directoryId === undefined) {
      // Clear everything (e.g. process exit / global reset).
      this.tasks.clear();
      this.runningIds.clear();
      this.stopTick();
      this.notify();
      return;
    }
    // Clear only tasks belonging to the given project directory.
    let cleared = false;
    for (const [id, task] of this.tasks) {
      if (task.directoryId === directoryId) {
        this.tasks.delete(id);
        this.runningIds.delete(id);
        cleared = true;
      }
    }
    if (cleared) {
      if (this.tasks.size === 0) {
        this.stopTick();
      }
      this.notify();
    }
  };

  togglePause = (id: string): ScheduledTaskRecord | null => {
    const task = this.tasks.get(id);
    if (!task) return null;
    const updated: ScheduledTaskRecord = {
      ...task,
      paused: !task.paused,
      status: !task.paused ? "pending" : task.status,
      nextRunAt: !task.paused
        ? new Date(
            computeNextRunMs(task.schedule, Date.now()) ?? Date.now()
          ).toISOString()
        : undefined,
    };
    this.tasks.set(id, updated);
    this.notify();
    return updated;
  };

  /** Triggers all tasks whose nextRunAt is due and not paused/running. */
  private dueTasks = async (): Promise<void> => {
    const now = Date.now();
    const due: ScheduledTaskRecord[] = [];
    for (const task of this.tasks.values()) {
      if (task.paused) continue;
      if (task.status === "running") continue;
      if (task.status === "completed") continue; // once-task already fired
      if (!task.nextRunAt) continue;
      const nextMs = Date.parse(task.nextRunAt);
      if (Number.isNaN(nextMs) || nextMs > now) continue;
      due.push(task);
    }

    for (const task of due) {
      await this.execute(task.id).catch(() => undefined);
    }
  };

  /** Executes a single task immediately (used by scheduler tick + "run now"). */
  execute = async (id: string): Promise<void> => {
    const task = this.tasks.get(id);
    if (!task) return;
    if (this.runningIds.has(id)) return; // already running

    const executor = this.executor;
    this.runningIds.add(id);

    // Mark running
    this.tasks.set(id, {
      ...task,
      status: "running",
      lastRunAt: new Date().toISOString(),
    });
    this.notify();

    try {
      if (!executor) {
        throw new Error("No executor registered (AI Loop unavailable)");
      }
      await executor(task.prompt, task.name);

      const after = this.tasks.get(id);
      if (after) {
        const next = this.advanceSchedule(after);
        this.tasks.set(id, next);
      }
    } catch (error) {
      const after = this.tasks.get(id);
      if (after) {
        const next = this.advanceSchedule(after, error);
        this.tasks.set(id, next);
      }
    } finally {
      this.runningIds.delete(id);
      this.notify();
    }
  };

  /** Computes the next record state after a run (success or error). */
  private advanceSchedule = (
    task: ScheduledTaskRecord,
    error?: unknown
  ): ScheduledTaskRecord => {
    const errorMessage =
      error instanceof Error
        ? error.message
        : typeof error === "string"
        ? error
        : "Unknown error";

    const runCount = task.runCount + 1;
    const lastRunAt = new Date().toISOString();

    // once-task: after firing it's done regardless of success
    if (task.schedule.type === "once") {
      return {
        ...task,
        status: error ? "error" : "completed",
        runCount,
        lastRunAt,
        lastError: error ? errorMessage : undefined,
        nextRunAt: undefined,
      };
    }

    // recurring: schedule next run even on error (so transient failures recover)
    const nextRunMs = computeNextRunMs(task.schedule, Date.now());
    return {
      ...task,
      status: "pending",
      runCount,
      lastRunAt,
      lastError: error ? errorMessage : undefined,
      nextRunAt:
        nextRunMs != null ? new Date(nextRunMs).toISOString() : undefined,
    };
  };

  /** Manually trigger a task run now (UI "Run now" button). */
  runNow = (id: string): Promise<void> => {
    return this.execute(id);
  };
}

/**
 * Process-wide singleton. Because the store is module-level and holds timers,
 * it dies with the renderer process — satisfying requirement #4. We expose a
 * single instance to both the React hook layer and the app-control bridge.
 */
export const scheduledTasksStore = new ScheduledTasksStore();
