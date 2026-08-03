import {
  BookOpen,
  CircleCheck,
  CirclePause,
  Download,
  Folder,
  Globe2,
  Loader2,
  RefreshCw,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  GithubSkillRecord,
  SkillDefinition,
  WorkspaceDirectoryRecord,
} from "../../../preload";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { GitHubLogo } from "../common/GitHubLogo";

type SkillsSettingsPanelProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onClose?: () => void;
};

type SkillsScope = "global" | "project";
type SkillsByScope = Record<SkillsScope, SkillDefinition[]>;

const EMPTY_SKILLS_BY_SCOPE: SkillsByScope = {
  global: [],
  project: [],
};

/**
 * Validate a GitHub URL / shorthand. Mirrors the Rust `parse_github_url`
 * logic so we can give instant feedback in the UI before invoking the backend.
 */
function isValidGitHubUrl(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) {
    return false;
  }
  let working = trimmed.replace(/\.git$/, "").replace(/\/$/, "");
  const urlMatch = working.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(\/.*)?)?$/i
  );
  if (urlMatch) {
    return Boolean(urlMatch[1] && urlMatch[2]);
  }
  const shorthandMatch = working.match(
    /^([^/\s@]+)\/([^/\s@]+)(?:@([^:]+))?(?::(.+))?$/
  );
  return Boolean(shorthandMatch && shorthandMatch[1] && shorthandMatch[2]);
}

