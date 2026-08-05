import type { ApiConfigInput } from "../../../../preload";
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_REQUEST_METHOD,
} from "./apiSettingsConstants";
import {
  DEFAULT_AUTO_COMPRESS_THRESHOLD_PERCENT,
  calculateAutoCompressThresholdTokens,
  normalizeAutoCompressThresholdPercent,
} from "./autoCompressThreshold";
import {
  DEFAULT_THINKING_VALUE,
  THINKING_OPTIONS_BY_METHOD,
} from "../../mainContent/chatInput/constants";
import type { ApiConfigFormData } from "./types";

type RequestMethod = "chat" | "responses" | "gemini" | "anthropic";

const normalizeRequestMethod = (value: string): RequestMethod => {
  if (value === "responses" || value === "gemini" || value === "anthropic") {
    return value;
  }
  return "chat";
};

/**
 * Validates a thinking value against the available options for the given
 * request method. Returns the value itself when it is a known option for
 * the method, otherwise falls back to DEFAULT_THINKING_VALUE.
 */
export const resolveThinkingValue = (
  thinkingValue: string,
  requestMethod: string
): string => {
  const method = normalizeRequestMethod(requestMethod);
  const options = THINKING_OPTIONS_BY_METHOD[method];
  const isValid = options.some((option) => option.value === thinkingValue);
  return isValid ? thinkingValue : DEFAULT_THINKING_VALUE;
};

/**
 * Builds the configJson string with thinking configuration applied to the
 * correct snowcfg key for the given request method. Each method uses a
 * different key name and value-field name:
 *   chat      -> chatThinking.reasoning_effort
 *   responses -> responsesReasoning.effort
 *   gemini    -> geminiThinking.thinkingLevel
 *   anthropic -> thinking.effort
 */
const buildConfigJsonWithThinking = (
  thinkingValue: string,
  requestMethod: string,
  snowcfgBase: Record<string, unknown>
): string => {
  const method = normalizeRequestMethod(requestMethod);
  const isThinkingEnabled = thinkingValue !== "none";

  const snowcfg: Record<string, unknown> = { ...snowcfgBase };
  snowcfg.requestMethod = requestMethod || method;

  if (method === "anthropic") {
    snowcfg.thinking = {
      type: "adaptive",
      enabled: isThinkingEnabled,
      effort: thinkingValue,
    };
  } else if (method === "gemini") {
    snowcfg.geminiThinking = {
      enabled: isThinkingEnabled,
      thinkingLevel: thinkingValue,
    };
  } else if (method === "responses") {
    snowcfg.responsesReasoning = {
      enabled: isThinkingEnabled,
      effort: thinkingValue,
    };
  } else {
    snowcfg.chatThinking = {
      enabled: isThinkingEnabled,
      reasoning_effort: thinkingValue,
    };
  }

  return JSON.stringify({ snowcfg });
};

/**
 * Extracts the thinking value from a configJson string, reading the correct
 * snowcfg key based on the request method. Falls back to DEFAULT_THINKING_VALUE
 * when the config is missing or the thinking section is absent.
 */
export const extractThinkingValueFromConfigJson = (
  configJson: string,
  requestMethod: string
): string => {
  try {
    const parsed = JSON.parse(configJson);
    const snowcfg = parsed?.snowcfg;
    if (typeof snowcfg !== "object" || snowcfg === null) {
      return DEFAULT_THINKING_VALUE;
    }

    const method = normalizeRequestMethod(requestMethod);
    let section: Record<string, unknown> | undefined;

    if (method === "anthropic") {
      section = snowcfg.thinking;
    } else if (method === "gemini") {
      section = snowcfg.geminiThinking;
    } else if (method === "responses") {
      section = snowcfg.responsesReasoning;
    } else {
      section = snowcfg.chatThinking;
    }

    if (typeof section !== "object" || section === null) {
      return DEFAULT_THINKING_VALUE;
    }

    if (section.enabled === false) {
      return "none";
    }

    const valueKey =
      method === "anthropic"
        ? "effort"
        : method === "gemini"
        ? "thinkingLevel"
        : method === "responses"
        ? "effort"
        : "reasoning_effort";

    const value = section[valueKey];
    return typeof value === "string" && value.trim()
      ? value
      : DEFAULT_THINKING_VALUE;
  } catch {
    return DEFAULT_THINKING_VALUE;
  }
};

