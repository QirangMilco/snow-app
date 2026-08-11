import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveResponseDisposition,
  type ResponseDisposition,
} from "./responseDisposition";

const assertIncomplete = (
  disposition: ResponseDisposition
): Extract<ResponseDisposition, { kind: "incomplete" }> => {
  assert.equal(disposition.kind, "incomplete");
  assert.equal(disposition.mayExecuteTools, false);
  assert.equal(disposition.mayContinueLoop, false);
  return disposition;
};

test("resolveResponseDisposition preserves completed and error terminal states", () => {
  assert.deepEqual(
    resolveResponseDisposition({
      status: "completed",
      toolCallsJson: '[{"name":"filesystem-read"}]',
    }),
    {
      kind: "complete",
      mayExecuteTools: true,
      mayContinueLoop: true,
    }
  );

  for (const status of ["error", "failed"]) {
    assert.deepEqual(resolveResponseDisposition({ status }), {
      kind: "error",
      mayExecuteTools: false,
      mayContinueLoop: false,
    });
  }
});

test("resolveResponseDisposition classifies incomplete content variants in safety order", () => {
  assert.equal(
    assertIncomplete(
      resolveResponseDisposition({
        status: "incomplete",
        content: "partial answer",
        thinking: "thinking",
        toolCallsJson: " [] ",
      })
    ).variant,
    "partial_content"
  );

  assert.equal(
    assertIncomplete(
      resolveResponseDisposition({
        status: "incomplete",
        content: "   ",
        thinking: "reasoning only",
        toolCallsJson: "null",
      })
    ).variant,
    "thinking_only"
  );

  assert.equal(
    assertIncomplete(
      resolveResponseDisposition({
        status: "incomplete",
        content: " ",
        thinking: "\n",
        toolCallsJson: "",
      })
    ).variant,
    "empty"
  );

  assert.equal(
    assertIncomplete(
      resolveResponseDisposition({
        status: "incomplete",
        toolCallsJson:
          '[{"name":"filesystem-read","arguments":{"filePath":"a"}}]',
      })
    ).variant,
    "tool_call"
  );

  assert.equal(
    assertIncomplete(
      resolveResponseDisposition({
        status: "incomplete",
        toolCallsJson: '[{"name":"filesystem-read","arguments":',
      })
    ).variant,
    "tool_call"
  );

  assert.equal(
    assertIncomplete(
      resolveResponseDisposition({
        status: "incomplete",
        content: "partial answer",
        thinking: "thinking",
        toolCallsJson: '[{"name":"filesystem-read"}]',
      })
    ).variant,
    "tool_call"
  );
});

test("resolveResponseDisposition normalizes legacy output-limit statuses", () => {
  for (const status of ["length", "max_tokens"]) {
    const disposition = assertIncomplete(
      resolveResponseDisposition({ status, content: "truncated" })
    );
    assert.equal(disposition.variant, "partial_content");
    assert.equal(disposition.reason, "output_limit");
    assert.equal(disposition.recoveryOutcome, null);
  }
});

test("resolveResponseDisposition accepts only the five stable interruption reasons", () => {
  const reasons = [
    "unexpected_eof",
    "read_error",
    "idle_timeout",
    "explicit_incomplete",
    "output_limit",
  ] as const;

  for (const reason of reasons) {
    const disposition = assertIncomplete(
      resolveResponseDisposition({
        status: "incomplete",
        interruptionReason: reason,
      })
    );
    assert.equal(disposition.reason, reason);
  }
});

test("resolveResponseDisposition accepts only the three stable recovery outcomes", () => {
  const outcomes = [
    "partial_threshold",
    "retry_exhausted",
    "non_retriable",
  ] as const;

  for (const recoveryOutcome of outcomes) {
    const disposition = assertIncomplete(
      resolveResponseDisposition({
        status: "incomplete",
        recoveryOutcome,
      })
    );
    assert.equal(disposition.recoveryOutcome, recoveryOutcome);
  }
});

test("resolveResponseDisposition redacts unknown metadata values", () => {
  const disposition = assertIncomplete(
    resolveResponseDisposition({
      status: "incomplete",
      interruptionReason: "raw provider error: secret",
      recoveryOutcome: "private retry detail",
    })
  );

  assert.equal(disposition.reason, "unknown");
  assert.equal(disposition.recoveryOutcome, "unknown");
  assert.equal(JSON.stringify(disposition).includes("secret"), false);
  assert.equal(JSON.stringify(disposition).includes("private"), false);
});
