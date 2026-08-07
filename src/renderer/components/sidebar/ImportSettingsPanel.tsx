import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
  FileCode2,
  FolderOpen,
  Loader2,
  MessageSquareText,
  Monitor,
  Plug,
  Puzzle,
  RefreshCw,
  Server,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ImportCandidate,
  ImportCandidateStatus,
  ImportCommitResult,
  ImportDiscovery,
  ImportProvider,
  ImportSource as DiscoveredImportSource,
} from "../../../preload";
import type { WorkspaceDirectoryRecord } from "../../../preload";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { PluginsSettingsPanel } from "./PluginsSettingsPanel";

type ImportSettingsPanelProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onClose?: () => void;
};

type ThirdPartyTab = "import" | "plugins";

type SummaryItem = {
  icon: typeof Plug;
  label: string;
  value: string;
  detail: string;
};

const sourceLabels: Record<ImportProvider, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  snow: "Snow",
};

const statusLabel = (
  status: ImportCandidateStatus,
  t: ReturnType<typeof useI18n>["t"]
): string => {
  const labels: Record<ImportCandidateStatus, string> = {
    new: t("settings.importStatusNew", { defaultValue: "New" }),
    "already-effective": t("settings.importStatusAlreadyEffective", {
      defaultValue: "Already effective",
    }),
    "update-available": t("settings.importStatusUpdate", {
      defaultValue: "Update available",
    }),
    conflict: t("settings.importStatusConflict", { defaultValue: "Conflict" }),
    unsupported: t("settings.importStatusUnsupported", {
      defaultValue: "Unsupported",
    }),
    managed: t("settings.importStatusManaged", { defaultValue: "Managed" }),
    repair: t("settings.importStatusRepair", {
      defaultValue: "Repair required",
    }),
  };
  return labels[status];
};

const candidateTypeLabel = (
  candidate: ImportCandidate,
  t: ReturnType<typeof useI18n>["t"]
): string => {
  const labels = {
    mcp: t("settings.importTypeMcp", { defaultValue: "MCP" }),
    skill: t("settings.importTypeSkill", { defaultValue: "Skill" }),
    prompt: t("settings.importTypePrompt", { defaultValue: "Prompt" }),
    command: t("settings.importTypeCommand", { defaultValue: "Command" }),
    agent: t("settings.importTypeAgent", { defaultValue: "Agent" }),
    plugin: t("settings.importTypePlugin", { defaultValue: "Plugin" }),
  } as const;
  return labels[candidate.type];
};

const candidateIcon = (candidate: ImportCandidate): typeof Plug => {
  if (candidate.type === "skill") return Sparkles;
  if (
    candidate.type === "prompt" ||
    candidate.type === "command" ||
    candidate.type === "agent"
  ) {
    return MessageSquareText;
  }
  if (candidate.type === "plugin") return Puzzle;
  return Plug;
};

const isSelectable = (candidate: ImportCandidate): boolean =>
  candidate.status === "new" ||
  candidate.status === "update-available" ||
  candidate.status === "conflict" ||
  candidate.status === "repair";

const conflictKey = (candidate: ImportCandidate): string =>
  [
    candidate.provider,
    candidate.type,
    candidate.scope,
    candidate.projectId ?? "",
    candidate.logicalId,
  ].join(":");

