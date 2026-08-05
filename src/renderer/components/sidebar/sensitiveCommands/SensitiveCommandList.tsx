import { Pencil, Trash2 } from "lucide-react";
import { useI18n } from "../../../i18n";

export type SensitiveCommandListItem = {
  commandId: string;
  pattern: string;
  description: string;
  enabled: boolean;
  isPreset: boolean;
  source: string;
  inherited: boolean;
  overridden: boolean;
  canEdit: boolean;
  canDelete: boolean;
};

type SensitiveCommandListProps = {
  commands: SensitiveCommandListItem[];
  isBusy: boolean;
  listTitle: string;
  emptyMessage: string;
  onToggleEnabled: (command: SensitiveCommandListItem) => void;
  onEdit: (command: SensitiveCommandListItem) => void;
  onDelete: (command: SensitiveCommandListItem) => void;
};

export function SensitiveCommandList({
  commands,
  isBusy,
  listTitle,
  emptyMessage,
  onToggleEnabled,
  onEdit,
  onDelete,
}: SensitiveCommandListProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="api-settings-form-section">
      <div className="api-settings-form-section-header">
        <strong className="api-settings-form-section-title">{listTitle}</strong>
      </div>

      <div className="api-settings-table-wrap sensitive-command-table-wrap">
        {commands.length === 0 ? (
          <div className="system-prompt-empty">{emptyMessage}</div>
        ) : (
          <table className="api-settings-table sensitive-command-table">
            <thead>
              <tr>
                <th>
                  {t("settings.sensitiveCommandPattern", {
                    defaultValue: "Pattern",
                  })}
                </th>
                <th>
                  {t("settings.sensitiveCommandSource", {
                    defaultValue: "Source",
                  })}
                </th>
                <th>{t("settings.status", { defaultValue: "Status" })}</th>
                <th className="api-settings-table-actions-col">
                  {t("settings.actions", { defaultValue: "Actions" })}
                </th>
              </tr>
            </thead>
            <tbody>
              {commands.map((command) => {
                const activeLabel = command.enabled
                  ? t("settings.sensitiveCommandDisable", {
                      defaultValue: "Disable",
                    })
                  : t("settings.sensitiveCommandEnable", {
                      defaultValue: "Enable",
                    });
                const sourceLabel = command.inherited
                  ? t(
                      command.overridden
                        ? "settings.sensitiveCommandInheritedOverride"
                        : "settings.sensitiveCommandInherited",
                      {
                        defaultValue: command.overridden
                          ? "Inherited override"
                          : "Inherited",
                      }
                    )
                  : command.isPreset
                  ? t("settings.sensitiveCommandPreset", {
                      defaultValue: "Preset",
                    })
                  : command.source;

                return (
                  <tr key={command.commandId}>
                    <td className="cell-name">
                      <strong>{command.pattern}</strong>
                      <span className="profile-name-hint">
                        {command.description || "-"}
                      </span>
                    </td>
                    <td>
                      <span className="badge method">{sourceLabel}</span>
                    </td>
                    <td>
                      <label
                        className="toggle-switch"
                        aria-label={activeLabel}
                        title={activeLabel}
                      >
                        <input
                          type="checkbox"
                          checked={command.enabled}
                          onChange={() => onToggleEnabled(command)}
                          disabled={isBusy}
                          hidden
                        />
                        <span className="toggle-slider" />
                      </label>
                    </td>
                    <td>
                      <div className="api-settings-table-actions">
                        {command.canEdit && (
                          <button
                            className="icon-btn ghost"
                            onClick={() => onEdit(command)}
                            type="button"
                            aria-label={t("settings.edit", {
                              defaultValue: "Edit",
                            })}
                            title={t("settings.edit", {
                              defaultValue: "Edit",
                            })}
                            disabled={isBusy}
                          >
                            <Pencil size={14} strokeWidth={1.9} />
                          </button>
                        )}
                        {command.canDelete && (
                          <button
                            className="icon-btn ghost danger"
                            onClick={() => onDelete(command)}
                            type="button"
                            aria-label={t("settings.delete", {
                              defaultValue: "Delete",
                            })}
                            title={t("settings.delete", {
                              defaultValue: "Delete",
                            })}
                            disabled={isBusy}
                          >
                            <Trash2 size={14} strokeWidth={1.9} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
