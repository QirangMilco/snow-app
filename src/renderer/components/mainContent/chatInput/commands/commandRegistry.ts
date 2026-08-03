import { createClearCommand } from "./ClearCommand";
import { createCodebaseCommand } from "./CodebaseCommand";
import { createCompactCommand } from "./CompactCommand";
import { createFileChangesCommand } from "./FileChangesCommand";
import { createMcpCommand } from "./McpCommand";
import { createRoleCommand } from "./RoleCommand";
import { createSensitiveCommandsCommand } from "./SensitiveCommandsCommand";
import { createSkillsCommand } from "./SkillsCommand";
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
]);

type ChatCommandLabels = {
  clearDescription: string;
  codebaseDescription: string;
  codebaseNoProject: string;
  compactDescription: string;
  fileChangesDescription: string;
  mcpDescription: string;
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
  onOpenSensitiveCommandsPanel: () => void;
  onOpenSkillsPanel: () => void;
  onOpenCodebasePanel: () => void;
  model?: string;
  apiProfile?: string;
  compactDisabled: boolean;
  fileChangesDisabled: boolean;
  mcpDisabled: boolean;
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
  onOpenSensitiveCommandsPanel,
  onOpenSkillsPanel,
  onOpenCodebasePanel,
  model,
  apiProfile,
  compactDisabled,
  fileChangesDisabled,
  mcpDisabled,
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

  return commands;
};
