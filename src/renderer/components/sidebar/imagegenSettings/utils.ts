import {
  DEFAULT_IMAGE_GEN_CHANNEL,
  DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
  DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
  IMAGE_GEN_MAX_CONCURRENT_RANGE,
  IMAGE_GEN_TIMEOUT_RANGE,
} from "./constants";
import type {
  ImageGenChannelValue,
  ImageGenProvider,
  ImageGenSettingsForm,
  ImageGenSettingsValue,
} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const toText = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

/** 解析最大并发生成数：非法/缺失回退默认值，超出范围时收敛到边界。 */
const toConcurrentCount = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_IMAGE_GEN_MAX_CONCURRENT;
  }
  const { min, max } = IMAGE_GEN_MAX_CONCURRENT_RANGE;
  return Math.min(max, Math.max(min, Math.round(value)));
};

/** 解析生图请求超时（秒）：非法/缺失回退默认值，超出范围时收敛到边界。 */
const toTimeoutSecs = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_IMAGE_GEN_TIMEOUT_SECS;
  }
  const { min, max } = IMAGE_GEN_TIMEOUT_RANGE;
  return Math.min(max, Math.max(min, Math.round(value)));
};

const readProvider = (
  value: unknown,
  fallback: ImageGenProvider
): ImageGenProvider => (value === "gemini" ? "gemini" : fallback);

/** 解析单个渠道的原始字段。 */
const readChannel = (source: unknown): ImageGenChannelValue => {
  if (!isRecord(source)) {
    return { ...DEFAULT_IMAGE_GEN_CHANNEL };
  }
  return {
    id: toText(source.id, DEFAULT_IMAGE_GEN_CHANNEL.id),
    name: toText(source.name, DEFAULT_IMAGE_GEN_CHANNEL.name),
    provider: readProvider(source.provider, DEFAULT_IMAGE_GEN_CHANNEL.provider),
    enabled: toBoolean(source.enabled, DEFAULT_IMAGE_GEN_CHANNEL.enabled),
    baseUrl: toText(source.baseUrl, DEFAULT_IMAGE_GEN_CHANNEL.baseUrl),
    apiKey: toText(source.apiKey, DEFAULT_IMAGE_GEN_CHANNEL.apiKey),
    model: toText(source.model, DEFAULT_IMAGE_GEN_CHANNEL.model),
    defaultSize: toText(
      source.defaultSize,
      DEFAULT_IMAGE_GEN_CHANNEL.defaultSize
    ),
    defaultQuality: toText(
      source.defaultQuality,
      DEFAULT_IMAGE_GEN_CHANNEL.defaultQuality
    ),
    outputFormat: toText(
      source.outputFormat,
      DEFAULT_IMAGE_GEN_CHANNEL.outputFormat
    ),
    webSearch: toBoolean(source.webSearch, DEFAULT_IMAGE_GEN_CHANNEL.webSearch),
    defaultStream: toBoolean(
      source.defaultStream,
      DEFAULT_IMAGE_GEN_CHANNEL.defaultStream
    ),
  };
};

/** 生成新的渠道 ID（前端使用；旧数据无 id 或新建渠道时调用）。 */
export const generateChannelId = (
  provider: ImageGenProvider,
  index = 0
): string => {
  const random = Math.random().toString(36).slice(2, 8);
  return `${provider}-${random}${index > 0 ? `-${index}` : ""}`;
};

/** 迁移旧格式渠道（旧双渠道键 "openai"/"gemini" 即协议类型）。 */
const migrateLegacyChannel = (
  provider: ImageGenProvider,
  source: unknown
): ImageGenChannelValue => {
  const channel = readChannel(source);
  if (!channel.id) {
    channel.id = provider;
  }
  channel.provider = provider;
  return channel;
};

/** 将 system_settings 原始 JSON 字符串解析为规范化设置（含旧格式迁移）。 */
export const readImageGenSettingsJson = (
  raw: string | null
): ImageGenSettingsValue => {
  if (!raw) {
    return {
      channels: [],
      maxConcurrentImages: DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
      timeoutSecs: DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
    };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return {
        channels: [],
        maxConcurrentImages: DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
        timeoutSecs: DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
      };
    }

    // 新版多渠道格式：{ channels: [...] }
    if (Array.isArray(parsed.channels)) {
      const channels = parsed.channels.map((item, index) => {
        const channel = readChannel(item);
        if (!channel.id) {
          channel.id = generateChannelId(channel.provider, index);
        }
        return channel;
      });
      return {
        channels,
        maxConcurrentImages: toConcurrentCount(parsed.maxConcurrentImages),
        timeoutSecs: toTimeoutSecs(parsed.timeoutSecs),
      };
    }

    // 旧版双渠道格式：{ openai: {...}, gemini: {...} }
    if (parsed.openai || parsed.gemini) {
      const channels: ImageGenChannelValue[] = [];
      if (parsed.openai) {
        channels.push(migrateLegacyChannel("openai", parsed.openai));
      }
      if (parsed.gemini) {
        channels.push(migrateLegacyChannel("gemini", parsed.gemini));
      }
      return {
        channels,
        maxConcurrentImages: DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
        timeoutSecs: DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
      };
    }

    // 旧版单渠道格式迁移：顶层 provider/baseUrl/apiKey/model/...
    const oldProvider = toText(parsed.provider, "");
    const oldBaseUrl = toText(parsed.baseUrl, "");
    const isGemini =
      oldProvider === "gemini" ||
      oldBaseUrl.includes("generativelanguage") ||
      oldBaseUrl.includes("googleapis.com");
    const legacy = migrateLegacyChannel(isGemini ? "gemini" : "openai", {
      ...parsed,
      enabled: true,
    });
    return {
      channels: [legacy],
      maxConcurrentImages: DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
      timeoutSecs: DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
    };
  } catch {
    return {
      channels: [],
      maxConcurrentImages: DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
      timeoutSecs: DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
    };
  }
};

/** 存储值 -> 表单（深拷贝渠道数组）。 */
export const toImageGenForm = (
  settings: ImageGenSettingsValue
): ImageGenSettingsForm => ({
  channels: settings.channels.map((channel) => ({ ...channel })),
  maxConcurrentImages: settings.maxConcurrentImages,
  timeoutSecs: settings.timeoutSecs,
});

/** 表单 -> 存储 JSON 字符串（channels 数组 + 最大并发生成数）。 */
export const toImageGenSettingsJson = (form: ImageGenSettingsForm): string =>
  JSON.stringify({
    channels: form.channels.map((channel) => ({
      id: channel.id.trim(),
      name: channel.name.trim(),
      provider: channel.provider,
      enabled: channel.enabled,
      baseUrl: channel.baseUrl.trim(),
      apiKey: channel.apiKey.trim(),
      model: channel.model.trim(),
      defaultSize: channel.defaultSize.trim(),
      defaultQuality: channel.defaultQuality.trim(),
      outputFormat: channel.outputFormat.trim(),
      webSearch: channel.webSearch,
      defaultStream: channel.defaultStream,
    })),
    maxConcurrentImages: toConcurrentCount(form.maxConcurrentImages),
    timeoutSecs: toTimeoutSecs(form.timeoutSecs),
  });
