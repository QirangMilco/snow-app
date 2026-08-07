import {
  getBrowserWebContents,
  registerDebuggerMessageListener,
} from "./browserNetworkRecorder";

/**
 * 性能 trace：基于 CDP Tracing 域录制页面性能数据（主线程长任务等），
 * 返回精简统计（不返回原始大 trace，控制上下文体积）。
 *
 * 录制模式：Tracing.start(transferMode: ReportEvents) → 事件经
 * Tracing.dataCollected 累积 → Tracing.end → Tracing.tracingComplete 完成。
 * 注意：ReportEvents 模式下数据全部走事件通道，录制时长建议 ≤10s。
 */

export type TraceStats = {
  ok: boolean;
  error?: string;
  durationMs: number;
  eventCount: number;
  longTasks: { count: number; totalMs: number; longestMs: number };
  topEventTypes: { name: string; count: number }[];
  note?: string;
};

type TraceEvent = {
  name?: string;
  dur?: number;
  ph?: string;
  cat?: string;
};

const TRACE_CATEGORIES = [
  "devtools.timeline",
  "v8.execute",
  "blink.user_timing",
  "loading",
  "latencyInfo",
];

type PendingTrace = {
  chunks: string[];
  resolve: (events: TraceEvent[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const pendingTraces = new Map<number, PendingTrace>();

/** 由 browserNetworkRecorder 的 debugger message 回调调用（Tracing.dataCollected / tracingComplete）。 */
export const handleTraceMessage = (
  webContentsId: number,
  method: string,
  params: unknown
): void => {
  const pending = pendingTraces.get(webContentsId);
  if (!pending) {
    return;
  }
  if (method === "Tracing.dataCollected") {
    const value = (params as { value?: unknown } | null)?.value;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          pending.chunks.push(entry);
        } else if (entry !== null && typeof entry === "object") {
          try {
            pending.chunks.push(JSON.stringify(entry));
          } catch {
            // 忽略不可序列化条目。
          }
        }
      }
    }
  } else if (method === "Tracing.tracingComplete") {
    clearTimeout(pending.timer);
    pendingTraces.delete(webContentsId);
    let events: TraceEvent[] = [];
    try {
      events = JSON.parse(`[${pending.chunks.join(",")}]`) as TraceEvent[];
    } catch {
      // 某些片段可能不是完整 JSON 对象（如流控制），尽力解析已收集部分。
      const valid: TraceEvent[] = [];
      for (const chunk of pending.chunks) {
        try {
          const parsed = JSON.parse(chunk) as TraceEvent;
          valid.push(parsed);
        } catch {
          // 跳过无效片段。
        }
      }
      events = valid;
    }
    pending.resolve(events);
  }
};

// 模块加载即注册：recorder 的 debugger message 回调会把 Tracing 事件转发到这里。
// （注册放在 handleTraceMessage 声明之后，避免 TDZ 引用错误。）
registerDebuggerMessageListener(handleTraceMessage);

const analyzeTrace = (events: TraceEvent[], durationMs: number): TraceStats => {
  const longTaskEvents = events.filter(
    (event) => (event.dur ?? 0) > 50 && event.ph === "X"
  );
  const longTaskTotalMs = longTaskEvents.reduce(
    (sum, event) => sum + (event.dur ?? 0) / 1000,
    0
  );
  const longestMs = longTaskEvents.reduce(
    (max, event) => Math.max(max, (event.dur ?? 0) / 1000),
    0
  );
  const typeCounts = new Map<string, number>();
  for (const event of events) {
    const name = event.name ?? event.cat ?? "unknown";
    typeCounts.set(name, (typeCounts.get(name) ?? 0) + 1);
  }
  const topEventTypes = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  return {
    ok: true,
    durationMs,
    eventCount: events.length,
    longTasks: {
      count: longTaskEvents.length,
      totalMs: Math.round(longTaskTotalMs),
      longestMs: Math.round(longestMs),
    },
    topEventTypes,
    note: "Long tasks are runnable events longer than 50ms (main-thread jank indicator).",
  };
};

/** 录制 durationMs 毫秒的页面性能 trace 并返回统计。 */
export const runBrowserTrace = async (
  webContentsId: number,
  durationMs: number
): Promise<TraceStats> => {
  const contents = getBrowserWebContents(webContentsId);
  if (!contents.debugger.isAttached()) {
    return {
      ok: false,
      durationMs: 0,
      eventCount: 0,
      longTasks: { count: 0, totalMs: 0, longestMs: 0 },
      topEventTypes: [],
      error: "Browser debugger is unavailable; close the page DevTools and retry",
    };
  }
  if (pendingTraces.has(webContentsId)) {
    return {
      ok: false,
      durationMs: 0,
      eventCount: 0,
      longTasks: { count: 0, totalMs: 0, longestMs: 0 },
      topEventTypes: [],
      error: "A trace is already running for this browser tab",
    };
  }

  const eventsPromise = new Promise<TraceEvent[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTraces.delete(webContentsId);
      reject(new Error(`Trace recording timed out after ${durationMs + 15000}ms`));
    }, durationMs + 15_000);
    pendingTraces.set(webContentsId, { chunks: [], resolve, reject, timer });
  });

  try {
    await contents.debugger.sendCommand("Tracing.start", {
      categories: TRACE_CATEGORIES,
      transferMode: "ReportEvents",
    });
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    await contents.debugger.sendCommand("Tracing.end");
    const events = await eventsPromise;
    return analyzeTrace(events, durationMs);
  } catch (error) {
    const pending = pendingTraces.get(webContentsId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingTraces.delete(webContentsId);
    }
    return {
      ok: false,
      durationMs: 0,
      eventCount: 0,
      longTasks: { count: 0, totalMs: 0, longestMs: 0 },
      topEventTypes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
