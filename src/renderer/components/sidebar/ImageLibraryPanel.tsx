import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Download,
  FolderCog,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { ConfirmDialog } from "../common/ConfirmDialog";
import type { ImageLibraryRecord } from "../../../preload";

type RatioFilter = "all" | "landscape" | "square" | "portrait";
type TimeFilter = "all" | "today" | "7d" | "30d";

/** data URL → Blob（不走 fetch：CSP connect-src 不允许 data:） */
const dataUrlToBlob = (dataUrl: string): Blob => {
  const [header, base64] = dataUrl.split(",");
  const mimeType =
    /^data:([^;]+)/.exec(header)?.[1] ?? "application/octet-stream";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
};

/** 图片 data URL 进程内缓存，避免重复 IPC */
const imageDataCache = new Map<string, string>();

const saveBlob = async (dataUrl: string, filename: string): Promise<void> => {
  const blob = dataUrlToBlob(dataUrl);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const ratioKind = (record: ImageLibraryRecord): RatioFilter => {
  if (!record.width || !record.height) return "all";
  const ratio = record.width / record.height;
  if (ratio > 1.05) return "landscape";
  if (ratio < 0.95) return "portrait";
  return "square";
};

type ImageLibraryPanelProps = {
  onClose: () => void;
};

export const ImageLibraryPanel = ({
  onClose,
}: ImageLibraryPanelProps): React.JSX.Element => {
  const { t } = useI18n();
  const [items, setItems] = useState<ImageLibraryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [root, setRoot] = useState("");
  const [customDir, setCustomDir] = useState("");
  const [changingDir, setChangingDir] = useState(false);
  const [ratioFilter, setRatioFilter] = useState<RatioFilter>("all");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [modelFilter, setModelFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("all");
  const [dataUrls, setDataUrls] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<ImageLibraryRecord | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDeletion, setPendingDeletion] =
    useState<ImageLibraryRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [records, rootPath, savedDir] = await Promise.all([
        window.snow.listImageLibrary(),
        window.snow.getImageLibraryRoot().catch(() => ""),
        window.snow.getImageLibraryDir().catch(() => ""),
      ]);
      setItems(records);
      setRoot(rootPath);
      setCustomDir(savedDir);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError)
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 批量解析缩略图 data URL（带缓存）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const record of items) {
        if (cancelled) break;
        const cached = imageDataCache.get(record.relativePath);
        if (cached) {
          next[record.relativePath] = cached;
          continue;
        }
        try {
          const dataUrl = await window.snow.resolveLibraryImage(
            record.relativePath
          );
          if (dataUrl) {
            imageDataCache.set(record.relativePath, dataUrl);
            next[record.relativePath] = dataUrl;
          }
        } catch {
          // 单张失败不中断
        }
      }
      if (!cancelled && Object.keys(next).length > 0) {
        setDataUrls((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items]);

  const models = useMemo(
    () => [...new Set(items.map((item) => item.model).filter(Boolean))].sort(),
    [items]
  );
  const providers = useMemo(
    () =>
      [...new Set(items.map((item) => item.provider).filter(Boolean))].sort(),
    [items]
  );

  const filtered = useMemo(() => {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const dayMs = 24 * 60 * 60 * 1000;
    return items.filter((item) => {
      if (ratioFilter !== "all" && ratioKind(item) !== ratioFilter) {
        return false;
      }
      if (modelFilter !== "all" && item.model !== modelFilter) {
        return false;
      }
      if (providerFilter !== "all" && item.provider !== providerFilter) {
        return false;
      }
      if (timeFilter !== "all") {
        const created = new Date(item.createdAt.replace(" ", "T")).getTime();
        const limit =
          timeFilter === "today"
            ? todayStart.getTime()
            : timeFilter === "7d"
            ? now - 7 * dayMs
            : now - 30 * dayMs;
        if (!Number.isFinite(created) || created < limit) {
          return false;
        }
      }
      return true;
    });
  }, [items, ratioFilter, timeFilter, modelFilter, providerFilter]);

  /** 请求删除图片（弹出确认对话框）。 */
  const requestDelete = (record: ImageLibraryRecord): void => {
    setPendingDeletion(record);
  };

  /** 确认删除图片。 */
  const confirmDelete = async (): Promise<void> => {
    const record = pendingDeletion;
    if (!record) {
      return;
    }
    setPendingDeletion(null);
    setDeletingId(record.id);
    try {
      await window.snow.deleteImageLibraryImage(record.id);
      imageDataCache.delete(record.relativePath);
      setItems((prev) => prev.filter((item) => item.id !== record.id));
      if (lightbox?.id === record.id) {
        setLightbox(null);
      }
    } finally {
      setDeletingId(null);
    }
  };

  const handleDownload = async (record: ImageLibraryRecord): Promise<void> => {
    const dataUrl =
      dataUrls[record.relativePath] ??
      (await window.snow.resolveLibraryImage(record.relativePath));
    if (!dataUrl) {
      return;
    }
    await saveBlob(
      dataUrl,
      record.fileName || record.relativePath.split("/").pop() || "image.png"
    );
  };

  const handleChangeDir = async (): Promise<void> => {
    const selected = await window.snow.selectImageDirectory(
      t("settings.imageLibrarySelectDir")
    );
    if (!selected) return;
    setChangingDir(true);
    try {
      await window.snow.setImageLibraryDir(selected);
      setCustomDir(selected);
      const newRoot = await window.snow.getImageLibraryRoot().catch(() => "");
      setRoot(newRoot);
      imageDataCache.clear();
      setDataUrls({});
    } finally {
      setChangingDir(false);
    }
  };

  const handleResetDir = async (): Promise<void> => {
    setChangingDir(true);
    try {
      await window.snow.setImageLibraryDir("");
      setCustomDir("");
      const newRoot = await window.snow.getImageLibraryRoot().catch(() => "");
      setRoot(newRoot);
      imageDataCache.clear();
      setDataUrls({});
    } finally {
      setChangingDir(false);
    }
  };

  const lightboxDataUrl = lightbox ? dataUrls[lightbox.relativePath] ?? "" : "";

  useEffect(() => {
    if (!lightbox) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLightbox(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightbox]);

  return (
    <div className="api-settings-page image-library-page">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>{t("settings.imageLibrary")}</strong>
          <span className="settings-item-description">
            {t("settings.imageLibraryDescription")}
          </span>
        </div>
        <div className="image-library-actions">
          <button
            type="button"
            className="icon-btn ghost"
            onClick={() => void load()}
            title={t("settings.imageLibraryRefresh")}
            aria-label={t("settings.imageLibraryRefresh")}
          >
            <RefreshCw size={15} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="icon-btn ghost"
            onClick={onClose}
            aria-label={t("toolCall.imagegen.close")}
            title={t("toolCall.imagegen.close")}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {root ? (
        <div className="image-library-root-bar" title={root}>
          {changingDir ? (
            <Loader2
              size={12}
              className="tool-call-icon-spinning"
              aria-hidden="true"
            />
          ) : (
            <FolderOpen size={12} aria-hidden="true" />
          )}
          <span className="image-library-root-path">{root}</span>
          <button
            type="button"
            className="image-library-root-action"
            onClick={() => void handleChangeDir()}
            disabled={changingDir}
            title={t("settings.imageLibraryChangeDir")}
            aria-label={t("settings.imageLibraryChangeDir")}
          >
            <FolderCog size={11} aria-hidden="true" />
          </button>
          {customDir ? (
            <button
              type="button"
              className="image-library-root-action"
              onClick={() => void handleResetDir()}
              disabled={changingDir}
              title={t("settings.imageLibraryResetDir")}
              aria-label={t("settings.imageLibraryResetDir")}
            >
              <X size={11} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="image-library-toolbar">
        <div className="image-library-filter-group">
          {(
            [
              ["all", t("settings.imageLibraryFilterAll")],
              ["landscape", t("settings.imageLibraryFilterLandscape")],
              ["square", t("settings.imageLibraryFilterSquare")],
              ["portrait", t("settings.imageLibraryFilterPortrait")],
            ] as [RatioFilter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`image-library-filter-btn${
                ratioFilter === value ? " active" : ""
              }`}
              onClick={() => setRatioFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="image-library-filter-group">
          {(
            [
              ["all", t("settings.imageLibraryTimeAll")],
              ["today", t("settings.imageLibraryTimeToday")],
              ["7d", t("settings.imageLibraryTime7d")],
              ["30d", t("settings.imageLibraryTime30d")],
            ] as [TimeFilter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`image-library-filter-btn${
                timeFilter === value ? " active" : ""
              }`}
              onClick={() => setTimeFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {providers.length > 1 ? (
          <select
            className="image-library-select"
            value={providerFilter}
            onChange={(event) => setProviderFilter(event.target.value)}
            aria-label={t("toolCall.imagegen.provider")}
          >
            <option value="all">{t("settings.imageLibraryProviderAll")}</option>
            {providers.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        ) : null}
        {models.length > 1 ? (
          <select
            className="image-library-select"
            value={modelFilter}
            onChange={(event) => setModelFilter(event.target.value)}
            aria-label={t("toolCall.imagegen.model")}
          >
            <option value="all">{t("settings.imageLibraryModelAll")}</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        ) : null}
        <span className="image-library-count">
          {t("settings.imageLibraryCount", {
            values: { count: filtered.length },
          })}
        </span>
      </div>

      <div className="image-library-content">
        {loading ? (
          <div className="image-library-state" role="status">
            <Loader2
              className="tool-call-icon-spinning"
              size={20}
              aria-hidden="true"
            />
            <span>{t("common.loading")}</span>
          </div>
        ) : error ? (
          <div className="image-library-state">
            <span className="tool-call-error">{error}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="image-library-state">
            <ImageIcon size={26} aria-hidden="true" />
            <span>{t("settings.imageLibraryEmpty")}</span>
          </div>
        ) : (
          <div className="image-library-grid">
            {filtered.map((record) => {
              const src = dataUrls[record.relativePath];
              return (
                <div
                  key={record.id}
                  className="image-library-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => setLightbox(record)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      setLightbox(record);
                    }
                  }}
                  title={record.prompt || record.fileName}
                >
                  {src ? (
                    <img src={src} alt={record.prompt || record.fileName} />
                  ) : (
                    <div className="image-library-card-placeholder">
                      <Loader2
                        className="tool-call-icon-spinning"
                        size={16}
                        aria-hidden="true"
                      />
                    </div>
                  )}
                  <div className="image-library-card-meta">
                    <span className="image-library-card-model">
                      {record.model || record.provider || "—"}
                    </span>
                    <span className="image-library-card-date">
                      {record.createdAt}
                    </span>
                  </div>
                  <div
                    className="image-library-card-actions"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="image-library-card-btn"
                      onClick={() => void handleDownload(record)}
                      title={t("toolCall.imagegen.download")}
                      aria-label={t("toolCall.imagegen.download")}
                    >
                      <Download size={12} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="image-library-card-btn danger"
                      onClick={() => requestDelete(record)}
                      disabled={deletingId === record.id}
                      title={t("settings.imageLibraryDelete")}
                      aria-label={t("settings.imageLibraryDelete")}
                    >
                      {deletingId === record.id ? (
                        <Loader2
                          className="tool-call-icon-spinning"
                          size={12}
                          aria-hidden="true"
                        />
                      ) : (
                        <Trash2 size={12} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {lightbox && lightboxDataUrl
        ? createPortal(
            <div
              className="tool-call-imagegen-lightbox"
              onClick={() => setLightbox(null)}
              role="presentation"
            >
              <img
                src={lightboxDataUrl}
                alt={lightbox.prompt || lightbox.fileName}
                onClick={(event) => event.stopPropagation()}
              />
              <div
                className="tool-call-imagegen-lightbox-toolbar"
                onClick={(event) => event.stopPropagation()}
              >
                <span className="image-library-lightbox-meta">
                  {lightbox.model ? `${lightbox.model} · ` : ""}
                  {lightbox.provider ? `${lightbox.provider} · ` : ""}
                  {lightbox.createdAt}
                </span>
                <button
                  type="button"
                  className="tool-call-imagegen-download"
                  onClick={() => void handleDownload(lightbox)}
                >
                  <Download size={13} aria-hidden="true" />
                  {t("toolCall.imagegen.download")}
                </button>
                <button
                  type="button"
                  className="tool-call-imagegen-lightbox-close"
                  onClick={() => setLightbox(null)}
                  aria-label={t("toolCall.imagegen.close")}
                >
                  ✕
                </button>
              </div>
            </div>,
            document.body
          )
        : null}

      <ConfirmDialog
        open={pendingDeletion !== null}
        title={t("settings.imageLibraryDeleteTitle", {
          defaultValue: "Delete image",
        })}
        message={t("settings.imageLibraryDeleteConfirm", {
          defaultValue:
            "Delete this image? It will also be removed from the conversation.",
        })}
        confirmLabel={t("settings.imageLibraryDelete", {
          defaultValue: "Delete",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDeletion(null)}
        variant="danger"
      />
    </div>
  );
};
