const SESSION_AWARE_TERMINAL_TOOLS = new Set([
  "bash-terminal-execute",
  "terminal-open",
]);

/**
 * Attach Snow-owned session metadata after model arguments have been parsed.
 * Invalid JSON is left untouched so the normal tool validation path reports it.
 */
export const injectSessionIdIntoToolArgs = (
  toolName: string,
  argsJson: string,
  sessionId: string | undefined
): string => {
  const normalizedSessionId = sessionId?.trim();
  if (
    !normalizedSessionId ||
    !SESSION_AWARE_TERMINAL_TOOLS.has(toolName)
  ) {
    return argsJson;
  }

  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return argsJson;
    }
    return JSON.stringify({
      ...(parsed as Record<string, unknown>),
      sessionId: normalizedSessionId,
    });
  } catch {
    return argsJson;
  }
};
