import { useCallback, useEffect, useState } from "react";
import {
  BROWSER_HOMEPAGE_SETTING_CODE,
  BROWSER_HOMEPAGE_SETTING_NAME,
  DEFAULT_BROWSER_HOMEPAGE,
  normalizeBrowserHomepage,
  readBrowserHomepageJson,
} from "./browserHomepageConstants";

const BROWSER_HOMEPAGE_CHANGED_EVENT = "browser-homepage-changed";

// 模块级共享状态：所有浏览器实例（含用户手动新建的 tab）共用同一份
// homepage 缓存与全局事件监听。否则每个实例都会独立读库（N 个 tab =
// N 次数据库 IPC）并各自挂 window 监听，多个实例时重复浪费。
let cachedHomepage = DEFAULT_BROWSER_HOMEPAGE;
let cachedLoaded = false;
let loadStarted = false;
let globalListenerAttached = false;
const subscribers = new Set<() => void>();

const notifySubscribers = (): void => {
  for (const subscriber of subscribers) {
    subscriber();
  }
};

const loadHomepage = async (): Promise<void> => {
  try {
    const value = await window.snow.getSystemSettingValue(
      BROWSER_HOMEPAGE_SETTING_CODE
    );
    cachedHomepage = readBrowserHomepageJson(value);
  } catch {
    cachedHomepage = DEFAULT_BROWSER_HOMEPAGE;
  }
  cachedLoaded = true;
  notifySubscribers();
};

const ensureHomepageLoaded = (): void => {
  if (!loadStarted) {
    loadStarted = true;
    void loadHomepage();
  }
  if (!globalListenerAttached) {
    globalListenerAttached = true;
    window.addEventListener(BROWSER_HOMEPAGE_CHANGED_EVENT, () => {
      void loadHomepage();
    });
  }
};

/**
 * Loads the browser homepage from the system settings store and keeps
 * it in sync when settings are changed elsewhere. 状态在模块级共享：
 * 首次使用时读库并挂全局监听，后续实例直接复用缓存并订阅变更，
 * 打开多个浏览器 tab 也只有一次数据库读取和一份全局事件监听。
 */
export function useBrowserHomepage(): {
  homepage: string;
  /** True once the initial async load from the database has settled. */
  loaded: boolean;
  setHomepage: (url: string) => Promise<void>;
} {
  const [, setVersion] = useState(0);

  useEffect(() => {
    ensureHomepageLoaded();
    const subscriber = () => setVersion((version) => version + 1);
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
    };
  }, []);

  const setHomepage = useCallback(async (url: string) => {
    const normalized = normalizeBrowserHomepage(url);
    await window.snow.setSystemSetting(
      BROWSER_HOMEPAGE_SETTING_NAME,
      BROWSER_HOMEPAGE_SETTING_CODE,
      JSON.stringify(normalized)
    );
    // 立即更新共享缓存并通知所有实例，避免等全局事件回读数据库造成延迟。
    cachedHomepage = normalized;
    cachedLoaded = true;
    notifySubscribers();
    window.dispatchEvent(new Event(BROWSER_HOMEPAGE_CHANGED_EVENT));
  }, []);

  return { homepage: cachedHomepage, loaded: cachedLoaded, setHomepage };
}
