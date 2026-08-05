import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  NativeBridge,
  SystemPromptItemInput,
  SystemPromptItemRecord,
} from "../native/types";
import { SNOW_CLI_CONFIG_DIR } from "../snowCli/paths";
import { readJsonFile } from "../utils/jsonFile";
import { isRecord, toBoolean, toText } from "../utils/value";

const SNOW_CLI_SYSTEM_PROMPT_JSON_FILE = join(
  SNOW_CLI_CONFIG_DIR,
  "system-prompt.json"
);
const SNOW_CLI_SYSTEM_PROMPT_TXT_FILE = join(
  SNOW_CLI_CONFIG_DIR,
  "system-prompt.txt"
);

type SnowCliPromptItem = {
  id: string;
  name: string;
  content: string;
  createdAt?: string;
};

type SnowCliSystemPromptConfig = {
  active: string[];
  prompts: SnowCliPromptItem[];
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isPromptItem = (value: unknown): value is SnowCliPromptItem => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.content === "string"
  );
};

const normalizeConfig = (value: unknown): SnowCliSystemPromptConfig => {
  const source = isRecord(value) ? value : {};
  const rawActive = source.active;
  let active: string[] = [];

  if (typeof rawActive === "string" && rawActive.length > 0) {
    active = [rawActive];
  } else if (isStringArray(rawActive)) {
    active = rawActive;
  }

  const rawPrompts = source.prompts;
  const prompts: SnowCliPromptItem[] = [];

  if (Array.isArray(rawPrompts)) {
    for (const item of rawPrompts) {
      if (isPromptItem(item)) {
        prompts.push({
          id: item.id,
          name: item.name,
          content: item.content,
        });
      }
    }
  }

  return { active, prompts };
};

const toNativeInput = (
  prompt: SnowCliPromptItem,
  isActive: boolean,
  sortOrder: number
): SystemPromptItemInput => ({
  promptId: prompt.id,
  name: prompt.name.trim() || "Unnamed Prompt",
  content: prompt.content,
  isActive,
  sortOrder,
  scope: "global",
});

const persistSystemPromptConfig = async (
  native: NativeBridge,
  config: SnowCliSystemPromptConfig
): Promise<void> => {
  const activeSet = new Set(config.active);
  const existing = await native.listSystemPrompts();

  for (const item of existing) {
    if (!config.prompts.some((prompt) => prompt.id === item.promptId)) {
      await native.deleteSystemPrompt(item.promptId);
    }
  }

  for (const [index, prompt] of config.prompts.entries()) {
    const isActive = activeSet.has(prompt.id);
    await native.upsertSystemPrompt(toNativeInput(prompt, isActive, index));
  }
};

export const readSnowCliSystemPromptConfig = async (
  native: NativeBridge
): Promise<SystemPromptItemRecord[]> => {
  if (
    !existsSync(SNOW_CLI_SYSTEM_PROMPT_JSON_FILE) &&
    existsSync(SNOW_CLI_SYSTEM_PROMPT_TXT_FILE)
  ) {
    const txtContent = readFileSync(SNOW_CLI_SYSTEM_PROMPT_TXT_FILE, "utf8");
    const migrated: SnowCliSystemPromptConfig = {
      active: txtContent.trim().length > 0 ? ["default"] : [],
      prompts:
        txtContent.trim().length > 0
          ? [{ id: "default", name: "Default", content: txtContent }]
          : [],
    };
    await persistSystemPromptConfig(native, migrated);
    return native.listSystemPrompts();
  }

  if (!existsSync(SNOW_CLI_SYSTEM_PROMPT_JSON_FILE)) {
    return native.listSystemPrompts();
  }

  const config = readJsonFile(SNOW_CLI_SYSTEM_PROMPT_JSON_FILE);
  const normalized = normalizeConfig(config);
  await persistSystemPromptConfig(native, normalized);
  return native.listSystemPrompts();
};

export const normalizeSystemPromptItem = (
  value: unknown
): SystemPromptItemInput => {
  const source = isRecord(value) ? value : {};
  const promptId = toText(source.promptId).trim();
  const name = toText(source.name).trim();
  const content = toText(source.content);
  const isActive = toBoolean(source.isActive, false);
  const rawSortOrder = Number(source.sortOrder ?? 0);
  const sortOrder = Number.isInteger(rawSortOrder) ? rawSortOrder : 0;
  const scope = source.scope === "project" ? "project" : "global";
  const projectId = toText(source.projectId).trim();

  return {
    promptId: promptId || String(Date.now()),
    name: name || "Unnamed Prompt",
    content,
    isActive,
    sortOrder,
    scope,
    ...(scope === "project" && projectId ? { projectId } : {}),
  };
};
