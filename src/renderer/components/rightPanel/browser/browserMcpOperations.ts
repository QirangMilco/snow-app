import { captureWebviewPage } from "./captureWebviewPage";
import type { BrowserMcpCommandArgs } from "./browserMcpController";

const TEXT_PREVIEW_LENGTH = 160;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

// Electron webview console-message level: 0=verbose, 1=info, 2=warning, 3=error.
const CONSOLE_LEVEL_MIN: Record<string, number> = {
  verbose: 0,
  info: 1,
  warning: 2,
  error: 3,
};

// executeJavaScript 的结果可能含循环引用/函数等无法 JSON 序列化的值，
// MCP 返回链路要求 JSON 安全，这里做兜底转换。
const toJsonSafe = (value: unknown): unknown => {
  if (value === undefined) {
    return null;
  }
  try {
    JSON.stringify(value);
    return value;
  } catch {
    try {
      return JSON.parse(
        JSON.stringify(value, (_key, item) =>
          typeof item === "function" ? undefined : item
        )
      );
    } catch {
      return String(value);
    }
  }
};

// 公共元素定位脚本：selector/text + shadowRoot 遍历 + 可见性/禁用检查 +
// scrollIntoView 居中。actionBody 在元素就绪后执行（可返回任意结果）。
// 被 click / type 复用，避免定位逻辑重复。
const buildElementLocatorScript = (
  selector: string | null,
  text: string | null,
  exact: boolean,
  actionBody: string
): string => `(async () => {
  const selector = ${JSON.stringify(selector)};
  const text = ${JSON.stringify(text)};
  const exact = ${JSON.stringify(exact)};
  const interactiveSelector = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[tabindex]:not([tabindex="-1"])',
    '[onclick]'
  ].join(',');
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const describe = (element) => normalize(
    element.innerText ||
    element.textContent ||
    element.value ||
    element.getAttribute('aria-label') ||
    element.getAttribute('title')
  );
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0;
  };
  const collectRoots = (root, roots) => {
    roots.push(root);
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) {
        collectRoots(element.shadowRoot, roots);
      }
    }
  };
  const roots = [];
  collectRoots(document, roots);
  let element = null;
  if (selector) {
    try {
      for (const root of roots) {
        const match = root.querySelector(selector);
        if (match) {
          element = match.closest(interactiveSelector) || match;
          break;
        }
      }
    } catch (error) {
      throw new Error('Invalid CSS selector: ' + selector);
    }
  }
  if (!element && text) {
    const expected = normalize(text);
    const candidates = roots.flatMap((root) =>
      Array.from(root.querySelectorAll(interactiveSelector))
    );
    const matches = candidates.filter((candidate) => {
      if (!isVisible(candidate) || candidate.matches(':disabled,[aria-disabled="true"]')) {
        return false;
      }
      const actual = describe(candidate);
      return exact ? actual === expected : actual.includes(expected);
    });
    element = matches.sort((left, right) => {
      const leftText = describe(left);
      const rightText = describe(right);
      const leftExact = leftText === expected ? 0 : 1;
      const rightExact = rightText === expected ? 0 : 1;
      return leftExact - rightExact || leftText.length - rightText.length;
    })[0] || null;
  }
  if (!element || !isVisible(element)) {
    throw new Error('Target element was not found or is not visible');
  }
  if (element.matches(':disabled,[aria-disabled="true"]')) {
    throw new Error('Target element is disabled');
  }
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  ${actionBody}
})()`;

