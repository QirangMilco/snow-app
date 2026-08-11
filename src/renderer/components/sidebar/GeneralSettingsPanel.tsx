import {
  Archive,
  Database,
  Download,
  FolderCog,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { localeLabels, useI18n, type Locale } from "../../i18n";
import { ConfirmDialog } from "../common/ConfirmDialog";
import type { UpdateStatus } from "../../../preload";
import type {
  StorageLocationKind,
  StorageLocations,
} from "../../../preload";

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

// 可迁移的存储位置（checkpoint / upload）
const STORAGE_KINDS: StorageLocationKind[] = ["checkpoint", "upload"];

/** 待确认迁移的目标目录 */
type PendingMigration = {
  kind: StorageLocationKind;
  target: string;
  dirLabel: string;
};

/** 迁移进度状态 */
type MigrationState = {
  kind: StorageLocationKind;
  copied: number;
  total: number;
};

type GeneralSettingsPanelProps = {
  onClose?: () => void;
};

/** 取文件路径的父目录（跨平台字符串处理，避免在渲染层引入 node:path）。 */
const parentDirOf = (filePath: string): string =>
  filePath.replace(/[\\/][^\\/]*$/, "") || filePath;

export function GeneralSettingsPanel({
  onClose,
}: GeneralSettingsPanelProps): React.JSX.Element {
  const { locale, setLocale, supportedLocales, t } = useI18n();
  const [appVersion, setAppVersion] = useState<string>("");
  const [isChecking, setIsChecking] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(
    INITIAL_UPDATE_STATUS
  );
  const [checkHint, setCheckHint] = useState<CheckHint>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 存储位置
  const [locations, setLocations] = useState<StorageLocations | null>(null);
  const [storageBusy, setStorageBusy] = useState<StorageLocationKind | null>(
    null
  );
  const [pendingMigration, setPendingMigration] =
    useState<PendingMigration | null>(null);
  const [migration, setMigration] = useState<MigrationState | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [storageError, setStorageError] = useState("");
  /** 用户请求取消迁移（chunk 循环之间检查） */
  const migrationCancelledRef = useRef(false);
  /** 组件卸载时若迁移仍进行中，触发回滚 */
  const migrationActiveRef = useRef(false);
  const pendingMigrationRef = useRef<PendingMigration | null>(null);

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

  const loadLocations = useCallback(async (): Promise<void> => {
    try {
      const value = await window.snow.getStorageLocations();
      setLocations(value);
    } catch (error) {
      setStorageError(
        error instanceof Error ? error.message : String(error)
      );
    }
  }, []);

  useEffect(() => {
    void loadLocations();
  }, [loadLocations]);

  // 迁移进行中关闭面板：触发回滚，避免遗留未完成的迁移日志
  useEffect(() => {
    return () => {
      if (migrationActiveRef.current) {
        const pending = pendingMigrationRef.current;
        if (pending) {
          void window.snow
            .rollbackStorageMigration(pending.kind)
            .catch(() => undefined);
        }
      }
    };
  }, []);

  const isMigrating = migration !== null || rollingBack;

  const handleOpenDir = async (dirPath: string): Promise<void> => {
    const errorMessage = await window.snow.openStorageDirectory(dirPath);
    if (errorMessage) {
      setStorageError(errorMessage);
    }
  };

  const handleChangeDir = async (kind: StorageLocationKind): Promise<void> => {
    const selected = await window.snow.selectStorageDirectory(
      kind === "checkpoint"
        ? t("settings.storageSelectCheckpointDir", {
            defaultValue: "Select checkpoint folder",
          })
        : t("settings.storageSelectUploadDir", {
            defaultValue: "Select upload folder",
          })
    );
    if (!selected) {
      return;
    }
    setPendingMigration({ kind, target: selected, dirLabel: selected });
  };

  const handleResetDir = (kind: StorageLocationKind): void => {
    setPendingMigration({
      kind,
      target: "",
      dirLabel: t("settings.storageDefaultDir", {
        defaultValue: "Default location",
      }),
    });
  };

  /** 确认迁移：prepare → 分批复制 → commit；取消则回滚。 */
  const confirmMigration = async (): Promise<void> => {
    const pending = pendingMigration;
    if (!pending) {
      return;
    }
    setPendingMigration(null);
    pendingMigrationRef.current = pending;
    migrationCancelledRef.current = false;
    migrationActiveRef.current = true;
    setStorageBusy(pending.kind);
    setStorageError("");
    try {
      const total = await window.snow.prepareStorageMigration(
        pending.kind,
        pending.target
      );
      if (total === 0) {
        // 无需迁移（目标与当前相同或目录为空）：直接切换
        await window.snow.setStorageDir(pending.kind, pending.target);
        await loadLocations();
        return;
      }
      setMigration({ kind: pending.kind, copied: 0, total });
      let done = false;
      while (!done) {
        if (migrationCancelledRef.current) {
          break;
        }
        const progress = await window.snow.migrateStorageChunk(pending.kind);
        setMigration({
          kind: pending.kind,
          copied: progress.copied,
          total: progress.total,
        });
        done = progress.done;
      }
      if (migrationCancelledRef.current) {
        // 用户取消：删除已复制文件，保持旧目录
        setRollingBack(true);
        await window.snow.rollbackStorageMigration(pending.kind);
        return;
      }
      await window.snow.commitStorageMigration(pending.kind);
      await loadLocations();
    } catch (migrationError) {
      // 出错自动回滚，保持旧目录
      try {
        await window.snow.rollbackStorageMigration(pending.kind);
      } catch {
        // 回滚失败不阻断错误提示
      }
      setStorageError(
        migrationError instanceof Error
          ? migrationError.message
          : String(migrationError)
      );
    } finally {
      setRollingBack(false);
      setMigration(null);
      migrationActiveRef.current = false;
      pendingMigrationRef.current = null;
      setStorageBusy(null);
    }
  };

  const cancelMigration = (): void => {
    migrationCancelledRef.current = true;
  };

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.generalSettings", {
              defaultValue: "General settings",
            })}
          </strong>
          <span className="settings-item-description">
            {t("settings.generalSettingsInfo", {
              defaultValue: "Language, version and update management.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.generalSettingsClosePanel", {
              defaultValue: "Close general settings",
            })}
            title={t("settings.generalSettingsClosePanel", {
              defaultValue: "Close general settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>
            {t("settings.languageSettings", { defaultValue: "Language" })}
          </strong>
          <span>
            {t("settings.languageSettingsInfo", {
              defaultValue: "Choose the display language for Snow App.",
            })}
          </span>
        </div>

        <div className="api-settings-form-body">
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

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>
            {t("settings.storageLocations", {
              defaultValue: "Storage locations",
            })}
          </strong>
          <span>
            {t("settings.storageLocationsInfo", {
              defaultValue:
                "Where Snow App stores its database, checkpoints and uploaded images.",
            })}
          </span>
        </div>

        <div className="api-settings-form-body">
          {storageError && (
            <span className="settings-update-error">{storageError}</span>
          )}

          {/* 数据库位置 */}
          <div className="general-storage-row">
            <div className="general-storage-info">
              <Database
                size={14}
                strokeWidth={1.8}
                className="general-storage-icon"
                aria-hidden="true"
              />
              <div className="general-storage-text">
                <span className="general-storage-label">
                  {t("settings.storageDatabase", {
                    defaultValue: "Database",
                  })}
                </span>
                <span
                  className="general-storage-path"
                  title={locations?.databasePath}
                >
                  {locations?.databasePath ?? "—"}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="general-storage-action"
              onClick={() =>
                locations &&
                void handleOpenDir(parentDirOf(locations.databasePath))
              }
              disabled={!locations || isMigrating}
              title={t("settings.storageOpenDir", {
                defaultValue: "Open folder",
              })}
            >
              <FolderOpen size={11} aria-hidden="true" />
              <span>
                {t("settings.storageOpenDir", {
                  defaultValue: "Open folder",
                })}
              </span>
            </button>
          </div>

          {/* 检查点 / 上传图片位置 */}
          {STORAGE_KINDS.map((kind) => {
            const isCheckpoint = kind === "checkpoint";
            const root = isCheckpoint
              ? locations?.checkpointRoot
              : locations?.uploadRoot;
            const customDir = isCheckpoint
              ? locations?.checkpointDir
              : locations?.uploadDir;
            const isCustom = (customDir ?? "") !== "";

            return (
              <div key={kind} className="general-storage-row">
                <div className="general-storage-info">
                  {isCheckpoint ? (
                    <Archive
                      size={14}
                      strokeWidth={1.8}
                      className="general-storage-icon"
                      aria-hidden="true"
                    />
                  ) : (
                    <ImageIcon
                      size={14}
                      strokeWidth={1.8}
                      className="general-storage-icon"
                      aria-hidden="true"
                    />
                  )}
                  <div className="general-storage-text">
                    <span className="general-storage-label">
                      {isCheckpoint
                        ? t("settings.storageCheckpoint", {
                            defaultValue: "Checkpoints",
                          })
                        : t("settings.storageUpload", {
                            defaultValue: "Uploaded images",
                          })}
                    </span>
                    <span className="general-storage-path" title={root}>
                      {root ?? "—"}
                    </span>
                  </div>
                </div>
                <div className="general-storage-actions">
                  <button
                    type="button"
                    className="general-storage-action"
                    onClick={() => root && void handleOpenDir(root)}
                    disabled={!root || isMigrating}
                    title={t("settings.storageOpenDir", {
                      defaultValue: "Open folder",
                    })}
                  >
                    <FolderOpen size={11} aria-hidden="true" />
                    <span>
                      {t("settings.storageOpenDir", {
                        defaultValue: "Open folder",
                      })}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="general-storage-action"
                    onClick={() => void handleChangeDir(kind)}
                    disabled={!root || isMigrating}
                    title={t("settings.storageChangeDir", {
                      defaultValue: "Change folder",
                    })}
                  >
                    <FolderCog size={11} aria-hidden="true" />
                    <span>
                      {t("settings.storageChangeDir", {
                        defaultValue: "Change folder",
                      })}
                    </span>
                  </button>
                  {isCustom && (
                    <button
                      type="button"
                      className="general-storage-action"
                      onClick={() => handleResetDir(kind)}
                      disabled={isMigrating}
                      title={t("settings.storageResetDir", {
                        defaultValue: "Use default",
                      })}
                    >
                      <X size={11} aria-hidden="true" />
                      <span>
                        {t("settings.storageResetDir", {
                          defaultValue: "Use default",
                        })}
                      </span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {/* 迁移进度 */}
          {migration && (
            <div className="general-storage-migrate-bar" role="status">
              <div className="general-storage-migrate-info">
                <LoaderCircle
                  size={12}
                  strokeWidth={1.8}
                  className="tool-call-icon-spinning"
                  aria-hidden="true"
                />
                <span>
                  {rollingBack
                    ? t("settings.storageMigrateRollingBack", {
                        defaultValue: "Rolling back...",
                      })
                    : t("settings.storageMigrateProgress", {
                        values: {
                          current: migration.copied,
                          total: migration.total,
                        },
                        defaultValue: `Migrating ${migration.copied}/${migration.total}`,
                      })}
                </span>
                {!rollingBack && (
                  <button
                    type="button"
                    className="general-storage-migrate-cancel"
                    onClick={cancelMigration}
                  >
                    {t("settings.cancel", { defaultValue: "Cancel" })}
                  </button>
                )}
              </div>
              <div className="general-storage-migrate-progress-bar">
                <div
                  className="general-storage-migrate-progress-fill"
                  style={{
                    width: `${
                      migration.total > 0
                        ? Math.min(
                            100,
                            Math.round(
                              (migration.copied / migration.total) * 100
                            )
                          )
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>
            {t("settings.about", { defaultValue: "About" })}
          </strong>
          <span>
            {t("settings.aboutInfo", {
              defaultValue: "Version and update management for Snow App.",
            })}
          </span>
        </div>

        <div className="api-settings-form-body">
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

      <ConfirmDialog
        open={pendingMigration !== null}
        title={t("settings.storageMigrateTitle", {
          defaultValue: "Migrate data",
        })}
        message={t("settings.storageMigrateConfirm", {
          values: { dir: pendingMigration?.dirLabel ?? "" },
          defaultValue:
            "Existing files will be moved to:\n{{dir}}\n\nContinue?",
        })}
        confirmLabel={t("settings.storageMigrateConfirmBtn", {
          defaultValue: "Migrate",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void confirmMigration()}
        onCancel={() => setPendingMigration(null)}
      />
    </div>
  );
}
