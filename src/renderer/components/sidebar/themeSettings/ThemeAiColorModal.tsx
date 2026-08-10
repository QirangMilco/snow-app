import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { CustomSelect } from "../../common/CustomSelect";
import { Modal } from "../../common/Modal";
import { MarkdownBlock } from "../../mainContent/chatMessages/components/markdownRenderer";
import { useI18n } from "../../../i18n";
import type { ApiConfigRecord, ThemePalette } from "../../../../preload";

const PALETTE_KEYS: ReadonlyArray<keyof ThemePalette> = [
  "bgPrimary",
  "bgSecondary",
  "bgTertiary",
  "bgHover",
  "bgActive",
  "chromeBg",
  "appBg",
  "borderColor",
  "borderLight",
  "borderSubtle",
  "textPrimary",
  "textSecondary",
  "textTertiary",
  "textMuted",
  "accentGreen",
  "accentGreenBg",
  "accentGreenText",
  "accentRed",
  "accentRedBg",
  "accentRedText",
  "accentBlue",
  "accentBlueBg",
  "accentBlueText",
  "accentColor",
  "onSolid",
  "selectionBg",
  "focusRing",
];

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

type AiColorModalProps = {
  open: boolean;
  imagePath: string;
  onClose: () => void;
  onApply: (palette: { light: ThemePalette; dark: ThemePalette }) => void;
};

type PalettePair = { light: ThemePalette; dark: ThemePalette };

