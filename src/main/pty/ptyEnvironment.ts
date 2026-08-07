export type PtySessionIdentity = {
  sessionId?: string;
  cwd?: string;
};

const ELECTRON_ONLY_ENV_KEYS = new Set([
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
]);

const hasEnvKey = (
  env: Record<string, string>,
  key: string,
  platform: NodeJS.Platform
): boolean => {
  if (platform !== "win32") {
    return Object.prototype.hasOwnProperty.call(env, key);
  }
  const normalizedKey = key.toLowerCase();
  return Object.keys(env).some(
    (existingKey) => existingKey.toLowerCase() === normalizedKey
  );
};

const setEnvDefault = (
  env: Record<string, string>,
  key: string,
  value: string | undefined,
  platform: NodeJS.Platform
): void => {
  if (!value || hasEnvKey(env, key, platform)) {
    return;
  }
  env[key] = value;
};

/** Build the inherited PTY environment plus optional Snow session defaults. */
export const buildPtyEnvironment = (
  sourceEnv: NodeJS.ProcessEnv,
  identity: PtySessionIdentity = {},
  platform: NodeJS.Platform = process.platform
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (typeof value !== "string" || ELECTRON_ONLY_ENV_KEYS.has(key)) {
      continue;
    }
    env[key] = value;
  }

  if (!env.TERM) {
    env.TERM = "xterm-256color";
  }

  const sessionId = identity.sessionId?.trim();
  if (!sessionId) {
    return env;
  }

  setEnvDefault(env, "SNOW_SESSION_ID", sessionId, platform);
  setEnvDefault(env, "TRELLIS_CONTEXT_ID", `snow-${sessionId}`, platform);
  setEnvDefault(env, "SNOW_CWD", identity.cwd?.trim(), platform);
  setEnvDefault(env, "SNOW_PLATFORM", "snow-app", platform);
  return env;
};
