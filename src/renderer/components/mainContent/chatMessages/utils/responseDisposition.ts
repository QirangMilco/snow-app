import type {
  StreamInterruptionReason,
  StreamRecoveryOutcome,
} from "../../../../../preload";

export type IncompleteVariant =
  | "partial_content"
  | "thinking_only"
  | "tool_call"
  | "empty";

export type NormalizedInterruptionReason =
  | StreamInterruptionReason
  | "unknown";

export type NormalizedRecoveryOutcome =
  | StreamRecoveryOutcome
  | "unknown"
  | null;

export type ResponseDispositionInput = {
  status?: string | null;
  content?: string | null;
  thinking?: string | null;
  toolCallsJson?: string | null;
  interruptionReason?: string | null;
  recoveryOutcome?: string | null;
};

export type ResponseDisposition =
  | {
      kind: "complete";
      mayExecuteTools: true;
      mayContinueLoop: true;
    }
  | {
      kind: "error";
      mayExecuteTools: false;
      mayContinueLoop: false;
    }
  | {
      kind: "incomplete";
      variant: IncompleteVariant;
      reason: NormalizedInterruptionReason;
      recoveryOutcome: NormalizedRecoveryOutcome;
      mayExecuteTools: false;
      mayContinueLoop: false;
    };

const normalizeInterruptionReason = (
  value: string | null | undefined,
  status: string | null | undefined
): NormalizedInterruptionReason => {
  switch (value) {
    case "unexpected_eof":
    case "read_error":
    case "idle_timeout":
    case "explicit_incomplete":
    case "output_limit":
      return value;
    default:
      return value == null && (status === "length" || status === "max_tokens")
        ? "output_limit"
        : "unknown";
  }
};

const normalizeRecoveryOutcome = (
  value: string | null | undefined
): NormalizedRecoveryOutcome => {
  if (value == null) {
    return null;
  }

  switch (value) {
    case "partial_threshold":
    case "retry_exhausted":
    case "non_retriable":
      return value;
    default:
      return "unknown";
  }
};

const hasUnsafeToolPayload = (toolCallsJson: string | null | undefined): boolean => {
  if (typeof toolCallsJson !== "string") {
    return false;
  }

  const normalized = toolCallsJson.trim();
  return normalized !== "" && normalized !== "[]" && normalized !== "null";
};

export const resolveResponseDisposition = (
  input: ResponseDispositionInput
): ResponseDisposition => {
  if (input.status === "error" || input.status === "failed") {
    return {
      kind: "error",
      mayExecuteTools: false,
      mayContinueLoop: false,
    };
  }

  const isIncompleteLike =
    input.status === "incomplete" ||
    input.status === "length" ||
    input.status === "max_tokens";
  if (!isIncompleteLike) {
    return {
      kind: "complete",
      mayExecuteTools: true,
      mayContinueLoop: true,
    };
  }

  let variant: IncompleteVariant;
  if (hasUnsafeToolPayload(input.toolCallsJson)) {
    variant = "tool_call";
  } else if (input.content?.trim()) {
    variant = "partial_content";
  } else if (input.thinking?.trim()) {
    variant = "thinking_only";
  } else {
    variant = "empty";
  }

  return {
    kind: "incomplete",
    variant,
    reason: normalizeInterruptionReason(input.interruptionReason, input.status),
    recoveryOutcome: normalizeRecoveryOutcome(input.recoveryOutcome),
    mayExecuteTools: false,
    mayContinueLoop: false,
  };
};
