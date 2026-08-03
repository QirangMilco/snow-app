import { session } from "electron";
import type { NativeBridge } from "../native/types";
import { snowLog } from "../../utils/snowLogger";
import {
  DEFAULT_PROXY_HOST,
  sanitizeProxyHost,
} from "../settings/proxyBrowserSettings";

const PROXY_BROWSER_SETTING_CODE = "proxy_browser_settings";

// electron-updater 内部使用独立的 "electron-updater" 分区会话发起请求
// （见 electron-updater 的 electronHttpExecutor.ts），defaultSession 的
// 代理设置对它不生效，因此需要把代理同步到这个分区会话。
const UPDATER_SESSION_PARTITION = "electron-updater";

type ProxySettingsJson = {
  enabled?: boolean;
  host?: string;
  port?: number;
};

const applyProxyToSession = async (
  target: Electron.Session,
  enabled: boolean,
  host: string,
  port: number
): Promise<void> => {
  if (enabled) {
    const proxyUrl = `http://${host}:${port}`;
    await target.setProxy({ proxyRules: proxyUrl });
    snowLog.info({
      module: "app/sessionProxy",
      func: "applyProxyToSession",
      message: `Session proxy applied: ${proxyUrl}`,
    });
  } else {
    // 未启用内置代理时跟随操作系统代理设置
    await target.setProxy({ mode: "system" });
    snowLog.info({
      module: "app/sessionProxy",
      func: "applyProxyToSession",
      message: "Session proxy set to system mode",
    });
  }
};

/**
 * 从数据库读取代理配置并应用到 Electron 会话。
 *
 * 同时覆盖 defaultSession（net.fetch / webview / macUpdater 下载）与
 * electron-updater 使用的独立分区会话，确保更新检查与更新文件下载
 * 都跟随配置的代理，与 Rust 后端的 reqwest 代理行为保持一致。
 */
export const applySessionProxy = async (
  native: NativeBridge
): Promise<void> => {
  try {
    const raw = await native.getSystemSettingValue(PROXY_BROWSER_SETTING_CODE);

    let enabled = false;
    let host = DEFAULT_PROXY_HOST;
    let port = 7890;

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ProxySettingsJson;
        enabled = parsed.enabled === true;
        host = sanitizeProxyHost(parsed.host);
        port =
          typeof parsed.port === "number" &&
          parsed.port >= 1 &&
          parsed.port <= 65535
            ? parsed.port
            : 7890;
      } catch {
        // JSON 解析失败，使用默认值（直连）
      }
    }

    await applyProxyToSession(session.defaultSession, enabled, host, port);
    await applyProxyToSession(
      session.fromPartition(UPDATER_SESSION_PARTITION, { cache: false }),
      enabled,
      host,
      port
    );
  } catch (error) {
    snowLog.error({
      module: "app/sessionProxy",
      func: "applySessionProxy",
      message: "Failed to apply session proxy",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
