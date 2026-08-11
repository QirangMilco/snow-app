import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessageRecord } from "../utils/conversationTypes";
import { extractFileChangesFromRecords } from "./fileChangeTracking";

const makeRecord = (
  overrides: Partial<ChatMessageRecord> = {}
): ChatMessageRecord => ({
  id: "message-1",
  role: "assistant",
  content: "",
  thinking: "",
  status: "completed",
  model: "test-model",
  responseId: "response-1",
  checkpointId: "",
  toolCallsJson: "",
  createdAt: "2026-08-10T00:00:00.000Z",
  ...overrides,
});

const makeCreateToolCallsJson = (filePath: string, content: string): string =>
  JSON.stringify([
    {
      name: "filesystem-create",
      call_id: "shared-call",
      arguments: JSON.stringify({ filePath, content }),
    },
  ]);

const makeSuccessfulToolResult = (): ChatMessageRecord =>
  makeRecord({
    id: "tool-result",
    role: "tool",
    content:
      '[Tool: filesystem-create#shared-call]\n{"success":true,"path":"src/completed.ts"}',
  });

test("extractFileChangesFromRecords ignores incomplete-like tool payloads", () => {
  for (const status of ["incomplete", "length", "max_tokens"] as const) {
    const changes = extractFileChangesFromRecords([
      makeRecord({
        id: `assistant-${status}`,
        status,
        toolCallsJson: makeCreateToolCallsJson(
          `src/${status}.ts`,
          "unsafe payload"
        ),
      }),
      makeSuccessfulToolResult(),
    ]);

    assert.deepEqual(changes, []);
  }
});

test("extractFileChangesFromRecords leaves results for completed assistant history", () => {
  const completedAt = "2026-08-10T00:01:00.000Z";
  const changes = extractFileChangesFromRecords([
    makeRecord({
      id: "incomplete-assistant",
      status: "incomplete",
      toolCallsJson: makeCreateToolCallsJson(
        "src/incomplete.ts",
        "unsafe payload"
      ),
    }),
    makeRecord({
      id: "completed-assistant",
      createdAt: completedAt,
      toolCallsJson: makeCreateToolCallsJson(
        "src/completed.ts",
        "completed payload"
      ),
    }),
    makeSuccessfulToolResult(),
  ]);

  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.filePath, "src/completed.ts");
  assert.equal(changes[0]?.kind, "create");
  assert.equal(changes[0]?.timestamp, Date.parse(completedAt));
  assert.match(changes[0]?.diff?.patch ?? "", /\+completed payload/);
});