const summaryFor = (
  discovery: ImportDiscovery,
  provider: ImportProvider,
  t: ReturnType<typeof useI18n>["t"]
): SummaryItem[] => {
  const candidates = discovery.candidates.filter((candidate) =>
    candidate.sources.some((origin) => origin.provider === provider)
  );
  const globalMcp = candidates.filter(
    (candidate) => candidate.type === "mcp" && candidate.scope === "global"
  ).length;
  const projectMcp = candidates.filter(
    (candidate) => candidate.type === "mcp" && candidate.scope === "project"
  ).length;
  const skills = candidates.filter(
    (candidate) => candidate.type === "skill"
  ).length;
  const prompts = candidates.filter(
    (candidate) =>
      candidate.type === "prompt" ||
      candidate.type === "command" ||
      candidate.type === "agent"
  ).length;
  const plugins = candidates.filter(
    (candidate) => candidate.type === "plugin"
  ).length;
  return [
    {
      icon: Plug,
      label: t("settings.importMcp", { defaultValue: "MCP servers" }),
      value: String(globalMcp + projectMcp),
      detail: t("settings.importMcpScopes", {
        defaultValue: "{{global}} global / {{project}} project",
        values: { global: globalMcp, project: projectMcp },
      }),
    },
    {
      icon: Sparkles,
      label: t("settings.importSkills", { defaultValue: "Skills" }),
      value: String(skills),
      detail: t("settings.importSkillSelectableDetail", {
        defaultValue: "Selectable external Skills",
      }),
    },
    {
      icon: MessageSquareText,
      label: t("settings.importPrompts", { defaultValue: "Prompts" }),
      value: String(prompts),
      detail: t("settings.importPromptDetail", {
        defaultValue: "Instructions, commands, and agents",
      }),
    },
    {
      icon: plugins > 0 ? Puzzle : FileCode2,
      label:
        plugins > 0
          ? t("settings.importPlugins", { defaultValue: "Plugins" })
          : t("settings.importProjectConfigs", {
              defaultValue: "Project configuration",
            }),
      value: String(
        plugins > 0
          ? plugins
          : discovery.sources.find((source) => source.provider === provider)
              ?.projectConfigCount ?? 0
      ),
      detail:
        plugins > 0
          ? t("settings.importPluginSelectableDetail", {
              defaultValue: "Import managed declarative Plugins",
            })
          : t("settings.importProjectConfigDetail", {
              defaultValue: "Registered local projects",
            }),
    },
  ];
};

type EnvironmentKind = "local" | "wsl" | "ssh";

const environmentIcon = (kind: EnvironmentKind): typeof Plug => {
  if (kind === "wsl") return Terminal;
  if (kind === "ssh") return Server;
  return Monitor;
};