export function ThemeAiColorModal({
  open,
  imagePath,
  onClose,
  onApply,
}: AiColorModalProps): React.JSX.Element {
  const { t } = useI18n();
  const [configs, setConfigs] = useState<ApiConfigRecord[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const streamIdRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (streamIdRef.current) {
        void window.snow.abortThemePalette(streamIdRef.current).catch(() => {
          // Ignore abort errors on unmount.
        });
      }
    };
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadConfigs();
  }, [open]);

  const loadConfigs = async (): Promise<void> => {
    try {
      const list = await window.snow.listApiConfigs();
      if (!isMountedRef.current) {
        return;
      }
      setConfigs(list);
      const active = list.find((config) => config.isActive);
      setSelectedProfile(active?.profileName ?? list[0]?.profileName ?? "");
    } catch (e) {
      if (isMountedRef.current) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.themeAiColorLoadConfigsError", {
                defaultValue: "Failed to load API configurations.",
              })
        );
      }
    }
  };

  const profileOptions = useMemo(
    () =>
      configs.map((config) => ({
        value: config.profileName,
        label: config.displayName.trim() || config.profileName,
      })),
    [configs]
  );

  const selectedConfig = useMemo(
    () => configs.find((config) => config.profileName === selectedProfile),
    [configs, selectedProfile]
  );

  const supportsVision = selectedConfig?.supportsVision ?? false;

  const handleGenerate = async (): Promise<void> => {
    if (!imagePath) {
      setError(
        t("settings.themeAiColorNoImageError", {
          defaultValue: "Please select a background image first.",
        })
      );
      return;
    }
    if (!selectedProfile) {
      setError(
        t("settings.themeAiColorNoProfileError", {
          defaultValue: "Please select an API configuration.",
        })
      );
      return;
    }

    setLoading(true);
    setError("");
    setStatus("");
    setStreamingContent("");

    try {
      const result = await window.snow.generateThemePalette(
        imagePath,
        selectedProfile,
        (chunk) => {
          if (!isMountedRef.current) {
            return;
          }
          if (chunk.contentDelta) {
            setStreamingContent((prev) => prev + chunk.contentDelta);
          }
        },
        (streamId) => {
          streamIdRef.current = streamId;
        }
      );

      streamIdRef.current = null;
      if (!isMountedRef.current) {
        return;
      }

      const parsed = parsePaletteJson(result.content);
      if (!parsed) {
        setError(
          t("settings.themeAiColorParseError", {
            defaultValue:
              "Failed to parse the AI-generated palette. Please try again.",
          })
        );
        return;
      }

      onApply(parsed);
      setStatus(
        t("settings.themeAiColorSuccess", {
          defaultValue: "AI palette generated and applied.",
        })
      );
    } catch (e) {
      if (isMountedRef.current) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.themeAiColorGenerateError", {
                defaultValue: "Failed to generate AI palette.",
              })
        );
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  };

  const handleCancel = (): void => {
    if (streamIdRef.current) {
      void window.snow.abortThemePalette(streamIdRef.current).catch(() => {
        // Ignore abort errors.
      });
      streamIdRef.current = null;
    }
    setLoading(false);
  };

  const handleClose = (): void => {
    handleCancel();
    setError("");
    setStatus("");
    setStreamingContent("");
    onClose();
  };

  return (
    <Modal
      open={open}
      title={t("settings.themeAiColorTitle", {
        defaultValue: "AI color palette",
      })}
      description={t("settings.themeAiColorDescription", {
        defaultValue:
          "Generate a theme palette from your background image using AI.",
      })}
      closeLabel={t("settings.themeAiColorClose", {
        defaultValue: "Close AI color palette",
      })}
      onClose={handleClose}
      closeDisabled={loading}
      size="medium"
      footer={
        <>
          <button
            className="api-settings-form-btn primary"
            onClick={handleGenerate}
            type="button"
            disabled={loading || !selectedProfile || !imagePath}
          >
            {loading ? (
              <Loader2 size={14} strokeWidth={1.9} className="spin" />
            ) : (
              <Sparkles size={14} strokeWidth={1.9} />
            )}
            <span>
              {loading
                ? t("settings.themeAiColorGenerating", {
                    defaultValue: "Generating...",
                  })
                : t("settings.themeAiColorGenerate", {
                    defaultValue: "Generate",
                  })}
            </span>
          </button>
          {loading ? (
            <button
              className="api-settings-form-btn secondary"
              onClick={handleCancel}
              type="button"
            >
              <X size={14} strokeWidth={1.9} />
              <span>
                {t("settings.themeAiColorCancel", {
                  defaultValue: "Cancel",
                })}
              </span>
            </button>
          ) : null}
        </>
      }
    >
      <div className="theme-ai-color-modal">
        <AutoDismissNotice
          message={error || status}
          tone={error ? "error" : "success"}
          onDismiss={() => {
            setError("");
            setStatus("");
          }}
        />

        <div className="theme-ai-color-field">
          <label className="theme-ai-color-label">
            {t("settings.themeAiColorProfileLabel", {
              defaultValue: "API configuration",
            })}
          </label>
          <CustomSelect
            value={selectedProfile}
            options={profileOptions}
            onChange={setSelectedProfile}
            disabled={loading || configs.length === 0}
            portal
          />
        </div>

        <p className="theme-ai-color-hint">
          {t("settings.themeAiColorVisionHint", {
            defaultValue:
              'AI color palette requires the selected profile\'s advanced model to support vision. Make sure "Supports vision" is enabled in API settings.',
          })}
        </p>

        {!supportsVision && selectedConfig ? (
          <p className="theme-ai-color-warning">
            {t("settings.themeAiColorVisionWarning", {
              defaultValue:
                "The selected profile's advanced model is marked as not supporting vision. Generation may fail.",
            })}
          </p>
        ) : null}

        {streamingContent ? (
          <div className="theme-ai-color-preview">
            <MarkdownBlock
              className="context-compaction-markdown theme-ai-color-markdown"
              content={streamingContent}
              streaming={loading}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/// Parse the AI-generated JSON content into a validated palette pair.
/// Tolerates surrounding markdown fences and extracts the first JSON object.
function parsePaletteJson(content: string): PalettePair | null {
  const jsonText = extractJsonObject(content);
  if (!jsonText) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const root = parsed as Record<string, unknown>;
  const light = normalizePalette(root.light);
  const dark = normalizePalette(root.dark);
  if (!light || !dark) {
    return null;
  }

  return { light, dark };
}

function extractJsonObject(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  // Strip markdown code fences if present.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return candidate.slice(start, end + 1);
}

function normalizePalette(value: unknown): ThemePalette | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const result = {} as ThemePalette;
  for (const key of PALETTE_KEYS) {
    const fieldKey = key as string;
    const raw = source[fieldKey];
    if (typeof raw !== "string") {
      return null;
    }
    const normalized = raw.trim();
    if (!HEX_COLOR_REGEX.test(normalized)) {
      return null;
    }
    result[key] = normalized.toLowerCase();
  }

  return result;
}
