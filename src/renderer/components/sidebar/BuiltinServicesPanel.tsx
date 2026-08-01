import { Loader2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { useI18n } from "../../i18n";
import type { BuiltinServicesStatus } from "../../../preload";

type BuiltinServicesPanelProps = {
  onClose?: () => void;
};

// 内置服务展示顺序与 i18n key 后缀（与后端 BUILTIN_SERVICE_IDS 保持一致）。
const BUILTIN_SERVICES: ReadonlyArray<{ id: string; i18nSuffix: string }> = [
  { id: "filesystem", i18nSuffix: "filesystem" },
  { id: "bash", i18nSuffix: "bash" },
  { id: "todo", i18nSuffix: "todo" },
  { id: "grep", i18nSuffix: "grep" },
  { id: "websearch", i18nSuffix: "websearch" },
  { id: "browser", i18nSuffix: "browser" },
  { id: "user-interaction", i18nSuffix: "userInteraction" },
  { id: "sub-agents", i18nSuffix: "subAgents" },
  { id: "codebase", i18nSuffix: "codebase" },
  { id: "codelens", i18nSuffix: "codelens" },
  { id: "app-control", i18nSuffix: "appControl" },
];

export function BuiltinServicesPanel({
  onClose,
}: BuiltinServicesPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [statuses, setStatuses] = useState<BuiltinServicesStatus>({});
  const [isLoading, setIsLoading] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const result = await window.snow.getBuiltinServicesStatus();
      setStatuses(result);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("builtinServices.loadError", {
              defaultValue: "Failed to load built-in services status",
            })
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggle = async (serviceId: string, enabled: boolean): Promise<void> => {
    setError("");
    setStatus("");
    setPendingIds((prev) => new Set(prev).add(serviceId));

    // 乐观更新，失败时回滚。
    const previous = statuses;
    setStatuses((prev) => ({ ...prev, [serviceId]: enabled }));

    try {
      const result = await window.snow.setBuiltinServicesStatus({
        ...previous,
        [serviceId]: enabled,
      });
      setStatuses(result);
      setStatus(
        t("builtinServices.saved", {
          defaultValue: "Settings saved. Disabled services are hidden from the model.",
        })
      );
    } catch (e) {
      setStatuses(previous);
      setError(
        e instanceof Error
          ? e.message
          : t("builtinServices.saveError", {
              defaultValue: "Failed to update built-in services status",
            })
      );
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(serviceId);
        return next;
      });
    }
  };

  const disabledCount = BUILTIN_SERVICES.filter(
    (service) => statuses[service.id] === false
  ).length;

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("builtinServices.title", {
              defaultValue: "Built-in services",
            })}
          </strong>
          <span className="settings-item-description">
            {t("builtinServices.info", {
              defaultValue:
                "Globally enable or disable Snow App's built-in MCP services. Disabled services' tools are hidden from the AI model and cannot be called.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("builtinServices.close", {
              defaultValue: "Close built-in services settings",
            })}
            title={t("builtinServices.close", {
              defaultValue: "Close built-in services settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      {disabledCount > 0 && (
        <div className="builtin-services-warning">
          {t("builtinServices.disabledHint", {
            values: { count: disabledCount },
            defaultValue: `${disabledCount} service(s) disabled — their tools are currently invisible to the model.`,
          })}
        </div>
      )}

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      {isLoading ? (
        <div className="main-content-loading" role="status">
          <Loader2 className="spin" size={22} aria-hidden="true" />
          <span>{t("common.loading")}</span>
        </div>
      ) : (
        <div className="builtin-services-list">
          {BUILTIN_SERVICES.map((service) => {
            const enabled = statuses[service.id] !== false;
            const isPending = pendingIds.has(service.id);

            return (
              <div className="builtin-service-row" key={service.id}>
                <div className="builtin-service-info">
                  <strong className="builtin-service-name">
                    {t(`builtinServices.${service.i18nSuffix}.name`, {
                      defaultValue: service.id,
                    })}
                  </strong>
                  <span className="builtin-service-id">{service.id}</span>
                </div>
                <button
                  className={`builtin-service-toggle ${enabled ? "on" : ""}`}
                  onClick={() => void handleToggle(service.id, !enabled)}
                  type="button"
                  disabled={isPending}
                  role="switch"
                  aria-checked={enabled}
                  aria-label={t(`builtinServices.${service.i18nSuffix}.name`, {
                    defaultValue: service.id,
                  })}
                >
                  {isPending ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <span className="builtin-service-toggle-knob" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