export function SkillsSettingsPanel({
  activeDirectory,
  onClose,
}: SkillsSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [activeScope, setActiveScope] = useState<SkillsScope>("global");
  const [skillsByScope, setSkillsByScope] = useState<SkillsByScope>(
    EMPTY_SKILLS_BY_SCOPE
  );
  const [isLoading, setIsLoading] = useState(false);
  const [updatingSkillId, setUpdatingSkillId] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const [githubSkills, setGithubSkills] = useState<GithubSkillRecord[]>([]);
  const [installUrl, setInstallUrl] = useState("");
  const [isInstalling, setIsInstalling] = useState(false);
  const [uninstallingSkillId, setUninstallingSkillId] = useState("");
  const [pendingUninstallSkill, setPendingUninstallSkill] =
    useState<SkillDefinition | null>(null);

  const loadSkills = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError("");

    try {
      const [globalSkills, effectiveSkills, githubRecords] = await Promise.all([
        window.snow.listAvailableSkills(),
        activeDirectory
          ? window.snow.listAvailableSkills(activeDirectory.directoryId)
          : Promise.resolve([]),
        window.snow.listGithubSkills(),
      ]);
      const globalSkillIds = new Set(globalSkills.map((skill) => skill.id));
      const projectSkills = effectiveSkills.filter(
        (skill) => skill.location === "project" && !globalSkillIds.has(skill.id)
      );

      setSkillsByScope({
        global: globalSkills,
        project: projectSkills,
      });
      setGithubSkills(githubRecords);
    } catch (loadError) {
      setSkillsByScope(EMPTY_SKILLS_BY_SCOPE);
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("settings.skillsLoadError", {
              defaultValue: "Failed to load Skills",
            })
      );
    } finally {
      setIsLoading(false);
    }
  }, [activeDirectory, t]);

  const toggleSkillEnabled = useCallback(
    async (skill: SkillDefinition): Promise<void> => {
      const nextEnabled = !skill.enabled;
      setUpdatingSkillId(skill.id);
      setError("");
      setStatus("");

      try {
        await window.snow.setSkillEnabled(
          skill.location === "project"
            ? activeDirectory?.directoryId
            : undefined,
          skill.id,
          nextEnabled
        );
        await loadSkills();
        setStatus(
          t(
            nextEnabled
              ? "settings.skillsEnableSuccess"
              : "settings.skillsDisableSuccess",
            {
              defaultValue: nextEnabled
                ? "Skill enabled."
                : "Skill disabled and removed from skill-execute.",
            }
          )
        );
      } catch (updateError) {
        setError(
          updateError instanceof Error
            ? updateError.message
            : t("settings.skillsUpdateError", {
                defaultValue: "Failed to update Skill",
              })
        );
      } finally {
        setUpdatingSkillId("");
      }
    },
    [activeDirectory?.directoryId, loadSkills, t]
  );

  const handleInstall = useCallback(async (): Promise<void> => {
    const url = installUrl.trim();
    if (!url || !isValidGitHubUrl(url)) {
      setError(
        t("settings.skillsInstallInvalidUrl", {
          defaultValue: "Please enter a valid GitHub URL.",
        })
      );
      return;
    }
    if (activeScope === "project" && !activeDirectory) {
      setError(
        t("settings.skillsInstallError", {
          defaultValue: "Install failed: {{error}}",
          values: { error: "No active project" },
        })
      );
      return;
    }

    setIsInstalling(true);
    setError("");
    setStatus("");

    try {
      const result = await window.snow.installSkillFromGithub(
        url,
        activeScope,
        activeScope === "project" ? activeDirectory?.directoryId : undefined
      );
      if (result.success) {
        const names = result.results
          .filter((r) => r.success)
          .map((r) => r.skillId)
          .join(", ");
        setStatus(
          `${t("settings.skillsInstallSuccess", {
            defaultValue: "{{count}} skill(s) installed successfully.",
            values: { count: result.installedCount },
          })}${names ? ` (${names})` : ""}`
        );
        setInstallUrl("");
        await loadSkills();
      } else {
        setError(
          t("settings.skillsInstallError", {
            defaultValue: "Install failed: {{error}}",
            values: { error: result.error ?? "Unknown error" },
          })
        );
      }
    } catch (installError) {
      setError(
        t("settings.skillsInstallError", {
          defaultValue: "Install failed: {{error}}",
          values: {
            error:
              installError instanceof Error
                ? installError.message
                : "Unknown error",
          },
        })
      );
    } finally {
      setIsInstalling(false);
    }
  }, [installUrl, activeScope, activeDirectory, loadSkills, t]);

  const requestUninstall = useCallback((skill: SkillDefinition): void => {
    setPendingUninstallSkill(skill);
  }, []);

  const confirmUninstall = useCallback(async (): Promise<void> => {
    const skill = pendingUninstallSkill;
    if (!skill) {
      return;
    }
    setPendingUninstallSkill(null);
    setUninstallingSkillId(skill.id);
    setError("");
    setStatus("");

    try {
      const result = await window.snow.uninstallGithubSkill(
        skill.id,
        skill.location === "project"
          ? activeDirectory?.directoryId
          : undefined
      );
      if (result.success) {
        setStatus(
          t("settings.skillsUninstallSuccess", {
            defaultValue: "Skill uninstalled.",
          })
        );
        await loadSkills();
      } else {
        setError(
          t("settings.skillsUninstallError", {
            defaultValue: "Failed to uninstall: {{error}}",
            values: { error: result.error ?? result.message },
          })
        );
      }
    } catch (uninstallError) {
      setError(
        t("settings.skillsUninstallError", {
          defaultValue: "Failed to uninstall: {{error}}",
          values: {
            error:
              uninstallError instanceof Error
                ? uninstallError.message
                : "Unknown error",
          },
        })
      );
    } finally {
      setUninstallingSkillId("");
    }
  }, [pendingUninstallSkill, activeDirectory?.directoryId, loadSkills, t]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    if (!activeDirectory && activeScope === "project") {
      setActiveScope("global");
    }
  }, [activeDirectory, activeScope]);

  const githubSkillIds = useMemo(
    () => new Set(githubSkills.map((r) => r.id)),
    [githubSkills]
  );

  const allSkills = [...skillsByScope.global, ...skillsByScope.project];
  const enabledCount = allSkills.filter((skill) => skill.enabled).length;
  const disabledCount = allSkills.length - enabledCount;
  const activeSkills = skillsByScope[activeScope];
  const isGlobalScope = activeScope === "global";
  const scopeTitle = isGlobalScope
    ? t("settings.skillsGlobalListTitle", { defaultValue: "Global Skills" })
    : t("settings.skillsProjectListTitle", { defaultValue: "Project Skills" });
  const scopeDescription = isGlobalScope
    ? t("settings.skillsGlobalTabInfo", {
        defaultValue:
          "Skills from the user profile. IDs that also exist in the project are listed here only.",
      })
    : t("settings.skillsProjectTabInfo", {
        defaultValue:
          "Project-only Skills for {{name}}. IDs already present globally are excluded.",
        values: { name: activeDirectory?.name ?? "" },
      });

  const urlValid = isValidGitHubUrl(installUrl);
  const canInstall =
    !isInstalling && !isLoading && installUrl.trim().length > 0 && urlValid;

  return (
    <div className="api-settings-page skills-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.skillsTitle", { defaultValue: "Skills settings" })}
          </strong>
          <span className="settings-item-description">
            {t("settings.skillsSettingsInfo", {
              defaultValue: "View effective project and global Skills.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeSkillsSettings", {
              defaultValue: "Close Skills settings",
            })}
            title={t("settings.closeSkillsSettings", {
              defaultValue: "Close Skills settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <div className="api-settings-summary-grid skills-settings-summary-grid">
        <div className="api-settings-summary-card">
          <BookOpen size={15} strokeWidth={1.8} />
          <span>{allSkills.length}</span>
          <small>
            {t("settings.skillsAvailableCount", { defaultValue: "Skills" })}
          </small>
        </div>
        <div className="api-settings-summary-card">
          <CircleCheck size={15} strokeWidth={1.8} />
          <span>{enabledCount}</span>
          <small>
            {t("settings.skillsEnabledCount", { defaultValue: "Enabled" })}
          </small>
        </div>
        <div className="api-settings-summary-card">
          <CirclePause size={15} strokeWidth={1.8} />
          <span>{disabledCount}</span>
          <small>
            {t("settings.skillsDisabledCount", { defaultValue: "Disabled" })}
          </small>
        </div>
      </div>

      <div className="api-settings-actions skills-settings-actions">
        <button
          className="api-settings-action-btn secondary"
          onClick={() => void loadSkills()}
          type="button"
          disabled={isLoading || Boolean(updatingSkillId) || isInstalling}
          aria-label={t("settings.skillsRefresh", {
            defaultValue: "Refresh Skills",
          })}
          title={t("settings.skillsRefresh", {
            defaultValue: "Refresh Skills",
          })}
        >
          <RefreshCw size={15} className={isLoading ? "spin" : ""} />
          <span>
            {t(
              isLoading
                ? "settings.skillsRefreshing"
                : "settings.skillsRefresh",
              { defaultValue: isLoading ? "Refreshing..." : "Refresh Skills" }
            )}
          </span>
        </button>
      </div>

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <div
        className="skills-settings-tabs"
        role="tablist"
        aria-label={t("settings.skillsScopeTabs", {
          defaultValue: "Skills scope",
        })}
      >
        <button
          className={`skills-settings-tab ${isGlobalScope ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={isGlobalScope}
          onClick={() => setActiveScope("global")}
        >
          <Globe2 size={14} strokeWidth={1.8} />
          <span>
            {t("settings.skillsTabGlobal", { defaultValue: "Global" })}
          </span>
          <small>{skillsByScope.global.length}</small>
        </button>
        <button
          className={`skills-settings-tab ${!isGlobalScope ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={!isGlobalScope}
          onClick={() => setActiveScope("project")}
          disabled={!activeDirectory}
        >
          <Folder size={14} strokeWidth={1.8} />
          <span>
            {t("settings.skillsTabProject", { defaultValue: "Project" })}
          </span>
          <small>{skillsByScope.project.length}</small>
        </button>
      </div>

      <section className="api-settings-form-section skills-settings-section skills-settings-install-section">
        <div className="skills-settings-section-header">
          <div>
            <strong className="api-settings-form-section-title">
              {t("settings.skillsInstallTitle", {
                defaultValue: "Install from GitHub",
              })}
            </strong>
            <span>
              {t("settings.skillsInstallUrlHint", {
                defaultValue:
                  "Supports full URLs, shorthand owner/repo, with optional branch and sub-directory.",
              })}
            </span>
          </div>
          <GitHubLogo size={16} />
        </div>

        <div className="skills-settings-install-form">
          <div className="skills-settings-install-row">
            <input
              className="skills-settings-install-input"
              type="text"
              value={installUrl}
              onChange={(event) => setInstallUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canInstall) {
                  void handleInstall();
                }
              }}
              placeholder={t("settings.skillsInstallUrlPlaceholder", {
                defaultValue: "https://github.com/owner/repo or owner/repo@branch",
              })}
              disabled={isInstalling}
              aria-label={t("settings.skillsInstallUrlLabel", {
                defaultValue: "GitHub URL",
              })}
            />
            <button
              className="api-settings-action-btn primary skills-settings-install-btn"
              onClick={() => void handleInstall()}
              type="button"
              disabled={!canInstall}
            >
              {isInstalling ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Download size={15} strokeWidth={1.8} />
              )}
              <span>
                {isInstalling
                  ? t("settings.skillsInstallInstalling", {
                      defaultValue: "Installing...",
                    })
                  : t("settings.skillsInstallButton", {
                      defaultValue: "Install",
                    })}
              </span>
            </button>
          </div>
          <span className="skills-settings-install-target">
            {t("settings.skillsInstallTarget", {
              defaultValue: "Installs to: {{scope}}",
              values: {
                scope: isGlobalScope
                  ? t("settings.skillsInstallLocationGlobal", {
                      defaultValue: "Global",
                    })
                  : t("settings.skillsInstallLocationProject", {
                      defaultValue: "Project",
                    }),
              },
            })}
          </span>
          <span className="skills-settings-install-example">
            {t("settings.skillsInstallExample", { defaultValue: "Example:" })}{" "}
            <code>https://github.com/upstash/context7/tree/master/skills</code>
          </span>
        </div>
      </section>

      <section className="api-settings-form-section skills-settings-section">
        <div className="skills-settings-section-header">
          <div>
            <strong className="api-settings-form-section-title">
              {scopeTitle}
            </strong>
            <span>{scopeDescription}</span>
          </div>
          <div className="skills-settings-paths" aria-label={scopeTitle}>
            <code>.snow/skills/</code>
            <code>.agents/skills/</code>
          </div>
        </div>

        <div
          className="system-prompt-list mcp-server-list skills-settings-list"
          aria-live="polite"
        >
          {isLoading ? (
            <div className="system-prompt-empty skills-settings-empty">
              <Loader2 size={15} className="spin" />
              <span>
                {t("settings.skillsLoading", {
                  defaultValue: "Loading Skills...",
                })}
              </span>
            </div>
          ) : activeSkills.length === 0 ? (
            <div className="system-prompt-empty skills-settings-empty">
              <BookOpen size={15} />
              <span>
                {t(
                  isGlobalScope
                    ? "settings.skillsGlobalEmpty"
                    : "settings.skillsProjectEmpty",
                  {
                    defaultValue: isGlobalScope
                      ? "No global Skills found."
                      : "No project-only Skills found.",
                  }
                )}
              </span>
            </div>
          ) : (
            activeSkills.map((skill) => {
              const isUpdating = updatingSkillId === skill.id;
              const isUninstalling = uninstallingSkillId === skill.id;
              const isGithubInstalled = githubSkillIds.has(skill.id);
              const toggleLabel = skill.enabled
                ? t("settings.skillsDisable", { defaultValue: "Disable Skill" })
                : t("settings.skillsEnable", { defaultValue: "Enable Skill" });
              const stateLabel = skill.enabled
                ? t("settings.enabled", { defaultValue: "Enabled" })
                : t("settings.inactive", { defaultValue: "Disabled" });
              const uninstallLabel = t("settings.skillsUninstall", {
                defaultValue: "Uninstall",
              });

              return (
                <div
                  className={`system-prompt-item skills-settings-item ${
                    skill.enabled ? "active" : "inactive"
                  }`}
                  key={skill.id}
                >
                  <div className="system-prompt-item-main skills-settings-item-main">
                    <label
                      className="toggle-switch system-prompt-switch skills-settings-switch"
                      aria-label={toggleLabel}
                      title={toggleLabel}
                    >
                      <input
                        type="checkbox"
                        checked={skill.enabled}
                        onChange={() => void toggleSkillEnabled(skill)}
                        disabled={isLoading || Boolean(updatingSkillId) || isInstalling}
                        hidden
                      />
                      <span className="toggle-slider" />
                      <span>{stateLabel}</span>
                    </label>
                    <div className="system-prompt-item-info skills-settings-item-info">
                      <div className="skills-settings-item-title">
                        <strong>{skill.name}</strong>
                        <code>{skill.id}</code>
                        {isGithubInstalled && (
                          <span
                            className="skills-settings-github-badge"
                            title={t("settings.skillsInstallTitle", {
                              defaultValue: "Install from GitHub",
                            })}
                          >
                            <GitHubLogo size={11} />
                          </span>
                        )}
                      </div>
                      <span className="skills-settings-item-description">
                        {skill.description ||
                          t("settings.skillsNoDescription", {
                            defaultValue: "No description provided.",
                          })}
                      </span>
                      <span className="skills-settings-item-path">
                        <Folder size={12} strokeWidth={1.8} />
                        <code title={skill.path}>{skill.path}</code>
                      </span>
                    </div>
                  </div>
                  <div className="system-prompt-item-actions skills-settings-item-actions">
                    {isUpdating && <Loader2 size={13} className="spin" />}
                    {skill.allowedTools && skill.allowedTools.length > 0 && (
                      <span
                        className="skills-settings-tools-count"
                        title={`${t("settings.skillsAllowedTools", {
                          defaultValue: "Allowed tools",
                        })}: ${skill.allowedTools.join(", ")}`}
                      >
                        <Wrench size={12} strokeWidth={1.8} />
                        {skill.allowedTools.length}
                      </span>
                    )}
                    <span className="skills-settings-badge">
                      .{skill.source}
                    </span>
                    {isGithubInstalled && (
                      <button
                        className="icon-btn ghost skills-settings-uninstall-btn"
                        onClick={() => requestUninstall(skill)}
                        type="button"
                        disabled={
                          Boolean(updatingSkillId) ||
                          isInstalling ||
                          isUninstalling
                        }
                        aria-label={uninstallLabel}
                        title={uninstallLabel}
                      >
                        {isUninstalling ? (
                          <Loader2 size={13} className="spin" />
                        ) : (
                          <Trash2 size={13} strokeWidth={1.8} />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      <ConfirmDialog
        open={Boolean(pendingUninstallSkill)}
        title={t("settings.skillsUninstall", { defaultValue: "Uninstall" })}
        message={t("settings.skillsUninstallConfirm", {
          defaultValue: "Uninstall this skill?",
          values: { name: pendingUninstallSkill?.name ?? "" },
        })}
        confirmLabel={t("settings.skillsUninstall", {
          defaultValue: "Uninstall",
        })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        onConfirm={() => void confirmUninstall()}
        onCancel={() => setPendingUninstallSkill(null)}
      />
    </div>
  );
}
