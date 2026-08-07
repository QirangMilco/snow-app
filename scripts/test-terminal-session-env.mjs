import assert from "node:assert/strict";

const { buildPtyEnvironment } = await import(
  "../src/main/pty/ptyEnvironment.ts"
);
const { injectSessionIdIntoToolArgs } = await import(
  "../src/renderer/components/mainContent/chatMessages/utils/toolSessionMetadata.ts"
);

const manualTerminalEnv = buildPtyEnvironment(
  { PATH: "test-path", ELECTRON_RUN_AS_NODE: "1" },
  {},
  "win32"
);
assert.equal(manualTerminalEnv.TERM, "xterm-256color");
assert.equal("SNOW_SESSION_ID" in manualTerminalEnv, false);
assert.equal("TRELLIS_CONTEXT_ID" in manualTerminalEnv, false);
assert.equal("SNOW_CWD" in manualTerminalEnv, false);
assert.equal("SNOW_PLATFORM" in manualTerminalEnv, false);
assert.equal("ELECTRON_RUN_AS_NODE" in manualTerminalEnv, false);

const aiTerminalEnv = buildPtyEnvironment(
  { PATH: "test-path" },
  { sessionId: " conv-main ", cwd: " D:/project " },
  "win32"
);
assert.deepEqual(
  {
    sessionId: aiTerminalEnv.SNOW_SESSION_ID,
    contextId: aiTerminalEnv.TRELLIS_CONTEXT_ID,
    cwd: aiTerminalEnv.SNOW_CWD,
    platform: aiTerminalEnv.SNOW_PLATFORM,
  },
  {
    sessionId: "conv-main",
    contextId: "snow-conv-main",
    cwd: "D:/project",
    platform: "snow-app",
  }
);

const inheritedEnv = buildPtyEnvironment(
  {
    snow_session_id: "explicit-session",
    TRELLIS_CONTEXT_ID: "explicit-context",
    SNOW_CWD: "explicit-cwd",
    SNOW_PLATFORM: "explicit-platform",
  },
  { sessionId: "conv-main", cwd: "D:/project" },
  "win32"
);
assert.equal(inheritedEnv.snow_session_id, "explicit-session");
assert.equal("SNOW_SESSION_ID" in inheritedEnv, false);
assert.equal(inheritedEnv.TRELLIS_CONTEXT_ID, "explicit-context");
assert.equal(inheritedEnv.SNOW_CWD, "explicit-cwd");
assert.equal(inheritedEnv.SNOW_PLATFORM, "explicit-platform");

const mainArgs = JSON.parse(
  injectSessionIdIntoToolArgs(
    "bash-terminal-execute",
    '{"sessionId":"model-controlled"}',
    "conv-main"
  )
);
assert.equal(mainArgs.sessionId, "conv-main");

const subAgentArgs = JSON.parse(
  injectSessionIdIntoToolArgs("terminal-open", "{}", "conv-sub-agent")
);
assert.equal(subAgentArgs.sessionId, "conv-sub-agent");
assert.equal(
  injectSessionIdIntoToolArgs("filesystem-read", "{}", "conv-main"),
  "{}"
);
assert.equal(
  injectSessionIdIntoToolArgs("terminal-open", "not-json", "conv-main"),
  "not-json"
);
assert.equal(
  injectSessionIdIntoToolArgs("terminal-open", "{}", "   "),
  "{}"
);

console.log("Terminal session identity regression checks passed");
