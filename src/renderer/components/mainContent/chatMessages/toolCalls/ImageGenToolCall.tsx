import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Download,
  Image as ImageIcon,
  Link2,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type ImageGenToolCallProps = {
  toolCall: ToolCallInfo;
};

type ParsedImageGenArgs = {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  outputFormat?: string;
  outputCompression?: number;
  n?: number;
  provider?: string;
  personGeneration?: string;
  webSearch?: boolean;
  stream?: boolean;
  inputFidelity?: string;
  background?: string;
  moderation?: string;
  seed?: number;
  thinkingLevel?: string;
  imageSearch?: boolean;
  images?: Array<{
    data: string;
    mimeType: string;
    /** 纯文本主模型场景下的磁盘相对路径引用（upload/...），渲染端仅作占位展示 */
    path?: string;
  }>;
};

type GeneratedImage = {
  data: string;
  mimeType: string;
  /** 图库相对路径引用（image/...，图片已落盘到图库目录），经 IPC 读取；优先于 data */
  path?: string;
};

type ParsedImageGenResult =
  | {
      type: "success";
      prompt: string;
      model: string;
      imageCount: number;
      images: GeneratedImage[];
      remoteUrls: string[];
      contentPreview: string;
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseImageGenArgs = (args: string): ParsedImageGenArgs | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (
      !isRecord(parsed) ||
      typeof parsed.prompt !== "string" ||
      parsed.prompt.trim() === ""
    ) {
      return null;
    }

    const result: ParsedImageGenArgs = { prompt: parsed.prompt };
    if (typeof parsed.model === "string") {
      result.model = parsed.model;
    }
    if (typeof parsed.size === "string") {
      result.size = parsed.size;
    }
    if (typeof parsed.quality === "string") {
      result.quality = parsed.quality;
    }
    if (typeof parsed.outputFormat === "string") {
      result.outputFormat = parsed.outputFormat;
    }
    if (typeof parsed.n === "number") {
      result.n = parsed.n;
    }
    if (typeof parsed.outputCompression === "number") {
      result.outputCompression = parsed.outputCompression;
    }
    if (typeof parsed.provider === "string" && parsed.provider.trim() !== "") {
      result.provider = parsed.provider;
    }
    if (typeof parsed.seed === "number") {
      result.seed = parsed.seed;
    }
    if (typeof parsed.thinkingLevel === "string") {
      result.thinkingLevel = parsed.thinkingLevel;
    }
    if (typeof parsed.imageSearch === "boolean") {
      result.imageSearch = parsed.imageSearch;
    }
    if (
      typeof parsed.personGeneration === "string" &&
      parsed.personGeneration.trim() !== ""
    ) {
      result.personGeneration = parsed.personGeneration;
    }
    if (typeof parsed.webSearch === "boolean") {
      result.webSearch = parsed.webSearch;
    }
    if (typeof parsed.stream === "boolean") {
      result.stream = parsed.stream;
    }
    if (typeof parsed.inputFidelity === "string") {
      result.inputFidelity = parsed.inputFidelity;
    }
    if (typeof parsed.background === "string") {
      result.background = parsed.background;
    }
    if (typeof parsed.moderation === "string") {
      result.moderation = parsed.moderation;
    }
    if (Array.isArray(parsed.images)) {
      const images: Array<{
        data: string;
        mimeType: string;
        path?: string;
      }> = [];
      for (const item of parsed.images) {
        if (isRecord(item) && typeof item.mimeType === "string") {
          if (typeof item.data === "string" && item.data.trim() !== "") {
            // 内联 base64 参考图
            images.push({ data: item.data, mimeType: item.mimeType });
          } else if (typeof item.path === "string" && item.path.trim() !== "") {
            // 磁盘相对路径引用（来自文本化消息的 [Reference image #N ...] 块），
            // 服务端已按此路径读取原图完成图生图；渲染端无法直接访问该路径，
            // 以占位图展示
            images.push({
              data: "",
              mimeType: item.mimeType,
              path: item.path.trim(),
            });
          }
        }
      }
      if (images.length > 0) {
        result.images = images;
      }
    }
    return result;
  } catch {
    return null;
  }
};

