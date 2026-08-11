import type { LucideIcon } from "lucide-react";

export type ChatCommand = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** 附加搜索关键词（如各语言版本的描述），用于指令面板过滤 */
  searchKeywords?: string[];
  disabled?: boolean;
  execute: () => void;
};
