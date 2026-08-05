import { Loader2, Pencil, Trash2, Wrench } from "lucide-react";
import { useI18n } from "../../../i18n";
import type {
  ImportResourceRecord,
  ImportResourceReleaseDisposition,
  ImportResourceSource,
} from "../../../../preload";
import { ManagedImportResourceActions } from "../importConfig/ManagedImportResourceActions";
import type { McpServerTool } from "./types";

export type McpSettingsListItem = {
  serverId: string;
  name: string;
  enabled: boolean;
  globalEnabled: boolean;
  detail: string;
  canManage: boolean;
  importResource?: ImportResourceRecord;
};

type McpSettingsListProps = {
  servers: McpSettingsListItem[];
  isBusy: boolean;
  listTitle: string;
  emptyMessage: string;
  toolsByServerId: Readonly<Record<string, readonly McpServerTool[]>>;
  fetchingToolServerIds: ReadonlySet<string>;
  onToggleEnabled: (server: McpSettingsListItem) => void;
  onFetchTools: (server: McpSettingsListItem) => void;
  onEdit: (server: McpSettingsListItem) => void;
  onDelete: (server: McpSettingsListItem) => void;
  onReleaseImportResource: (
    resource: ImportResourceRecord,
    source: ImportResourceSource,
    disposition: ImportResourceReleaseDisposition
  ) => void;
};

export function McpSettingsList({
  servers,
  isBusy,
  listTitle,
  emptyMessage,
  toolsByServerId,
  fetchingToolServerIds,
  onToggleEnabled,
  onFetchTools,
  onEdit,
  onDelete,
  onReleaseImportResource,
}: McpSettingsListProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="api-settings-form-section">
      <div className="api-settings-form-section-header">
        <strong className="api-settings-form-section-title">{listTitle}</strong>
      </div>

      <div className="system-prompt-list mcp-server-list">
        {servers.length === 0 ? (
          <div className="system-prompt-empty">{emptyMessage}</div>
        ) : (
          servers.map((server) => {
            const globallyUnavailable = !server.globalEnabled;
            const activeLabel = globallyUnavailable
              ? t("settings.mcpGloballyDisabled", {
                  defaultValue: "Disabled in global scope",
                })
              : server.enabled
              ? t("settings.mcpDisableServer", { defaultValue: "Disable" })
              : t("settings.mcpEnableServer", { defaultValue: "Enable" });
            const activeStateLabel = globallyUnavailable
              ? t("settings.mcpGlobalDisabledShort", {
                  defaultValue: "Global off",
                })
              : server.enabled
              ? t("settings.active", { defaultValue: "Active" })
              : t("settings.inactive", { defaultValue: "Inactive" });
            const isFetchingTools = fetchingToolServerIds.has(server.serverId);
            const tools = toolsByServerId[server.serverId];
            const toolCount = tools?.length;
            const fetchToolsLabel = globallyUnavailable
              ? t("settings.mcpGloballyDisabled", {
                  defaultValue: "Disabled in global scope",
                })
              : server.enabled
              ? t("settings.mcpFetchTools", { defaultValue: "Fetch tools" })
              : t("settings.mcpEnableBeforeFetchTools", {
                  defaultValue: "Enable this server before fetching tools",
                });

            return (
              <div
                key={server.serverId}
                className={`system-prompt-item ${
                  server.enabled && server.globalEnabled ? "active" : ""
                }`}
              >
                <div className="system-prompt-item-main">
                  <label
                    className="toggle-switch system-prompt-switch"
                    aria-label={activeLabel}
                    title={activeLabel}
                  >
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      onChange={() => onToggleEnabled(server)}
                      disabled={isBusy || globallyUnavailable}
                      hidden
                    />
                    <span className="toggle-slider" />
                    <span>{activeStateLabel}</span>
                  </label>
                  <div className="system-prompt-item-info">
                    <strong>{server.name}</strong>
                    <span title={server.detail}>{server.detail || "-"}</span>
                  </div>
                </div>
                <div className="system-prompt-item-actions">
                  <button
                    className="mcp-tools-count-button"
                    onClick={() => onFetchTools(server)}
                    type="button"
                    aria-label={fetchToolsLabel}
                    title={fetchToolsLabel}
                    disabled={
                      isBusy ||
                      isFetchingTools ||
                      !server.enabled ||
                      globallyUnavailable
                    }
                  >
                    {isFetchingTools ? (
                      <Loader2 size={13} className="spin" />
                    ) : (
                      <Wrench size={13} strokeWidth={1.9} />
                    )}
                    <span>{toolCount ?? "-"}</span>
                  </button>
                  {server.canManage && (
                    <>
                      <button
                        className="icon-btn ghost"
                        onClick={() => onEdit(server)}
                        type="button"
                        aria-label={t("settings.edit", {
                          defaultValue: "Edit",
                        })}
                        title={t("settings.edit", { defaultValue: "Edit" })}
                        disabled={isBusy}
                      >
                        <Pencil size={14} strokeWidth={1.9} />
                      </button>
                      <button
                        className="icon-btn ghost danger"
                        onClick={() => onDelete(server)}
                        type="button"
                        aria-label={t("settings.delete", {
                          defaultValue: "Delete",
                        })}
                        title={t("settings.delete", { defaultValue: "Delete" })}
                        disabled={isBusy}
                      >
                        <Trash2 size={14} strokeWidth={1.9} />
                      </button>
                    </>
                  )}
                  <ManagedImportResourceActions
                    resource={server.importResource}
                    isBusy={isBusy}
                    onRelease={onReleaseImportResource}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
