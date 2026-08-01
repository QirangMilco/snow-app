import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { localeLabels, useI18n, type Locale } from "../../i18n";
import { SETTINGS_ITEMS } from "./settingsItems";
import { SETTINGS_VIEW_IDS } from "./settingsItems";
import type { SidebarContentProps } from "./types";

export function SettingsSidebarContent({
  activeMainView,
  onSelectMainView,
  onSwitchContent,
}: SidebarContentProps): React.JSX.Element {
  const { locale, setLocale, supportedLocales, t } = useI18n();
  const [appVersion, setAppVersion] = useState<string>("");

  useEffect(() => {
    window.snow
      .getAppVersion()
      .then((version) => setAppVersion(version))
      .catch(() => undefined);
  }, []);

  const handleExitSettings = (): void => {
    onSwitchContent("main");

    if (SETTINGS_VIEW_IDS.has(activeMainView)) {
      onSelectMainView("chat");
    }
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
          </div>
        </div>
      </div>
    </>
  );
}
