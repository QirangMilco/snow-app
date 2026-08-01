import { ArrowLeft, Download, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { localeLabels, useI18n, type Locale } from "../../i18n";
import { SETTINGS_ITEMS } from "./settingsItems";
import { SETTINGS_VIEW_IDS } from "./settingsItems";
import type { SidebarContentProps } from "./types";
import type { UpdateStatus } from "../../../preload";

const INITIAL_UPDATE_STATUS: UpdateStatus = {
  available: false,
  version: null,
  downloading: false,
  progress: 0,
  downloaded: false,
  error: null,
};

// 手动检查后的提示类型
type CheckHint = "up-to-date" | "error" | null;

// 提示自动隐藏时长（毫秒）
const HINT_AUTO_HIDE_MS = 3000;

export function SettingsSidebarContent({
  activeMainView,
  onSelectMainView,
  onSwitchContent,
}: SidebarContentProps): React.JSX.Element {
  const { locale, setLocale, supportedLocales, t } = useI18n();
  const [appVersion, setAppVersion] = useState<string>("");
  const [isChecking, setIsChecking] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(
    INITIAL_UPDATE_STATUS
  );
  const [checkHint, setCheckHint] = useState<CheckHint>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    window.snow
      .getAppVersion()
      .then((version) => setAppVersion(version))
      .catch(() => undefined);
    window.snow
      .getUpdateStatus()
      .then(setUpdateStatus)
      .catch(() => undefined);
    const unsubscribe = window.snow.onUpdateStatusChanged((status) => {
      setUpdateStatus(status);
    });
    return () => {
      unsubscribe();
      if (hintTimerRef.current) {
        clearTimeout(hintTimerRef.current);
        hintTimerRef.current = null;
      }
    };
  }, []);

  const clearHintTimer = (): void => {
    if (hintTimerRef.current) {
      clearTimeout(hintTimerRef.current);
      hintTimerRef.current = null;
    }
  };

  const showHint = (hint: Exclude<CheckHint, null>): void => {
    clearHintTimer();
    setCheckHint(hint);
    hintTimerRef.current = setTimeout(() => {
      setCheckHint(null);
      hintTimerRef.current = null;
    }, HINT_AUTO_HIDE_MS);
  };

  const handleExitSettings = (): void => {
    onSwitchContent("main");

    if (SETTINGS_VIEW_IDS.has(activeMainView)) {
      onSelectMainView("chat");
    }
  };

  const handleCheckForUpdates = (): void => {
    if (isChecking || updateStatus.downloading) {
      return;
    }
    setIsChecking(true);
    clearHintTimer();
    setCheckHint(null);
    window.snow
      .checkForUpdates()
      .then((result) => {
        if (result.available) {
          // 发现新版本，更新按钮会自动出现，无需额外提示
          return;
        }
        if (result.error) {
          showHint("error");
        } else {
          showHint("up-to-date");
        }
      })
      .catch(() => {
        showHint("error");
      })
      .finally(() => {
        setIsChecking(false);
      });
  };

  const handleDownloadUpdate = (): void => {
    void window.snow.downloadUpdate();
  };

  const handleInstallUpdate = (): void => {
    void window.snow.installUpdate();
  };

  return (
    <>
      <div className="sidebar-content-header">
        <button
          className="icon-btn ghost"
          onClick={handleExitSettings}
          type="button"
          aria-label={t("settings.backToMain", {
            defaultValue: "Back to main sidebar",
          })}
        >
          <ArrowLeft size={16} strokeWidth={1.8} />
        </button>
        <span className="sidebar-content-title">
          {t("settings.title", { defaultValue: "Settings" })}
        </span>
      </div>

      <div className="settings-content">
        <div className="sidebar-section settings-menu-section">
          <div className="settings-list">
            {SETTINGS_ITEMS.map((item) => {
              const isActive = item.view === activeMainView;

              return (
                <button
                  key={item.id}
                  className={`settings-item ${isActive ? "active" : ""}`}
                  onClick={() => onSelectMainView(item.view)}
                  type="button"
                >
                  <item.icon
                    className="settings-item-icon"
                    size={16}
                    strokeWidth={1.8}
                  />
                  <span className="settings-item-content">
                    <span className="settings-item-title">
                      {t(item.labelKey, { defaultValue: item.defaultLabel })}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="sidebar-section">
          <div className="section-header">
            <span className="section-title">
              {t("settings.languageSettings", { defaultValue: "Language" })}
            </span>
          </div>
          <div className="settings-panel">
            <span className="settings-item-description">
              {t("settings.languageSettingsInfo", {
                defaultValue: "Choose the display language for Snow App.",
              })}
            </span>
            <div className="settings-language-options">
              {supportedLocales.map((supportedLocale) => (
                <button
                  key={supportedLocale}
                  className={`settings-language-option ${
                    locale === supportedLocale ? "active" : ""
                  }`}
                  onClick={() => setLocale(supportedLocale as Locale)}
                  type="button"
                >
                  {localeLabels[supportedLocale]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="sidebar-section">
          <div className="section-header">
            <span className="section-title">
              {t("settings.about", { defaultValue: "About" })}
            </span>
          </div>
          <div className="settings-panel">
            <div className="settings-about-row">
              <span className="settings-item-description">
                {t("settings.version", { defaultValue: "Version" })}
              </span>
              {appVersion && (
                <span className="sidebar-version-badge">v{appVersion}</span>
              )}
            </div>

            <div className="settings-update-actions">
              {/* 检查更新按钮 - 始终可见 */}
              <button
                className={`nav-item check-update-btn ${
                  isChecking ? "checking" : ""
                }`}
                onClick={handleCheckForUpdates}
                type="button"
                disabled={isChecking || updateStatus.downloading}
              >
                <RefreshCw size={16} strokeWidth={1.8} />
                <span>
                  {isChecking
                    ? t("settings.checkingUpdate", {
                        defaultValue: "Checking for updates...",
                      })
                    : t("settings.checkUpdate", {
                        defaultValue: "Check for updates",
                      })}
                </span>
              </button>

              {/* 发现新版本 → 下载按钮 */}
              {updateStatus.available &&
                !updateStatus.downloading &&
                !updateStatus.downloaded && (
                  <button
                    className="nav-item update-ready-btn"
                    onClick={handleDownloadUpdate}
                    type="button"
                  >
                    <Download size={16} strokeWidth={1.8} />
                    <span>
                      {t("settings.newVersionAvailable", {
                        values: { version: updateStatus.version ?? "" },
                        defaultValue: `Update to ${updateStatus.version ?? ""}`,
                      })}
                    </span>
                  </button>
                )}

              {/* 下载中 */}
              {updateStatus.available && updateStatus.downloading && (
                <div className="nav-item update-downloading">
                  <LoaderCircle size={16} strokeWidth={1.8} />
                  <span>
                    {t("settings.updateDownloading", {
                      values: { percent: updateStatus.progress },
                      defaultValue: `Downloading ${updateStatus.progress}%`,
                    })}
                  </span>
                </div>
              )}

              {/* 下载完成 → 重启更新 */}
              {updateStatus.downloaded && (
                <button
                  className="nav-item update-ready-btn"
                  onClick={handleInstallUpdate}
                  type="button"
                >
                  <Download size={16} strokeWidth={1.8} />
                  <span>
                    {t("settings.updateReady", {
                      defaultValue: "Restart to update",
                    })}
                  </span>
                </button>
              )}

              {/* 已是最新版本 - 自动隐藏 */}
              {checkHint === "up-to-date" && !updateStatus.available && (
                <span className="settings-update-hint">
                  {t("settings.upToDate", {
                    defaultValue: "You're up to date",
                  })}
                </span>
              )}

              {/* 检查失败提示 - 自动隐藏 */}
              {checkHint === "error" && (
                <span className="settings-update-error">
                  {t("settings.updateCheckFailed", {
                    defaultValue: "Update check failed",
                  })}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
