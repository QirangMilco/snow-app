import {
  AlertCircle,
  FileCode2,
  FolderOpen,
  Loader2,
  Save,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceDirectoryRecord } from "../../../../preload";
import { CustomSelect } from "../../common/CustomSelect";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { useI18n } from "../../../i18n";
import {
  buildRoleFilePath,
  buildRoleSettingsPath,
  buildSshConnectParams,
  readIncludeGlobalRules,
  resolveProjectDirectory,
  writeIncludeGlobalRules,
  type ProjectDirectoryInfo,
} from "./roleFileUtils";

/**
 * 项目规则编辑器：选择工作区项目后编辑其根目录的 ROLE.md。
 * 支持本地与 SSH 远程工作区（复用 RoleEditorPanel 的 SSH 链路）。
 */
export const ProjectRoleEditor = (): React.JSX.Element => {
  const { t } = useI18n();
  const [projects, setProjects] = useState<WorkspaceDirectoryRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [directoryInfo, setDirectoryInfo] =
    useState<ProjectDirectoryInfo | null>(null);
  const [roleFilePath, setRoleFilePath] = useState("");
  const [settingsFilePath, setSettingsFilePath] = useState("");
  const [settingsContent, setSettingsContent] = useState("");
  const [includeGlobalRules, setIncludeGlobalRules] = useState(true);
  const [originalIncludeGlobalRules, setOriginalIncludeGlobalRules] =
    useState(true);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const loadGenerationRef = useRef(0);
  const sshSessionIdRef = useRef<string | null>(null);

  // 加载项目列表。
  useEffect(() => {
    setIsLoadingProjects(true);
    window.snow
      .listWorkspaceDirectories()
      .then(setProjects)
      .catch((loadError: unknown) => {
        setError(
          loadError instanceof Error ? loadError.message : String(loadError)
        );
      })
      .finally(() => setIsLoadingProjects(false));
  }, []);

  // 断开 SSH 会话（切换项目/卸载时）。
  const disconnectSsh = useCallback((): void => {
    if (sshSessionIdRef.current) {
      void window.snow.sshDisconnect(sshSessionIdRef.current);
      sshSessionIdRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      disconnectSsh();
    };
  }, [disconnectSsh]);

  const loadProjectRole = useCallback(
    async (projectId: string): Promise<void> => {
      const generation = loadGenerationRef.current + 1;
      loadGenerationRef.current = generation;
      setIsLoading(true);
      setError(null);
      setSaveSuccess(false);
      setContent("");
      setOriginalContent("");
      setDirectoryInfo(null);
      setRoleFilePath("");
      setSettingsFilePath("");
      setSettingsContent("");
      setIncludeGlobalRules(true);
      setOriginalIncludeGlobalRules(true);
      disconnectSsh();

      try {
        const info = await resolveProjectDirectory(projectId);
        if (loadGenerationRef.current !== generation) return;

        if (!info) {
          setError(
            t("personalization.projectNotFound", {
              defaultValue: "Project directory not found.",
            })
          );
          return;
        }

        setDirectoryInfo(info);
        const filePath = buildRoleFilePath(info);
        const projectSettingsPath = buildRoleSettingsPath(info);
        setRoleFilePath(filePath);
        setSettingsFilePath(projectSettingsPath);

        if (info.isSsh) {
          const connectParams = await buildSshConnectParams(info.path);
          if (loadGenerationRef.current !== generation) return;
          if (!connectParams) {
            setError(
              t("roleEditor.sshCredentialMissing", {
                defaultValue:
                  "SSH credential is missing. Please configure it in the project settings.",
              })
            );
            return;
          }

          const sessionId = await window.snow.sshConnect(connectParams);
          if (loadGenerationRef.current !== generation) {
            void window.snow.sshDisconnect(sessionId);
            return;
          }
          sshSessionIdRef.current = sessionId;

          try {
            const result = await window.snow.sshReadFile(sessionId, filePath);
            if (loadGenerationRef.current !== generation) return;
            const text = result.isBinary ? "" : result.content;
            setContent(text);
            setOriginalContent(text);
          } catch (readError) {
            if (loadGenerationRef.current !== generation) return;
            // File does not exist yet — start with empty content.
            setContent("");
            setOriginalContent("");
          }
          try {
            const result = await window.snow.sshReadFile(
              sessionId,
              projectSettingsPath
            );
            if (loadGenerationRef.current !== generation) return;
            const text = result.isBinary ? "" : result.content;
            const enabled = readIncludeGlobalRules(text);
            setSettingsContent(text);
            setIncludeGlobalRules(enabled);
            setOriginalIncludeGlobalRules(enabled);
          } catch {
            setSettingsContent("");
          }
        } else {
          try {
            const result = await window.snow.readFileContent(filePath);
            if (loadGenerationRef.current !== generation) return;
            const text = result.isBinary ? "" : result.content;
            setContent(text);
            setOriginalContent(text);
          } catch (readError) {
            if (loadGenerationRef.current !== generation) return;
            // File does not exist yet — start with empty content.
            setContent("");
            setOriginalContent("");
          }
          try {
            const result = await window.snow.readFileContent(projectSettingsPath);
            if (loadGenerationRef.current !== generation) return;
            const text = result.isBinary ? "" : result.content;
            const enabled = readIncludeGlobalRules(text);
            setSettingsContent(text);
            setIncludeGlobalRules(enabled);
            setOriginalIncludeGlobalRules(enabled);
          } catch {
            setSettingsContent("");
          }
        }
      } catch (loadError) {
        if (loadGenerationRef.current !== generation) return;
        setError(
          loadError instanceof Error ? loadError.message : String(loadError)
        );
      } finally {
        if (loadGenerationRef.current === generation) {
          setIsLoading(false);
        }
      }
    },
    [disconnectSsh, t]
  );

  const handleProjectChange = (projectId: string): void => {
    setSelectedProjectId(projectId);
    if (projectId) {
      void loadProjectRole(projectId);
    } else {
      loadGenerationRef.current += 1;
      setDirectoryInfo(null);
      setRoleFilePath("");
      setSettingsFilePath("");
      setContent("");
      setOriginalContent("");
      setError(null);
      disconnectSsh();
    }
  };

  const handleSave = async (): Promise<void> => {
    if (!directoryInfo || !roleFilePath || !settingsFilePath || isSaving) return;

    setIsSaving(true);
    setError(null);
    setSaveSuccess(false);

    try {
      if (directoryInfo.isSsh) {
        if (!sshSessionIdRef.current) {
          const connectParams = await buildSshConnectParams(directoryInfo.path);
          if (!connectParams) {
            setError(
              t("roleEditor.sshCredentialMissing", {
                defaultValue:
                  "SSH credential is missing. Please configure it in the project settings.",
              })
            );
            setIsSaving(false);
            return;
          }
          sshSessionIdRef.current = await window.snow.sshConnect(connectParams);
        }
        await window.snow.sshWriteFile(
          sshSessionIdRef.current,
          roleFilePath,
          content
        );
        if (includeGlobalRules !== originalIncludeGlobalRules) {
          const settingsDirectory = settingsFilePath.replace(/\/[^/]+$/, "");
          const quotedDirectory = `'${settingsDirectory.replace(/'/g, `'"'"'`)}'`;
          await window.snow.sshExecuteCommand(
            sshSessionIdRef.current,
            `mkdir -p -- ${quotedDirectory}`
          );
          const nextSettings = writeIncludeGlobalRules(
            settingsContent,
            includeGlobalRules
          );
          await window.snow.sshWriteFile(
            sshSessionIdRef.current,
            settingsFilePath,
            nextSettings
          );
          setSettingsContent(nextSettings);
        }
      } else {
        await window.snow.writeFileContent(roleFilePath, content);
        if (includeGlobalRules !== originalIncludeGlobalRules) {
          const nextSettings = writeIncludeGlobalRules(
            settingsContent,
            includeGlobalRules
          );
          await window.snow.writeFileContent(settingsFilePath, nextSettings);
          setSettingsContent(nextSettings);
        }
      }

      setOriginalContent(content);
      setOriginalIncludeGlobalRules(includeGlobalRules);
      setSaveSuccess(true);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError)
      );
    } finally {
      setIsSaving(false);
    }
  };

  const hasChanges =
    content !== originalContent ||
    includeGlobalRules !== originalIncludeGlobalRules;
  const selectedProject = projects.find(
    (project) => project.directoryId === selectedProjectId
  );

  return (
    <section
      className="personalization-section"
      aria-label={t("personalization.projectTitle")}
    >
      <div className="personalization-section-header">
        <div className="personalization-section-title">
          <span className="personalization-section-icon">
            <FolderOpen size={15} strokeWidth={2} />
          </span>
          <strong>
            {t("personalization.projectTitle", {
              defaultValue: "Project rules",
            })}
          </strong>
          <span>
            {t("personalization.projectInfo", {
              defaultValue:
                "Project-specific rules are added after the global rules.",
            })}
          </span>
        </div>
      </div>

      <div className="personalization-project-select-row">
        <label className="personalization-project-select-label">
          <span>
            {t("personalization.projectSelect", {
              defaultValue: "Project",
            })}
          </span>
          <div className="personalization-project-select-wrap">
            <CustomSelect
              value={selectedProjectId}
              options={[
                {
                  value: "",
                  label: t("personalization.projectSelectPlaceholder", {
                    defaultValue: "Select a project...",
                  }),
                },
                ...projects.map((project) => ({
                  value: project.directoryId,
                  label: project.name,
                })),
              ]}
              onChange={handleProjectChange}
              disabled={isLoadingProjects}
              portal
            />
          </div>
        </label>
        {selectedProject ? (
          <span className="personalization-project-kind">
            {selectedProject.path.startsWith("ssh://")
              ? "SSH"
              : t("personalization.projectKindLocal", {
                  defaultValue: "Local",
                })}
          </span>
        ) : null}
      </div>

      {selectedProjectId ? (
        <div className="personalization-inheritance-row">
          <div className="personalization-inheritance-copy">
            <strong>
              {t("personalization.includeGlobalTitle", {
                defaultValue: "Load global rules",
              })}
            </strong>
            <span>
              {t("personalization.includeGlobalDesc", {
                defaultValue:
                  "Keep shared preferences active in this project. Project rules are applied afterwards.",
              })}
            </span>
          </div>
          <label className="toggle-switch">
            <input
              checked={includeGlobalRules}
              disabled={isLoading || isSaving}
              onChange={(event) => {
                setIncludeGlobalRules(event.target.checked);
                setSaveSuccess(false);
              }}
              type="checkbox"
            />
            <span className="toggle-slider" />
          </label>
        </div>
      ) : null}

      {!selectedProjectId ? (
        <div className="personalization-empty">
          <FolderOpen size={20} />
          <span>
            {t("personalization.projectEmpty", {
              defaultValue:
                "Select a project to edit its ROLE.md. Add projects from the sidebar first.",
            })}
          </span>
        </div>
      ) : (
        <>
          <div className="personalization-toolbar">
            <div className="personalization-toolbar-main">
              <FileCode2 size={14} />
              <div className="personalization-toolbar-info">
                <span>
                  {t("personalization.projectScopeNote", {
                    defaultValue:
                      "Project rules are appended after global rules and take priority when instructions conflict.",
                  })}
                </span>
                {roleFilePath ? (
                  <small className="project-skills-path" title={roleFilePath}>
                    {roleFilePath}
                  </small>
                ) : null}
              </div>
            </div>
            <div>
              <button
                className="personalization-save-btn"
                disabled={isSaving || isLoading || !hasChanges}
                onClick={() => void handleSave()}
                type="button"
              >
                {isSaving ? (
                  <Loader2 className="spin" size={14} />
                ) : (
                  <Save size={14} />
                )}
                <span>
                  {t("personalization.save", { defaultValue: "Save" })}
                </span>
              </button>
            </div>
          </div>

          {error ? (
            <div className="project-sensitive-command-error">
              <AlertCircle size={15} />
              <span>{error}</span>
            </div>
          ) : null}

          {saveSuccess ? (
            <AutoDismissNotice
              message={t("personalization.projectSaved", {
                defaultValue: "Project rules saved.",
              })}
              tone="success"
              onDismiss={() => setSaveSuccess(false)}
            />
          ) : null}

          {isLoading ? (
            <div className="project-sensitive-command-state">
              <Loader2 className="spin" size={18} />
              <span>
                {t("roleEditor.loading", {
                  defaultValue: "Loading ROLE.md...",
                })}
              </span>
            </div>
          ) : (
            <>
              <textarea
                aria-label={t("personalization.projectTitle", {
                  defaultValue: "Project rules",
                })}
                className="personalization-textarea"
                onChange={(event) => {
                  setContent(event.target.value);
                  setSaveSuccess(false);
                }}
                placeholder={t("personalization.projectPlaceholder", {
                  defaultValue:
                    "Enter rules for this project here, e.g. code style, architecture conventions, tech stack notes...",
                })}
                spellCheck={false}
                value={content}
              />
              <div className="role-editor-footer">
                <small>
                  {t("personalization.globalHint", {
                    defaultValue:
                      "Changes take effect in the next conversation.",
                  })}
                </small>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
};
