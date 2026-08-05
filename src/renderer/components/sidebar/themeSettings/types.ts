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
  accentColor: string;
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

/**
 * 流式光标配置。iconType 决定渲染形态：
 * - "dot"：默认脉动圆点
 * - "lucide"：使用内置 lucide 图标，由 lucideName 指定
 * - "custom"：使用用户上传的 SVG，由 svgPath 指定文件路径
 */
export type ThemeStreamCursor = {
  iconType: "dot" | "lucide" | "custom";
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

export type ThemePreset = {
  id: string;
  nameKey: string;
  defaultName: string;
  light: ThemePalette;
  dark: ThemePalette;
};

export type ThemeSettingsPanelProps = {
  onClose?: () => void;
};

export type ColorGroup = {
  titleKey: string;
  defaultTitle: string;
  roles: ColorRoleDefinition[];
};

export type ColorRoleDefinition = {
  role: keyof ThemePalette;
  labelKey: string;
  defaultLabel: string;
};
