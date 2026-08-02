import {
  AlertCircle,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Command,
  Target,
  Keyboard,
  Loader2,
  Paperclip,
  RefreshCw,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../i18n";
import type { ChatInputViewProps } from "./types";
import { TokenUsageRing } from "./TokenUsageRing";
import {
  createChangeChipHtml,
  createChipHtml,
  createCommitChipHtml,
  createImageChipHtml,
  insertHtmlAtSelection,
  insertLineBreak,
  readEditableContent,
  renumberImageChips as renumberImageChipsFn,
  type ChangeTag,
  type CommitTag,
  type FileTag,
  type ImageTag,
} from "./fileTagUtils";
import {
  FileMentionPopup,
  type FileMentionPopupHandle,
} from "./FileMentionPopup";
import { useDropdownDirection } from "./useDropdownDirection";
import { PlusMenu, type PlusMenuSection } from "./PlusMenu";
import { PendingMessages } from "./PendingMessages";
import { ProjectMcpPanel } from "./ProjectMcpPanel";
import { ProjectCodebasePanel } from "./ProjectCodebasePanel";
import { ProjectSensitiveCommandsPanel } from "./ProjectSensitiveCommandsPanel";
import { ProjectSkillsPanel } from "./ProjectSkillsPanel";
import { RoleEditorPanel } from "./RoleEditorPanel";
import { StreamMetrics } from "./StreamMetrics";
import { useChatConversationContext } from "../chatMessages";
import { CommandPanel, type CommandPanelHandle } from "./commands/CommandPanel";
import { createChatCommands } from "./commands/commandRegistry";
import type { ChatCommand } from "./commands/types";

export const ChatInputView = ({
  placeholder,
  projectId,
  projectName,
  value,
  textareaRef,
  apiConfigs,
  selectedApiProfile,
  modelMenuView,
  isSubAgentConversation,
  models,
  selectedModel,
  displayModel,
  isLoadingModels,
  modelError,
  isModelMenuOpen,
  isManualMode,
  manualValue,
  dropdownRef,
  runtimeApiConfig,
  requestMethod,
  thinkingOptions,
  thinkingValue,
  thinkingLabel,
  ActiveThinkingIcon,
  isLoadingApiConfig,
  isSavingThinking,
  thinkingError,
  labels,
  isStreaming,
  isAborting,
  tokenUsage,
  pendingMessages,
  onWithdrawPendingMessage,
  onSendPendingMessageNow,
  onCompactConversation,
  yoloMode,
  isUpdatingYoloMode,
  onYoloModeChange,
  onRefreshYoloMode,
  planMode,
  isUpdatingPlanMode,
  onPlanModeChange,
  onRefreshPlanMode,
  goalMode,
  isUpdatingGoalMode,
  onGoalModeChange,
  onRefreshGoalMode,
  goalModeTokenBudget,
  onGoalModeTokenBudgetChange,
  autoScrollEnabled,
  onAutoScrollChange,
  isCompacting,
  setManualValue,
  setIsManualMode,
  setModelMenuView,
  handleChange,
  handleSend,
  handleAbort,
  handleKeyDown,
  handleSelectModel,
  handleOpenManualMode,
  handleConfirmManualModel,
  handleManualKeyDown,
  handleRetryFetchModels,
  handleToggleModelMenu,
  handleSelectApiProfile,
  handleSelectThinking,
  restoreContent,
}: ChatInputViewProps): React.JSX.Element => {
  const { t } = useI18n();
  const {
    handleNewChat,
    messages,
    streamTokenCount,
    streamElapsedMs,
    streamTtftMs,
    streamStartedAt,
    isPaused,
    handlePause,
    handleResume,
  } = useChatConversationContext();
  const isDraggingOverRef = useRef(false);
  const [isMentionOpen, setIsMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const mentionAnchorRef = useRef<HTMLDivElement>(null);
  const mentionPopupRef = useRef<FileMentionPopupHandle>(null);
  const mentionStartOffsetRef = useRef<number>(-1);
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const commandPanelRef = useRef<CommandPanelHandle>(null);
  const commandTriggerRef = useRef<HTMLButtonElement>(null);
  const [isProjectMcpOpen, setIsProjectMcpOpen] = useState(false);
  const [isProjectSensitiveCommandsOpen, setIsProjectSensitiveCommandsOpen] =
    useState(false);
  const [isProjectSkillsOpen, setIsProjectSkillsOpen] = useState(false);
  const [isProjectCodebaseOpen, setIsProjectCodebaseOpen] = useState(false);
  const [isRoleEditorOpen, setIsRoleEditorOpen] = useState(false);
  const [isCustomThinkingMode, setIsCustomThinkingMode] = useState(false);
  const [customThinkingValue, setCustomThinkingValue] = useState("");

  // 菜单关闭时退出自定义思考强度输入
  useEffect(() => {
    if (!isModelMenuOpen) {
      setIsCustomThinkingMode(false);
    }
  }, [isModelMenuOpen]);

  const commands = useMemo(
    () =>
      createChatCommands({
        onNewChat: handleNewChat,
        onCompactConversation,
        onOpenMcpPanel: () => {
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsProjectMcpOpen(true);
        },
        onOpenRolePanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(true);
        },
        onOpenSensitiveCommandsPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsProjectSensitiveCommandsOpen(true);
        },
        onOpenSkillsPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsProjectSkillsOpen(true);
        },
        onOpenCodebasePanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsRoleEditorOpen(false);
          setIsProjectCodebaseOpen(true);
        },
        model: selectedModel || undefined,
        compactDisabled: messages.length === 0 || isCompacting,
        mcpDisabled: !projectId,
        roleDisabled: !projectId,
        sensitiveCommandsDisabled: !projectId,
        skillsDisabled: !projectId,
        codebaseDisabled: !projectId,
        isRunning: isStreaming,
        labels: {
          clearDescription: t("chatCommand.clearDescription"),
          compactDescription: t("chatCommand.compactDescription"),
          mcpDescription: projectId
            ? t("chatCommand.mcpDescription")
            : t("chatCommand.mcpNoProject"),
          roleDescription: t("chatCommand.roleDescription"),
          roleNoProject: t("chatCommand.roleNoProject"),
          sensitiveCommandsDescription: projectId
            ? t("chatCommand.sensitiveCommandsDescription")
            : t("chatCommand.sensitiveCommandsNoProject"),
          skillsDescription: projectId
            ? t("chatCommand.skillsDescription")
            : t("chatCommand.skillsNoProject"),
          codebaseDescription: t("chatCommand.codebaseDescription"),
          codebaseNoProject: t("chatCommand.codebaseNoProject"),
        },
      }),
    [
      handleNewChat,
      isCompacting,
      isStreaming,
      messages.length,
      onCompactConversation,
      projectId,
      selectedModel,
      t,
    ]
  );

  const [imagePreview, setImagePreview] = useState<{
    url: string;
    x: number;
    y: number;
  } | null>(null);
  const imagePreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const [imageLightbox, setImageLightbox] = useState<string | null>(null);

  const modelDropdownDir = useDropdownDirection(dropdownRef, isModelMenuOpen);
  const isCustomThinkingValue = !thinkingOptions.some(
    (option) => option.value === thinkingValue
  );

  const renumberImageChips = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      renumberImageChipsFn(el);
    }
  }, [textareaRef]);

  const syncContent = useCallback(() => {
    if (textareaRef.current) {
      renumberImageChips();
      const content = readEditableContent(textareaRef.current);
      handleChange(content);
      textareaRef.current.dataset.empty =
        content.trim() === "" ? "true" : "false";
    }
  }, [handleChange, renumberImageChips, textareaRef]);

  const insertFileTag = useCallback(
    (tag: FileTag) => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
      insertHtmlAtSelection(createChipHtml(tag));
      syncContent();
    },
    [syncContent, textareaRef]
  );

  const insertFileTags = useCallback(
    (tags: FileTag[]) => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
      const html = tags.map((tag) => createChipHtml(tag)).join(" ");
      insertHtmlAtSelection(html);
      syncContent();
    },
    [syncContent, textareaRef]
  );

  const deleteMentionQuery = useCallback(() => {
    const el = textareaRef.current;
    if (!el || mentionStartOffsetRef.current < 0) {
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }

    const range = selection.getRangeAt(0);
    const currentNode = range.startContainer;
    const currentOffset = range.startOffset;

    if (currentNode.nodeType !== Node.TEXT_NODE) {
      return;
    }

    const textNode = currentNode as Text;
    const start = mentionStartOffsetRef.current - 1;
    if (start < 0 || currentOffset <= start) {
      return;
    }

    range.setStart(textNode, start);
    range.setEnd(textNode, currentOffset);
    range.deleteContents();
    selection.removeAllRanges();
    selection.addRange(range);

    mentionStartOffsetRef.current = -1;
  }, [textareaRef]);

  const handleMentionSelect = useCallback(
    (tag: FileTag) => {
      deleteMentionQuery();
      insertFileTag(tag);
    },
    [deleteMentionQuery, insertFileTag]
  );

  const handleMentionSelectBatch = useCallback(
    (tags: FileTag[]) => {
      deleteMentionQuery();
      insertFileTags(tags);
    },
    [deleteMentionQuery, insertFileTags]
  );

  const handleCloseMention = useCallback(() => {
    setIsMentionOpen(false);
    setMentionQuery("");
    mentionStartOffsetRef.current = -1;
  }, []);

  const handleCloseCommand = useCallback(() => {
    setIsCommandOpen(false);
    setCommandQuery("");
  }, []);

  const handleToggleCommand = useCallback(() => {
    setIsCommandOpen((prev) => {
      const next = !prev;
      if (!next) {
        setCommandQuery("");
      }
      return next;
    });
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [textareaRef]);

  useEffect(() => {
    if (!isCommandOpen) {
      return;
    }
    const handleDocumentPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (commandTriggerRef.current?.contains(target)) {
        return;
      }
      const panelEl = document.querySelector(".chat-command-panel");
      if (panelEl?.contains(target)) {
        return;
      }
      handleCloseCommand();
    };
    document.addEventListener("mousedown", handleDocumentPointerDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentPointerDown);
    };
  }, [isCommandOpen, handleCloseCommand]);

  const handleCommandSelect = useCallback(
    (command: ChatCommand) => {
      if (command.disabled) {
        return;
      }
      handleCloseCommand();
      restoreContent("");
      command.execute();
    },
    [handleCloseCommand, restoreContent]
  );

  const handleMentionDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, tag: FileTag) => {
      event.dataTransfer.setData("application/json", JSON.stringify(tag));
      event.dataTransfer.effectAllowed = "copy";
    },
    []
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      isDraggingOverRef.current = false;
      if (textareaRef.current) {
        textareaRef.current.classList.remove("drag-over");
      }

      const jsonData = event.dataTransfer.getData("application/json");
      if (!jsonData) {
        return;
      }

      try {
        const parsed = JSON.parse(jsonData) as Record<string, unknown>;

        // 搜索结果组合拖拽：{ type: "file-tags", tags: FileTag[] }
        if (parsed.type === "file-tags" && Array.isArray(parsed.tags)) {
          const tags: FileTag[] = parsed.tags
            .filter(
              (item) =>
                item &&
                typeof item === "object" &&
                typeof (item as Record<string, unknown>).path === "string" &&
                typeof (item as Record<string, unknown>).name === "string"
            )
            .map((item) => {
              const t = item as Record<string, unknown>;
              const rawLines = t.lines;
              const lines = Array.isArray(rawLines)
                ? rawLines
                    .map((n) =>
                      typeof n === "number" ? n : Number.parseInt(String(n), 10)
                    )
                    .filter((n) => Number.isFinite(n) && n > 0)
                : undefined;
              return {
                path: t.path as string,
                name: t.name as string,
                isDirectory: t.isDirectory === true,
                lines: t.isDirectory === true ? undefined : lines,
              };
            });
          if (tags.length > 0) {
            insertFileTags(tags);
          }
          return;
        }

        // Commit tag: has "hash" and "repoPath" fields
        if (
          typeof parsed.hash === "string" &&
          typeof parsed.repoPath === "string" &&
          typeof parsed.shortHash === "string"
        ) {
          const tag: CommitTag = {
            hash: parsed.hash,
            shortHash: parsed.shortHash,
            author: typeof parsed.author === "string" ? parsed.author : "",
            date: typeof parsed.date === "string" ? parsed.date : "",
            message: typeof parsed.message === "string" ? parsed.message : "",
            repoPath: parsed.repoPath,
          };

          if (textareaRef.current) {
            textareaRef.current.focus();
          }

          insertHtmlAtSelection(createCommitChipHtml(tag));
          syncContent();
          return;
        }

        // Change tag: has "section", "path", "repoPath" and "status" fields
        if (
          typeof parsed.section === "string" &&
          (parsed.section === "staged" || parsed.section === "unstaged") &&
          typeof parsed.path === "string" &&
          typeof parsed.repoPath === "string" &&
          typeof parsed.status === "string"
        ) {
          const tag: ChangeTag = {
            repoPath: parsed.repoPath,
            path: parsed.path,
            section: parsed.section,
            status: parsed.status,
          };

          if (textareaRef.current) {
            textareaRef.current.focus();
          }

          insertHtmlAtSelection(createChangeChipHtml(tag));
          syncContent();
          return;
        }

        // File tag: has "path" and "name" fields
        if (
          typeof parsed.path === "string" &&
          typeof parsed.name === "string"
        ) {
          const rawLines = parsed.lines;
          const lines = Array.isArray(rawLines)
            ? rawLines
                .map((n) =>
                  typeof n === "number" ? n : Number.parseInt(String(n), 10)
                )
                .filter((n) => Number.isFinite(n) && n > 0)
            : undefined;
          const tag: FileTag = {
            path: parsed.path,
            name: parsed.name,
            isDirectory: parsed.isDirectory === true,
            lines: parsed.isDirectory === true ? undefined : lines,
          };

          if (textareaRef.current) {
            textareaRef.current.focus();
          }

          insertHtmlAtSelection(createChipHtml(tag));
          syncContent();
        }
      } catch {
        // Ignore invalid drag data
      }
    },
    [insertFileTags, syncContent, textareaRef]
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const jsonData = event.dataTransfer.types.includes("application/json");
      if (!jsonData) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (!isDraggingOverRef.current && textareaRef.current) {
        isDraggingOverRef.current = true;
        textareaRef.current.classList.add("drag-over");
      }
    },
    [textareaRef]
  );

  const handleDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (event.currentTarget === event.target) {
        isDraggingOverRef.current = false;
        if (textareaRef.current) {
          textareaRef.current.classList.remove("drag-over");
        }
      }
    },
    [textareaRef]
  );

  const checkInputTriggers = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      handleCloseMention();
      handleCloseCommand();
      return;
    }

    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    const offset = range.startOffset;

    if (node.nodeType !== Node.TEXT_NODE) {
      handleCloseMention();
      handleCloseCommand();
      return;
    }

    const textBefore = (node.textContent ?? "").slice(0, offset);
    const commandMatch = textBefore.match(/^\/([^\s]*)$/);
    if (commandMatch) {
      handleCloseMention();
      setIsCommandOpen(true);
      setCommandQuery(commandMatch[1]);
      return;
    }

    const mentionMatch = textBefore.match(/(?:^|\s)@([^\s]*)$/);
    if (mentionMatch) {
      const queryText = mentionMatch[1];
      const atOffset = offset - queryText.length - 1;

      setIsMentionOpen(true);
      mentionStartOffsetRef.current = atOffset + 1;
      setMentionQuery(queryText);
      handleCloseCommand();
      return;
    }

    handleCloseMention();
    handleCloseCommand();
  }, [handleCloseCommand, handleCloseMention]);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();

      const items = event.clipboardData.items;
      const imageItems: DataTransferItem[] = [];

      for (const item of items) {
        if (item.type.startsWith("image/")) {
          imageItems.push(item);
        }
      }

      if (imageItems.length > 0) {
        for (const imageItem of imageItems) {
          const file = imageItem.getAsFile();
          if (!file) {
            continue;
          }

          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            if (!dataUrl) {
              return;
            }

            const mimeMatch = file.type.match(/^image\/([a-z]+)$/);
            const ext = mimeMatch ? mimeMatch[1] : "png";
            const imageTag: ImageTag = {
              name: `image.${ext}`,
              dataUrl,
            };

            if (textareaRef.current) {
              textareaRef.current.focus();
            }
            insertHtmlAtSelection(createImageChipHtml(imageTag));
            syncContent();
          };
          reader.readAsDataURL(file);
        }
        return;
      }

      const text = event.clipboardData.getData("text/plain");
      if (!text) {
        return;
      }
      // 用浏览器原生 insertText 插入纯文本：配合 .input-field-editable 的
      // white-space: pre-wrap，原文的换行与缩进（连续空格）原样保留；
      // 同时接入浏览器撤销栈，Ctrl+Z 可整体撤销本次粘贴。
      document.execCommand("insertText", false, text);
      syncContent();
      checkInputTriggers();
    },
    [syncContent, checkInputTriggers]
  );

  const handleInput = useCallback(() => {
    syncContent();
    checkInputTriggers();
  }, [syncContent, checkInputTriggers]);

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const nativeEvent = event.nativeEvent;
      const isComposing =
        nativeEvent.isComposing ||
        (nativeEvent as unknown as { keyCode?: number }).keyCode === 229;

      if (isComposing) {
        return;
      }

      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        insertLineBreak();
        syncContent();
        return;
      }

      if (isCommandOpen && commandPanelRef.current) {
        const handled = commandPanelRef.current.handleKeyDown(event);
        if (handled) {
          return;
        }
      }

      if (isMentionOpen && mentionPopupRef.current) {
        const handled = mentionPopupRef.current.handleKeyDown(event);
        if (handled) {
          return;
        }
      }

      handleKeyDown(event);
    },
    [handleKeyDown, isCommandOpen, isMentionOpen, syncContent]
  );

  const showImagePreview = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const chip = target.closest(
        "[data-image-tag='true']"
      ) as HTMLElement | null;
      if (!chip) {
        if (imagePreviewTimerRef.current) {
          clearTimeout(imagePreviewTimerRef.current);
          imagePreviewTimerRef.current = null;
        }
        setImagePreview(null);
        return;
      }

      const dataUrl = chip.dataset.imageDataUrl;
      if (!dataUrl) {
        if (imagePreviewTimerRef.current) {
          clearTimeout(imagePreviewTimerRef.current);
          imagePreviewTimerRef.current = null;
        }
        setImagePreview(null);
        return;
      }

      if (imagePreviewTimerRef.current) {
        clearTimeout(imagePreviewTimerRef.current);
        imagePreviewTimerRef.current = null;
      }

      const rect = chip.getBoundingClientRect();
      const PREVIEW_MAX_W = 328;
      const halfW = PREVIEW_MAX_W / 2;
      const clampedX = Math.max(
        halfW + 4,
        Math.min(rect.left + rect.width / 2, window.innerWidth - halfW - 4)
      );
      setImagePreview({
        url: dataUrl,
        x: clampedX,
        y: rect.top,
      });
    },
    []
  );

  const handleChipRemove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const removeBtn = target.closest("[data-chip-remove='true']");
      if (!removeBtn) {
        return;
      }

      const chip = removeBtn.closest(".file-chip");
      if (chip && textareaRef.current?.contains(chip)) {
        chip.remove();
        syncContent();
      }
    },
    [syncContent, textareaRef]
  );

  const scheduleHideImagePreview = useCallback(() => {
    imagePreviewTimerRef.current = setTimeout(() => {
      setImagePreview(null);
    }, 200);
  }, []);

  const cancelHideImagePreview = useCallback(() => {
    if (imagePreviewTimerRef.current) {
      clearTimeout(imagePreviewTimerRef.current);
      imagePreviewTimerRef.current = null;
    }
  }, []);

  const handleSelectFilesAndFolders = useCallback(async () => {
    try {
      const selected = await window.snow.selectFiles(
        t("plusMenu.selectFilesTitle")
      );
      if (!selected || selected.length === 0) {
        return;
      }
      const tags: FileTag[] = selected.map((item) => {
        const path = item.path;
        const name = path.split("/").filter(Boolean).pop() || path;
        return { path, name, isDirectory: item.isDirectory };
      });
      insertFileTags(tags);
    } catch {
      // dialog cancelled or error
    }
  }, [insertFileTags, t]);

  const plusMenuSections = useMemo<PlusMenuSection[]>(
    () => [
      {
        id: "add",
        label: t("plusMenu.sectionAdd"),
        items: [
          {
            id: "files-and-folders",
            label: t("plusMenu.filesAndFolders"),
            icon: Paperclip,
            onSelect: () => void handleSelectFilesAndFolders(),
          },
        ],
      },
    ],
    [t, handleSelectFilesAndFolders]
  );

  const handleWithdrawPending = useCallback(
    (index: number): string | null => {
      const restored = onWithdrawPendingMessage?.(index);
      if (restored) {
        restoreContent(restored);
      }
      return restored ?? null;
    },
    [onWithdrawPendingMessage, restoreContent]
  );

  const handleSendPendingNow = useCallback(
    (index: number): void => {
      onSendPendingMessageNow?.(index);
    },
    [onSendPendingMessageNow]
  );

  const handleOpenCustomThinking = useCallback(() => {
    setCustomThinkingValue(isCustomThinkingValue ? thinkingValue : "");
    setIsCustomThinkingMode(true);
  }, [isCustomThinkingValue, thinkingValue]);

  const handleConfirmCustomThinking = useCallback(async () => {
    const nextValue = customThinkingValue.trim();
    if (!nextValue || isSavingThinking) {
      return;
    }

    await handleSelectThinking(nextValue);
    setIsCustomThinkingMode(false);
  }, [customThinkingValue, handleSelectThinking, isSavingThinking]);

  const handleCustomThinkingKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        if (event.nativeEvent.isComposing) {
          return;
        }

        event.preventDefault();
        void handleConfirmCustomThinking();
      } else if (event.key === "Escape") {
        setIsCustomThinkingMode(false);
      }
    },
    [handleConfirmCustomThinking]
  );

  return (
    <div className="input-area">
      <ProjectMcpPanel
        open={isProjectMcpOpen}
        projectId={projectId}
        projectName={projectName}
        onClose={() => setIsProjectMcpOpen(false)}
      />
      <ProjectSensitiveCommandsPanel
        open={isProjectSensitiveCommandsOpen}
        projectId={projectId}
        projectName={projectName}
        onClose={() => setIsProjectSensitiveCommandsOpen(false)}
      />
      <ProjectSkillsPanel
        open={isProjectSkillsOpen}
        projectId={projectId}
        projectName={projectName}
        onClose={() => setIsProjectSkillsOpen(false)}
      />
      <ProjectCodebasePanel
        open={isProjectCodebaseOpen}
        projectId={projectId}
        projectName={projectName}
        onClose={() => setIsProjectCodebaseOpen(false)}
      />
      <RoleEditorPanel
        open={isRoleEditorOpen}
        projectId={projectId}
        projectName={projectName}
        onClose={() => setIsRoleEditorOpen(false)}
      />
      <div className="input-content" ref={mentionAnchorRef}>
        <FileMentionPopup
          ref={mentionPopupRef}
          visible={isMentionOpen}
          query={mentionQuery}
          onClose={handleCloseMention}
          onSelect={handleMentionSelect}
          onSelectBatch={handleMentionSelectBatch}
          textareaRef={textareaRef}
          onDragStart={handleMentionDragStart}
        />
        <CommandPanel
          ref={commandPanelRef}
          commands={commands}
          query={commandQuery}
          visible={isCommandOpen}
          onClose={handleCloseCommand}
          onSelect={handleCommandSelect}
        />
        <PendingMessages
          messages={pendingMessages}
          onWithdraw={handleWithdrawPending}
          onSendNow={handleSendPendingNow}
        />
        {isStreaming ? (
          <div className="stream-metrics-bar">
            <StreamMetrics
              tokenCount={streamTokenCount}
              elapsedMs={streamElapsedMs}
              ttftMs={streamTtftMs}
              startedAt={streamStartedAt}
              isPaused={isPaused}
              onPause={handlePause}
              onResume={handleResume}
            />
          </div>
        ) : null}
        <div className="input-box">
          <div
            ref={textareaRef}
            className={`input-field input-field-editable${
              isCompacting ? " is-disabled" : ""
            }`}
            contentEditable={!isCompacting}
            suppressContentEditableWarning
            data-placeholder={placeholder}
            data-empty="true"
            onInput={handleInput}
            onKeyDown={handleInputKeyDown}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onMouseMove={showImagePreview}
            onMouseLeave={scheduleHideImagePreview}
            onClick={handleChipRemove}
          />
          {imagePreview &&
            createPortal(
              <div
                className="image-chip-preview"
                style={{
                  left: imagePreview.x,
                  top: imagePreview.y,
                  transform: "translate(-50%, calc(-100% - 8px))",
                }}
                onMouseEnter={cancelHideImagePreview}
                onMouseLeave={scheduleHideImagePreview}
                onClick={() => {
                  setImageLightbox(imagePreview.url);
                  setImagePreview(null);
                }}
              >
                <img src={imagePreview.url} alt="preview" />
              </div>,
              document.body
            )}
          {imageLightbox &&
            createPortal(
              <div
                className="image-lightbox-overlay"
                onClick={() => setImageLightbox(null)}
              >
                <img src={imageLightbox} alt="fullscreen" />
              </div>,
              document.body
            )}
          <div className="input-toolbar">
            <div className="toolbar-left">
              <PlusMenu
                sections={plusMenuSections}
                yoloMode={yoloMode}
                isUpdatingYoloMode={isUpdatingYoloMode}
                onYoloModeChange={onYoloModeChange}
                onRefreshYoloMode={onRefreshYoloMode}
                planMode={planMode}
                isUpdatingPlanMode={isUpdatingPlanMode}
                onPlanModeChange={onPlanModeChange}
                onRefreshPlanMode={onRefreshPlanMode}
                goalMode={goalMode}
                isUpdatingGoalMode={isUpdatingGoalMode}
                onGoalModeChange={onGoalModeChange}
                onRefreshGoalMode={onRefreshGoalMode}
                goalModeTokenBudget={goalModeTokenBudget}
                onGoalModeTokenBudgetChange={onGoalModeTokenBudgetChange}
                autoScrollEnabled={autoScrollEnabled}
                onAutoScrollChange={onAutoScrollChange}
              />
              {value.trim() === "" && (
                <button
                  ref={commandTriggerRef}
                  className={`toolbar-btn command-trigger${
                    isCommandOpen ? " is-active" : ""
                  }`}
                  aria-label={t("chatCommand.trigger")}
                  aria-expanded={isCommandOpen}
                  onClick={handleToggleCommand}
                  type="button"
                  title={t("chatCommand.trigger")}
                >
                  <Command size={15} />
                </button>
              )}
              {planMode && (
                <>
                  <span className="toolbar-divider" aria-hidden="true" />
                  <span
                    className="plan-mode-badge"
                    title={t("plusMenu.planModeActive")}
                  >
                    <ClipboardList size={14} />
                  </span>
                </>
              )}
              {goalMode && (
                <>
                  <span className="toolbar-divider" aria-hidden="true" />
                  <span
                    className="plan-mode-badge"
                    title={t("plusMenu.goalModeActive")}
                  >
                    <Target size={14} />
                  </span>
                </>
              )}
            </div>
            <div className="toolbar-right">
              <div className="model-selector" ref={dropdownRef}>
                <button
                  className={`toolbar-btn model ${
                    modelError ? "model-error" : ""
                  }${isStreaming ? " is-disabled" : ""}`}
                  aria-label={labels.selectModel}
                  aria-expanded={isModelMenuOpen}
                  onClick={handleToggleModelMenu}
                  disabled={isStreaming}
                  type="button"
                >
                  {modelError ? (
                    <AlertCircle size={14} className="model-icon" />
                  ) : (
                    <Bot size={14} className="model-icon" />
                  )}
                  <span className="model-name" title={displayModel}>
                    {displayModel}
                  </span>
                  <span
                    className="model-trigger-thinking"
                    title={
                      thinkingError ??
                      (isLoadingApiConfig
                        ? t("chat.loadingApiConfig")
                        : t("chat.thinkingStrengthWithValue", {
                            values: { value: thinkingLabel },
                          }))
                    }
                  >
                    {isLoadingApiConfig || isSavingThinking ? (
                      <Loader2 size={12} className="spin" />
                    ) : thinkingError ? (
                      <AlertCircle size={12} />
                    ) : (
                      <ActiveThinkingIcon size={12} />
                    )}
                    <span className="model-trigger-thinking-label">
                      {thinkingLabel}
                    </span>
                  </span>
                  <ChevronDown size={12} />
                </button>
                {isModelMenuOpen && (
                  <div className={`model-dropdown drop-${modelDropdownDir}`}>
                    {modelMenuView === "root" && (
                      <div className="model-dropdown-list">
                        <button
                          className="model-dropdown-item"
                          onClick={() => setModelMenuView("model")}
                          type="button"
                        >
                          <span className="model-dropdown-item-name">
                            {t("chat.model")}
                          </span>
                          <span className="model-menu-value">
                            <span
                              className="model-menu-value-text"
                              title={displayModel}
                            >
                              {displayModel}
                            </span>
                            <ChevronRight size={12} />
                          </span>
                        </button>
                        <button
                          className="model-dropdown-item"
                          disabled={
                            !runtimeApiConfig ||
                            isLoadingApiConfig ||
                            isSavingThinking
                          }
                          onClick={() => setModelMenuView("thinking")}
                          type="button"
                        >
                          <span className="model-dropdown-item-name">
                            {t("chat.thinkingStrength")}
                          </span>
                          <span className="model-menu-value">
                            {isSavingThinking ? (
                              <Loader2 size={12} className="spin" />
                            ) : (
                              <span className="model-menu-value-text">
                                {thinkingLabel}
                              </span>
                            )}
                            <ChevronRight size={12} />
                          </span>
                        </button>
                        {!isSubAgentConversation && apiConfigs.length > 0 && (
                          <button
                            className="model-dropdown-item"
                            onClick={() => setModelMenuView("apiProfile")}
                            type="button"
                          >
                            <span className="model-dropdown-item-name">
                              {labels.selectApiProfile}
                            </span>
                            <span className="model-menu-value">
                              <span
                                className="model-menu-value-text"
                                title={runtimeApiConfig?.displayName}
                              >
                                {runtimeApiConfig?.displayName ||
                                  labels.selectApiProfile}
                              </span>
                              <ChevronRight size={12} />
                            </span>
                          </button>
                        )}
                      </div>
                    )}
                    {modelMenuView === "apiProfile" && (
                      <>
                        <div className="model-menu-header">
                          <button
                            aria-label={t("common.back")}
                            className="model-menu-back"
                            onClick={() => setModelMenuView("root")}
                            type="button"
                          >
                            <ChevronLeft size={14} />
                          </button>
                          <span>{labels.selectApiProfile}</span>
                        </div>
                        <div className="model-dropdown-list">
                          {apiConfigs.map((config) => (
                            <button
                              key={config.profileName}
                              className={`model-dropdown-item ${
                                config.profileName === selectedApiProfile
                                  ? "active"
                                  : ""
                              }`}
                              onClick={() => {
                                void handleSelectApiProfile(config.profileName);
                              }}
                              type="button"
                              title={config.displayName}
                            >
                              <span className="model-dropdown-item-name">
                                {config.displayName}
                              </span>
                              <span className="model-dropdown-item-model">
                                {config.advancedModel ||
                                  config.basicModel ||
                                  "-"}
                              </span>
                              {config.profileName === selectedApiProfile && (
                                <Check
                                  size={14}
                                  className="model-dropdown-check"
                                />
                              )}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    {modelMenuView === "model" &&
                      (isManualMode ? (
                        <>
                          <div className="model-menu-header">
                            <button
                              aria-label={t("common.back")}
                              className="model-menu-back"
                              onClick={() => setModelMenuView("root")}
                              type="button"
                            >
                              <ChevronLeft size={14} />
                            </button>
                            <span>{labels.manualModel}</span>
                          </div>
                          <div className="model-manual-input">
                            <input
                              autoFocus
                              value={manualValue}
                              onChange={(event) =>
                                setManualValue(event.target.value)
                              }
                              onKeyDown={handleManualKeyDown}
                              placeholder={labels.manualModelPlaceholder}
                              className="model-manual-field"
                            />
                            <div className="model-manual-actions">
                              <button
                                className="model-manual-btn secondary"
                                onClick={() => setIsManualMode(false)}
                                type="button"
                              >
                                {labels.cancel}
                              </button>
                              <button
                                className="model-manual-btn primary"
                                onClick={() => void handleConfirmManualModel()}
                                disabled={!manualValue.trim()}
                                type="button"
                              >
                                {labels.confirm}
                              </button>
                            </div>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="model-menu-header">
                            <button
                              aria-label={t("common.back")}
                              className="model-menu-back"
                              onClick={() => setModelMenuView("root")}
                              type="button"
                            >
                              <ChevronLeft size={14} />
                            </button>
                            <span>{labels.selectModel}</span>
                          </div>
                          {isLoadingModels && (
                            <div
                              className="model-dropdown-status"
                              aria-live="polite"
                            >
                              <Loader2 size={14} className="spin" />
                              <span>{labels.loadingModels}</span>
                            </div>
                          )}
                          {modelError && (
                            <div className="model-dropdown-error">
                              <AlertCircle size={14} />
                              <span>{modelError}</span>
                              <button
                                className="model-dropdown-retry"
                                onClick={handleRetryFetchModels}
                                disabled={isLoadingModels}
                                type="button"
                              >
                                {labels.retry}
                              </button>
                            </div>
                          )}
                          <div className="model-dropdown-list">
                            {models.length === 0 &&
                              !modelError &&
                              !isLoadingModels && (
                                <div className="model-dropdown-empty">
                                  {labels.noModelsFound}
                                </div>
                              )}
                            {models.map((model) => (
                              <button
                                key={model.id}
                                className={`model-dropdown-item ${
                                  selectedModel === model.id ? "active" : ""
                                }`}
                                onClick={() => void handleSelectModel(model.id)}
                                type="button"
                                title={model.id}
                              >
                                <span className="model-dropdown-item-name">
                                  {model.id}
                                </span>
                                {selectedModel === model.id && (
                                  <Check
                                    size={14}
                                    className="model-dropdown-check"
                                  />
                                )}
                              </button>
                            ))}
                          </div>
                          <div className="model-dropdown-footer model-dropdown-footer-actions">
                            <button
                              className="model-dropdown-action"
                              onClick={handleRetryFetchModels}
                              disabled={isLoadingModels}
                              title={labels.refreshModels}
                              type="button"
                            >
                              <RefreshCw size={14} />
                              <span>{labels.refreshModels}</span>
                            </button>
                            <button
                              className="model-dropdown-action"
                              onClick={handleOpenManualMode}
                              type="button"
                            >
                              <Keyboard size={14} />
                              <span>{labels.manualModel}</span>
                            </button>
                          </div>
                        </>
                      ))}
                    {modelMenuView === "thinking" &&
                      (isCustomThinkingMode ? (
                        <>
                          <div className="model-menu-header">
                            <button
                              aria-label={t("common.back")}
                              className="model-menu-back"
                              onClick={() => setModelMenuView("root")}
                              type="button"
                            >
                              <ChevronLeft size={14} />
                            </button>
                            <span>{t("chat.customThinkingStrength")}</span>
                          </div>
                          <div className="model-manual-input thinking-custom-input">
                            <input
                              autoFocus
                              value={customThinkingValue}
                              onChange={(event) =>
                                setCustomThinkingValue(event.target.value)
                              }
                              onKeyDown={handleCustomThinkingKeyDown}
                              placeholder={t("chat.customThinkingPlaceholder")}
                              className="model-manual-field thinking-custom-field"
                              maxLength={64}
                            />
                            <div className="model-manual-actions thinking-custom-actions">
                              <button
                                className="model-manual-btn thinking-custom-btn secondary"
                                onClick={() => setIsCustomThinkingMode(false)}
                                type="button"
                              >
                                {labels.cancel}
                              </button>
                              <button
                                className="model-manual-btn thinking-custom-btn primary"
                                onClick={() =>
                                  void handleConfirmCustomThinking()
                                }
                                disabled={
                                  !customThinkingValue.trim() ||
                                  isSavingThinking
                                }
                                type="button"
                              >
                                {labels.confirm}
                              </button>
                            </div>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="model-menu-header">
                            <button
                              aria-label={t("common.back")}
                              className="model-menu-back"
                              onClick={() => setModelMenuView("root")}
                              type="button"
                            >
                              <ChevronLeft size={14} />
                            </button>
                            <span>{t("chat.thinkingStrength")}</span>
                            <small>{requestMethod}</small>
                          </div>
                          <div className="model-dropdown-list">
                            {thinkingOptions.map((option) => {
                              const ThinkingOptionIcon = option.icon;

                              return (
                                <button
                                  key={option.value}
                                  className={`model-dropdown-item ${
                                    thinkingValue === option.value
                                      ? "active"
                                      : ""
                                  }`}
                                  onClick={() =>
                                    void handleSelectThinking(option.value)
                                  }
                                  type="button"
                                >
                                  <span className="model-dropdown-item-name with-icon">
                                    <ThinkingOptionIcon
                                      size={14}
                                      className="thinking-option-icon"
                                    />
                                    <span>{option.label}</span>
                                  </span>
                                  {thinkingValue === option.value && (
                                    <Check
                                      size={14}
                                      className="model-dropdown-check"
                                    />
                                  )}
                                </button>
                              );
                            })}
                          </div>
                          <div className="model-dropdown-footer">
                            <button
                              className={`model-dropdown-action ${
                                isCustomThinkingValue ? "active" : ""
                              }`}
                              onClick={handleOpenCustomThinking}
                              type="button"
                            >
                              <Keyboard size={14} />
                              <span>{t("chat.customThinking")}</span>
                              {isCustomThinkingValue && (
                                <Check
                                  size={14}
                                  className="model-dropdown-check"
                                />
                              )}
                            </button>
                          </div>
                        </>
                      ))}
                  </div>
                )}
              </div>
              <TokenUsageRing
                tokenUsage={tokenUsage}
                maxContextTokens={runtimeApiConfig?.maxContextTokens ?? null}
              />
              <div className="input-action-buttons">
                {isStreaming || isAborting ? (
                  <button
                    className={`abort-btn ${isAborting ? "is-aborting" : ""}`}
                    aria-label={
                      isAborting ? "Stopping generation" : "Stop generating"
                    }
                    title={
                      isAborting ? "Stopping generation" : "Stop generating"
                    }
                    onClick={handleAbort}
                    disabled={isAborting}
                    type="button"
                  >
                    {isAborting ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <Square size={14} fill="currentColor" />
                    )}
                  </button>
                ) : (
                  <span className="abort-btn-placeholder" aria-hidden="true" />
                )}
                <button
                  className="send-btn"
                  aria-label="Send"
                  title="Send"
                  onClick={handleSend}
                  disabled={!value.trim() || isCompacting}
                  type="button"
                >
                  <ArrowUp size={16} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