function CandidateRow({
  candidate,
  checked,
  onToggle,
}: {
  candidate: ImportCandidate;
  checked: boolean;
  onToggle: (candidate: ImportCandidate) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const Icon = candidateIcon(candidate);
  const selectable = isSelectable(candidate);
  const sourceText = candidate.sources
    .map((source) => sourceLabels[source.provider])
    .join(", ");
  const reason = candidate.unsupportedReason;
  const environmentLabel = candidate.environmentLabel ?? "";
  return (
    <div
      className={`import-candidate-row ${checked ? "selected" : ""} ${
        !selectable ? "disabled" : ""
      }`}
    >
      <label className="import-candidate-checkbox">
        <input
          type="checkbox"
          checked={checked}
          disabled={!selectable}
          onChange={() => onToggle(candidate)}
          aria-label={`${candidateTypeLabel(candidate, t)} ${
            candidate.logicalId
          }`}
        />
        <span aria-hidden="true" className="import-candidate-checkmark">
          {checked ? <Check size={12} strokeWidth={2.2} /> : null}
        </span>
      </label>
      <Icon size={15} aria-hidden="true" />
      <div className="import-candidate-main">
        <strong title={candidate.logicalId}>{candidate.logicalId}</strong>
        <span title={candidate.originPath}>{candidate.originPath}</span>
        <small>
          {sourceText}
          {environmentLabel ? ` · ${environmentLabel}` : ""}
        </small>
      </div>
      <span
        className={`import-candidate-status import-candidate-status-${candidate.status}`}
      >
        {statusLabel(candidate.status, t)}
      </span>
      {reason ? (
        <span className="import-candidate-reason">{reason}</span>
      ) : null}
    </div>
  );
}

export function ImportSettingsPanel({
  activeDirectory,
  onClose,
}: ImportSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const activeDirectoryId = activeDirectory?.directoryId;
  const [activeTab, setActiveTab] = useState<ThirdPartyTab>("import");
  const [activeSource, setActiveSource] = useState<ImportProvider>("codex");
  const [discovery, setDiscovery] = useState<ImportDiscovery | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [lastResult, setLastResult] = useState<ImportCommitResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCommitting, setIsCommitting] = useState(false);
  const [error, setError] = useState("");

  const loadDiscovery = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError("");
    setLastResult(null);
    try {
      const next = await window.snow.discoverImportCandidates(activeDirectoryId);
      setDiscovery(next);
      setSelectedIds(new Set());
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("settings.importPreviewError", {
              defaultValue: "Failed to inspect import configuration",
            })
      );
    } finally {
      setIsLoading(false);
    }
  }, [activeDirectoryId, t]);

  // Discover once on mount. Re-running the full provider scan on every tab
  // switch back to "import" was expensive (it walks every workspace project
  // for all three providers); the refresh button covers explicit reloads.
  useEffect(() => {
    void loadDiscovery();
  }, [loadDiscovery]);

  const visibleCandidates = useMemo(() => {
    if (!discovery) return [];
    return discovery.candidates
      .filter((candidate) =>
        candidate.sources.some((origin) => origin.provider === activeSource)
      )
      .sort((left, right) => {
        const typeOrder = [
          "plugin",
          "skill",
          "mcp",
          "prompt",
          "command",
          "agent",
        ];
        return (
          typeOrder.indexOf(left.type) - typeOrder.indexOf(right.type) ||
          left.logicalId.localeCompare(right.logicalId)
        );
      });
  }, [activeSource, discovery]);

  const selectedCandidates = useMemo(
    () =>
      discovery?.candidates.filter((candidate) =>
        selectedIds.has(candidate.candidateId)
      ) ?? [],
    [discovery, selectedIds]
  );

  const toggleCandidate = (candidate: ImportCandidate): void => {
    if (!isSelectable(candidate)) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(candidate.candidateId)) {
        next.delete(candidate.candidateId);
      } else {
        for (const other of discovery?.candidates ?? []) {
          if (
            other.candidateId !== candidate.candidateId &&
            other.status === "conflict" &&
            conflictKey(other) === conflictKey(candidate)
          ) {
            next.delete(other.candidateId);
          }
        }
        next.add(candidate.candidateId);
      }
      return next;
    });
  };

  const commit = async (): Promise<void> => {
    if (selectedIds.size === 0 || isCommitting) return;
    setIsCommitting(true);
    setError("");
    try {
      const result = await window.snow.commitImportSelection({
        candidateIds: [...selectedIds],
        ...(activeDirectoryId ? { activeDirectoryId } : {}),
      });
      setLastResult(result);
      setSelectedIds(new Set());
      const refreshed = await window.snow.discoverImportCandidates(activeDirectoryId);
      setDiscovery(refreshed);
    } catch (commitError) {
      setError(
        commitError instanceof Error
          ? commitError.message
          : t("settings.importSourceError", {
              defaultValue: "Failed to import configuration",
            })
      );
    } finally {
      setIsCommitting(false);
    }
  };

  const source = discovery?.sources.find(
    (item) => item.provider === activeSource
  );
  const summaryItems = discovery ? summaryFor(discovery, activeSource, t) : [];
  const selectedCount = selectedCandidates.length;
  const sourceDescription =
    activeSource === "codex"
      ? t("settings.importCodexDescription", {
          defaultValue: "MCP, Skills, Plugins, and prompts from Codex.",
        })
      : activeSource === "claude-code"
      ? t("settings.importClaudeCodeDescription", {
          defaultValue:
            "MCP, Skills, CLAUDE.md, rules, and commands from Claude Code.",
        })
      : t("settings.importOpenCodeDescription", {
          defaultValue:
            "MCP, Skills, instructions, commands, and agents from OpenCode.",
        });
  const pageDescription =
    activeTab === "plugins"
      ? t("settings.pluginsSettingsInfo", {
          defaultValue:
            "Install and manage Plugins: enable, disable, update, and uninstall.",
        })
      : sourceDescription;

  return (
    <div className="api-settings-page import-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.thirdPartySettings", {
              defaultValue: "Third-party configuration",
            })}
          </strong>
          <span className="settings-item-description">{pageDescription}</span>
        </div>
        {onClose ? (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeThirdPartySettings", {
              defaultValue: "Close third-party configuration",
            })}
            title={t("settings.closeThirdPartySettings", {
              defaultValue: "Close third-party configuration",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        ) : null}
      </div>

      <div
        className="third-party-settings-tabs"
        role="tablist"
        aria-label={t("settings.thirdPartySettings", {
          defaultValue: "Third-party configuration",
        })}
      >
        <button
          id="third-party-tab-import"
          className={`third-party-settings-tab ${
            activeTab === "import" ? "active" : ""
          }`}
          type="button"
          role="tab"
          aria-selected={activeTab === "import"}
          aria-controls="third-party-panel-import"
          onClick={() => setActiveTab("import")}
        >
          <Download size={15} strokeWidth={1.8} />
          <span>
            {t("settings.thirdPartyImportTab", {
              defaultValue: "Import configuration",
            })}
          </span>
        </button>
        <button
          id="third-party-tab-plugins"
          className={`third-party-settings-tab ${
            activeTab === "plugins" ? "active" : ""
          }`}
          type="button"
          role="tab"
          aria-selected={activeTab === "plugins"}
          aria-controls="third-party-panel-plugins"
          onClick={() => setActiveTab("plugins")}
        >
          <Puzzle size={15} strokeWidth={1.8} />
          <span>
            {t("settings.thirdPartyPluginsTab", {
              defaultValue: "Manage Plugins",
            })}
          </span>
        </button>
      </div>

      {activeTab === "plugins" ? (
        <div
          id="third-party-panel-plugins"
          className="third-party-settings-panel third-party-settings-panel-plugins"
          role="tabpanel"
          aria-labelledby="third-party-tab-plugins"
        >
          <PluginsSettingsPanel embedded />
        </div>
      ) : (
        <div
          id="third-party-panel-import"
          className="third-party-settings-panel third-party-settings-panel-import"
          role="tabpanel"
          aria-labelledby="third-party-tab-import"
        >
          <div className="import-settings-source-panel">
            <div className="import-settings-scroll">
              <div
                className="import-settings-tabs"
                role="tablist"
                aria-label={t("settings.importSourceTabs", {
                  defaultValue: "Import source",
                })}
              >
                {(["codex", "claude-code", "opencode"] as const).map(
                  (provider) => (
                    <button
                      key={provider}
                      className={`import-settings-tab ${
                        provider === activeSource ? "active" : ""
                      }`}
                      type="button"
                      role="tab"
                      aria-selected={provider === activeSource}
                      onClick={() => setActiveSource(provider)}
                    >
                      {sourceLabels[provider]}
                    </button>
                  )
                )}
              </div>

              <div className="api-settings-actions import-settings-actions import-settings-toolbar">
                <button
                  className="api-settings-action-btn"
                  onClick={() => void loadDiscovery()}
                  type="button"
                  disabled={isLoading || isCommitting}
                >
                  {isLoading ? (
                    <Loader2 size={15} className="spin" />
                  ) : (
                    <RefreshCw size={15} />
                  )}
                  <span>
                    {t("settings.importRefresh", {
                      defaultValue: "Refresh discovery",
                    })}
                  </span>
                </button>
              </div>

              <AutoDismissNotice
                message={error}
                tone="error"
                onDismiss={() => setError("")}
              />

              {lastResult ? (
                <section className="import-settings-result" aria-live="polite">
                  <CheckCircle2 size={15} aria-hidden="true" />
                  <span>
                    {t("settings.importCommitSummary", {
                      defaultValue:
                        "Imported {{imported}}, unchanged {{unchanged}}, skipped {{skipped}}, unsupported {{unsupported}}.",
                      values: lastResult.summary,
                    })}
                  </span>
                </section>
              ) : null}

              {discovery ? (
                <>
                  <div className="api-settings-summary-grid import-settings-summary-grid">
                    {summaryItems.map(
                      ({ icon: Icon, label, value, detail }) => (
                        <div className="api-settings-summary-card" key={label}>
                          <Icon size={15} strokeWidth={1.8} />
                          <span>{label}</span>
                          <strong className="import-settings-summary-value">
                            {value}
                          </strong>
                          <small>{detail}</small>
                        </div>
                      )
                    )}
                  </div>

                  <section className="api-settings-form-section import-settings-candidates">
                    <div className="api-settings-form-section-header">
                      <strong className="api-settings-form-section-title">
                        {t("settings.importCandidates", {
                          defaultValue: "Candidates",
                        })}
                      </strong>
                      <span className="settings-item-description">
                        {t("settings.importSelectedCount", {
                          defaultValue: "{{count}} selected",
                          values: { count: selectedCount },
                        })}
                      </span>
                    </div>
                    {visibleCandidates.length > 0 ? (
                      <div className="import-candidate-list">
                        {visibleCandidates.map((candidate) => (
                          <CandidateRow
                            key={candidate.candidateId}
                            candidate={candidate}
                            checked={selectedIds.has(candidate.candidateId)}
                            onToggle={toggleCandidate}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="settings-empty-state">
                        {t("settings.importNoCandidates", {
                          defaultValue: "No import candidates found.",
                        })}
                      </div>
                    )}
                  </section>

                  <section className="api-settings-form-section import-settings-source">
                    <div className="api-settings-form-section-header">
                      <strong className="api-settings-form-section-title">
                        {t("settings.importSourceFiles", {
                          defaultValue: "Source files",
                        })}
                      </strong>
                      <span
                        className={
                          source?.sourceFound
                            ? "import-settings-found"
                            : "import-settings-missing"
                        }
                      >
                        {source?.sourceFound ? (
                          <CheckCircle2 size={13} aria-hidden="true" />
                        ) : null}
                        {source?.sourceFound
                          ? t("settings.importSourceFound", {
                              defaultValue: "Source found",
                            })
                          : t("settings.importSourceMissing", {
                              defaultValue: "Source not found",
                            })}
                      </span>
                    </div>
                    <div className="import-settings-path-list">
                      {source?.environments && source.environments.length > 1 ? (
                        <div className="import-settings-environments">
                          {source.environments.map((environment) => {
                            const EnvIcon = environmentIcon(
                              environment.kind as EnvironmentKind
                            );
                            return (
                              <div
                                className="import-settings-environment-row"
                                key={environment.environmentId}
                              >
                                <EnvIcon size={13} aria-hidden="true" />
                                <span className="import-settings-environment-label">
                                  {environment.label}
                                </span>
                                <code title={environment.home}>
                                  {environment.home}
                                </code>
                                {environment.found ? (
                                  <CheckCircle2 size={12} aria-hidden="true" />
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                      <div className="import-settings-path-row">
                        <FolderOpen size={14} aria-hidden="true" />
                        <span>
                          {t("settings.importSourceDirectory", {
                            defaultValue: "Source directory",
                          })}
                        </span>
                        <code title={source?.sourceHome}>
                          {source?.sourceHome ?? "-"}
                        </code>
                      </div>
                      {source?.configPaths.map((path) => (
                        <div
                          className="import-settings-path-row"
                          key={path.path}
                        >
                          <FileCode2 size={14} aria-hidden="true" />
                          <span>{path.label}</span>
                          <code title={path.path}>{path.path}</code>
                        </div>
                      ))}
                    </div>
                  </section>

                  {source && source.warnings.length > 0 ? (
                    <section className="api-settings-form-section import-settings-warnings">
                      <strong className="api-settings-form-section-title">
                        {t("settings.importWarnings", {
                          defaultValue: "Warnings",
                        })}
                      </strong>
                      <ul>
                        {source.warnings.map((warning, index) => (
                          <li key={`${warning}-${index}`}>
                            <AlertTriangle size={14} aria-hidden="true" />
                            <span>{warning}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </>
              ) : null}
            </div>

            <div className="import-settings-footer">
              <span className="import-settings-footer-selection settings-item-description">
                {t("settings.importSelectedCount", {
                  defaultValue: "{{count}} selected",
                  values: { count: selectedCount },
                })}
              </span>
              <button
                className="api-settings-action-btn primary"
                onClick={() => void commit()}
                type="button"
                disabled={selectedCount === 0 || isCommitting || isLoading}
              >
                {isCommitting ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <CheckCircle2 size={15} />
                )}
                <span>
                  {t("settings.importCommit", {
                    defaultValue: "Import selected",
                  })}{" "}
                  ({selectedCount})
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
