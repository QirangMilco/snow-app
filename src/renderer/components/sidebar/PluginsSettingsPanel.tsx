import {
  CircleCheck,
  Download,
  FileWarning,
  Globe2,
  GripVertical,
  Loader2,
  Plus,
  Play,
  RefreshCw,
  Square,
  ShieldCheck,
  Store,
  Trash2,
  TriangleAlert,
  Unplug,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PluginComponentRecord,
  PluginMarketplaceCatalog,
  PluginMarketplaceInstallPreview,
  PluginMarketplacePlugin,
  PluginRecord,
  PluginRuntimePermission,
} from "../../../preload";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";

type PluginsSettingsPanelProps = {
  onClose?: () => void;
  embedded?: boolean;
};

const PLUGINS_SPLIT_STORAGE_KEY = "snow.plugins-settings.split-ratio";
const PLUGINS_SPLIT_DEFAULT = 0.5;
const PLUGINS_SPLIT_MIN = 0.25;
const PLUGINS_SPLIT_MAX = 0.75;
const PLUGINS_SPLIT_STEP = 0.05;

const clampSplitRatio = (value: number): number =>
  Math.min(PLUGINS_SPLIT_MAX, Math.max(PLUGINS_SPLIT_MIN, value));

const readStoredSplitRatio = (): number => {
  try {
    const stored = Number(window.localStorage.getItem(PLUGINS_SPLIT_STORAGE_KEY));
    return Number.isFinite(stored) ? clampSplitRatio(stored) : PLUGINS_SPLIT_DEFAULT;
  } catch {
    return PLUGINS_SPLIT_DEFAULT;
  }
};

const componentLabel = (component: PluginComponentRecord): string =>
  component.componentType === "mcp"
    ? "MCP"
    : component.componentType === "skill"
      ? "Skill"
      : component.componentType === "prompt"
        ? "Prompt"
        : component.componentType === "command"
          ? "Command"
          : component.componentType === "agent"
            ? "Agent"
            : "Hook";

const runtimePermissionLabel = (permission: PluginRuntimePermission): string =>
  permission === "storage"
    ? "Plugin storage"
    : permission === "network"
      ? "Network"
      : "Child process";

