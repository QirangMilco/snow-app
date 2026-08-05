/** 渠道协议类型：openai = OpenAI 兼容 Images API；gemini = Google Gemini Imagen。 */
export type ImageGenProvider = "openai" | "gemini";

/** 单个生图渠道（支持任意多个，每个渠道独立配置自己的端点/密钥/模型）。 */
export type ImageGenChannelValue = {
  /** 渠道唯一 ID（前端生成；旧数据迁移时用协议名），供 provider 参数引用。 */
  id: string;
  /** 用户自定义显示名（留空时回退到协议名）。 */
  name: string;
  /** 协议类型（决定请求协议与默认端点）。 */
  provider: ImageGenProvider;
  /** 渠道启用开关（未启用时该渠道不可用）。 */
  enabled: boolean;
  /** 留空 = 使用服务商官方默认端点。 */
  baseUrl: string;
  apiKey: string;
  /** 绘图模型；留空时该渠道不可用（无内置默认）。 */
  model: string;
  defaultSize: string;
  defaultQuality: string;
  outputFormat: string;
  /** Gemini 联网搜索（Grounding with Google Search），仅 Gemini 生效。 */
  webSearch: boolean;
  /** 默认流式预览（生成过程实时显示中间图），工具参数 stream 可覆盖。 */
  defaultStream: boolean;
};

/** 生图设置：任意多个独立渠道（数组顺序即优先级），可同时启用。 */
export type ImageGenSettingsValue = {
  channels: ImageGenChannelValue[];
  /**
   * 同一批次生图请求的最大并发数（1-8）。AI 一次请求多张图片时，
   * 最多同时发起该数量的生成请求，其余排队（完成一张补一张）。
   * 旧数据缺失该字段时回退默认值（4）。
   */
  maxConcurrentImages: number;
  /**
   * 生图请求超时（秒，60-3600）。单次生成/编辑请求（含流式）的最长
   * 等待时间，超时后请求被中断。复杂提示词或高分辨率（2K/4K）生成
   * 可能超过 3 分钟，默认 300 秒（5 分钟）；旧数据缺失时回退默认值。
   */
  timeoutSecs: number;
};

/** 设置表单（与存储值同构）。 */
export type ImageGenSettingsForm = ImageGenSettingsValue;

export type ImageGenSettingsPanelProps = {
  onClose?: () => void;
};