export const emptyApiConfigForm = (
  index: number,
  active: boolean
): ApiConfigFormData => ({
  profileName: `manual-${index}`,
  displayName: "",
  baseUrl: DEFAULT_API_BASE_URL,
  baseUrlMode: "auto",
  apiKey: "",
  requestMethod: DEFAULT_REQUEST_METHOD,
  advancedModel: "",
  basicModel: "",
  isActive: active,
  supportsVision: true,
  visionBaseUrl: "",
  visionApiKey: "",
  visionRequestMethod: DEFAULT_REQUEST_METHOD,
  visionModel: "",
  maxContextTokens: "",
  maxTokens: "",
  streamIdleTimeoutSec: "",
  enableAutoCompress: true,
  autoCompressThreshold: String(DEFAULT_AUTO_COMPRESS_THRESHOLD_PERCENT),
  maxRetries: "5",
  retryBaseDelayMs: "3000",
  systemPromptIdsJson: "",
  customHeaderSchemeId: "",
  thinkingValue: DEFAULT_THINKING_VALUE,
});

export const parseOptionalInteger = (value: string): number | null => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

export function toApiConfigPayload(
  data: ApiConfigFormData,
  isActive: boolean,
  configCount: number
): ApiConfigInput {
  const profileName = data.profileName.trim();
  const displayName = data.displayName.trim() || profileName;
  const baseUrl = data.baseUrl.trim() || DEFAULT_API_BASE_URL;
  const requestMethod = data.requestMethod.trim() || DEFAULT_REQUEST_METHOD;
  const advancedModel = data.advancedModel.trim();
  const basicModel = data.basicModel.trim();
  const visionRequestMethod = data.visionRequestMethod.trim() || requestMethod;
  const autoCompressThresholdPercent = normalizeAutoCompressThresholdPercent(
    data.autoCompressThreshold
  );
  const autoCompressThresholdTokens = calculateAutoCompressThresholdTokens(
    data.maxContextTokens,
    autoCompressThresholdPercent
  );
  const configJson = buildConfigJsonWithThinking(
    data.thinkingValue || DEFAULT_THINKING_VALUE,
    requestMethod,
    {
      baseUrl,
      baseUrlMode: data.baseUrlMode,
      requestMethod,
      advancedModel,
      basicModel,
      supportsVision: data.supportsVision,
      maxContextTokens:
        parseOptionalInteger(data.maxContextTokens) ?? undefined,
      maxTokens: parseOptionalInteger(data.maxTokens) ?? undefined,
      streamIdleTimeoutSec:
        parseOptionalInteger(data.streamIdleTimeoutSec) ?? undefined,
      enableAutoCompress: data.enableAutoCompress,
      autoCompressThresholdPercent,
      autoCompressThreshold: autoCompressThresholdTokens ?? undefined,
    }
  );

  return {
    profileName,
    displayName,
    isActive: isActive || configCount === 0,
    baseUrl,
    baseUrlMode: data.baseUrlMode || "auto",
    apiKey: data.apiKey,
    requestMethod,
    advancedModel,
    basicModel,
    supportsVision: data.supportsVision,
    visionBaseUrl: data.visionBaseUrl.trim(),
    visionBaseUrlMode: "auto",
    visionApiKey: data.visionApiKey,
    visionRequestMethod,
    visionModel: data.visionModel.trim(),
    maxContextTokens: parseOptionalInteger(data.maxContextTokens),
    maxTokens: parseOptionalInteger(data.maxTokens),
    streamIdleTimeoutSec: parseOptionalInteger(data.streamIdleTimeoutSec),
    enableAutoCompress: data.enableAutoCompress,
    autoCompressThreshold: autoCompressThresholdTokens,
    maxRetries: parseOptionalInteger(data.maxRetries),
    retryBaseDelayMs: parseOptionalInteger(data.retryBaseDelayMs),
    systemPromptIdsJson: data.systemPromptIdsJson,
    customHeaderSchemeId: data.customHeaderSchemeId,
    configJson,
    source: "manual",
  };
}
