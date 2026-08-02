import { Pencil, RotateCcw, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { CustomSelect } from "../common/CustomSelect";
import { Modal } from "../common/Modal";
import { useI18n } from "../../i18n";
import { useDebouncedAutoSave } from "../../hooks/useDebouncedAutoSave";
import { getPresetById } from "./themeSettings/themePresets";
import {
  applyFontFamilyToDocument,
  applyPaletteToDocument,
  applyThemePresetToDocument,
  applyStreamCursorToDocument,
  applyThemeModeToDocument,
  DEFAULT_THEME_SETTINGS,
  MAX_BACKGROUND_OPACITY,
  normalizeThemeSettings,
  readThemeCache,
  resolveActivePalette,
  writeThemeCache,
} from "./themeSettings/themeSettingsUtils";
import type {
  ThemeBackground,
  ThemeMode,
  ThemePalette,
  ThemeSettings,
  ThemeSettingsPanelProps,
  ThemeStreamCursor,
} from "./themeSettings/types";
import { themeBgUrl } from "../../utils/themeBgUrl";
import { ThemeAiColorModal } from "./themeSettings/ThemeAiColorModal";
import { ThemeBackgroundSection } from "./themeSettings/ThemeBackgroundSection";
import { ThemeColorEditor } from "./themeSettings/ThemeColorEditor";
import { ThemeFontSection } from "./themeSettings/ThemeFontSection";
import { ThemeModeSelector } from "./themeSettings/ThemeModeSelector";
import { ThemePresetGrid } from "./themeSettings/ThemePresetGrid";
import { ThemePreview } from "./themeSettings/ThemePreview";
import { ThemeStreamCursorSection } from "./themeSettings/ThemeStreamCursorSection";

type EditorTab = "light" | "dark";

// 自动保存 debounce 延时。滑块拖动期间 ThemeBackgroundSection 已做本地 state
// 隔离（120ms 提交），这里再加一层较长的保存 debounce，避免连续微调时频繁触发
// IPC 持久化与 localStorage 写入。600ms 偏短，拖动稍快就会在拖动途中触发保存；
// 1000ms 在交互流畅度与"改完即存"体感之间取得平衡。
const SAVE_DEBOUNCE_MS = 1000;

/**
 * 计算待保存的主题设置值。
 * 返回 null 表示无需保存（加载中 / 与上次保存一致）。
 */
function computeThemeSaveValue(
  form: ThemeSettings,
  lastSaved: ThemeSettings,
  isLoading: boolean
): ThemeSettings | null {
  if (isLoading) {
    return null;
  }
  if (JSON.stringify(form) === JSON.stringify(lastSaved)) {
    return null;
  }
  return form;
}

export function ThemeSettingsPanel({
  onClose,
}: ThemeSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  // 初始值优先取 localStorage 主题缓存，避免加载完成前表单回退到默认主题导致预览闪烁。
  // isLoading 初始为 true：挂载必然要异步加载一次真实设置，期间跳过预览 useEffect，
  // 保留 useTheme 在进入面板前已应用到 document 的主题，避免出现"默认主题→真实主题"的切换。
  const initialSettings = useMemo<ThemeSettings>(
    () => readThemeCache() ?? DEFAULT_THEME_SETTINGS,
    []
  );
  const [form, setForm] = useState<ThemeSettings>(initialSettings);
  const [lastSaved, setLastSaved] = useState<ThemeSettings>(initialSettings);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [editorTab, setEditorTab] = useState<EditorTab>("light");
  const [editorOpen, setEditorOpen] = useState(false);
  const [aiColorOpen, setAiColorOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const raw = await window.snow.getThemeSettings();
      const normalized = normalizeThemeSettings(raw);
      setForm(normalized);
      setLastSaved(normalized);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.themeLoadError", {
              defaultValue: "Failed to load theme settings",
            })
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // 实时预览：表单变化时即时应用到 document，但不持久化。
  useEffect(() => {
    if (isLoading) {
      return;
    }
    const systemDark =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    // 根据 mode 计算当前生效的亮/暗，而非直接用 systemDark。
    // 否则用户选"浅色"但系统是深色时仍会取深色调色板。
    const effectiveDark =
      form.mode === "system" ? systemDark : form.mode === "dark";
    applyThemeModeToDocument(form.mode);
    applyThemePresetToDocument(form.presetId);
    const palette = resolveActivePalette(form, effectiveDark);
    applyPaletteToDocument(palette);

    // 预览字体和流式光标配置。
    applyFontFamilyToDocument(form.fontFamily);
    applyStreamCursorToDocument(form.streamCursor);

    // 同步窗口背景色到主进程，使 Electron 窗口背景跟随预览。
    const bgPrimary = palette.bgPrimary;
    if (bgPrimary && typeof window !== "undefined" && window.snow) {
      void window.snow.setThemeBackgroundColor(bgPrimary).catch(() => {
        // 忽略同步失败。
      });
    }

    const bg = form.background;
    const root = document.documentElement;
    if (bg.enabled && bg.imagePath) {
      const opacity = Math.max(0, Math.min(MAX_BACKGROUND_OPACITY, bg.opacity));
      const blur = Math.max(0, bg.blur);
      root.style.setProperty(
        "--theme-bg-image",
        `url("${themeBgUrl(bg.imagePath)}")`
      );
      root.style.setProperty("--theme-bg-opacity", String(opacity));
      root.style.setProperty("--theme-bg-blur", `${blur}px`);
      root.setAttribute("data-theme-bg", "on");
    } else {
      root.style.removeProperty("--theme-bg-image");
      root.style.removeProperty("--theme-bg-opacity");
      root.style.removeProperty("--theme-bg-blur");
      root.removeAttribute("data-theme-bg");
    }
  }, [form, isLoading]);

  const previewPalette = useMemo<ThemePalette>(() => {
    const systemDark =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    const effectiveDark =
      form.mode === "system" ? systemDark : form.mode === "dark";
    return resolveActivePalette(form, effectiveDark);
  }, [form]);

  const handleModeChange = (mode: ThemeMode): void => {
    setForm((previous: ThemeSettings) => ({ ...previous, mode }));
  };

  const handlePresetSelect = (presetId: string): void => {
    setForm((previous: ThemeSettings) => {
      if (presetId === "custom") {
        return { ...previous, presetId };
      }
      const preset = getPresetById(presetId);
      if (!preset) {
        return previous;
      }
      // 切换到预设时，将预设的调色板复制到 custom，作为后续自定义的起点。
      return {
        ...previous,
        presetId,
        custom: {
          light: { ...preset.light },
          dark: { ...preset.dark },
        },
      };
    });
  };

  const handleEnableCustom = (enabled: boolean): void => {
    if (enabled) {
      setForm((previous: ThemeSettings) => {
        const preset = getPresetById(previous.presetId);
        const baseLight = preset?.light ?? previous.custom.light;
        const baseDark = preset?.dark ?? previous.custom.dark;
        return {
          ...previous,
          presetId: "custom",
          custom: {
            light: { ...baseLight },
            dark: { ...baseDark },
          },
        };
      });
    } else {
      // 关闭自定义时回退到 snow 预设。
      const fallback = getPresetById("snow");
      if (fallback) {
        setForm((previous: ThemeSettings) => ({
          ...previous,
          presetId: "snow",
          custom: {
            light: { ...fallback.light },
            dark: { ...fallback.dark },
          },
        }));
      }
    }
  };

  const handleOpenEditor = (): void => {
    // 打开编辑器时，若尚未启用自定义，则把当前预设调色板复制到 custom 作为编辑起点；
    // 这里不切换 presetId，只有真正改动颜色时才切换（见 handleColorChange）。
    setForm((previous: ThemeSettings) => {
      if (previous.presetId === "custom") {
        return previous;
      }
      const preset = getPresetById(previous.presetId);
      if (!preset) {
        return previous;
      }
      return {
        ...previous,
        custom: {
          light: { ...preset.light },
          dark: { ...preset.dark },
        },
      };
    });
    setEditorOpen(true);
  };

  const handleColorChange = (role: keyof ThemePalette, value: string): void => {
    setForm((previous: ThemeSettings) => {
      // 未启用自定义时编辑会先基于当前预设的调色板，
      // 并在真正改动颜色时自动切换到 custom。
      const preset =
        previous.presetId === "custom"
          ? undefined
          : getPresetById(previous.presetId);
      const baseLight = preset?.light ?? previous.custom.light;
      const baseDark = preset?.dark ?? previous.custom.dark;
      const baseCustom =
        previous.presetId === "custom"
          ? previous.custom
          : { light: { ...baseLight }, dark: { ...baseDark } };
      return {
        ...previous,
        presetId: "custom",
        custom: {
          ...baseCustom,
          [editorTab]: {
            ...baseCustom[editorTab],
            [role]: value,
          },
        },
      };
    });
  };

  const handleApplyAiPalette = (palette: {
    light: ThemePalette;
    dark: ThemePalette;
  }): void => {
    const nextSettings: ThemeSettings = {
      ...form,
      presetId: "custom",
      custom: {
        light: { ...palette.light },
        dark: { ...palette.dark },
      },
    };
    setForm(nextSettings);
    setAiColorOpen(false);
    setStatus(
      t("settings.themeAiColorApplied", {
        defaultValue:
          "AI palette applied. Adjust colors in the editor if needed.",
      })
    );
    // AI 配色是一个完整的生成操作，应用后立即持久化，不依赖 600ms debounce，
    // 避免用户在 debounce 窗口内切换菜单导致保存丢失。
    void saveSettings(nextSettings);
  };

  const handleBackgroundChange = (background: ThemeBackground): void => {
    setForm((previous: ThemeSettings) => ({ ...previous, background }));
  };

  const handleFontChange = (fontFamily: string): void => {
    setForm((previous: ThemeSettings) => ({ ...previous, fontFamily }));
  };

  const handleStreamCursorChange = (streamCursor: ThemeStreamCursor): void => {
    setForm((previous: ThemeSettings) => ({ ...previous, streamCursor }));
  };

  const handleSelectSvg = async (): Promise<void> => {
    setIsBusy(true);
    setError("");
    setStatus("");
    try {
      const title = t("settings.themeStreamCursorSelectDialogTitle", {
        defaultValue: "Select stream cursor SVG",
      });
      const sourcePath = await window.snow.selectThemeStreamCursorSvg(title);
      if (!sourcePath) {
        return;
      }
      // 替换 SVG 时先删除旧文件，避免冗余文件堆积。
      const previousSvgPath = form.streamCursor.svgPath;
      if (previousSvgPath) {
        await window.snow
          .deleteThemeStreamCursorSvg(previousSvgPath)
          .catch(() => {
            // 旧文件删除失败不阻塞新 SVG 上传。
          });
      }
      const savedPath = await window.snow.saveThemeStreamCursorSvg(sourcePath);
      setForm((previous: ThemeSettings) => ({
        ...previous,
        streamCursor: {
          iconType: "custom",
          lucideName: "",
          svgPath: savedPath,
          iconSize: previous.streamCursor.iconSize,
        },
      }));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.themeStreamCursorSaveError", {
              defaultValue: "Failed to save stream cursor SVG",
            })
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleRemoveSvg = async (): Promise<void> => {
    const svgPath = form.streamCursor.svgPath;
    if (!svgPath) {
      return;
    }
    setIsBusy(true);
    setError("");
    setStatus("");
    try {
      await window.snow.deleteThemeStreamCursorSvg(svgPath);
      setForm((previous: ThemeSettings) => ({
        ...previous,
        streamCursor: {
          iconType: "dot",
          lucideName: "",
          svgPath: "",
          iconSize: previous.streamCursor.iconSize,
        },
      }));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.themeStreamCursorDeleteError", {
              defaultValue: "Failed to delete stream cursor SVG",
            })
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleSelectImage = async (): Promise<void> => {
    setIsBusy(true);
    setError("");
    setStatus("");
    try {
      const title = t("settings.themeBackgroundSelectDialogTitle", {
        defaultValue: "Select background image",
      });
      const sourcePath = await window.snow.selectThemeBackgroundImage(title);
      if (!sourcePath) {
        return;
      }
      // 替换图片时先删除旧文件，避免冗余文件堆积。
      const previousImagePath = form.background.imagePath;
      if (previousImagePath) {
        await window.snow
          .deleteThemeBackgroundImage(previousImagePath)
          .catch(() => {
            // 旧文件删除失败不阻塞新图片上传。
          });
      }
      const savedPath = await window.snow.saveThemeBackgroundImage(sourcePath);
      setForm((previous: ThemeSettings) => {
        // 首次上传背景图时，透明度默认 0.2；替换图片时保留用户已调整的 opacity。
        const isFirstUpload = !previous.background.imagePath;
        return {
          ...previous,
          background: {
            ...previous.background,
            imagePath: savedPath,
            enabled: true,
            opacity: isFirstUpload ? 0.2 : previous.background.opacity,
          },
        };
      });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.themeBackgroundSaveError", {
              defaultValue: "Failed to save background image",
            })
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleRemoveImage = async (): Promise<void> => {
    const imagePath = form.background.imagePath;
    if (!imagePath) {
      return;
    }
    setIsBusy(true);
    setError("");
    setStatus("");
    try {
      await window.snow.deleteThemeBackgroundImage(imagePath);
      setForm((previous) => ({
        ...previous,
        background: {
          enabled: false,
          imagePath: "",
          opacity: 0.2,
          blur: 0,
        },
      }));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.themeBackgroundDeleteError", {
              defaultValue: "Failed to delete background image",
            })
      );
    } finally {
      setIsBusy(false);
    }
  };

  const saveSettings = useCallback(
    async (settings: ThemeSettings) => {
      // isMountedRef 仅守卫 React state 更新；writeThemeCache 和 theme:changed
      // 是纯副作用，即使组件已卸载也必须执行，确保 flush 保存后
      // localStorage 缓存与后端一致、全局 useTheme 能同步。
      const mounted = isMountedRef.current;
      if (mounted) {
        setIsSaving(true);
        setError("");
      }
      try {
        await window.snow.setThemeSettings(settings);
        // 即时更新 localStorage 主题缓存，确保下次启动时首屏即呈现新主题。
        // 必须在 isMountedRef 守卫之外，使组件卸载 flush 时也能写入缓存。
        writeThemeCache(settings);
        // 通知全局 useTheme Hook 重新加载，使 App 级状态与持久化数据同步。
        // 必须在 isMountedRef 守卫之外，使组件卸载 flush 时也能派发事件。
        window.dispatchEvent(new CustomEvent("theme:changed"));
        if (mounted) {
          setLastSaved(settings);
          setStatus(
            t("settings.themeSaveSuccess", {
              defaultValue: "Theme settings saved.",
            })
          );
        }
      } catch (e) {
        if (mounted) {
          setError(
            e instanceof Error
              ? e.message
              : t("settings.themeSaveError", {
                  defaultValue: "Failed to save theme settings",
                })
          );
        }
      } finally {
        if (mounted) {
          setIsSaving(false);
        }
      }
    },
    [t]
  );

  // 修改即保存：表单变化后 debounce 保存，卸载时立即冲刷避免丢失。
  const saveValue = useMemo(
    () => computeThemeSaveValue(form, lastSaved, isLoading),
    [form, lastSaved, isLoading]
  );
  useDebouncedAutoSave(saveValue, saveSettings, SAVE_DEBOUNCE_MS);

  const handleReset = (): void => {
    setForm(DEFAULT_THEME_SETTINGS);
    setError("");
    setStatus("");
    // 重置主题时一并清除窗口尺寸缓存，下次启动回退到默认窗口尺寸。
    // 清除失败不影响主题重置本身。
    void window.snow.clearWindowState().catch(() => {});
    // 立即持久化默认主题，避免 debounce 窗口内退出导致保存丢失。
    void saveSettings(DEFAULT_THEME_SETTINGS);
  };
  const handleTabChange = (tab: EditorTab): void => {
    setEditorTab(tab);
  };

  const busy = isLoading || isSaving || isBusy;
  const isCustom = form.presetId === "custom";
  // AI 配色按钮仅在用户已上传背景图时显示。
  const hasBackgroundImage = Boolean(form.background.imagePath);
  // 弹窗中始终编辑 custom 调色板，与是否启用自定义无关。
  const currentPalette =
    editorTab === "light" ? form.custom.light : form.custom.dark;

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.themeTitle", {
              defaultValue: "Theme settings",
            })}
          </strong>
          <span className="settings-item-description">
            {t("settings.themeSettingsInfo", {
              defaultValue: "Adjust appearance and color theme.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeThemeSettings", {
              defaultValue: "Close theme settings",
            })}
            title={t("settings.closeThemeSettings", {
              defaultValue: "Close theme settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <div className="api-settings-manual-form">
        <div className="api-settings-form-body">
          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.themeMode", {
                  defaultValue: "Appearance mode",
                })}
              </strong>
            </div>
            <span className="settings-item-description">
              {t("settings.themeModeInfo", {
                defaultValue:
                  "Choose whether the app follows the system, stays light, or stays dark.",
              })}
            </span>
            <ThemeModeSelector
              mode={form.mode}
              disabled={busy}
              onChange={handleModeChange}
            />
          </div>

          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.themePresets", {
                  defaultValue: "Preset themes",
                })}
              </strong>
            </div>
            <span className="settings-item-description">
              {t("settings.themePresetsInfo", {
                defaultValue:
                  "Pick a built-in color scheme. Light and dark variants are bundled together.",
              })}
            </span>
            <ThemePresetGrid
              selectedPresetId={form.presetId}
              disabled={busy}
              onSelect={handlePresetSelect}
            />
          </div>

          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.themeCustomTitle", {
                  defaultValue: "Custom theme",
                })}
              </strong>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={isCustom}
                  onChange={(event) => handleEnableCustom(event.target.checked)}
                  disabled={busy}
                  hidden
                />
                <span className="toggle-slider" />
                <span>
                  {isCustom
                    ? t("settings.enabled", {
                        defaultValue: "Enabled",
                      })
                    : t("settings.disabled", {
                        defaultValue: "Disabled",
                      })}
                </span>
              </label>
            </div>
            <span className="settings-item-description">
              {t("settings.themeCustomInfo", {
                defaultValue:
                  "Fine-tune every color. Light and dark palettes are edited separately; editing a color switches to the custom theme.",
              })}
            </span>
            <div className="api-settings-form-actions theme-custom-edit-action">
              <button
                className="api-settings-form-btn secondary"
                onClick={handleOpenEditor}
                type="button"
                disabled={busy}
              >
                <Pencil size={14} strokeWidth={1.9} />
                <span>{t("settings.edit", { defaultValue: "Edit" })}</span>
              </button>
              {hasBackgroundImage ? (
                <button
                  className="api-settings-form-btn secondary"
                  onClick={() => setAiColorOpen(true)}
                  type="button"
                  disabled={busy}
                  title={t("settings.themeAiColorButtonTitle", {
                    defaultValue:
                      "Generate a palette from the background image",
                  })}
                >
                  <Sparkles size={14} strokeWidth={1.9} />
                  <span>
                    {t("settings.themeAiColorButton", {
                      defaultValue: "AI palette",
                    })}
                  </span>
                </button>
              ) : null}
            </div>
          </div>

          <ThemeBackgroundSection
            background={form.background}
            disabled={busy}
            busy={isBusy}
            onChange={handleBackgroundChange}
            onSelectImage={handleSelectImage}
            onRemoveImage={handleRemoveImage}
          />

          <ThemeFontSection
            fontFamily={form.fontFamily}
            disabled={busy}
            onChange={handleFontChange}
          />

          <ThemeStreamCursorSection
            cursor={form.streamCursor}
            disabled={busy}
            busy={isBusy}
            onChange={handleStreamCursorChange}
            onSelectSvg={handleSelectSvg}
            onRemoveSvg={handleRemoveSvg}
          />

          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.themePreviewTitle", {
                  defaultValue: "Preview",
                })}
              </strong>
            </div>
            <ThemePreview palette={previewPalette} />
          </div>
        </div>

        <div className="api-settings-form-actions">
          <button
            className="api-settings-form-btn secondary"
            onClick={handleReset}
            type="button"
            disabled={busy}
          >
            <RotateCcw size={15} strokeWidth={1.9} />
            <span>{t("settings.reset", { defaultValue: "Reset" })}</span>
          </button>
        </div>
      </div>

      <Modal
        open={editorOpen}
        title={t("settings.themeCustomTitle", {
          defaultValue: "Custom theme",
        })}
        closeLabel={t("settings.closeThemeSettings", {
          defaultValue: "Close theme settings",
        })}
        onClose={() => setEditorOpen(false)}
        size="large"
      >
        <div className="theme-custom-editor">
          <div className="theme-custom-editor-tabs">
            <CustomSelect
              value={editorTab}
              onChange={(value) => handleTabChange(value as EditorTab)}
              disabled={busy}
              options={[
                {
                  value: "light",
                  label: t("settings.themeTabLight", {
                    defaultValue: "Light palette",
                  }),
                },
                {
                  value: "dark",
                  label: t("settings.themeTabDark", {
                    defaultValue: "Dark palette",
                  }),
                },
              ]}
            />
          </div>
          <ThemeColorEditor
            palette={currentPalette}
            disabled={busy}
            onChange={handleColorChange}
          />
        </div>
      </Modal>

      <ThemeAiColorModal
        open={aiColorOpen}
        imagePath={form.background.imagePath}
        onClose={() => setAiColorOpen(false)}
        onApply={handleApplyAiPalette}
      />
    </div>
  );
}
