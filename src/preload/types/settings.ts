export type ProxyBrowserSettings = {
  enabled: boolean;
  host: string;
  port: number;
  browserPath: string;
  browserDebugPort: number;
  searchEngine: string;
};

export type TerminalSettings = {
  shellPath: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  lineHeight: number;
  proxy: string;
};

export type PrivacyApiConfig = {
  url: string;
  apiKey: string;
  model: string;
};

export type PrivacyToolResultsConfig = {
  tools: string[];
};

export type PrivacySettings = {
  enabled: boolean;
  mode: string;
  api: PrivacyApiConfig;
  toolResults: PrivacyToolResultsConfig;
};

export type ThemeMode = "system" | "light" | "dark";

export type ThemePalette = {
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  bgHover: string;
  bgActive: string;
  chromeBg: string;
  appBg: string;
  borderColor: string;
  borderLight: string;
  borderSubtle: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textMuted: string;
  accentGreen: string;
  accentGreenBg: string;
  accentGreenText: string;
  accentRed: string;
  accentRedBg: string;
  accentRedText: string;
  accentBlue: string;
  accentBlueBg: string;
  accentBlueText: string;
  onSolid: string;
  selectionBg: string;
  focusRing: string;
};

export type CustomTheme = {
  light: ThemePalette;
  dark: ThemePalette;
};

export type ThemeBackground = {
  enabled: boolean;
  imagePath: string;
  opacity: number;
  blur: number;
};

export type ThemeStreamCursor = {
  iconType: string;
  lucideName: string;
  svgPath: string;
  iconSize: number;
};

export type ThemeSettings = {
  mode: ThemeMode;
  presetId: string;
  custom: CustomTheme;
  background: ThemeBackground;
  fontFamily: string;
  streamCursor: ThemeStreamCursor;
};

export type DetectedTerminal = {
  name: string;
  path: string;
  family: "powershell" | "cmd" | "wsl" | "posix";
};

export type CodebaseSettingsInput = {
  profileName: string;
  embeddingType: string;
  embeddingModelName: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingDimensions: number;
  batchMaxLines: number;
  batchConcurrency: number;
  chunkingMaxLinesPerChunk: number;
  chunkingMinLinesPerChunk: number;
  chunkingMinCharsPerChunk: number;
  chunkingOverlapLines: number;
  rerankingModelName: string;
  rerankingBaseUrl: string;
  rerankingApiKey: string;
  rerankingContextLength: number;
  rerankingTopN: number;
  configJson: string;
  source: string;
};

export type CodebaseProjectScopeSettings = {
  projectId: string;
  enabled?: boolean;
  enableAgentReview?: boolean;
  enableReranking?: boolean;
};

export type UsageRecord = {
  id: string;
  conversationId: string;
  responseId: string;
  model: string;
  apiProfileName: string;
  apiConfigId: string;
  requestMethod: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  status: string;
  isSubAgent: boolean;
  directoryId: string;
  createdAt: string;
  totalTokens: number;
  effectiveCacheReadTokens: number;
  nonCachedInputTokens: number;
};

export type UsageRecordPage = {
  items: UsageRecord[];
  total: number;
};

export type UsageSummary = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalRequests: number;
  errorRequests: number;
  totalTokens: number;
  effectiveCacheReadTokens: number;
  nonCachedInputTokens: number;
};

export type DailyUsageBreakdown = {
  date: string;
  totalRequests: number;
  errorRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalTokens: number;
};

export type AppLogRecord = {
  id: string;
  level: string;
  module: string;
  func: string;
  line?: number;
  message: string;
  input: string;
  output: string;
  duration: string;
  context: string;
  error: string;
  source: string;
  createdAt: string;
};

export type AppLogPage = {
  items: AppLogRecord[];
  total: number;
};

export type CodebaseEmbedProgress = {
  phase: string;
  totalFiles: number;
  processedFiles: number;
  totalChunks: number;
  processedChunks: number;
  currentFile: string;
  error: string;
  elapsedMs: number;
};

export type CodebaseIndexStats = {
  totalChunks: number;
  totalFiles: number;
  totalSizeBytes: number;
  isIndexed: boolean;
};

export type CodebaseIndexedFile = {
  relativePath: string;
  filePath: string;
  chunkCount: number;
  startLine: number;
  endLine: number;
  sizeBytes: number;
  updatedAt: string;
};

