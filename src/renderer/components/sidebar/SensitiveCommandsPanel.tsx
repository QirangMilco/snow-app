import { Download, Folder, Globe2, Loader2, Plus, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceDirectoryRecord } from "../../../preload";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Modal } from "../common/Modal";
import { SensitiveCommandEditor, SensitiveCommandEditorActions } from "./sensitiveCommands/SensitiveCommandEditor";
import {
  SensitiveCommandList,
  type SensitiveCommandListItem,
} from "./sensitiveCommands/SensitiveCommandList";
import { SensitiveCommandSummary } from "./sensitiveCommands/SensitiveCommandSummary";
import {
  EMPTY_SENSITIVE_COMMAND_DRAFT,
  hasDuplicatePattern,
  toDraft,
  toInput,
} from "./sensitiveCommands/sensitiveCommandUtils";
import type {
  ProjectSensitiveCommandConfig,
  SensitiveCommandConfig,
  SensitiveCommandDraft,
} from "./sensitiveCommands/types";

type SensitiveCommandsPanelProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onClose?: () => void;
};

type SensitiveCommandScope = "global" | "project";

export function SensitiveCommandsPanel({
  activeDirectory,
  onClose,
}: SensitiveCommandsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [activeScope, setActiveScope] =
    useState<SensitiveCommandScope>("global");
  const [commands, setCommands] = useState<SensitiveCommandConfig[]>([]);
  const [projectCommands, setProjectCommands] = useState<
    ProjectSensitiveCommandConfig[]
  >([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [draft, setDraft] = useState<SensitiveCommandDraft | null>(null);
  const [commandPendingDeletion, setCommandPendingDeletion] =
    useState<SensitiveCommandListItem | null>(null);
  const [resetPending, setResetPending] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const loadGenerationRef = useRef(0);

  const isBusy = isLoading || isSaving;

  const load = useCallback(async (): Promise<void> => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setIsLoading(true);
    setIsSaving(false);
    setDraft(null);
    setCommandPendingDeletion(null);
    setProjectCommands([]);
    setError("");

    try {
      const [globalItems, projectItems] = await Promise.all([
        window.snow.listSensitiveCommandConfigs(),
        activeDirectory
          ? window.snow.listProjectSensitiveCommandConfigs(
              activeDirectory.directoryId
            )
          : Promise.resolve([]),
      ]);
      if (loadGenerationRef.current !== generation) {
        return;
      }

      setCommands(globalItems);
      setProjectCommands(projectItems);
    } catch (loadError) {
      if (loadGenerationRef.current === generation) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : t("settings.sensitiveCommandLoadError", {
                defaultValue: "Failed to load sensitive command rules",
              })
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsLoading(false);
      }
    }
  }, [activeDirectory, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!activeDirectory && activeScope === "project") {
      setActiveScope("global");
    }
  }, [activeDirectory, activeScope]);

  const handleImport = async (): Promise<void> => {
    setIsLoading(true);
    setError("");
    setStatus("");

    try {
      await window.snow.importSnowCliSensitiveCommandConfig();
      await load();
      setDraft(null);
      setStatus(
        t("settings.sensitiveCommandImportSuccess", {
          defaultValue: "Synced sensitive command rules from Snow CLI.",
        })
      );
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : t("settings.sensitiveCommandImportError", {
              defaultValue: "Failed to sync Snow CLI sensitive command rules",
            })
      );
    } finally {
      setIsLoading(false);
    }
  };

  const startAdd = (): void => {
    const scopedCommands =
      activeScope === "global" ? commands : projectCommands;
    const maxSortOrder = scopedCommands.reduce(
      (max, command) => Math.max(max, command.sortOrder),
      -1
    );
    setDraft({
      ...EMPTY_SENSITIVE_COMMAND_DRAFT,
      sortOrder: maxSortOrder + 1,
      source: activeScope === "global" ? "manual" : "project",
    });
    setError("");
    setStatus("");
  };

  const startEdit = (command: SensitiveCommandListItem): void => {
    if (!command.canEdit) {
      return;
    }

    if (activeScope === "global") {
      const globalCommand = commands.find(
        (item) => item.commandId === command.commandId
      );
      if (globalCommand) {
        setDraft(toDraft(globalCommand));
      }
    } else {
      const projectCommand = projectCommands.find(
        (item) => item.commandId === command.commandId && !item.inherited
      );
      if (projectCommand) {
        setDraft({
          commandId: projectCommand.commandId,
          pattern: projectCommand.pattern,
          description: projectCommand.description,
          enabled: projectCommand.enabled,
          isPreset: false,
          sortOrder: projectCommand.sortOrder,
          source: "project",
        });
      }
    }
    setError("");
    setStatus("");
  };

  const cancelDraft = (): void => {
    setDraft(null);
    setError("");
  };

  const patchDraft = (patch: Partial<SensitiveCommandDraft>): void => {
    setDraft((previous) => (previous ? { ...previous, ...patch } : null));
  };

  const saveDraft = async (): Promise<void> => {
    if (!draft || isSaving) {
      return;
    }

    if (!draft.pattern.trim()) {
      setError(
        t("settings.sensitiveCommandPatternRequired", {
          defaultValue: "Command pattern is required.",
        })
      );
      setStatus("");
      return;
    }

    const duplicatePattern =
      activeScope === "global"
        ? hasDuplicatePattern(commands, draft)
        : projectCommands.some(
            (command) =>
              command.pattern.trim() === draft.pattern.trim() &&
              command.commandId !== draft.commandId
          );
    if (duplicatePattern) {
      setError(
        t("settings.sensitiveCommandDuplicatePattern", {
          defaultValue: "Command pattern already exists.",
        })
      );
      setStatus("");
      return;
    }

    const operationScope = activeScope;
    const operationProjectId = activeDirectory?.directoryId;
    const generation = loadGenerationRef.current;
    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      if (operationScope === "global") {
        const maxSortOrder = commands.reduce(
          (max, command) => Math.max(max, command.sortOrder),
          -1
        );
        const items = await window.snow.upsertSensitiveCommandConfig(
          toInput(draft, maxSortOrder + 1)
        );
        setCommands(items);
      } else if (operationProjectId) {
        const maxSortOrder = projectCommands
          .filter((command) => !command.inherited)
          .reduce((max, command) => Math.max(max, command.sortOrder), -1);
        const items = await window.snow.upsertProjectSensitiveCommandConfig(
          operationProjectId,
          {
            commandId: draft.commandId,
            pattern: draft.pattern.trim(),
            description: draft.description.trim(),
            enabled: draft.enabled,
            sortOrder: draft.commandId ? draft.sortOrder : maxSortOrder + 1,
          }
        );
        if (loadGenerationRef.current !== generation) {
          return;
        }
        setProjectCommands(items);
      } else {
        return;
      }

      setDraft(null);
      setStatus(
        draft.commandId
          ? t("settings.sensitiveCommandSaveSuccess", {
              defaultValue: "Saved sensitive command rule.",
            })
          : t("settings.sensitiveCommandAddSuccess", {
              defaultValue: "Added sensitive command rule.",
            })
      );
    } catch (saveError) {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setError(
          saveError instanceof Error
            ? saveError.message
            : t("settings.sensitiveCommandSaveError", {
                defaultValue: "Failed to save sensitive command rule",
              })
        );
      }
    } finally {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setIsSaving(false);
      }
    }
  };

  const toggleEnabled = async (
    command: SensitiveCommandListItem
  ): Promise<void> => {
    if (isBusy) {
      return;
    }

    const operationScope = activeScope;
    const operationProjectId = activeDirectory?.directoryId;
    const generation = loadGenerationRef.current;
    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      if (operationScope === "global") {
        const globalCommand = commands.find(
          (item) => item.commandId === command.commandId
        );
        if (!globalCommand) {
          return;
        }
        const items = await window.snow.upsertSensitiveCommandConfig({
          commandId: globalCommand.commandId,
          pattern: globalCommand.pattern,
          description: globalCommand.description,
          enabled: !globalCommand.enabled,
          isPreset: globalCommand.isPreset,
          sortOrder: globalCommand.sortOrder,
          source: globalCommand.source,
        });
        setCommands(items);
      } else if (operationProjectId) {
        const items = await window.snow.setProjectSensitiveCommandEnabled(
          operationProjectId,
          command.commandId,
          !command.enabled
        );
        if (loadGenerationRef.current !== generation) {
          return;
        }
        setProjectCommands(items);
      }
    } catch (updateError) {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setError(
          updateError instanceof Error
            ? updateError.message
            : t("settings.sensitiveCommandSaveError", {
                defaultValue: "Failed to update sensitive command rule",
              })
        );
      }
    } finally {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setIsSaving(false);
      }
    }
  };

  const handleDelete = async (
    command: SensitiveCommandListItem
  ): Promise<void> => {
    if (isBusy || !command.canDelete) {
      return;
    }

    setError("");
    setStatus("");

    const operationScope = activeScope;
    const operationProjectId = activeDirectory?.directoryId;
    const generation = loadGenerationRef.current;
    setIsSaving(true);

    try {
      if (operationScope === "global") {
        const items = await window.snow.deleteSensitiveCommandConfig(
          command.commandId
        );
        setCommands(items);
      } else if (operationProjectId) {
        const items = await window.snow.deleteProjectSensitiveCommandConfig(
          operationProjectId,
          command.commandId
        );
        if (loadGenerationRef.current !== generation) {
          return;
        }
        setProjectCommands(items);
      } else {
        return;
      }

      if (draft?.commandId === command.commandId) {
        setDraft(null);
      }
      setStatus(
        t("settings.sensitiveCommandDeleteSuccess", {
          defaultValue: "Deleted sensitive command rule.",
        })
      );
    } catch (deleteError) {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setError(
          deleteError instanceof Error
            ? deleteError.message
            : t("settings.sensitiveCommandDeleteError", {
                defaultValue: "Failed to delete sensitive command rule",
              })
        );
      }
    } finally {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setIsSaving(false);
      }
    }
  };

  const confirmDelete = (): void => {
    if (!commandPendingDeletion || isBusy) {
      return;
    }

    const command = commandPendingDeletion;
    setCommandPendingDeletion(null);
    void handleDelete(command);
  };

  const handleReset = async (): Promise<void> => {
    if (isBusy) {
      return;
    }

    setResetPending(false);
    setIsSaving(true);
    setDraft(null);
    setError("");
    setStatus("");

    try {
      const items = await window.snow.resetSensitiveCommandConfigs();
      setCommands(items);
      setStatus(
        t("settings.sensitiveCommandResetSuccess", {
          defaultValue: "Reset sensitive command rules to system defaults.",
        })
      );
    } catch (resetError) {
      setError(
        resetError instanceof Error
          ? resetError.message
          : t("settings.sensitiveCommandResetError", {
              defaultValue: "Failed to reset sensitive command rules",
            })
      );
    } finally {
      setIsSaving(false);
    }
  };

  const isGlobalScope = activeScope === "global";
  const globalListItems: SensitiveCommandListItem[] = commands.map(
    (command) => ({
      commandId: command.commandId,
      pattern: command.pattern,
      description: command.description,
      enabled: command.enabled,
      isPreset: command.isPreset,
      source: command.source,
      inherited: false,
      overridden: false,
      canEdit: true,
      canDelete: !command.isPreset,
    })
  );
  const projectListItems: SensitiveCommandListItem[] = projectCommands.map(
    (command) => ({
      commandId: command.commandId,
      pattern: command.pattern,
      description: command.description,
      enabled: command.enabled,
      isPreset: command.isPreset,
      source: command.source,
      inherited: command.inherited,
      overridden:
        command.inherited && command.enabled !== command.globalEnabled,
      canEdit: !command.inherited,
      canDelete: !command.inherited,
    })
  );
  const activeCommands = isGlobalScope ? globalListItems : projectListItems;
  const enabledCount = activeCommands.filter(
    (command) => command.enabled
  ).length;
  const specialCount = isGlobalScope
    ? activeCommands.filter((command) => command.isPreset).length
    : activeCommands.filter((command) => command.inherited).length;
  const specialLabel = isGlobalScope
    ? t("settings.sensitiveCommandPresetCount", {
        defaultValue: "Preset rules",
      })
    : t("settings.sensitiveCommandInheritedCount", {
        defaultValue: "Inherited rules",
      });
  const listTitle = isGlobalScope
    ? t("settings.sensitiveCommandGlobalListTitle", {
        defaultValue: "Global sensitive command rules",
      })
    : t("settings.sensitiveCommandProjectListTitle", {
        defaultValue: "Effective project rules",
      });
  const emptyMessage = isGlobalScope
    ? t("settings.sensitiveCommandNoRules", {
        defaultValue:
          "No sensitive command rules yet. Sync from Snow CLI or add one manually.",
      })
    : t("settings.sensitiveCommandProjectNoRules", {
        defaultValue:
          "No sensitive command rules are available for this project.",
      });

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.sensitiveCommandTitle", {
              defaultValue: "Sensitive commands",
            })}
          </strong>
          <span className="settings-item-description">
            {t("settings.sensitiveCommandsInfo", {
              defaultValue: "Review command approval rules.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeSensitiveCommandSettings", {
              defaultValue: "Close sensitive command settings",
            })}
            title={t("settings.closeSensitiveCommandSettings", {
              defaultValue: "Close sensitive command settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <SensitiveCommandSummary
        totalCount={activeCommands.length}
        enabledCount={enabledCount}
        specialCount={specialCount}
        specialLabel={specialLabel}
      />

      <div className="api-settings-actions sensitive-commands-actions">
        {isGlobalScope && (
          <button
            className="api-settings-action-btn primary"
            onClick={() => void handleImport()}
            type="button"
            disabled={isBusy}
          >
            {isLoading ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Download size={15} />
            )}
            <span>
              {t("settings.syncSnowCliSensitiveCommands", {
                defaultValue: "Sync Snow CLI sensitive commands",
              })}
            </span>
          </button>
        )}
        {isGlobalScope && (
          <button
            className="api-settings-action-btn secondary"
            onClick={() => setResetPending(true)}
            type="button"
            disabled={isBusy}
            title={t("settings.sensitiveCommandReset", {
              defaultValue: "Reset to system defaults",
            })}
          >
            <RotateCcw size={15} />
            <span>
              {t("settings.sensitiveCommandReset", {
                defaultValue: "Reset to system defaults",
              })}
            </span>
          </button>
        )}
        <button
          className="api-settings-action-btn secondary"
          onClick={startAdd}
          type="button"
          disabled={isBusy || (!isGlobalScope && !activeDirectory)}
        >
          <Plus size={15} />
          <span>
            {t(
              isGlobalScope
                ? "settings.sensitiveCommandAddNew"
                : "settings.sensitiveCommandAddProjectRule",
              {
                defaultValue: isGlobalScope ? "Add rule" : "Add project rule",
              }
            )}
          </span>
        </button>
      </div>

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <div
        className="skills-settings-tabs"
        role="tablist"
        aria-label={t("settings.sensitiveCommandScopeTabs", {
          defaultValue: "Sensitive command scope",
        })}
      >
        <button
          className={`skills-settings-tab ${isGlobalScope ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={isGlobalScope}
          onClick={() => {
            setActiveScope("global");
            setDraft(null);
          }}
        >
          <Globe2 size={14} strokeWidth={1.8} />
          <span>
            {t("settings.sensitiveCommandTabGlobal", {
              defaultValue: "Global",
            })}
          </span>
          <small>{globalListItems.length}</small>
        </button>
        <button
          className={`skills-settings-tab ${!isGlobalScope ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={!isGlobalScope}
          onClick={() => {
            setActiveScope("project");
            setDraft(null);
          }}
          disabled={!activeDirectory}
        >
          <Folder size={14} strokeWidth={1.8} />
          <span>
            {t("settings.sensitiveCommandTabProject", {
              defaultValue: "Project",
            })}
          </span>
          <small>{projectListItems.length}</small>
        </button>
      </div>

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>{listTitle}</strong>
          <span>
            {isGlobalScope
              ? t("settings.sensitiveCommandGlobalTabInfo", {
                  defaultValue:
                    "Manage command approval rules shared by all projects.",
                })
              : t("settings.sensitiveCommandProjectTabInfo", {
                  defaultValue:
                    "Manage project rules for {{name}}. Inherited global rules can only be enabled or disabled here.",
                  values: { name: activeDirectory?.name ?? "" },
                })}
          </span>
        </div>

        <div className="api-settings-form-body">
          <SensitiveCommandList
            commands={activeCommands}
            isBusy={isBusy}
            listTitle={listTitle}
            emptyMessage={emptyMessage}
            onToggleEnabled={(command) => void toggleEnabled(command)}
            onEdit={startEdit}
            onDelete={setCommandPendingDeletion}
          />
        </div>
      </div>

      <Modal
        open={Boolean(draft)}
        title={t("settings.sensitiveCommandEditorTitle", {
          defaultValue: "Sensitive command rule editor",
        })}
        description={
          draft?.pattern ||
          t("settings.sensitiveCommandAddNew", { defaultValue: "Add rule" })
        }
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={cancelDraft}
        closeDisabled={isBusy}
        size="large"
        className="sensitive-command-editor-modal"
        footer={
          draft && (
            <SensitiveCommandEditorActions
              isBusy={isBusy}
              isSaving={isSaving}
              onCancel={cancelDraft}
              onSave={() => void saveDraft()}
            />
          )
        }
      >
        {draft && (
          <SensitiveCommandEditor
            draft={draft}
            isBusy={isBusy}
            isSaving={isSaving}
            onDraftChange={patchDraft}
            onCancel={cancelDraft}
            onSave={() => void saveDraft()}
          />
        )}
      </Modal>
      <ConfirmDialog
        open={commandPendingDeletion !== null}
        title={t("settings.sensitiveCommandDeleteTitle", {
          defaultValue: "Delete sensitive command rule",
        })}
        message={t("settings.sensitiveCommandDeleteConfirm", {
          defaultValue: 'Delete sensitive command rule "{{pattern}}"?',
          values: { pattern: commandPendingDeletion?.pattern ?? "" },
        })}
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={confirmDelete}
        onCancel={() => setCommandPendingDeletion(null)}
        variant="danger"
      />
      <ConfirmDialog
        open={resetPending}
        title={t("settings.sensitiveCommandResetConfirmTitle", {
          defaultValue: "Reset sensitive command rules",
        })}
        message={t("settings.sensitiveCommandResetConfirm", {
          defaultValue:
            "Reset all sensitive command rules to system defaults? Custom rules will be removed and preset rules will be restored.",
        })}
        confirmLabel={t("settings.sensitiveCommandReset", {
          defaultValue: "Reset to system defaults",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void handleReset()}
        onCancel={() => setResetPending(false)}
        variant="warning"
      />
    </div>
  );
}
