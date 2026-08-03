import { useMemo } from "react";
import type { ChatConversationMessage } from "../utils/conversationTypes";

export type TodoStatus = "pending" | "inProgress" | "completed";

export type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
  createdAt: string;
  updatedAt: string;
  parentId?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isValidStatus = (value: unknown): value is TodoStatus =>
  typeof value === "string" &&
  ["pending", "inProgress", "completed"].includes(value);

/**
 * Parse a todo-manage tool result JSON into a TodoItem array.
 * Returns null if the result is not a valid todo list.
 */
const parseTodoResult = (
  result: string | undefined
): { todos: TodoItem[]; sessionId: string } | null => {
  if (!result) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return null;
    }

    // A `message` field is only an accompanying hint (e.g. "no TODOs yet"),
    // it does not invalidate a well-formed todo list.
    if (typeof parsed.error === "string") {
      return null;
    }

    if (typeof parsed.sessionId === "string" && Array.isArray(parsed.todos)) {
      const todos = parsed.todos
        .filter(isRecord)
        .map((t) => ({
          id: typeof t.id === "string" ? t.id : "",
          content: typeof t.content === "string" ? t.content : "",
          status: isValidStatus(t.status) ? t.status : "pending",
          createdAt: typeof t.createdAt === "string" ? t.createdAt : "",
          updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : "",
          parentId: typeof t.parentId === "string" ? t.parentId : undefined,
        }))
        .filter((t) => t.id);
      return { todos, sessionId: parsed.sessionId };
    }

    return null;
  } catch {
    return null;
  }
};

/**
 * Extract the latest TODO list from conversation messages by scanning
 * all tool calls to `todo-todo-manage` and taking the last
 * successful result that contains a todo array.
 */
export const useTodoPanel = (
  messages: ChatConversationMessage[]
): {
  todos: TodoItem[];
  sessionId: string | null;
  totalCount: number;
  completedCount: number;
  incompleteCount: number;
} => {
  const { todos, sessionId } = useMemo(() => {
    let latestTodos: TodoItem[] | null = null;
    let latestSessionId: string | null = null;

    for (const message of messages) {
      if (!message.toolCalls) {
        continue;
      }

      for (const toolCall of message.toolCalls) {
        if (toolCall.name !== "todo-todo-manage") {
          continue;
        }

        const parsed = parseTodoResult(toolCall.result);
        if (parsed !== null) {
          latestTodos = parsed.todos;
          latestSessionId = parsed.sessionId;
        }
      }
    }

    return { todos: latestTodos ?? [], sessionId: latestSessionId };
  }, [messages]);

  const totalCount = todos.length;
  const completedCount = todos.filter((t) => t.status === "completed").length;
  const incompleteCount = totalCount - completedCount;

  return { todos, sessionId, totalCount, completedCount, incompleteCount };
};