/** 匹配 result 文本中追加的内联图片标签（@@image:data:...@@）。该标签由
 *  formatMcpToolResultForModel 在持久化时生成（真实 base64 换占位符 +
 *  标签），历史回放时由 Rust resolve_inline_images_from_disk 还原为
 *  data URL。剥离标签后 result 才是纯 JSON。 */
const INLINE_IMAGE_TAG_RE = /@@image:(data:[^@]+)@@/g;

const parseImageGenResult = (
  result: string | undefined
): ParsedImageGenResult => {
  if (!result) {
    return { type: "empty" };
  }

  // 历史消息回放时 result 形如 "{JSON}\n@@image:data:...@@\n..."，
  // 直接 JSON.parse 会失败 → 走 raw 兜底把 JSON + base64 当文本展示
  // （表现为生图结果区域渲染出大量乱码/重复字符）。先提取并剥离标签。
  const inlineDataUrls: string[] = [];
  const stripped = result
    .replace(INLINE_IMAGE_TAG_RE, (_match, dataUrl: string) => {
      inlineDataUrls.push(dataUrl);
      return "";
    })
    .trim();

  try {
    const parsed: unknown = JSON.parse(stripped);
    if (!isRecord(parsed)) {
      return { type: "raw", text: result };
    }
    if (typeof parsed.error === "string") {
      return { type: "error", message: parsed.error };
    }

    const images: GeneratedImage[] = [];
    const remoteUrls: string[] = [];

    if (Array.isArray(parsed.content)) {
      let inlineIndex = 0;
      for (const block of parsed.content) {
        if (
          isRecord(block) &&
          block.type === "image" &&
          typeof block.mimeType === "string"
        ) {
          const data = typeof block.data === "string" ? block.data : "";
          // 存储时真实 base64 被替换为占位符，这里用标签中的 data URL 还原
          let resolvedData = data;
          if (
            (data === "" || data === "[attached as multimodal image]") &&
            inlineIndex < inlineDataUrls.length
          ) {
            const dataUrl = inlineDataUrls[inlineIndex];
            const comma = dataUrl.indexOf(",");
            if (comma > 0) {
              resolvedData = dataUrl.slice(comma + 1);
            }
          }
          inlineIndex += 1;
          if (
            typeof block.path === "string" &&
            block.path.trim() !== "" &&
            resolvedData === ""
          ) {
            // 图库落盘引用（image/...）：渲染时经 IPC 读取文件
            images.push({
              data: "",
              mimeType: block.mimeType as string,
              path: block.path.trim(),
            });
          } else {
            images.push({
              data: resolvedData,
              mimeType: block.mimeType as string,
            });
          }
        }
      }
    }

    if (Array.isArray(parsed.remoteUrls)) {
      for (const url of parsed.remoteUrls) {
        if (typeof url === "string" && url.trim() !== "") {
          remoteUrls.push(url);
        }
      }
    }

    if (images.length === 0 && remoteUrls.length === 0) {
      return { type: "raw", text: result };
    }

    return {
      type: "success",
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      imageCount:
        typeof parsed.imageCount === "number"
          ? parsed.imageCount
          : images.length + remoteUrls.length,
      images,
      remoteUrls,
      contentPreview:
        typeof parsed.contentPreview === "string" ? parsed.contentPreview : "",
    };
  } catch {
    return { type: "raw", text: result };
  }
};

const truncateLabel = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

const mimeToExtension = (mimeType: string): string => {
  if (mimeType.includes("jpeg")) return "png";
  if (mimeType.includes("webp")) return "webp";
  return "png";
};

/** 宽高比超过该阈值视为超宽（通栏展示），低于该阈值视为超窄（限高展示） */
const IMG_WIDE_RATIO = 1.6;
const IMG_TALL_RATIO = 0.7;

/**
 * 并行图片分档列数：让每张图尽量大且尾行不孤。
 * 2-4 张：数量即列数（一行占满）；5-6 张：3 列两行（3+2/3+3）；
 * 7-8 张：4 列两行（4+3/4+4）。
 */
