/**
 * Markdown 图片代理自定义协议工具。
 *
 * 主进程通过 protocol.handle 注册 img-proxy:// 协议：
 *  - `img-proxy://localhost/<encodeURIComponent(http(s) URL)>` 代理外部图片
 *  - `img-proxy://local/<encodeURIComponent(相对路径)>` 读取本地图片
 *    （image/ 图库路径或 upload/ 上传路径），由主进程定位根目录后返回文件
 * 渲染进程通过 imageProxyUrl / localImageProxyUrl 构造代理 URL。
 *
 * 这个文件是纯函数，不依赖 electron 模块，主进程和渲染进程（含 Web Worker）均可导入。
 *
 * 存在动机：CSP 的 img-src 不允许 http:/https:，外部图片会被拒绝加载。
 * 通过自定义协议代理，CSP 只需放行 img-proxy: 即可；本地相对路径在渲染进程
 * 也没有静态映射，统一走协议后主进程直接读磁盘，无需 IPC + data URL 中转。
 */

export const IMG_PROXY_SCHEME = "img-proxy";

/** 外部图片代理的 host（区分本地文件分支）。 */
export const IMG_PROXY_REMOTE_HOST = "localhost";
/** 本地图片代理的 host。 */
export const IMG_PROXY_LOCAL_HOST = "local";

/** 仅允许代理 http/https URL，禁止 file:、data: 等被构造成代理地址。 */
const HTTP_OR_HTTPS = /^https?:\/\//i;

/**
 * 将外部 http(s) 图片 URL 转换为 img-proxy:// 代理 URL。
 * 非法 scheme 原样返回，避免误代理本地资源或已有 data: URL。
 */
export const imageProxyUrl = (originalUrl: string): string => {
  if (!HTTP_OR_HTTPS.test(originalUrl)) {
    return originalUrl;
  }
  return `${IMG_PROXY_SCHEME}://${IMG_PROXY_REMOTE_HOST}/${encodeURIComponent(
    originalUrl
  )}`;
};

/**
 * 将本地图片相对路径（image/... 或 upload/...）转换为 img-proxy:// 代理 URL。
 * 非本地路径原样返回。
 */
export const localImageProxyUrl = (relativePath: string): string => {
  if (!relativePath || !/^(image|upload)\//.test(relativePath)) {
    return relativePath;
  }
  return `${IMG_PROXY_SCHEME}://${IMG_PROXY_LOCAL_HOST}/${encodeURIComponent(
    relativePath
  )}`;
};

/**
 * 解码 img-proxy:// URL，还原出原始外部图片 URL。
 * 主进程协议处理器使用。
 */
export const decodeImageProxyUrl = (proxyUrl: string): string => {
  const url = new URL(proxyUrl);
  const encoded = url.pathname.replace(/^\//, "");
  return decodeURIComponent(encoded);
};

/**
 * 判断 img-proxy:// URL 是否指向本地文件（host 为 local）。
 * 主进程协议处理器据此分流到本地读盘分支。
 */
export const isLocalImageProxyUrl = (proxyUrl: string): boolean => {
  try {
    return new URL(proxyUrl).hostname === IMG_PROXY_LOCAL_HOST;
  } catch {
    return false;
  }
};
