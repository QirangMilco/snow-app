import { Loader2, Pencil, Trash2 } from "lucide-react";
import { useI18n } from "../../../i18n";
import type { HookListItem } from "./types";

type HooksSettingsListProps = {
  hooks: HookListItem[];
  isBusy: boolean;
  listTitle: string;
  emptyMessage: string;
  onEdit: (hook: HookListItem) => void;
  onDelete: (hook: HookListItem) => void;
};

export function HooksSettingsList({
  hooks,
  isBusy,
  listTitle,
  emptyMessage,
  onEdit,
  onDelete,
}: HooksSettingsListProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="api-settings-form-section">
      <div className="api-settings-form-section-header">
        <strong className="api-settings-form-section-title">
          {listTitle}
        </strong>
      </div>

      <div className="system-prompt-list hooks-list">
        {hooks.length === 0 ? (
          <div className="system-prompt-empty">{emptyMessage}</div>
        ) : (
          hooks.map((hook) => {
            const isConfigured = hook.ruleCount > 0;
            const stateLabel = isConfigured
              ? hook.enabledActionCount > 0
                ? t("settings.active", { defaultValue: "Active" })
                : t("settings.inactive", { defaultValue: "Inactive" })
              : t("settings.hooksNotConfigured", {
                  defaultValue: "Not configured",
                });
            const detail = `${hook.ruleCount} ${
              hook.ruleCount === 1
                ? t("settings.hooksRuleSingular", {
                    defaultValue: "rule",
                  })
                : t("settings.hooksRulePlural", {
                    defaultValue: "rules",
                  })
            } · ${hook.enabledActionCount}/${hook.totalActionCount} ${t(
              "settings.hooksActionsLabel",
              { defaultValue: "actions" }
            )}`;

            return (
              <div
                key={`${hook.scope}:${hook.hookType}`}
                className={`system-prompt-item ${
                  isConfigured && hook.enabledActionCount > 0 ? "active" : ""
                }`}
              >
                <div className="system-prompt-item-main">
                  <div className="system-prompt-item-info">
                    <strong title={hook.hookType}>
                      {t(`hookTypes.${hook.hookType}`, {
                        defaultValue: hook.hookType,
                      })}
                    </strong>
                    <span title={detail}>{detail}</span>
                  </div>
                  <span className="hooks-state-label">{stateLabel}</span>
                </div>
                <div className="system-prompt-item-actions">
                  <button
                    className="icon-btn ghost"
                    onClick={() => onEdit(hook)}
                    type="button"
                    aria-label={t("settings.edit", {
                      defaultValue: "Edit",
                    })}
                    title={t("settings.edit", { defaultValue: "Edit" })}
                    disabled={isBusy}
                  >
                    <Pencil size={14} strokeWidth={1.9} />
                  </button>
                  {isConfigured && (
                    <button
                      className="icon-btn ghost danger"
                      onClick={() => onDelete(hook)}
                      type="button"
                      aria-label={t("settings.delete", {
                        defaultValue: "Delete",
                      })}
                      title={t("settings.delete", {
                        defaultValue: "Delete",
                      })}
                      disabled={isBusy}
                    >
                      {isBusy ? (
                        <Loader2 size={14} strokeWidth={1.9} className="spin" />
                      ) : (
                        <Trash2 size={14} strokeWidth={1.9} />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
