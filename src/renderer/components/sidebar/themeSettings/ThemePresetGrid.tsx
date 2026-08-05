import { Check } from "lucide-react";
import { useI18n } from "../../../i18n";
import { THEME_PRESETS } from "./themePresets";

type ThemePresetGridProps = {
  selectedPresetId: string;
  disabled?: boolean;
  onSelect: (presetId: string) => void;
};

export function ThemePresetGrid({
  selectedPresetId,
  disabled,
  onSelect,
}: ThemePresetGridProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="theme-preset-grid">
      {THEME_PRESETS.map((preset) => {
        const isActive = selectedPresetId === preset.id;
        return (
          <button
            key={preset.id}
            type="button"
            className={`theme-preset-card theme-preset-card-${preset.id}${
              isActive ? " active" : ""
            }`}
            data-theme-preset-id={preset.id}
            onClick={() => onSelect(preset.id)}
            disabled={disabled}
            title={t(preset.nameKey, { defaultValue: preset.defaultName })}
          >
            <div className="theme-preset-swatches">
              <span
                className="theme-preset-swatch"
                style={{ background: preset.light.bgPrimary }}
              />
              <span
                className="theme-preset-swatch"
                style={{ background: preset.light.textPrimary }}
              />
              <span
                className="theme-preset-swatch"
                style={{ background: preset.light.accentBlue }}
              />
              <span
                className="theme-preset-swatch dark"
                style={{ background: preset.dark.bgPrimary }}
              />
              <span
                className="theme-preset-swatch dark"
                style={{ background: preset.dark.textPrimary }}
              />
              <span
                className="theme-preset-swatch dark"
                style={{ background: preset.dark.accentBlue }}
              />
            </div>
            {preset.id === "google" ? (
              <span className="theme-preset-brand-stripe" aria-hidden="true">
                <span className="google-blue" />
                <span className="google-red" />
                <span className="google-yellow" />
                <span className="google-green" />
              </span>
            ) : null}
            <span className="theme-preset-name">
              {t(preset.nameKey, { defaultValue: preset.defaultName })}
            </span>
            {isActive && (
              <span className="theme-preset-check" aria-hidden="true">
                <Check size={14} strokeWidth={2.2} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