const requiredString = (args: BrowserMcpCommandArgs, field: string): string => {
  const value = args[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
};

const requiredRawString = (
  args: BrowserMcpCommandArgs,
  field: string
): string => {
  const value = args[field];
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
};

const optionalString = (
  args: BrowserMcpCommandArgs,
  field: string
): string | undefined => {
  const value = args[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string when provided`);
  }
  return value.trim();
};

const currentPageMetadata = async (
  webview: Electron.WebviewTag,
  instanceId: string
): Promise<{ instanceId: string; url: string; title: string }> => ({
  instanceId,
  url: webview.getURL(),
  title: await webview.executeJavaScript("document.title || ''"),
});

const waitForNavigation = (
  webview: Electron.WebviewTag,
  url: string,
  timeoutMs: number
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let sawSuccessfulNavigation = false;
    const handleNavigate = (): void => {
      sawSuccessfulNavigation = true;
    };
    const handleStop = (): void => {
      cleanup();
      resolve();
    };
    const handleFail = (
      event: Event & {
        errorCode?: number;
        errorDescription?: string;
        validatedURL?: string;
        isMainFrame?: boolean;
      }
    ): void => {
      if (event.isMainFrame === false) {
        return;
      }
      if (
        event.errorCode === -3 ||
        (event.errorCode === -2 && sawSuccessfulNavigation)
      ) {
        return;
      }
      cleanup();
      reject(
        new Error(
          event.errorDescription ||
            `Failed to navigate browser to ${event.validatedURL || url}`
        )
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Browser navigation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      webview.removeEventListener(
        "did-navigate",
        handleNavigate as EventListener
      );
      webview.removeEventListener(
        "did-navigate-in-page",
        handleNavigate as EventListener
      );
      webview.removeEventListener(
        "did-stop-loading",
        handleStop as EventListener
      );
      webview.removeEventListener("did-fail-load", handleFail as EventListener);
    };

    webview.addEventListener("did-navigate", handleNavigate as EventListener);
    webview.addEventListener(
      "did-navigate-in-page",
      handleNavigate as EventListener
    );
    webview.addEventListener("did-stop-loading", handleStop as EventListener);
    webview.addEventListener("did-fail-load", handleFail as EventListener);
    Promise.resolve(webview.loadURL(url)).catch((error: unknown) => {
      const code =
        error instanceof Error
          ? (error as Error & { code?: string }).code
          : undefined;
      if (code === "ERR_ABORTED" || code === "ERR_FAILED") {
        return;
      }
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

const navigate = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs
): Promise<unknown> => {
  const url = requiredString(args, "url");
  const timeoutMs =
    typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000;
  await waitForNavigation(webview, url, timeoutMs);
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    success: true,
  };
};

const click = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs
): Promise<unknown> => {
  const selector = optionalString(args, "selector");
  const text = optionalString(args, "text");
  const exact = args.exact === true;
  const locateScript = buildElementLocatorScript(
    selector ?? null,
    text ?? null,
    exact,
    `const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
      throw new Error('Clickable element is outside the browser viewport');
    }
    return {
      x,
      y,
      element: {
        tagName: element.tagName.toLowerCase(),
        id: element.id || null,
        text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
        href: element.href || null,
      },
    };`
  );
  const target = (await webview.executeJavaScript(locateScript)) as {
    x: number;
    y: number;
    element: unknown;
  };
  const metadata = await currentPageMetadata(webview, instanceId);
  webview.focus();
  await webview.sendInputEvent({ type: "mouseMove", x: target.x, y: target.y });
  await webview.sendInputEvent({
    type: "mouseDown",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  await webview.sendInputEvent({
    type: "mouseUp",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  return {
    ...metadata,
    success: true,
    element: target.element,
  };
};

const evaluate = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs
): Promise<unknown> => {
  const expression = requiredString(args, "expression");
  let result: unknown;
  let error: string | undefined;
  try {
    result = await webview.executeJavaScript(expression);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    ...(error !== undefined ? { error } : { result: toJsonSafe(result) }),
  };
};

const type = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs
): Promise<unknown> => {
  const selector = optionalString(args, "selector");
  const text = optionalString(args, "text");
  const value = requiredRawString(args, "value");
  const submit = args.submit === true;
  const delayMs = typeof args.delayMs === "number" ? args.delayMs : 0;

  // 逐键模式：定位并聚焦元素，用真实键盘事件逐字符输入（触发表单校验）。
  if (delayMs > 0) {
    const focusScript = buildElementLocatorScript(
      selector ?? null,
      text ?? null,
      false,
      `element.focus();
      return {
        element: {
          tagName: element.tagName.toLowerCase(),
          id: element.id || null,
          text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
        },
      };`
    );
    const target = (await webview.executeJavaScript(focusScript)) as {
      element: unknown;
    };
    webview.focus();
    for (const char of value) {
      await webview.sendInputEvent({ type: "keyDown", keyCode: char });
      await webview.sendInputEvent({ type: "char", keyCode: char });
      await webview.sendInputEvent({ type: "keyUp", keyCode: char });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (submit) {
      await webview.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      await webview.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    }
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      success: true,
      mode: "keys",
      element: target.element,
    };
  }

  // 默认一次性设值：原生 setter + input/change 事件（React 受控组件兼容），
  // 与 Playwright fill 同原理。
  const fillScript = buildElementLocatorScript(
    selector ?? null,
    text ?? null,
    false,
    `const editable = element.matches(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], [contenteditable=""]'
    );
    if (!editable) {
      throw new Error('Target element is not editable (expected input, textarea, or contenteditable)');
    }
    const value = ${JSON.stringify(value)};
    if (element.matches('[contenteditable="true"], [contenteditable=""]')) {
      element.textContent = value;
    } else {
      const proto = element.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) {
        setter.call(element, value);
      } else {
        element.value = value;
      }
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    if (${JSON.stringify(submit)}) {
      const form = element.closest('form');
      if (form) {
        form.requestSubmit();
      } else {
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
    }
    element.focus();
    return {
      element: {
        tagName: element.tagName.toLowerCase(),
        id: element.id || null,
        text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
      },
    };`
  );
  const result = (await webview.executeJavaScript(fillScript)) as {
    element: unknown;
  };
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    success: true,
    mode: "fill",
    value,
    element: result.element,
  };
};

const screenshot = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs
): Promise<unknown> => {
  // Viewport-only by default: full-page captures of long pages produce
  // huge base64 payloads that inflate context and may exceed provider
  // per-image limits.
  const fullPage = args.fullPage === true;
  const dataUrl = fullPage
    ? await captureWebviewPage(webview)
    : (await webview.capturePage()).toDataURL();
  if (!dataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("Browser screenshot did not return PNG data");
  }
  const base64 = dataUrl.slice("data:image/png;base64,".length);
  const estimatedBytes = Math.floor((base64.length * 3) / 4);
  if (estimatedBytes > MAX_SCREENSHOT_BYTES) {
    throw new Error(
      `Browser screenshot is too large to return (${estimatedBytes} bytes, maximum ${MAX_SCREENSHOT_BYTES} bytes)`
    );
  }
  const metadata = await currentPageMetadata(webview, instanceId);
  return {
    ...metadata,
    fullPage,
    content: [
      {
        type: "text",
        text: `Browser screenshot captured: ${metadata.title || metadata.url}`,
      },
      {
        type: "image",
        data: base64,
        mimeType: "image/png",
      },
    ],
  };
};

const devtools = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
  consoleMessages: readonly unknown[]
): Promise<unknown> => {
  const action = typeof args.action === "string" ? args.action : "snapshot";
  if (action === "open") {
    webview.openDevTools();
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      opened: true,
    };
  }
  if (action === "console") {
    const level = typeof args.level === "string" ? args.level : undefined;
    const minLevel =
      level !== undefined ? CONSOLE_LEVEL_MIN[level] : undefined;
    const messages =
      minLevel === undefined
        ? consoleMessages
        : consoleMessages.filter((entry) => {
            const entryLevel = (entry as { level?: unknown }).level;
            return (
              typeof entryLevel === "number" && entryLevel >= minLevel
            );
          });
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      messages,
      totalMessages: messages.length,
      level: level ?? "all",
    };
  }
  if (action === "network") {
    const filter = optionalString(args, "filter");
    const limit = typeof args.limit === "number" ? args.limit : 50;
    const requests = await window.snow.browserNetworkRequests(
      webview.getWebContentsId(),
      filter,
      limit
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      requests,
      total: requests.length,
    };
  }
  if (action === "dialog") {
    const dialogResponse = args.dialogResponse;
    if (
      dialogResponse !== null &&
      typeof dialogResponse === "object" &&
      typeof (dialogResponse as { accept?: unknown }).accept === "boolean"
    ) {
      const accept = (dialogResponse as { accept: boolean }).accept;
      const promptText =
        typeof (dialogResponse as { promptText?: unknown }).promptText ===
        "string"
          ? (dialogResponse as { promptText: string }).promptText
          : undefined;
      const responded = await window.snow.browserDialogRespond(
        webview.getWebContentsId(),
        accept,
        promptText
      );
      return {
        ...(await currentPageMetadata(webview, instanceId)),
        responded,
      };
    }
    const dialogs = await window.snow.browserDialogs(
      webview.getWebContentsId()
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      dialogs,
      pending: dialogs.length,
    };
  }

  const maxContentLength =
    typeof args.maxContentLength === "number" ? args.maxContentLength : 20_000;
  const snapshot = await webview.executeJavaScript(`(() => {
    const text = String(document.body?.innerText || '').slice(0, ${maxContentLength});
    return {
      url: location.href,
      title: document.title || '',
      readyState: document.readyState,
      contentType: document.contentType,
      characterSet: document.characterSet,
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      },
      text,
      links: Array.from(document.links).slice(0, 100).map((link) => ({
        text: String(link.innerText || link.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
        href: link.href,
      })),
    };
  })()`);
  return {
    instanceId,
    snapshot,
  };
};

export const executeBrowserMcpOperation = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  operation: string,
  args: BrowserMcpCommandArgs,
  consoleMessages: readonly unknown[]
): Promise<unknown> => {
  switch (operation) {
    case "navigate":
      return navigate(webview, instanceId, args);
    case "click":
      return click(webview, instanceId, args);
    case "evaluate":
      return evaluate(webview, instanceId, args);
    case "type":
      return type(webview, instanceId, args);
    case "screenshot":
      return screenshot(webview, instanceId, args);
    case "devtools":
      return devtools(webview, instanceId, args, consoleMessages);
    default:
      throw new Error(`Unsupported browser operation: ${operation}`);
  }
};