const columnsForCount = (count: number): number => {
  if (count <= 4) return count;
  if (count <= 6) return 3;
  return 4;
};

/**
 * upload 相对路径 → data URL 的进程内缓存。
 * path 引用（纯文本主模型场景的 [Reference image #N ...] 块）需要经主进程
 * 读取文件，同一图片在历史消息中会反复渲染，缓存避免重复 IPC。
 */
const uploadImageCache = new Map<string, string>();

/** 将 data URL 直接解码为 Blob。不走 fetch(dataUrl) —— CSP connect-src
 *  不允许 data:，fetch 会被拦截导致保存静默失败（点击无反应）。 */
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

/** 保存生成的图片（原生文件选择器优先，回退为浏览器下载）。 */
const saveImageBlob = async (
  dataUrl: string,
  filename: string
): Promise<void> => {
  const blob = dataUrlToBlob(dataUrl);

  const picker = (
    window as unknown as {
      showSaveFilePicker?: (opts: {
        suggestedName?: string;
        types: { description?: string; accept: Record<string, string[]> }[];
      }) => Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;

  if (typeof picker === "function") {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [
          {
            description: "Image file",
            accept: { [blob.type]: [blob.type] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch {
      // User cancelled the picker — fall through to anchor download.
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const ImageGenToolCall = ({
  toolCall,
}: ImageGenToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const [lightbox, setLightbox] = useState<GeneratedImage | null>(null);

  // 图片真实宽高比探测：index → width/height，加载完成后驱动卡片比例
  const [ratios, setRatios] = useState<Record<number, number>>({});

  const handleImageLoad = useCallback((index: number) => {
    return (event: React.SyntheticEvent<HTMLImageElement>): void => {
      const img = event.currentTarget;
      if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
        return;
      }
      const ratio = img.naturalWidth / img.naturalHeight;
      setRatios((prev) =>
        prev[index] === ratio ? prev : { ...prev, [index]: ratio }
      );
    };
  }, []);

  // 同批并行生成的图片统一展示比例：取已加载比例的中位数，避免个别图抖动
  const unifiedRatio = useMemo(() => {
    const values = Object.values(ratios).filter(
      (value) => Number.isFinite(value) && value > 0
    );
    if (values.length === 0) {
      return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }, [ratios]);

  // 极端比例适配：超宽通栏展示；超窄限高展示（容器查询按真实比例计算高度）
  const figureClassName = `tool-call-imagegen-figure${
    unifiedRatio !== null && unifiedRatio > IMG_WIDE_RATIO
      ? " tool-call-imagegen-figure-wide"
      : unifiedRatio !== null && unifiedRatio < IMG_TALL_RATIO
      ? " tool-call-imagegen-figure-tall"
      : ""
  }`;
  const figureStyle =
    unifiedRatio !== null
      ? ({ "--img-ar": unifiedRatio } as React.CSSProperties)
      : undefined;

  const parsedArgs = useMemo(
    () => parseImageGenArgs(toolCall.arguments),
    [toolCall.arguments]
  );
  const parsedResult = useMemo(
    () => parseImageGenResult(toolCall.result),
    [toolCall.result]
  );

  // 收集 path 引用参考图（无内联 data 的项），挂载后经主进程读取真实缩略图
  const referencePaths = useMemo(() => {
    const paths: string[] = [];
    for (const image of parsedArgs?.images ?? []) {
      if (!image.data && image.path && !paths.includes(image.path)) {
        paths.push(image.path);
      }
    }
    return paths;
  }, [parsedArgs]);

  const [resolvedRefs, setResolvedRefs] = useState<Record<string, string>>({});

  // 收集图库落盘引用（image/... 前缀），挂载后经 IPC 读取真实图片数据
  const libraryPaths = useMemo(() => {
    const paths: string[] = [];
    if (parsedResult.type === "success") {
      for (const image of parsedResult.images) {
        if (
          image.path &&
          image.path.startsWith("image/") &&
          !paths.includes(image.path)
        ) {
          paths.push(image.path);
        }
      }
    }
    return paths;
  }, [parsedResult]);

  const [resolvedLibrary, setResolvedLibrary] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    if (libraryPaths.length === 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const path of libraryPaths) {
        if (cancelled) {
          return;
        }
        const cached = uploadImageCache.get(path);
        if (cached) {
          next[path] = cached;
          continue;
        }
        let dataUrl: string | null = null;
        try {
          dataUrl = await window.snow.resolveLibraryImage(path);
        } catch (error) {
          console.warn(
            "[imagegen] resolveLibraryImage failed for",
            path,
            error
          );
        }
        if (cancelled) {
          return;
        }
        if (dataUrl) {
          uploadImageCache.set(path, dataUrl);
          next[path] = dataUrl;
        }
      }
      if (!cancelled && Object.keys(next).length > 0) {
        setResolvedLibrary((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryPaths]);

  useEffect(() => {
    if (referencePaths.length === 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const path of referencePaths) {
        if (cancelled) {
          return;
        }
        const cached = uploadImageCache.get(path);
        if (cached) {
          next[path] = cached;
          continue;
        }
        let dataUrl: string | null = null;
        try {
          dataUrl = await window.snow.resolveUploadImage(path);
        } catch (error) {
          // IPC 失败（如主进程未注册 handler / native 未就绪）不应中断其余
          // 参考图的解析；记录日志便于排查，当前项回退为占位展示。
          console.warn("[imagegen] resolveUploadImage failed for", path, error);
        }
        if (cancelled) {
          return;
        }
        if (dataUrl) {
          uploadImageCache.set(path, dataUrl);
          next[path] = dataUrl;
        }
      }
      if (!cancelled && Object.keys(next).length > 0) {
        setResolvedRefs((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [referencePaths]);

  const hasError = parsedResult.type === "error";
  const effectiveStatus = hasError ? "error" : toolCall.status;

  const streamingImages = toolCall.streamingImages ?? [];

  const prompt = parsedArgs?.prompt ?? "";
  const imageCount =
    parsedResult.type === "success" ? parsedResult.imageCount : 0;

  // 灯箱：挂载到 document.body，确保 fixed 定位始终相对视口，
  // 无论页面滚动到何处都保持水平 + 垂直居中。
  const lightboxSrc = lightbox
    ? lightbox.path
      ? resolvedLibrary[lightbox.path] ?? ""
      : `data:${lightbox.mimeType};base64,${lightbox.data}`
    : "";

  // 灯箱打开时若图片数据尚未解析（path 引用），立即兜底解析，
  // 避免 src 为空导致破图图标闪烁
  useEffect(() => {
    if (!lightbox?.path) {
      return;
    }
    const targetPath = lightbox.path;
    if (resolvedLibrary[targetPath]) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const dataUrl = await window.snow.resolveLibraryImage(targetPath);
        if (!cancelled && dataUrl) {
          setResolvedLibrary((prev) => ({ ...prev, [targetPath]: dataUrl }));
        }
      } catch (error) {
        console.warn(
          "[imagegen] resolveLibraryImage failed for lightbox",
          targetPath,
          error
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lightbox?.path, resolvedLibrary]);

  // Esc 关闭灯箱
  useEffect(() => {
    if (!lightbox) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLightbox(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightbox]);

  const lightboxElement = lightbox
    ? createPortal(
        <div
          className="tool-call-imagegen-lightbox"
          onClick={() => setLightbox(null)}
          role="presentation"
        >
          {lightboxSrc ? (
            <img
              src={lightboxSrc}
              alt={t("toolCall.imagegen.generatedImage")}
              draggable={false}
              onClick={(event) => event.stopPropagation()}
            />
          ) : (
            <div
              className="tool-call-imagegen-lightbox-loading"
              role="status"
            >
              <Loader2
                className="tool-call-icon-spinning"
                size={28}
                aria-hidden="true"
              />
              <span>{t("common.loading")}</span>
            </div>
          )}
          <div
            className="tool-call-imagegen-lightbox-toolbar"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="tool-call-imagegen-download"
              onClick={() => {
                void (async () => {
                  let src = lightboxSrc;
                  if (!src && lightbox.path) {
                    src =
                      (await window.snow.resolveLibraryImage(lightbox.path)) ??
                      "";
                  }
                  if (src) {
                    await saveImageBlob(
                      src,
                      `generated-image.${mimeToExtension(lightbox.mimeType)}`
                    );
                  }
                })().catch((error) => {
                  console.error("[imagegen] save image failed:", error);
                });
              }}
              title={t("toolCall.imagegen.download")}
              aria-label={t("toolCall.imagegen.download")}
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
    : null;

  // 成功且有图片：直接以相框画廊展示，不再渲染工具卡片头部
  if (parsedResult.type === "success" && parsedResult.images.length > 0) {
    const resultImageCount = parsedResult.images.length;
    // 并行生成的多张图共享同一宽度：按数量分档列数（见 columnsForCount），
    // 整批作为一个图块占满消息可用宽度，而非每张图独立小列
    const gridStyle =
      resultImageCount > 1
        ? ({
            gridTemplateColumns: `repeat(${columnsForCount(
              resultImageCount
            )}, minmax(0, 1fr))`,
          } as React.CSSProperties)
        : undefined;
    return (
      <div className="tool-call-imagegen tool-call-imagegen-result">
        <div
          className={`tool-call-imagegen-grid${
            resultImageCount === 1 ? " tool-call-imagegen-grid-single" : ""
          }`}
          style={gridStyle}
        >
          {parsedResult.images.map((image, index) => (
            <figure
              key={`${index}-${image.data.length}`}
              className={figureClassName}
              style={figureStyle}
            >
              <button
                type="button"
                className="tool-call-imagegen-thumb"
                onClick={() => setLightbox(image)}
                title={t("toolCall.imagegen.zoom")}
                aria-label={t("toolCall.imagegen.zoom")}
              >
                <img
                  src={
                    image.path
                      ? resolvedLibrary[image.path] ?? ""
                      : `data:${image.mimeType};base64,${image.data}`
                  }
                  alt={`${t("toolCall.imagegen.generatedImage")} ${index + 1}`}
                  onLoad={handleImageLoad(index)}
                />
                {resultImageCount > 1 ? (
                  <span className="tool-call-imagegen-badge">{index + 1}</span>
                ) : null}
              </button>
            </figure>
          ))}
        </div>

        {parsedResult.remoteUrls.length > 0 ? (
          <div className="tool-call-imagegen-remote">
            <span className="tool-call-imagegen-remote-label">
              <Link2 size={10} aria-hidden="true" />
              {t("toolCall.imagegen.remoteUrls")}
            </span>
            {parsedResult.remoteUrls.map((url, index) => (
              <a
                key={url}
                className="tool-call-imagegen-remote-link"
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                {truncateLabel(url, 80)}
                {index + 1 < parsedResult.remoteUrls.length ? " · " : ""}
              </a>
            ))}
          </div>
        ) : null}

        {lightboxElement}
      </div>
    );
  }

  // 生成中（等待/执行/流式预览）：同样以纯相框画廊展示
  const isGenerating =
    !hasError &&
    (toolCall.status === "pending" || toolCall.status === "running");
  if (isGenerating && parsedResult.type !== "success") {
    const latestStream =
      streamingImages.length > 0
        ? streamingImages[streamingImages.length - 1]
        : null;
    return (
      <div className="tool-call-imagegen tool-call-imagegen-result">
        <div className="tool-call-imagegen-grid tool-call-imagegen-grid-single">
          <figure className={figureClassName} style={figureStyle}>
            <div className="tool-call-imagegen-thumb tool-call-imagegen-thumb-static">
              {latestStream ? (
                <img
                  src={`data:${latestStream.mimeType};base64,${latestStream.data}`}
                  alt={t("toolCall.imagegen.streamingPreview")}
                  onLoad={handleImageLoad(0)}
                />
              ) : (
                <div className="tool-call-imagegen-placeholder">
                  <Loader2
                    className="tool-call-icon-spinning"
                    size={22}
                    aria-hidden="true"
                  />
                  <span>
                    {toolCall.status === "running"
                      ? t("toolCall.imagegen.generating")
                      : t("toolCall.imagegen.waiting")}
                  </span>
                </div>
              )}
            </div>
            <figcaption className="tool-call-imagegen-figure-caption">
              <span className="tool-call-imagegen-figure-index">
                {streamingImages.length > 0 ? streamingImages.length : "…"}
              </span>
              <span className="tool-call-imagegen-figure-label">
                {latestStream
                  ? t("toolCall.imagegen.streamingPreview")
                  : toolCall.status === "running"
                  ? t("toolCall.imagegen.generating")
                  : t("toolCall.imagegen.waiting")}
              </span>
              <span aria-hidden="true" />
            </figcaption>
          </figure>
        </div>
      </div>
    );
  }

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={t("toolCall.imagegen.name")}
      category="image"
      displayName={prompt ? truncateLabel(prompt, 60) : undefined}
      displayNameTitle={prompt || undefined}
      status={effectiveStatus}
      meta={
        parsedResult.type === "success" ? (
          <span className="tool-call-imagegen-count">
            <ImageIcon size={10} aria-hidden="true" />
            {t("toolCall.imagegen.count", {
              values: { count: imageCount },
            })}
          </span>
        ) : null
      }
      className="tool-call-imagegen"
    >
      <div className="tool-call-body tool-call-imagegen-body">
        {/* 生图参数 */}
        {parsedArgs ? (
          <div className="tool-call-imagegen-params">
            <div className="tool-call-imagegen-param-item">
              <Sparkles size={11} aria-hidden="true" />
              <span className="tool-call-imagegen-param-label">
                {t("toolCall.imagegen.prompt")}
              </span>
              <code className="tool-call-imagegen-param-value">
                {parsedArgs.prompt}
              </code>
            </div>

            {parsedArgs.model ||
            parsedArgs.size ||
            parsedArgs.quality ||
            parsedArgs.outputCompression !== undefined ||
            parsedArgs.n !== undefined ||
            parsedArgs.provider ||
            parsedArgs.personGeneration ||
            parsedArgs.webSearch === true ||
            parsedArgs.stream === true ||
            parsedArgs.inputFidelity ||
            parsedArgs.background ||
            parsedArgs.moderation ||
            parsedArgs.seed !== undefined ||
            parsedArgs.thinkingLevel ||
            parsedArgs.imageSearch === true ? (
              <div className="tool-call-imagegen-param-tags">
                {parsedArgs.provider ? (
                  <span className="tool-call-imagegen-param-tag">
                    {t("toolCall.imagegen.provider")}: {parsedArgs.provider}
                  </span>
                ) : null}
                {parsedArgs.model ? (
                  <span className="tool-call-imagegen-param-tag">
                    {t("toolCall.imagegen.model")}: {parsedArgs.model}
                  </span>
                ) : null}
                {parsedArgs.size ? (
                  <span className="tool-call-imagegen-param-tag">
                    {t("toolCall.imagegen.size")}: {parsedArgs.size}
                  </span>
                ) : null}
                {parsedArgs.quality ? (
                  <span className="tool-call-imagegen-param-tag">
                    {t("toolCall.imagegen.quality")}: {parsedArgs.quality}
                  </span>
                ) : null}
                {parsedArgs.outputCompression !== undefined ? (
                  <span className="tool-call-imagegen-param-tag">
                    {t("toolCall.imagegen.outputCompression")}:{" "}
                    {parsedArgs.outputCompression}%
                  </span>
                ) : null}
                {parsedArgs.personGeneration ? (
                  <span className="tool-call-imagegen-param-tag">
                    {t("toolCall.imagegen.personGeneration")}:{" "}
                    {parsedArgs.personGeneration}
                  </span>
                ) : null}
                {parsedArgs.webSearch === true ? (
                  <span className="tool-call-imagegen-param-tag">
                    {t("toolCall.imagegen.webSearch")}
                  </span>
                ) : null}
                {parsedArgs.stream === true ? (
                  <span className="tool-call-imagegen-param-tag">
                    {t("toolCall.imagegen.streaming")}
                  </span>
                ) : null}
                {parsedArgs.n !== undefined && parsedArgs.n > 1 ? (
                  <span className="tool-call-imagegen-param-tag">
                    {t("toolCall.imagegen.countParam", {
                      values: { count: parsedArgs.n },
                    })}
                  </span>
                ) : null}
                {parsedArgs.inputFidelity ? (
                  <span className="tool-call-imagegen-param-tag">
                    {t("toolCall.imagegen.inputFidelity")}:{" "}
                    {parsedArgs.inputFidelity}
                  </span>
                ) : null}
                {parsedArgs.background ? (
                  <span className="tool-call-imagegen-param-tag">
                    {t("toolCall.imagegen.background")}: {parsedArgs.background}
                  </span>
                ) : null}
                {parsedArgs.moderation ? (
                  <span className="tool-call-imagegen-param-tag">
                    {t("toolCall.imagegen.moderation")}: {parsedArgs.moderation}
                  </span>
                ) : null}
                {parsedArgs.seed !== undefined ? (
                  <span className="tool-call-imagegen-param-tag">
                    {t("toolCall.imagegen.seed")}: {parsedArgs.seed}
                  </span>
                ) : null}
                {parsedArgs.thinkingLevel ? (
                  <span className="tool-call-imagegen-param-tag">
                    {t("toolCall.imagegen.thinkingLevel")}:{" "}
                    {parsedArgs.thinkingLevel}
                  </span>
                ) : null}
                {parsedArgs.imageSearch === true ? (
                  <span className="tool-call-imagegen-param-tag">
                    {t("toolCall.imagegen.imageSearch")}
                  </span>
                ) : null}
              </div>
            ) : null}

            {/* 参考图（图生图） */}
            {parsedArgs?.images && parsedArgs.images.length > 0 ? (
              <div className="tool-call-imagegen-refs">
                <span className="tool-call-imagegen-refs-label">
                  <ImageIcon size={10} aria-hidden="true" />
                  {t("toolCall.imagegen.refImages", {
                    values: { count: parsedArgs.images.length },
                  })}
                </span>
                <div className="tool-call-imagegen-refs-grid">
                  {parsedArgs.images.map((image, index) => {
                    const src = image.data
                      ? `data:${image.mimeType};base64,${image.data}`
                      : image.path
                      ? resolvedRefs[image.path] ?? ""
                      : "";
                    return (
                      <div
                        key={`${index}-${image.path ?? image.data.length}`}
                        className="tool-call-imagegen-ref-thumb"
                        title={image.path ?? undefined}
                      >
                        {src ? (
                          <img
                            src={src}
                            alt={`${t("toolCall.imagegen.refImage")} ${
                              index + 1
                            }`}
                          />
                        ) : (
                          <span className="tool-call-imagegen-ref-placeholder">
                            <ImageIcon size={14} aria-hidden="true" />
                            {index + 1}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 错误 */}
        {parsedResult.type === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
          </div>
        ) : null}

        {/* 远程图片链接（兼容返回 url 的端点） */}
        {parsedResult.type === "success" &&
        parsedResult.remoteUrls.length > 0 ? (
          <div className="tool-call-imagegen-remote">
            <span className="tool-call-imagegen-remote-label">
              <Link2 size={10} aria-hidden="true" />
              {t("toolCall.imagegen.remoteUrls")}
            </span>
            {parsedResult.remoteUrls.map((url, index) => (
              <a
                key={url}
                className="tool-call-imagegen-remote-link"
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                {truncateLabel(url, 80)}
                {index + 1 < parsedResult.remoteUrls.length ? " · " : ""}
              </a>
            ))}
          </div>
        ) : null}

        {/* 原始结果兜底 */}
        {parsedResult.type === "raw" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.imagegen.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}
      </div>

      {lightboxElement}
    </ToolCallNode>
  );
};
