import { createClearCommand } from "./ClearCommand";
import { createCodebaseCommand } from "./CodebaseCommand";
import { createCompactCommand } from "./CompactCommand";
import { createFileChangesCommand } from "./FileChangesCommand";
import { createMcpCommand } from "./McpCommand";
import { createReviewCommand } from "./ReviewCommand";
import { createRoleCommand } from "./RoleCommand";
import { createSensitiveCommandsCommand } from "./SensitiveCommandsCommand";
import { createSkillsCommand } from "./SkillsCommand";
import { SUPPORTED_LOCALES, resources } from "../../../../i18n";
import type { ChatCommand } from "./types";

/**
 * 运行中状态下禁止执行的指令 ID 列表。
 * 运行中时这些指令会被自动禁用（不可选中、不可执行）。
 * 后续新增指令若需在运行中禁用，只需在此列表中追加其 id。
 */
export const RUNNING_DISABLED_COMMAND_IDS: ReadonlySet<string> = new Set([
  "compact",
  "role",
  "sensitive-commands",
  "skills",
  "codebase",
  "mcp",
  "review",
]);

/**
 * 指令描述对应的 i18n key 映射（含无项目等禁用态变体）。
 * 用于跨语言搜索：过滤时除当前语言的 description 外，
 * 还会匹配所有语言版本的描述文本（如中文界面下输入 /new 也能搜到 clear）。
 */
const COMMAND_DESCRIPTION_KEYS: Record<string, string[]> = {
  clear: ["chatCommand.clearDescription"],
  changes: ["chatCommand.fileChangesDescription"],
  mcp: ["chatCommand.mcpDescription", "chatCommand.mcpNoProject"],
  role: ["chatCommand.roleDescription", "chatCommand.roleNoProject"],
  "sensitive-commands": [
    "chatCommand.sensitiveCommandsDescription",
    "chatCommand.sensitiveCommandsNoProject",
  ],
  skills: ["chatCommand.skillsDescription", "chatCommand.skillsNoProject"],
  codebase: ["chatCommand.codebaseDescription", "chatCommand.codebaseNoProject"],
  review: [
    "chatCommand.reviewDescription",
    "chatCommand.reviewNoProject",
    "chatCommand.reviewNewChatOnly",
  ],
  compact: ["chatCommand.compactDescription"],
};

/** 收集指定 i18n key 在所有语言下的描述文本（去重）作为搜索关键词 */
const collectSearchKeywords = (keys: string[]): string[] => {
  const keywords = new Set<string>();
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of keys) {
      const text = resources[locale][key];
      if (text) {
        keywords.add(text);
      }
    }
  }
  return [...keywords];
};

type ChatCommandLabels = {
  clearDescription: string;
  codebaseDescription: string;
  codebaseNoProject: string;
  compactDescription: string;
  fileChangesDescription: string;
  mcpDescription: string;
  reviewDescription: string;
  reviewNoProject: string;
  roleDescription: string;
  roleNoProject: string;
  sensitiveCommandsDescription: string;
  skillsDescription: string;
};

type CreateChatCommandsOptions = {
  onNewChat: () => void;
  onCompactConversation?: (
    model?: string,
    apiProfile?: string
  ) => void | Promise<void>;
  onOpenFileChangesPanel: () => void;
  onOpenMcpPanel: () => void;
  onOpenRolePanel: () => void;
  onOpenReviewPanel: () => void;
  onOpenSensitiveCommandsPanel: () => void;
  onOpenSkillsPanel: () => void;
  onOpenCodebasePanel: () => void;
  model?: string;
  apiProfile?: string;
  compactDisabled: boolean;
  fileChangesDisabled: boolean;
  mcpDisabled: boolean;
  reviewDisabled: boolean;
  roleDisabled: boolean;
  sensitiveCommandsDisabled: boolean;
  skillsDisabled: boolean;
  codebaseDisabled: boolean;
  isRunning?: boolean;
  labels: ChatCommandLabels;
};

export const createChatCommands = ({
  onNewChat,
  onCompactConversation,
  onOpenFileChangesPanel,
  onOpenMcpPanel,
  onOpenRolePanel,
  onOpenReviewPanel,
  onOpenSensitiveCommandsPanel,
  onOpenSkillsPanel,
  onOpenCodebasePanel,
  model,
  apiProfile,
  compactDisabled,
  fileChangesDisabled,
  mcpDisabled,
  reviewDisabled,
  roleDisabled,
  sensitiveCommandsDisabled,
  skillsDisabled,
  codebaseDisabled,
  isRunning = false,
  labels,
}: CreateChatCommandsOptions): ChatCommand[] => {
  const isRunningDisabled = (id: string): boolean =>
    isRunning && RUNNING_DISABLED_COMMAND_IDS.has(id);

  const commands: ChatCommand[] = [
    createClearCommand(onNewChat, labels.clearDescription),
    {
      ...createFileChangesCommand(
        onOpenFileChangesPanel,
        labels.fileChangesDescription,
        fileChangesDisabled
      ),
      disabled: fileChangesDisabled,
    },
    {
      ...createMcpCommand(onOpenMcpPanel, labels.mcpDescription, mcpDisabled),
      disabled: mcpDisabled || isRunningDisabled("mcp"),
    },
    {
      ...createRoleCommand(
        onOpenRolePanel,
        roleDisabled ? labels.roleNoProject : labels.roleDescription,
        roleDisabled
      ),
      disabled: roleDisabled || isRunningDisabled("role"),
    },
    {
      ...createSensitiveCommandsCommand(
        onOpenSensitiveCommandsPanel,
        labels.sensitiveCommandsDescription,
        sensitiveCommandsDisabled
      ),
      disabled: sensitiveCommandsDisabled || isRunningDisabled("sensitive-commands"),
    },
    {
      ...createSkillsCommand(
        onOpenSkillsPanel,
        labels.skillsDescription,
        skillsDisabled
      ),
      disabled: skillsDisabled || isRunningDisabled("skills"),
    },
    {
      ...createCodebaseCommand(
        onOpenCodebasePanel,
        codebaseDisabled ? labels.codebaseNoProject : labels.codebaseDescription,
        codebaseDisabled
      ),
      disabled: codebaseDisabled || isRunningDisabled("codebase"),
    },
    {
      // review 的描述由调用方根据禁用原因预先计算（仅新建会话 / 无项目）。
      ...createReviewCommand(
        onOpenReviewPanel,
        labels.reviewDescription,
        reviewDisabled
      ),
      disabled: reviewDisabled || isRunningDisabled("review"),
    },
  ];

  if (onCompactConversation) {
    commands.push({
      ...createCompactCommand(
        onCompactConversation,
        model,
        apiProfile,
        labels.compactDescription,
        compactDisabled
      ),
      disabled: compactDisabled || isRunningDisabled("compact"),
    });
  }

  // 附加跨语言搜索关键词：过滤指令时支持按任意语言版本的描述匹配
  for (const command of commands) {
    const keys = COMMAND_DESCRIPTION_KEYS[command.id];
    if (keys) {
      command.searchKeywords = collectSearchKeywords(keys);
    }
  }

  return commands;
};
