import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const getCodexHome = (): string => {
  const configuredHome = process.env.CODEX_HOME?.trim();
  return configuredHome ? resolve(configuredHome) : join(homedir(), ".codex");
};

export const getCodexConfigPath = (): string => join(getCodexHome(), "config.toml");
