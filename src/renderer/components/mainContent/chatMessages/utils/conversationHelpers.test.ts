import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessageRecord } from "../../../../../preload";
import { buildConversationMessages } from "./conversationHelpers";
import { resolveResponseDisposition } from "./responseDisposition";

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
  createdAt: "2026-08-09T00:00:00.000Z",
  ...overrides,
});

test("buildConversationMessages restores cold incomplete content variants", () => {
  const messages = buildConversationMessages([
    makeRecord({
      id: "partial",
      status: "incomplete",
      content: "partial answer",
      interruptionReason: "unexpected_eof",
      recoveryOutcome: "partial_threshold",
    }),
    makeRecord({
      id: "thinking",
      status: "incomplete",
      thinking: "reasoning only",
      interruptionReason: "read_error",
      recoveryOutcome: "retry_exhausted",
    }),
    makeRecord({
      id: "empty",
      status: "incomplete",
      interruptionReason: "idle_timeout",
      recoveryOutcome: "non_retriable",
    }),
  ]);

  assert.deepEqual(
    messages.map((message) => ({
      id: message.id,
      status: message.status,
      variant: message.incompleteVariant,
      reason: message.interruptionReason,
      outcome: message.recoveryOutcome,
    })),
    [
      {
        id: "partial",
        status: "incomplete",
        variant: "partial_content",
        reason: "unexpected_eof",
        outcome: "partial_threshold",
      },
      {
        id: "thinking",
        status: "incomplete",
        variant: "thinking_only",
        reason: "read_error",
        outcome: "retry_exhausted",
      },
      {
        id: "empty",
        status: "incomplete",
        variant: "empty",
        reason: "idle_timeout",
        outcome: "non_retriable",
      },
    ]
  );
});

test("buildConversationMessages never restores incomplete tool calls or consumes their result", () => {
  const [message] = buildConversationMessages([
    makeRecord({
      id: "unsafe-tool",
      status: "incomplete",
      content: "partial answer",
      toolCallsJson:
        '[{"name":"filesystem-read","call_id":"unsafe-call","arguments":"{\\"filePath\\":\\"a\\"}"}]',
      interruptionReason: "explicit_incomplete",
    }),
    makeRecord({
      id: "unsafe-result",
      role: "tool",
      content: "[Tool: filesystem-read#unsafe-call]\nshould not be attached",
      status: "completed",
    }),
  ]);

  assert.equal(message.status, "incomplete");
  assert.equal(message.incompleteVariant, "tool_call");
  assert.equal(message.interruptionReason, "explicit_incomplete");
  assert.equal(message.toolCalls, undefined);
});

test("buildConversationMessages preserves completed and error history behavior", () => {
  const messages = buildConversationMessages([
    makeRecord({
      id: "completed",
      content: "done",
      toolCallsJson:
        '[{"name":"filesystem-read","call_id":"call-1","arguments":"{\\"filePath\\":\\"a\\"}"}]',
    }),
    makeRecord({
      id: "tool-result",
      role: "tool",
      content: "[Tool: filesystem-read#call-1]\nloaded",
      status: "completed",
    }),
    makeRecord({ id: "error", status: "failed", content: "failed" }),
  ]);

  assert.equal(messages[0].status, "sent");
  assert.equal(messages[0].toolCalls?.[0]?.status, "completed");
  assert.equal(messages[0].toolCalls?.[0]?.result, "loaded");
  assert.equal(messages[1].status, "error");
  assert.equal(messages[1].incompleteVariant, undefined);
});

test("buildConversationMessages gives legacy incomplete rows a generic notice", () => {
  for (const legacyMetadataValue of [undefined, null]) {
    const [message] = buildConversationMessages([
      makeRecord({
        status: "incomplete",
        thinking: "legacy thinking",
        interruptionReason: legacyMetadataValue,
        recoveryOutcome: legacyMetadataValue,
      }),
    ]);

    assert.equal(message.status, "incomplete");
    assert.equal(message.incompleteVariant, "thinking_only");
    assert.equal(message.interruptionReason, "unknown");
    assert.equal(message.recoveryOutcome, null);
  }
});

test("live and history response shapes resolve to the same disposition", () => {
  const shared = {
    status: "max_tokens",
    content: "truncated",
    thinking: "reasoning",
    toolCallsJson: "[]",
    interruptionReason: null,
    recoveryOutcome: null,
  } as const;
  const historyRecord = makeRecord(shared);

  assert.deepEqual(
    resolveResponseDisposition(shared),
    resolveResponseDisposition(historyRecord)
  );

  const [message] = buildConversationMessages([historyRecord]);
  assert.equal(message.status, "incomplete");
  assert.equal(message.incompleteVariant, "partial_content");
  assert.equal(message.interruptionReason, "output_limit");
  assert.equal(message.recoveryOutcome, null);
});
