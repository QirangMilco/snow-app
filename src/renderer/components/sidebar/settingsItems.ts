import {
  Boxes,
  ChartColumn,
  EyeOff,
  Globe,
  FishingHook,
  Keyboard,
  List,
  MessageSquareText,
  Palette,
  Plug,
  Puzzle,
  ScrollText,
  Search,
  Sparkles,
  ShieldAlert,
  Terminal,
  Users,
  Wand2,
} from "lucide-react";

import type { MainContentView } from "../mainContent/types";

export type SettingsItem = {
  id: string;
  icon: React.ComponentType<{
    size?: number;
    strokeWidth?: number;
    className?: string;
  }>;
  labelKey: string;
  defaultLabel: string;
  view: MainContentView;
};

export const SETTINGS_ITEMS: SettingsItem[] = [
  {
    id: "api",
    icon: Plug,
    labelKey: "settings.apiSettings",
    defaultLabel: "API settings",
    view: "api-settings",
  },
  {
    id: "proxy",
    icon: Globe,
    labelKey: "settings.proxySettings",
    defaultLabel: "Proxy settings",
    view: "proxy-browser-settings",
  },
  {
    id: "codebase",
    icon: Search,
    labelKey: "settings.codebaseSettings",
    defaultLabel: "Codebase settings",
    view: "codebase-settings",
  },
  {
    id: "systemprompt",
    icon: MessageSquareText,
    labelKey: "settings.systemPromptSettings",
    defaultLabel: "System prompt",
    view: "system-prompt-settings",
  },
  {
    id: "featureprompts",
    icon: Wand2,
    labelKey: "settings.featurePromptsSettings",
    defaultLabel: "Feature prompts",
    view: "feature-prompts-settings",
  },
  {
    id: "builtin-services",
    icon: Boxes,
    labelKey: "settings.builtinServicesSettings",
    defaultLabel: "Built-in services",
    view: "builtin-services-settings",
  },
  {
    id: "customheaders",
    icon: List,
    labelKey: "settings.customHeadersSettings",
    defaultLabel: "Custom headers",
    view: "custom-headers-settings",
  },
  {
    id: "mcp",
    icon: Puzzle,
    labelKey: "settings.mcpSettings",
    defaultLabel: "MCP settings",
    view: "mcp-settings",
  },
  {
    id: "skills",
    icon: Sparkles,
    labelKey: "settings.skillsSettings",
    defaultLabel: "Skills settings",
    view: "skills-settings",
  },
  {
    id: "subagent",
    icon: Users,
    labelKey: "settings.subAgentSettings",
    defaultLabel: "Sub-agent settings",
    view: "sub-agent-settings",
  },
  {
    id: "sensitive-commands",
    icon: ShieldAlert,
    labelKey: "settings.sensitiveCommands",
    defaultLabel: "Sensitive commands",
    view: "sensitive-command-settings",
  },
  {
    id: "hooks",
    icon: FishingHook,
    labelKey: "settings.hooksSettings",
    defaultLabel: "Hooks settings",
    view: "hooks-settings",
  },
  {
    id: "theme",
    icon: Palette,
    labelKey: "settings.themeSettings",
    defaultLabel: "Theme settings",
    view: "theme-settings",
  },
  {
    id: "terminal",
    icon: Terminal,
    labelKey: "settings.terminalSettings",
    defaultLabel: "Terminal settings",
    view: "terminal-settings",
  },
  {
    id: "keyboard-shortcuts",
    icon: Keyboard,
    labelKey: "settings.keyboardShortcuts",
    defaultLabel: "Keyboard shortcuts",
    view: "keyboard-shortcuts-settings",
  },
  {
    id: "privacy",
    icon: EyeOff,
    labelKey: "settings.privacySettings",
    defaultLabel: "Privacy settings",
    view: "privacy-settings",
  },
  {
    id: "usage",
    icon: ChartColumn,
    labelKey: "settings.usageSettings",
    defaultLabel: "Usage statistics",
    view: "usage-settings",
  },
  {
    id: "system-logs",
    icon: ScrollText,
    labelKey: "settings.systemLogs",
    defaultLabel: "System logs",
    view: "system-logs",
  },
];

/**
 * Set of all MainContentView values backed by a settings panel. Used to detect
 * when the active view is a settings page (e.g. to reset to chat on exit).
 */
export const SETTINGS_VIEW_IDS: ReadonlySet<MainContentView> = new Set(
  SETTINGS_ITEMS.map((item) => item.view)
);
