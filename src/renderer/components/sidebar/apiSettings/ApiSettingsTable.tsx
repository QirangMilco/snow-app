import { useMemo, useState, type ChangeEvent } from "react";
import { Copy, Loader2, Pencil, Search, Trash2 } from "lucide-react";
import { useI18n } from "../../../i18n";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import {
  DISABLED_STATUS_LABEL,
  ENABLED_STATUS_LABEL,
} from "./apiSettingsConstants";
import { filterApiConfigs } from "./apiSettingsSearch";
import type { ApiConfigItem } from "./types";

type ApiSettingsTableProps = {
  configs: ApiConfigItem[];
  isLoading: boolean;
  onDuplicate: (config: ApiConfigItem) => void;
  onEdit: (config: ApiConfigItem) => void;
  onDelete: (profileName: string, displayName: string) => void;
  onToggleActive: (config: ApiConfigItem) => void;
};

export function ApiSettingsTable({
  configs,
  isLoading,
  onDuplicate,
  onEdit,
  onDelete,
  onToggleActive,
}: ApiSettingsTableProps): React.JSX.Element {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingDeletion, setPendingDeletion] = useState<ApiConfigItem | null>(
    null
  );
  const filteredConfigs = useMemo(
    () => filterApiConfigs(configs, searchQuery),
    [configs, searchQuery]
  );
  const hasSearchQuery = searchQuery.trim().length > 0;

  const handleSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.target.value);
  };

  return (
    <div
      className="api-settings-table-panel"
      aria-label={t("settings.apiConfigTable", {
        defaultValue: "API configuration table",
      })}
    >
      <div className="api-settings-table-toolbar">
        <label className="api-settings-table-search">
          <Search size={14} strokeWidth={1.8} aria-hidden="true" />
          <input
            value={searchQuery}
            onChange={handleSearchChange}
            placeholder={t("settings.apiSearchPlaceholder", {
              defaultValue: "Search profiles, models, or base URLs",
            })}
            aria-label={t("settings.apiSearchLabel", {
              defaultValue: "Search API profiles",
            })}
            disabled={isLoading && configs.length === 0}
          />
        </label>
      </div>

      <div className="api-settings-table-wrap">
        {isLoading && configs.length === 0 ? (
          <div className="api-settings-empty">
            <Loader2 size={16} className="spin" />
            {t("settings.loadingApiConfigs", {
              defaultValue: "Loading API configs...",
            })}
          </div>
        ) : configs.length === 0 ? (
          <div className="api-settings-empty">
            {t("settings.noApiConfigs", {
              defaultValue:
                "No API profiles yet. Import Snow CLI profiles or add one manually.",
            })}
          </div>
        ) : filteredConfigs.length === 0 ? (
          <div className="api-settings-empty">
            {t("settings.noApiSearchResults", {
              defaultValue: "No API profiles match your search.",
            })}
          </div>
        ) : (
          <table className="api-settings-table">
            <thead>
              <tr>
                <th>{t("settings.tableName", { defaultValue: "Name" })}</th>
                <th>
                  {t("settings.tableBaseUrl", { defaultValue: "Base URL" })}
                </th>
                <th>{t("settings.tableModel", { defaultValue: "Model" })}</th>
                <th>{t("settings.tableMethod", { defaultValue: "Method" })}</th>
                <th>{t("settings.tableStatus", { defaultValue: "Status" })}</th>
                <th className="api-settings-table-actions-col">
                  {t("settings.tableActions", { defaultValue: "Actions" })}
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredConfigs.map((config) => {
                const activeStateLabel = config.isActive
                  ? t("settings.active", {
                      defaultValue: ENABLED_STATUS_LABEL,
                    })
                  : t("settings.inactive", {
                      defaultValue: DISABLED_STATUS_LABEL,
                    });
                const activeActionLabel = config.isActive
                  ? t("settings.activeProfile", {
                      defaultValue: "Enabled profile",
                    })
                  : t("settings.clickToActivate", {
                      defaultValue: "Click to enable this profile",
                    });

                return (
                  <tr key={config.profileName}>
                    <td className="cell-name">
                      <strong>{config.displayName}</strong>
                      <small className="profile-name-hint">
                        {config.profileName}
                      </small>
                    </td>
                    <td className="cell-url">{config.baseUrl || "-"}</td>
                    <td>{config.advancedModel || config.basicModel || "-"}</td>
                    <td>
                      <span className="badge method">
                        {config.requestMethod}
                      </span>
                    </td>
                    <td>
                      <label
                        className="toggle-switch api-settings-table-switch"
                        title={activeActionLabel}
                        aria-label={activeActionLabel}
                      >
                        <input
                          type="checkbox"
                          checked={config.isActive}
                          onChange={() => onToggleActive(config)}
                          disabled={config.isActive}
                        />
                        <span className="toggle-slider" />
                        <span>{activeStateLabel}</span>
                      </label>
                    </td>
                    <td className="api-settings-table-actions-col">
                      <div className="api-settings-table-actions">
                        <button
                          className="icon-btn ghost"
                          onClick={() => onDuplicate(config)}
                          type="button"
                          title={t("settings.duplicate", {
                            defaultValue: "Duplicate",
                          })}
                          aria-label={t("settings.duplicate", {
                            defaultValue: "Duplicate",
                          })}
                        >
                          <Copy size={13} strokeWidth={1.8} />
                        </button>
                        <button
                          className="icon-btn ghost"
                          onClick={() => onEdit(config)}
                          type="button"
                          title={t("settings.edit", { defaultValue: "Edit" })}
                          aria-label={t("settings.edit", {
                            defaultValue: "Edit",
                          })}
                        >
                          <Pencil size={13} strokeWidth={1.8} />
                        </button>
                        <button
                          className="icon-btn ghost danger"
                          onClick={() => setPendingDeletion(config)}
                          type="button"
                          title={t("settings.delete", {
                            defaultValue: "Delete",
                          })}
                          aria-label={t("settings.delete", {
                            defaultValue: "Delete",
                          })}
                        >
                          <Trash2 size={13} strokeWidth={1.8} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {hasSearchQuery && filteredConfigs.length > 0 && (
        <span className="api-settings-search-count">
          {t("settings.apiSearchResultCount", {
            defaultValue: "{count} profile(s) found",
          }).replace("{count}", String(filteredConfigs.length))}
        </span>
      )}

      <ConfirmDialog
        open={pendingDeletion !== null}
        title={t("settings.apiDeleteTitle", {
          defaultValue: "Delete API profile",
        })}
        message={t("settings.apiDeleteConfirm", {
          defaultValue: `Delete API profile "${
            pendingDeletion?.displayName ?? ""
          }"? This cannot be undone.`,
          values: { name: pendingDeletion?.displayName ?? "" },
        })}
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => {
          if (pendingDeletion) {
            onDelete(pendingDeletion.profileName, pendingDeletion.displayName);
          }
          setPendingDeletion(null);
        }}
        onCancel={() => setPendingDeletion(null)}
        variant="danger"
      />
    </div>
  );
}
