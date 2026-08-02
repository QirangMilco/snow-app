import { join } from "node:path";

export const isMacOS = process.platform === "darwin";
export const isWindows = process.platform === "win32";
export const macTrafficLightPosition = { x: 18, y: 28 };
export const APP_ICON_PATH = join(__dirname, "../../resources/icon.png");

// 托盘图标用的小尺寸源图：16px（100% DPI）与 32px（200% DPI @2x 表示），
// 直接使用设计好的 favicon，避免从大图缩放导致的模糊。
export const APP_FAVICON_16_PATH = join(
  __dirname,
  "../../resources/web/favicon-16.png"
);
export const APP_FAVICON_32_PATH = join(
  __dirname,
  "../../resources/web/favicon-32.png"
);

/**
 * Windows 应用用户模型 ID (AppUserModelID)。
 *
 * 该 ID 必须与 electron-builder 配置中的 `appId` 一致，否则 Windows 通知中心
 * 会使用默认的 `electron.app.<productName>` 形式（导致显示成 "electron.app.Snow App"），
 * 同时通知无法正确归类到应用、开始菜单快捷方式也会丢失应用名。
 *
 * 在 app.whenReady() 之前或之后调用 `app.setAppUserModelId()` 都可以生效，
 * 这里作为常量统一维护，避免与 package.json 中的 build.appId 漂移。
 */
export const APP_USER_MODEL_ID = "com.snow.app";
