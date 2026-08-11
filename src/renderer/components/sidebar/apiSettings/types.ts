import type { ApiConfigRecord } from "../../../../preload";

export type ApiSettingsPanelProps = {
  onClose?: () => void;
};

export type ApiConfigFormData = {
  profileName: string;
  displayName: string;
  baseUrl: string;
  baseUrlMode: string;
  apiKey: string;
  requestMethod: string;
  advancedModel: string;
  basicModel: string;
  isActive: boolean;
  supportsVision: boolean;
  visionBaseUrl: string;
  visionApiKey: string;
  visionRequestMethod: string;
  visionModel: string;
  maxContextTokens: string;
  maxTokens: string;
  streamIdleTimeoutSec: string;
  enableAutoCompress: boolean;
  autoCompressThreshold: string;
  maxRetries: string;
  retryBaseDelayMs: string;
  partialRetryMaxChars: string;
  systemPromptIdsJson: string;
  customHeaderSchemeId: string;
  thinkingValue: string;
  /** 1M 上下文开关（anthropic 请求方式）。独立存储于 snowcfg.enable1mContext，
   *  开启后所有 anthropic 请求都会携带 context-1m beta 头，不依赖模型名标记。 */
  oneMContext: boolean;
  responsesVerbosity: string;
  responsesFastMode: boolean;
  googleSearch: boolean;
  visionGoogleSearch: boolean;
  visionThinkingEnabled: boolean;
  visionThinkingEffort: string;
  visionMaxTokens: string;
  configJson: string;
};

export type ApiConfigItem = ApiConfigRecord;