function PluginEnableToggle({
  plugin,
  disabled,
  onToggle,
}: {
  plugin: PluginRecord;
  disabled: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const enabled = plugin.state === "enabled";
  const label = enabled
    ? t("settings.pluginsDisable", { defaultValue: "Disable Plugin" })
    : t("settings.pluginsEnable", { defaultValue: "Enable Plugin" });
  const stateLabel = enabled
    ? t("settings.enabled", { defaultValue: "Enabled" })
    : t("settings.inactive", { defaultValue: "Disabled" });

  return (
    <label className="toggle-switch system-prompt-switch plugin-settings-switch" aria-label={label} title={label}>
      <input
        type="checkbox"
        checked={enabled}
        onChange={onToggle}
        disabled={disabled}
        hidden
      />
      <span className="toggle-slider" />
      <span>{stateLabel}</span>
    </label>
  );
}

const pluginStateLabel = (
  state: PluginRecord["state"],
  t: ReturnType<typeof useI18n>["t"]
): string => {
  if (state === "update-available") {
    return t("settings.pluginsStateUpdateAvailable", { defaultValue: "Update available" });
  }
  if (state === "broken") {
    return t("settings.pluginsStateBroken", { defaultValue: "Broken" });
  }
  return state;
};

export function PluginsSettingsPanel({ onClose, embedded = false }: PluginsSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [marketplaces, setMarketplaces] = useState<PluginMarketplaceCatalog[]>([]);
  const [selectedMarketplaceId, setSelectedMarketplaceId] = useState("");
  const [marketplaceSource, setMarketplaceSource] = useState("");
  const [showMarketplaceForm, setShowMarketplaceForm] = useState(false);
  const [isAddingMarketplace, setIsAddingMarketplace] = useState(false);
  const [busyMarketplaceId, setBusyMarketplaceId] = useState("");
  const [installingPluginKey, setInstallingPluginKey] = useState("");
  const [pendingMarketplaceInstall, setPendingMarketplaceInstall] = useState<PluginMarketplaceInstallPreview | null>(null);
  const [approvedMarketplaceMcpIds, setApprovedMarketplaceMcpIds] = useState<Set<string>>(() => new Set());
  const [pendingMarketplaceRemoval, setPendingMarketplaceRemoval] = useState<PluginMarketplaceCatalog | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [busyPluginId, setBusyPluginId] = useState("");
  const [expandedPluginId, setExpandedPluginId] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<PluginRecord | null>(null);
  const [pendingRuntimeStart, setPendingRuntimeStart] = useState<PluginRecord | null>(null);
  const [splitRatio, setSplitRatio] = useState(readStoredSplitRatio);
  const [isResizing, setIsResizing] = useState(false);
  const columnsRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const load = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError("");
    try {
      setPlugins(await window.snow.listPlugins());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("settings.pluginsLoadError", {
        defaultValue: "Failed to load Plugins",
      }));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  const loadMarketplaces = useCallback(async (): Promise<void> => {
    try {
      const next = await window.snow.listPluginMarketplaces();
      setMarketplaces(next);
      setSelectedMarketplaceId((current) => current && next.some((item) => item.marketplaceId === current)
        ? current
        : next[0]?.marketplaceId ?? "");
    } catch (loadError) {
      setMarketplaces([]);
      setError(loadError instanceof Error ? loadError.message : t("settings.pluginsMarketplaceLoadError", {
        defaultValue: "Marketplace could not be loaded",
      }));
    }
  }, [t]);

  useEffect(() => {
    void load();
    void loadMarketplaces();
  }, [load, loadMarketplaces]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PLUGINS_SPLIT_STORAGE_KEY, String(splitRatio));
    } catch {
      // Layout preference persistence is best effort.
    }
  }, [splitRatio]);

  useEffect(() => {
    const hasActiveRuntime = plugins.some((plugin) => {
      const state = plugin.runtimeStatus?.state;
      return state === "starting" || state === "running" || state === "stopping";
    });
    if (!hasActiveRuntime) return;
    const timer = window.setInterval(() => {
      void window.snow.listPlugins().then(setPlugins).catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [plugins]);

  const rescan = async (): Promise<void> => {
    setIsLoading(true);
    setError("");
    setStatus("");
    try {
      setPlugins(await window.snow.rescanPlugins());
      setStatus(t("settings.pluginsRescanSuccess", { defaultValue: "Plugin sources rescanned." }));
    } catch (rescanError) {
      setError(rescanError instanceof Error ? rescanError.message : t("settings.pluginsRescanError", {
        defaultValue: "Failed to rescan Plugins",
      }));
    } finally {
      setIsLoading(false);
    }
  };

  const toggleEnabled = async (plugin: PluginRecord): Promise<void> => {
    if (plugin.state === "update-available" || plugin.state === "broken") {
      return;
    }
    const enable = plugin.state !== "enabled";
    setBusyPluginId(plugin.pluginId);
    setError("");
    setStatus("");
    try {
      await window.snow.setPluginEnabled(plugin.pluginId, enable);
      await load();
      setStatus(t(enable ? "settings.pluginsEnableSuccess" : "settings.pluginsDisableSuccess", {
        defaultValue: enable ? "Plugin enabled." : "Plugin disabled.",
      }));
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : t("settings.pluginsUpdateError", {
        defaultValue: "Failed to update Plugin",
      }));
    } finally {
      setBusyPluginId("");
    }
  };

  const update = async (plugin: PluginRecord): Promise<void> => {
    setBusyPluginId(plugin.pluginId);
    setError("");
    setStatus("");
    try {
      await window.snow.updatePlugin(plugin.pluginId);
      await load();
      setStatus(t("settings.pluginsUpdateSuccess", { defaultValue: "Plugin updated." }));
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : t("settings.pluginsUpdateError", {
        defaultValue: "Failed to update Plugin",
      }));
    } finally {
      setBusyPluginId("");
    }
  };

  const startRuntime = async (): Promise<void> => {
    const plugin = pendingRuntimeStart;
    if (!plugin?.runtime) return;
    setPendingRuntimeStart(null);
    setBusyPluginId(plugin.pluginId);
    setError("");
    setStatus("");
    try {
      const result = await window.snow.startPluginRuntime(plugin.pluginId, plugin.runtime.permissions);
      await load();
      setStatus(result.message || t("settings.pluginsRuntimeStartSuccess", { defaultValue: "Plugin runtime started." }));
    } catch (runtimeError) {
      setError(runtimeError instanceof Error ? runtimeError.message : t("settings.pluginsRuntimeStartError", {
        defaultValue: "Failed to start Plugin runtime",
      }));
    } finally {
      setBusyPluginId("");
    }
  };

  const stopRuntime = async (plugin: PluginRecord): Promise<void> => {
    setBusyPluginId(plugin.pluginId);
    setError("");
    setStatus("");
    try {
      const result = await window.snow.stopPluginRuntime(plugin.pluginId);
      await load();
      setStatus(result.message || t("settings.pluginsRuntimeStopSuccess", { defaultValue: "Plugin runtime stopped." }));
    } catch (runtimeError) {
      setError(runtimeError instanceof Error ? runtimeError.message : t("settings.pluginsRuntimeStopError", {
        defaultValue: "Failed to stop Plugin runtime",
      }));
    } finally {
      setBusyPluginId("");
    }
  };

  const remove = async (): Promise<void> => {
    const plugin = pendingRemoval;
    if (!plugin) return;
    setPendingRemoval(null);
    setBusyPluginId(plugin.pluginId);
    setError("");
    setStatus("");
    try {
      await window.snow.removePlugin(plugin.pluginId);
      await load();
      setStatus(t("settings.pluginsRemoveSuccess", { defaultValue: "Plugin removed." }));
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : t("settings.pluginsRemoveError", {
        defaultValue: "Failed to remove Plugin",
      }));
    } finally {
      setBusyPluginId("");
    }
  };

  const addMarketplace = async (): Promise<void> => {
    const source = marketplaceSource.trim();
    if (!source) return;
    setIsAddingMarketplace(true);
    setError("");
    setStatus("");
    try {
      const next = await window.snow.addPluginMarketplace(source);
      setMarketplaces(next);
      setSelectedMarketplaceId(next[0]?.marketplaceId ?? "");
      setMarketplaceSource("");
      setShowMarketplaceForm(false);
      setStatus(t("settings.pluginsMarketplaceAddSuccess", { defaultValue: "Marketplace added." }));
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : t("settings.pluginsMarketplaceAddError", {
        defaultValue: "Failed to add marketplace",
      }));
    } finally {
      setIsAddingMarketplace(false);
    }
  };

  const refreshMarketplace = async (marketplace: PluginMarketplaceCatalog): Promise<void> => {
    setBusyMarketplaceId(marketplace.marketplaceId);
    setError("");
    setStatus("");
    try {
      const next = await window.snow.updatePluginMarketplace(marketplace.marketplaceId);
      setMarketplaces(next);
      setStatus(t("settings.pluginsMarketplaceUpdateSuccess", { defaultValue: "Marketplace refreshed." }));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : t("settings.pluginsMarketplaceUpdateError", {
        defaultValue: "Failed to refresh marketplace",
      }));
    } finally {
      setBusyMarketplaceId("");
    }
  };

  const removeMarketplace = async (): Promise<void> => {
    const marketplace = pendingMarketplaceRemoval;
    if (!marketplace) return;
    setPendingMarketplaceRemoval(null);
    setBusyMarketplaceId(marketplace.marketplaceId);
    setError("");
    setStatus("");
    try {
      await window.snow.removePluginMarketplace(marketplace.marketplaceId);
      const next = marketplaces.filter((item) => item.marketplaceId !== marketplace.marketplaceId);
      setMarketplaces(next);
      setSelectedMarketplaceId(next[0]?.marketplaceId ?? "");
      setStatus(t("settings.pluginsMarketplaceRemoveSuccess", { defaultValue: "Marketplace removed." }));
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : t("settings.pluginsMarketplaceRemoveError", {
        defaultValue: "Failed to remove marketplace",
      }));
    } finally {
      setBusyMarketplaceId("");
    }
  };

  const previewMarketplacePluginInstall = async (marketplace: PluginMarketplaceCatalog, plugin: PluginMarketplacePlugin): Promise<void> => {
    const key = `${marketplace.marketplaceId}:${plugin.pluginName}`;
    setInstallingPluginKey(key);
    setError("");
    setStatus("");
    try {
      const preview = await window.snow.previewPluginMarketplaceInstall(marketplace.marketplaceId, plugin.pluginName);
      setPendingMarketplaceInstall(preview);
      setApprovedMarketplaceMcpIds(new Set());
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : t("settings.pluginsMarketplaceInstallError", {
        defaultValue: "Failed to install Plugin",
      }));
    } finally {
      setInstallingPluginKey("");
    }
  };

  const installMarketplacePlugin = async (): Promise<void> => {
    const preview = pendingMarketplaceInstall;
    if (!preview) return;
    const key = `${preview.marketplaceId}:${preview.pluginName}`;
    setPendingMarketplaceInstall(null);
    setInstallingPluginKey(key);
    setError("");
    setStatus("");
    try {
      await window.snow.installPluginFromMarketplace(
        preview.marketplaceId,
        preview.pluginName,
        preview.mcpServers
          .filter((mcp) => approvedMarketplaceMcpIds.has(mcp.componentId))
          .map((mcp) => ({ componentId: mcp.componentId, approvalHash: mcp.approvalHash }))
      );
      await Promise.all([load(), loadMarketplaces()]);
      setStatus(t("settings.pluginsMarketplaceInstallSuccess", { defaultValue: "Plugin installed." }));
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : t("settings.pluginsMarketplaceInstallError", {
        defaultValue: "Failed to install Plugin",
      }));
    } finally {
      setInstallingPluginKey("");
    }
  };

  const toggleMarketplaceMcpApproval = (componentId: string): void => {
    setApprovedMarketplaceMcpIds((current) => {
      const next = new Set(current);
      if (next.has(componentId)) next.delete(componentId);
      else next.add(componentId);
      return next;
    });
  };

  const startSplitResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      event.preventDefault();
      const container = columnsRef.current;
      if (!container || container.clientWidth <= 0) {
        return;
      }

      const startX = event.clientX;
      const startRatio = splitRatio;
      const containerWidth = container.clientWidth;
      setIsResizing(true);
      event.currentTarget.setPointerCapture(event.pointerId);

      const handlePointerMove = (pointerEvent: PointerEvent): void => {
        const deltaRatio = (pointerEvent.clientX - startX) / containerWidth;
        setSplitRatio(clampSplitRatio(startRatio + deltaRatio));
      };

      const stopResize = (): void => {
        setIsResizing(false);
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", stopResize);
        document.removeEventListener("pointercancel", stopResize);
      };

      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", stopResize);
      document.addEventListener("pointercancel", stopResize);
    },
    [splitRatio]
  );

  const handleSplitKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      let nextRatio: number | null = null;
      if (event.key === "ArrowLeft") {
        nextRatio = splitRatio - PLUGINS_SPLIT_STEP;
      } else if (event.key === "ArrowRight") {
        nextRatio = splitRatio + PLUGINS_SPLIT_STEP;
      } else if (event.key === "Home") {
        nextRatio = PLUGINS_SPLIT_MIN;
      } else if (event.key === "End") {
        nextRatio = PLUGINS_SPLIT_MAX;
      }
      if (nextRatio === null) {
        return;
      }
      event.preventDefault();
      setSplitRatio(clampSplitRatio(nextRatio));
    },
    [splitRatio]
  );

  const enabledCount = plugins.filter((plugin) => plugin.state === "enabled").length;
  const brokenCount = plugins.filter((plugin) => plugin.state === "broken").length;
  const selectedMarketplace = marketplaces.find((item) => item.marketplaceId === selectedMarketplaceId) ?? null;
  const catalogPlugins = useMemo(() => selectedMarketplace?.plugins ?? [], [selectedMarketplace]);

  return (
    <div
      className={embedded ? "plugins-settings-embedded" : "api-settings-page plugins-settings-page"}
      role="region"
    >
      <div className={`api-settings-page-header ${embedded ? "plugins-settings-embedded-header" : ""}`}>
        <div className="api-settings-title-group">
          <strong>{t("settings.pluginsSettings", { defaultValue: "Plugins" })}</strong>
          <span className="settings-item-description">
            {t("settings.pluginsSettingsInfo", { defaultValue: "Manage imported declarative Plugin components." })}
          </span>
        </div>
        <div className="api-settings-header-actions">
          <button
            className="icon-btn ghost"
            type="button"
            onClick={() => void rescan()}
            disabled={isLoading || Boolean(busyPluginId)}
            aria-label={t("settings.pluginsRescan", { defaultValue: "Rescan Plugins" })}
            title={t("settings.pluginsRescan", { defaultValue: "Rescan Plugins" })}
          >
            {isLoading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
          </button>
          {onClose ? (
            <button
              className="icon-btn ghost"
              type="button"
              onClick={onClose}
              aria-label={t("settings.closePluginsSettings", { defaultValue: "Close Plugins settings" })}
              title={t("settings.closePluginsSettings", { defaultValue: "Close Plugins settings" })}
            >
              <X size={15} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="api-settings-summary-grid plugins-settings-summary-grid">
        <div className="api-settings-summary-card"><Wrench size={15} /><span>{t("settings.pluginsInstalled", { defaultValue: "Installed" })}</span><strong>{plugins.length}</strong></div>
        <div className="api-settings-summary-card"><CircleCheck size={15} /><span>{t("settings.pluginsEnabled", { defaultValue: "Enabled" })}</span><strong>{enabledCount}</strong></div>
        <div className="api-settings-summary-card"><TriangleAlert size={15} /><span>{t("settings.pluginsIssues", { defaultValue: "Issues" })}</span><strong>{brokenCount}</strong></div>
      </div>

      <AutoDismissNotice message={status} tone="success" onDismiss={() => setStatus("")} />
      <AutoDismissNotice message={error} tone="error" onDismiss={() => setError("")} />

      <div
        className={`plugins-management-columns ${isResizing ? "is-resizing" : ""}`}
        ref={columnsRef}
        style={{ "--plugins-installed-width": `${splitRatio * 100}%` } as React.CSSProperties}
      >
        <section className="api-settings-form-section plugins-settings-list" aria-label={t("settings.pluginsList", { defaultValue: "Plugin list" })}>
          <div className="api-settings-form-section-header">
            <div className="plugins-marketplaces-title">
              <strong className="api-settings-form-section-title">
                {t("settings.pluginsInstalledSection", { defaultValue: "Installed Plugins" })}
              </strong>
              <span className="settings-item-description">
                {t("settings.pluginsInstalledInfo", { defaultValue: "Enable, disable, update, or uninstall Plugins managed by Snow." })}
              </span>
            </div>
            <span className="plugins-section-count">{plugins.length}</span>
          </div>
          {plugins.length === 0 && !isLoading ? (
            <div className="settings-empty-state">{t("settings.pluginsEmpty", { defaultValue: "No imported Plugins." })}</div>
          ) : plugins.map((plugin) => {
            const busy = busyPluginId === plugin.pluginId;
            const expanded = expandedPluginId === plugin.pluginId;
            const unsupported = plugin.components.filter((item) => item.status === "unsupported").length;
            const runtimeState = plugin.runtimeStatus?.state ?? "unavailable";
            const runtimeActive = runtimeState === "starting" || runtimeState === "running" || runtimeState === "stopping";
            const toggleDisabled = busy || isLoading || plugin.state === "update-available" || plugin.state === "broken";
            return (
              <article className={`plugin-settings-item ${plugin.state === "disabled" ? "inactive" : ""}`} key={plugin.pluginId}>
                <div className="plugin-settings-item-main">
                  <PluginEnableToggle
                    plugin={plugin}
                    disabled={toggleDisabled}
                    onToggle={() => void toggleEnabled(plugin)}
                  />
                  <button
                    type="button"
                    className="plugin-settings-name"
                    onClick={() => setExpandedPluginId(expanded ? "" : plugin.pluginId)}
                    aria-expanded={expanded}
                  >
                    <strong>{plugin.name}</strong>
                    <span>{plugin.provider}{plugin.version ? ` ${plugin.version}` : ""}</span>
                  </button>
                  {plugin.state !== "enabled" && plugin.state !== "disabled" ? (
                    <span className={`plugin-settings-state state-${plugin.state}`}>{pluginStateLabel(plugin.state, t)}</span>
                  ) : null}
                  <span className="plugin-settings-count">{plugin.components.length}</span>
                  <div className="plugin-settings-actions">
                    {plugin.runtime ? (
                      <button
                        className={`icon-btn ghost ${runtimeActive ? "primary" : ""}`}
                        type="button"
                        disabled={busy || isLoading || plugin.state !== "enabled"}
                        onClick={() => runtimeActive ? void stopRuntime(plugin) : setPendingRuntimeStart(plugin)}
                        aria-label={t(runtimeActive ? "settings.pluginsRuntimeStop" : "settings.pluginsRuntimeStart", { defaultValue: runtimeActive ? "Stop Plugin runtime" : "Start Plugin runtime" })}
                        title={t(runtimeActive ? "settings.pluginsRuntimeStop" : "settings.pluginsRuntimeStart", { defaultValue: runtimeActive ? "Stop Plugin runtime" : "Start Plugin runtime" })}
                      >
                        {busy ? <Loader2 size={15} className="spin" /> : runtimeActive ? <Square size={14} /> : <Play size={15} />}
                      </button>
                    ) : null}
                    {plugin.state === "update-available" ? (
                      <button
                        className="icon-btn ghost"
                        type="button"
                        disabled={busy || isLoading}
                        onClick={() => void update(plugin)}
                        aria-label={t("settings.pluginsUpdate", { defaultValue: "Update Plugin" })}
                        title={t("settings.pluginsUpdate", { defaultValue: "Update Plugin" })}
                      ><RefreshCw size={15} /></button>
                    ) : null}
                    <button
                      className="icon-btn ghost danger"
                      type="button"
                      disabled={busy || isLoading}
                      onClick={() => setPendingRemoval(plugin)}
                      aria-label={t("settings.pluginsRemove", { defaultValue: "Remove Plugin" })}
                      title={t("settings.pluginsRemove", { defaultValue: "Remove Plugin" })}
                    ><Trash2 size={15} /></button>
                  </div>
                </div>
                {expanded ? (
                  <div className="plugin-settings-components">
                    <div className="plugin-settings-path" title={plugin.sourcePath}>{plugin.sourcePath}</div>
                    {plugin.runtime ? (
                      <div className={`plugin-settings-runtime state-${runtimeState}`}>
                        <ShieldCheck size={14} />
                        <span>{t("settings.pluginsRuntime", { defaultValue: "Runtime" })}</span>
                        <code>{plugin.runtime.entry}</code>
                        <small>{t(`settings.pluginsRuntimeState.${runtimeState}`, { defaultValue: runtimeState })}</small>
                        <small>{plugin.runtime.permissions.length > 0
                          ? plugin.runtime.permissions.map(runtimePermissionLabel).join(", ")
                          : t("settings.pluginsRuntimeNoPermissions", { defaultValue: "No additional permissions" })}</small>
                        {plugin.runtimeStatus?.message ? <small>{plugin.runtimeStatus.message}</small> : null}
                      </div>
                    ) : null}
                    {plugin.components.map((component) => (
                      <div className={`plugin-settings-component ${component.status}`} key={component.componentId}>
                        {component.status === "unsupported" ? <FileWarning size={14} /> : <Unplug size={14} />}
                        <span>{componentLabel(component)}</span>
                        <code>{component.logicalId}</code>
                        {component.unsupportedReason ? <small>{component.unsupportedReason}</small> : null}
                      </div>
                    ))}
                    {unsupported > 0 ? <span className="plugin-settings-unsupported-count">{unsupported}</span> : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </section>

        <div
          className={`plugins-columns-resizer ${isResizing ? "is-resizing" : ""}`}
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-valuemin={PLUGINS_SPLIT_MIN * 100}
          aria-valuemax={PLUGINS_SPLIT_MAX * 100}
          aria-valuenow={Math.round(splitRatio * 100)}
          aria-label={t("settings.pluginsResizeColumns", { defaultValue: "Resize installed Plugins and marketplace columns" })}
          onPointerDown={startSplitResize}
          onKeyDown={handleSplitKeyDown}
        >
          <GripVertical size={14} aria-hidden="true" />
        </div>

        <div className="plugins-marketplace-column">
          <section className="api-settings-form-section plugins-marketplaces-section" aria-label={t("settings.pluginsMarketplaces", { defaultValue: "Plugin marketplaces" })}>
            <div className="api-settings-form-section-header">
              <div className="plugins-marketplaces-title">
                <strong className="api-settings-form-section-title">
                  {t("settings.pluginsMarketplaces", { defaultValue: "Plugin marketplaces" })}
                </strong>
                <span className="settings-item-description">
                  {t("settings.pluginsMarketplacesInfo", { defaultValue: "Add a local or remote marketplace, then install Plugins from its catalog." })}
                </span>
              </div>
              <button
                className="api-settings-form-btn secondary plugins-marketplace-add-button"
                type="button"
                onClick={() => setShowMarketplaceForm((current) => !current)}
                disabled={isAddingMarketplace || Boolean(busyMarketplaceId)}
              >
                <Plus size={14} />
                <span>{t("settings.pluginsMarketplaceAdd", { defaultValue: "Add marketplace" })}</span>
              </button>
            </div>
            {showMarketplaceForm ? (
              <div className="plugins-marketplace-add-form">
                <label className="api-settings-field">
                  <span>{t("settings.pluginsMarketplaceSourceLabel", { defaultValue: "Marketplace source" })}</span>
                  <input
                    autoFocus
                    value={marketplaceSource}
                    onChange={(event) => setMarketplaceSource(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void addMarketplace();
                      }
                    }}
                    placeholder={t("settings.pluginsMarketplaceSourcePlaceholder", { defaultValue: "./my-marketplace, owner/repo, or https://example.com/marketplace.json" })}
                    disabled={isAddingMarketplace}
                  />
                </label>
                <div className="api-settings-form-actions">
                  <button className="api-settings-form-btn secondary" type="button" onClick={() => setShowMarketplaceForm(false)} disabled={isAddingMarketplace}>
                    <span>{t("settings.pluginsMarketplaceAddCancel", { defaultValue: "Cancel" })}</span>
                  </button>
                  <button className="api-settings-form-btn primary" type="button" onClick={() => void addMarketplace()} disabled={isAddingMarketplace || !marketplaceSource.trim()}>
                    {isAddingMarketplace ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
                    <span>{t(isAddingMarketplace ? "settings.pluginsMarketplaceAdding" : "settings.pluginsMarketplaceAddConfirm", { defaultValue: isAddingMarketplace ? "Adding marketplace..." : "Add marketplace" })}</span>
                  </button>
                </div>
                <small className="plugins-marketplace-trust-note">
                  <ShieldCheck size={13} />
                  {t("settings.pluginsMarketplaceTrustNote", { defaultValue: "Only install Plugins from sources you trust. Snow reads declarative components and does not run install scripts." })}
                </small>
              </div>
            ) : null}
            {marketplaces.length === 0 ? (
              <div className="settings-empty-state">{t("settings.pluginsMarketplaceEmpty", { defaultValue: "No marketplaces added." })}</div>
            ) : (
              <div className="plugins-marketplace-list">
                {marketplaces.map((marketplace) => {
                  const selected = marketplace.marketplaceId === selectedMarketplaceId;
                  const busy = busyMarketplaceId === marketplace.marketplaceId;
                  return (
                    <article className={`plugins-marketplace-item ${selected ? "selected" : ""}`} key={marketplace.marketplaceId}>
                      <button className="plugins-marketplace-select" type="button" onClick={() => setSelectedMarketplaceId(marketplace.marketplaceId)} aria-pressed={selected}>
                        <Store size={15} />
                        <span className="plugins-marketplace-item-copy">
                          <strong>{marketplace.displayName || marketplace.name}</strong>
                          <small>{marketplace.name} · {t(`settings.pluginsMarketplaceSourceType.${marketplace.sourceType}`, { defaultValue: marketplace.sourceType })}</small>
                        </span>
                        <span className="plugins-marketplace-count">{marketplace.plugins.length}</span>
                      </button>
                      <div className="plugins-marketplace-item-actions">
                        <button className="icon-btn ghost" type="button" onClick={() => void refreshMarketplace(marketplace)} disabled={busy || Boolean(busyMarketplaceId) || isAddingMarketplace} aria-label={t("settings.pluginsMarketplaceUpdate", { defaultValue: "Refresh marketplace" })} title={t("settings.pluginsMarketplaceUpdate", { defaultValue: "Refresh marketplace" })}>
                          {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                        </button>
                        <button className="icon-btn ghost danger" type="button" onClick={() => setPendingMarketplaceRemoval(marketplace)} disabled={busy || Boolean(busyMarketplaceId) || isAddingMarketplace} aria-label={t("settings.pluginsMarketplaceRemove", { defaultValue: "Remove marketplace" })} title={t("settings.pluginsMarketplaceRemove", { defaultValue: "Remove marketplace" })}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {selectedMarketplace ? (
            <section className="api-settings-form-section plugins-marketplace-catalog" aria-label={t("settings.pluginsMarketplaceCatalog", { defaultValue: "Available Plugins" })}>
              <div className="api-settings-form-section-header">
                <div className="plugins-marketplaces-title">
                  <strong className="api-settings-form-section-title">{selectedMarketplace.displayName || selectedMarketplace.name}</strong>
                  <span className="settings-item-description">{selectedMarketplace.description || selectedMarketplace.sourcePath}</span>
                </div>
                <Globe2 size={15} className="plugins-marketplace-catalog-icon" />
              </div>
              {selectedMarketplace.loadError ? <div className="plugins-marketplace-load-error"><TriangleAlert size={14} />{selectedMarketplace.loadError}</div> : null}
              {catalogPlugins.length === 0 ? (
                <div className="settings-empty-state">{t("settings.pluginsMarketplaceCatalogEmpty", { defaultValue: "This marketplace has no installable Plugins." })}</div>
              ) : (
                <div className="plugins-marketplace-plugin-list">
                  {catalogPlugins.map((plugin) => {
                    const key = `${selectedMarketplace.marketplaceId}:${plugin.pluginName}`;
                    const installing = installingPluginKey === key;
                    const installedPlugin = plugin.installedPluginId
                      ? plugins.find((item) => item.pluginId === plugin.installedPluginId)
                      : undefined;
                    const installedToggleDisabled = Boolean(installedPlugin) && (isLoading || busyPluginId === installedPlugin?.pluginId || installedPlugin?.state === "update-available" || installedPlugin?.state === "broken");
                    return (
                      <article className={`plugins-marketplace-plugin ${plugin.supported ? "" : "unsupported"}`} key={plugin.pluginName}>
                        <div className="plugins-marketplace-plugin-copy">
                          <strong>{plugin.displayName}</strong>
                          <small>{plugin.pluginName}{plugin.version ? ` · ${plugin.version}` : ""}{plugin.category ? ` · ${plugin.category}` : ""}</small>
                          {plugin.description ? <p>{plugin.description}</p> : null}
                          {plugin.unsupportedReason ? <small className="plugins-marketplace-plugin-error">{plugin.unsupportedReason}</small> : null}
                        </div>
                        <div className="plugins-marketplace-plugin-actions">
                          {installedPlugin ? (
                            <PluginEnableToggle
                              plugin={installedPlugin}
                              disabled={installedToggleDisabled}
                              onToggle={() => void toggleEnabled(installedPlugin)}
                            />
                          ) : null}
                          {installedPlugin && installedPlugin.state !== "enabled" && installedPlugin.state !== "disabled" ? (
                            <span className={`plugins-marketplace-installed-state state-${installedPlugin.state}`}>
                              {pluginStateLabel(installedPlugin.state, t)}
                            </span>
                          ) : null}
                          {plugin.supported ? (
                            <button className="api-settings-form-btn secondary plugins-marketplace-install-button" type="button" onClick={() => void previewMarketplacePluginInstall(selectedMarketplace, plugin)} disabled={installing || Boolean(installingPluginKey) || Boolean(busyMarketplaceId)}>
                              {installing ? <Loader2 size={14} className="spin" /> : plugin.installedPluginId ? <RefreshCw size={14} /> : <Download size={14} />}
                              <span>{t(installing ? "settings.pluginsMarketplaceInstalling" : plugin.installedPluginId ? "settings.pluginsUpdate" : "settings.pluginsMarketplaceInstall", { defaultValue: installing ? "Installing..." : plugin.installedPluginId ? "Update Plugin" : "Install Plugin" })}</span>
                            </button>
                          ) : (
                            <span className="plugins-marketplace-unsupported">{t("settings.pluginsMarketplaceUnsupported", { defaultValue: "Unsupported" })}</span>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(pendingMarketplaceInstall)}
        title={t("settings.pluginsMarketplaceReviewTitle", { defaultValue: "Review Plugin installation" })}
        message={t("settings.pluginsMarketplaceReviewMessage", { defaultValue: "MCP servers are disabled by default. Select each server you want to authorize after reviewing its declaration." })}
        confirmLabel={t("settings.pluginsMarketplaceInstall", { defaultValue: "Install Plugin" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void installMarketplacePlugin()}
        onCancel={() => setPendingMarketplaceInstall(null)}
        variant="warning"
        className="plugin-marketplace-install-review"
      >
        {pendingMarketplaceInstall ? (
          <div className="plugin-marketplace-install-review-content">
            <dl className="plugin-marketplace-install-sources">
              <div>
                <dt>{t("settings.pluginsMarketplaceSourceLabel", { defaultValue: "Marketplace source" })}</dt>
                <dd><code>{pendingMarketplaceInstall.marketplaceSource}</code></dd>
              </div>
              <div>
                <dt>{t("settings.pluginsMarketplacePluginSourceLabel", { defaultValue: "Plugin source" })}</dt>
                <dd><code>{pendingMarketplaceInstall.pluginSource}</code></dd>
              </div>
            </dl>
            {pendingMarketplaceInstall.mcpServers.length === 0 ? (
              <p className="plugin-marketplace-install-empty">
                {t("settings.pluginsMarketplaceNoMcp", { defaultValue: "This Plugin does not declare MCP servers." })}
              </p>
            ) : (
              <div className="plugin-marketplace-install-mcps">
                {pendingMarketplaceInstall.mcpServers.map((mcp) => (
                  <section className="plugin-marketplace-install-mcp" key={mcp.componentId}>
                    <label className="plugin-marketplace-install-mcp-toggle">
                      <input
                        type="checkbox"
                        checked={approvedMarketplaceMcpIds.has(mcp.componentId)}
                        onChange={() => toggleMarketplaceMcpApproval(mcp.componentId)}
                      />
                      <span>{t("settings.pluginsMarketplaceEnableMcp", { defaultValue: "Enable this MCP server" })}</span>
                    </label>
                    <strong>{mcp.name}</strong>
                    <dl className="plugin-marketplace-install-mcp-details">
                      <div><dt>{t("settings.pluginsMarketplaceDeclarationSource", { defaultValue: "Declaration" })}</dt><dd><code>{mcp.declarationPath}</code></dd></div>
                      <div><dt>{t("settings.pluginsMarketplaceTransport", { defaultValue: "Transport" })}</dt><dd><code>{mcp.transportType}</code></dd></div>
                      <div><dt>{t("settings.pluginsMarketplaceCommand", { defaultValue: "Command" })}</dt><dd><code>{mcp.command || "-"}</code></dd></div>
                      <div><dt>{t("settings.pluginsMarketplaceArgs", { defaultValue: "Arguments" })}</dt><dd><code>{JSON.stringify(mcp.args)}</code></dd></div>
                      <div><dt>{t("settings.pluginsMarketplaceEnv", { defaultValue: "Environment" })}</dt><dd><code>{JSON.stringify(mcp.env)}</code></dd></div>
                      <div><dt>{t("settings.pluginsMarketplaceUrl", { defaultValue: "URL" })}</dt><dd><code>{mcp.url || "-"}</code></dd></div>
                      {Object.keys(mcp.headers).length > 0 ? <div><dt>{t("settings.pluginsMarketplaceHeaders", { defaultValue: "HTTP headers" })}</dt><dd><code>{JSON.stringify(mcp.headers)}</code></dd></div> : null}
                    </dl>
                  </section>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(pendingRuntimeStart)}
        title={t("settings.pluginsRuntimeStart", { defaultValue: "Start Plugin runtime" })}
        message={pendingRuntimeStart?.runtime
          ? `${t("settings.pluginsRuntimeConfirm", { defaultValue: "Run external Plugin code in an isolated utility process. Only run code you trust." })} ${pendingRuntimeStart.runtime.permissions.length > 0
            ? `${t("settings.pluginsRuntimePermissions", { defaultValue: "Requested permissions:" })} ${pendingRuntimeStart.runtime.permissions.map(runtimePermissionLabel).join(", ")}.`
            : t("settings.pluginsRuntimeNoPermissions", { defaultValue: "No additional permissions" })}`
          : ""}
        confirmLabel={t("settings.pluginsRuntimeStart", { defaultValue: "Start Plugin runtime" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void startRuntime()}
        onCancel={() => setPendingRuntimeStart(null)}
        variant="warning"
      />

      <ConfirmDialog
        open={Boolean(pendingMarketplaceRemoval)}
        title={t("settings.pluginsMarketplaceRemove", { defaultValue: "Remove marketplace" })}
        message={t("settings.pluginsMarketplaceRemoveConfirm", { defaultValue: "Remove this marketplace and its Snow cache? Installed Plugins are kept." })}
        confirmLabel={t("settings.pluginsMarketplaceRemove", { defaultValue: "Remove marketplace" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void removeMarketplace()}
        onCancel={() => setPendingMarketplaceRemoval(null)}
        variant="danger"
      />

      <ConfirmDialog
        open={Boolean(pendingRemoval)}
        title={t("settings.pluginsRemove", { defaultValue: "Remove Plugin" })}
        message={t("settings.pluginsRemoveConfirm", { defaultValue: "Remove this Plugin and its Snow-managed components?" })}
        confirmLabel={t("settings.pluginsRemove", { defaultValue: "Remove Plugin" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void remove()}
        onCancel={() => setPendingRemoval(null)}
        variant="danger"
      />
    </div>
  );
}