export type CodebaseIndexedFilePage = {
  items: CodebaseIndexedFile[];
  total: number;
  page: number;
  pageSize: number;
};

export type CodebaseSphereRelatedFile = {
  index: number;
  similarity: number;
};

export type CodebaseSphereNode = {
  index: number;
  relativePath: string;
  chunkCount: number;
  startLine: number;
  endLine: number;
  sizeBytes: number;
  x: number;
  y: number;
  z: number;
  related: CodebaseSphereRelatedFile[];
};

export type CodebaseSphereEdge = {
  a: number;
  b: number;
  similarity: number;
};

export type CodebaseSphereLayout = {
  nodes: CodebaseSphereNode[];
  edges: CodebaseSphereEdge[];
};

export type CodebaseScanPreview = {
  fileCount: number;
  estimatedChunks: number;
  totalSizeBytes: number;
};

export type CodebaseSyncProgress = {
  phase: string;
  filesToEmbed: number;
  processedFiles: number;
  deletedFiles: number;
  skippedFiles: number;
  currentFile: string;
  error: string;
};

export type CodebaseSyncResult = {
  changed: boolean;
  embeddedFiles: number;
  deletedFiles: number;
  skippedFiles: number;
  error: string;
};

export type ResumableCodebaseSession = {
  sessionId: string;
  projectId: string;
  status: string;
  totalFiles: number;
  processedFiles: number;
  totalChunks: number;
  processedChunks: number;
  currentFile: string;
  error: string;
  createdAt: string;
  updatedAt: string;
};

export type SystemPromptItemInput = {
  promptId: string;
  name: string;
  content: string;
  isActive: boolean;
  sortOrder: number;
};

export type SystemPromptItemRecord = SystemPromptItemInput & {
  id: string;
  updatedAt: string;
};

/** 内置功能提示词记录（由 Rust 后端 listFeaturePrompts 返回）。 */
export type FeaturePromptRecord = {
  promptKey: string;
  name: string;
  description: string;
  content: string;
  defaultContent: string;
  isModified: boolean;
};

/** 内置 MCP 服务全局开关状态（serviceId -> enabled）。 */
export type BuiltinServicesStatus = Record<string, boolean>;

export type CustomHeaderSchemeInput = {
  schemeId: string;
  name: string;
  headersJson: string;
  isActive: boolean;
  sortOrder: number;
};

export type CustomHeaderSchemeRecord = CustomHeaderSchemeInput & {
  id: string;
  updatedAt: string;
};

export type SubAgentConfigInput = {
  agentId: string;
  name: string;
  description: string;
  systemPrompt: string;
  toolsJson: string;
  configProfile: string;
  builtin: boolean;
  sortOrder: number;
  source: string;
};

export type SubAgentConfigRecord = SubAgentConfigInput & {
  id: string;
  updatedAt: string;
};

export type SensitiveCommandConfigInput = {
  commandId: string;
  pattern: string;
  description: string;
  enabled: boolean;
  isPreset: boolean;
  sortOrder: number;
  source: string;
};
export type SensitiveCommandConfigRecord = SensitiveCommandConfigInput & {
  id: string;
  updatedAt: string;
};

export type ProjectSensitiveCommandConfigInput = {
  commandId: string;
  pattern: string;
  description: string;
  enabled: boolean;
  sortOrder: number;
};

export type ProjectSensitiveCommandConfigRecord =
  ProjectSensitiveCommandConfigInput & {
    inherited: boolean;
    globalEnabled: boolean;
    isPreset: boolean;
    source: string;
  };

// ===== Keyboard shortcuts =====

export type KeyboardShortcutAction =
  | "cancelSession"
  | "openSearch"
  | "openMemo"
  | "openTodo"
  | "cycleProject"
  | "openProjectExplorer";

export type KeyboardShortcutConfig = {
  /**
   * 平台无关的规范化按键绑定。
   * `mod` 代表平台主修饰键（macOS=Cmd，其他=Ctrl），主键用小写。
   * 例如 `mod+f`、`escape`、`mod+backtick`。
   */
  key: string;
  enabled: boolean;
  foregroundOnly: boolean;
};

export type KeyboardShortcutsSettings = {
  cancelSession: KeyboardShortcutConfig;
  openSearch: KeyboardShortcutConfig;
  openMemo: KeyboardShortcutConfig;
  openTodo: KeyboardShortcutConfig;
  cycleProject: KeyboardShortcutConfig;
  openProjectExplorer: KeyboardShortcutConfig;
};
