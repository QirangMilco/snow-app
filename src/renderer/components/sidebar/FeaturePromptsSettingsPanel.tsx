import { Loader2, RotateCcw, Save, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { useI18n } from "../../i18n";
import type { FeaturePromptRecord } from "../../../preload";

type FeaturePromptsSettingsPanelProps = {
  onClose?: () => void;
};

// promptKey -> i18n key 后缀映射（三语文案见 i18n/lang/*.ts）。
const PROMPT_KEY_I18N_SUFFIX: Record<string, string> = {
  commit_message: "commitMessage",
  summary: "summary",
  theme_palette: "themePalette",
  plan_mode_system_prompt: "planMode",
  goal_mode_system_prompt: "goalMode",
  codebase_review: "codebaseReview",
  vision: "vision",
};

export function FeaturePromptsSettingsPanel({
  onClose,
}: FeaturePromptsSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [prompts, setPrompts] = useState<FeaturePromptRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  // promptKey -> 当前编辑中的内容
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // promptKey -> 保存/重置进行中
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const promptName = useCallback(
    (prompt: FeaturePromptRecord): string =>
      t(`featurePrompts.${PROMPT_KEY_I18N_SUFFIX[prompt.promptKey] ?? prompt.promptKey}.name`, {
        defaultValue: prompt.name,
      }),
    [t]
  );

  const promptDescription = useCallback(
    (prompt: FeaturePromptRecord): string =>
      t(
        `featurePrompts.${PROMPT_KEY_I18N_SUFFIX[prompt.promptKey] ?? prompt.promptKey}.description`,
        { defaultValue: prompt.description }
      ),
    [t]
  );

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const items = await window.snow.listFeaturePrompts();
      setPrompts(items);
      setDrafts(Object.fromEntries(items.map((item) => [item.promptKey, item.content])));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("featurePrompts.loadError", {
              defaultValue: "Failed to load feature prompts",
            })
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const setBusy = (promptKey: string, busy: boolean): void => {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      if (busy) {
        next.add(promptKey);
      } else {
        next.delete(promptKey);
      }
      return next;
    });
  };

  const handleSave = async (prompt: FeaturePromptRecord): Promise<void> => {
    const content = drafts[prompt.promptKey] ?? "";
    setError("");
    setStatus("");
    setBusy(prompt.promptKey, true);

    try {
      const items = await window.snow.setFeaturePrompt(prompt.promptKey, content);
      setPrompts(items);
      setDrafts(
        Object.fromEntries(items.map((item) => [item.promptKey, item.content]))
      );
      setStatus(
        t("featurePrompts.saved", {
          defaultValue: "Prompt saved.",
        })
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("featurePrompts.saveError", {
              defaultValue: "Failed to save the prompt",
            })
      );
    } finally {
      setBusy(prompt.promptKey, false);
    }
  };

  const handleReset = async (prompt: FeaturePromptRecord): Promise<void> => {
    setError("");
    setStatus("");
    setBusy(prompt.promptKey, true);

    try {
      const items = await window.snow.resetFeaturePrompt(prompt.promptKey);
      setPrompts(items);
      setDrafts(
        Object.fromEntries(items.map((item) => [item.promptKey, item.content]))
      );
      setStatus(
        t("featurePrompts.resetDone", {
          defaultValue: "Prompt reset to default.",
        })
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("featurePrompts.resetError", {
              defaultValue: "Failed to reset the prompt",
            })
      );
    } finally {
      setBusy(prompt.promptKey, false);
    }
  };

  const handleResetAll = async (): Promise<void> => {
    setError("");
    setStatus("");
    const modified = prompts.filter((prompt) => prompt.isModified);
    if (modified.length === 0) {
      return;
    }

    setBusyKeys(new Set(modified.map((prompt) => prompt.promptKey)));
    try {
      for (const prompt of modified) {
        await window.snow.resetFeaturePrompt(prompt.promptKey);
      }
      const items = await window.snow.listFeaturePrompts();
      setPrompts(items);
      setDrafts(
        Object.fromEntries(items.map((item) => [item.promptKey, item.content]))
      );
      setStatus(
        t("featurePrompts.resetAllDone", {
          defaultValue: "All prompts reset to defaults.",
        })
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("featurePrompts.resetError", {
              defaultValue: "Failed to reset the prompts",
            })
      );
    } finally {
      setBusyKeys(new Set());
    }
  };

  const modifiedCount = prompts.filter((prompt) => prompt.isModified).length;

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("featurePrompts.title", {
              defaultValue: "Built-in feature prompts",
            })}
          </strong>
          <span className="settings-item-description">
            {t("featurePrompts.info", {
              defaultValue:
                "Edit the prompts used by Snow App's built-in AI features. Changes take effect immediately and are stored locally.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("featurePrompts.close", {
              defaultValue: "Close feature prompts settings",
            })}
            title={t("featurePrompts.close", {
              defaultValue: "Close feature prompts settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      {modifiedCount > 0 && (
        <div className="api-settings-actions">
          <button
            className="api-settings-action-btn secondary"
            onClick={() => void handleResetAll()}
            type="button"
            disabled={isLoading || busyKeys.size > 0}
          >
            {busyKeys.size > 0 ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <RotateCcw size={15} />
            )}
            <span>
              {t("featurePrompts.resetAll", {
                values: { count: modifiedCount },
                defaultValue: `Reset all modified (${modifiedCount})`,
              })}
            </span>
          </button>
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
        <div className="feature-prompts-list">
          {prompts.map((prompt) => {
            const isBusy = busyKeys.has(prompt.promptKey);
            const current = drafts[prompt.promptKey] ?? prompt.content;
            const isModified =
              prompt.isModified || current !== prompt.defaultContent;
            const isDirty = current !== prompt.content;

            return (
              <div className="feature-prompt-card" key={prompt.promptKey}>
                <div className="feature-prompt-card-header">
                  <div className="feature-prompt-card-title-group">
                    <strong className="feature-prompt-card-title">
                      {promptName(prompt)}
                    </strong>
                    {isModified && (
                      <span className="feature-prompt-modified-badge">
                        {t("featurePrompts.modified", {
                          defaultValue: "Modified",
                        })}
                      </span>
                    )}
                  </div>
                  <span className="settings-item-description">
                    {promptDescription(prompt)}
                  </span>
                </div>
                <textarea
                  className="feature-prompt-textarea"
                  value={current}
                  onChange={(e) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [prompt.promptKey]: e.target.value,
                    }))
                  }
                  rows={8}
                  spellCheck={false}
                />
                <div className="feature-prompt-card-actions">
                  <button
                    className="api-settings-action-btn primary"
                    onClick={() => void handleSave(prompt)}
                    type="button"
                    disabled={isBusy || !isDirty}
                  >
                    {isBusy ? (
                      <Loader2 size={15} className="spin" />
                    ) : (
                      <Save size={15} />
                    )}
                    <span>
                      {t("featurePrompts.save", { defaultValue: "Save" })}
                    </span>
                  </button>
                  {isModified && (
                    <button
                      className="api-settings-action-btn secondary"
                      onClick={() => void handleReset(prompt)}
                      type="button"
                      disabled={isBusy}
                    >
                      <RotateCcw size={15} />
                      <span>
                        {t("featurePrompts.reset", {
                          defaultValue: "Reset to default",
                        })}
                      </span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
