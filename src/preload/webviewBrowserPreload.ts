import { contextBridge, ipcRenderer } from "electron";

/**
 * 内置浏览器 webview 的密码助手 preload。
 *
 * 运行在 guest 页面上下文中（`<webview webpreferences="sandbox=no">`），
 * 提供两项能力：
 *
 * 1. 自动填充：页面出现密码输入框且为空时，向主进程查询当前 origin
 *    已保存的凭据并填入（主进程侧带 senderFrame origin 校验，恶意站点
 *    无法借此跨源读取）。
 * 2. 自动保存：监听表单 submit 与提交按钮点击，捕获用户名/密码并写入
 *    密码保险库（AES-256-GCM 加密落盘）。同一次会话中相同凭据只保存
 *    一次，避免登录失败反复覆盖；凭据变化（如修改密码）会再次保存。
 *
 * 同时通过 contextBridge 暴露 `window.snowPasswordBridge`，页面脚本可
 * 以手动触发查找/保存。
 */

const getOrigin = (): string => {
  try {
    return window.location.origin;
  } catch {
    return "";
  }
};

const isHttpOrigin = (origin: string): boolean =>
  origin.startsWith("http://") || origin.startsWith("https://");

const isVisible = (input: HTMLInputElement): boolean =>
  input.offsetParent !== null;

const findPasswordInput = (): HTMLInputElement | null => {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>("input[type=password]")
  ).filter((input) => input.ownerDocument === document);
  return inputs.find(isVisible) ?? inputs[0] ?? null;
};

const findUsernameInput = (
  passwordInput: HTMLInputElement
): HTMLInputElement | null => {
  const form = passwordInput.form;
  const candidates = form
    ? Array.from(form.querySelectorAll<HTMLInputElement>("input"))
    : Array.from(document.querySelectorAll<HTMLInputElement>("input"));
  const textInputs = candidates.filter(
    (input) =>
      input.ownerDocument === document &&
      input !== passwordInput &&
      input.type !== "password" &&
      input.type !== "hidden" &&
      input.type !== "submit" &&
      input.type !== "button" &&
      input.type !== "checkbox" &&
      input.type !== "radio" &&
      !input.disabled &&
      !input.readOnly &&
      isVisible(input)
  );
  // 优先 name/id/autocomplete 含 user/email/login/account 语义的输入框。
  const named = textInputs.find((input) =>
    /(user|email|login|account)/i.test(
      `${input.name} ${input.id} ${input.autocomplete || ""}`
    )
  );
  return named ?? textInputs[0] ?? null;
};

const tryAutofill = async (): Promise<void> => {
  const origin = getOrigin();
  if (!isHttpOrigin(origin)) {
    return;
  }
  const passwordInput = findPasswordInput();
  if (
    !passwordInput ||
    passwordInput.value ||
    passwordInput.dataset.snowFilled === "1"
  ) {
    return;
  }
  let credentials: { username: string; password: string } | null = null;
  try {
    credentials = (await ipcRenderer.invoke("browser-passwords:find", {
      origin,
    })) as { username: string; password: string } | null;
  } catch {
    return;
  }
  if (!credentials || !credentials.password) {
    return;
  }
  const usernameInput = findUsernameInput(passwordInput);
  if (usernameInput && !usernameInput.value) {
    usernameInput.value = credentials.username;
    usernameInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
  passwordInput.value = credentials.password;
  passwordInput.dataset.snowFilled = "1";
  passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
  passwordInput.dispatchEvent(new Event("change", { bubbles: true }));
};

/** 已提交过的凭据（origin + username + password），避免重复写入。 */
let lastSubmitted = "";

const trySave = async (passwordInput: HTMLInputElement): Promise<void> => {
  const origin = getOrigin();
  if (!isHttpOrigin(origin) || passwordInput.ownerDocument !== document) {
    return;
  }
  const password = passwordInput.value;
  if (!password) {
    return;
  }
  const usernameInput = findUsernameInput(passwordInput);
  const username = usernameInput?.value ?? "";
  const fingerprint = `${origin}\u0000${username}\u0000${password}`;
  if (fingerprint === lastSubmitted) {
    return;
  }
  lastSubmitted = fingerprint;
  try {
    await ipcRenderer.invoke("browser-passwords:save", {
      origin,
      username,
      password,
    });
  } catch {
    // 保存失败（origin 校验拒绝/保险库不可用）静默忽略，不影响浏览。
  }
};

const setup = (): void => {
  // 表单 submit（捕获阶段，兼容 iframe 冒泡的过滤）。
  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target as HTMLFormElement;
      const passwordInput = form.querySelector<HTMLInputElement>(
        "input[type=password]"
      );
      if (passwordInput) {
        void trySave(passwordInput);
      }
    },
    true
  );

  // 无 <form> 的站点：点击提交按钮时兜底捕获。
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target as HTMLElement;
      const button = target.closest<
        HTMLButtonElement | HTMLInputElement
      >("button[type=submit], input[type=submit], button:not([type])");
      if (!button) {
        return;
      }
      const form = button.closest("form");
      const passwordInput = form
        ? form.querySelector<HTMLInputElement>("input[type=password]")
        : document.querySelector<HTMLInputElement>("input[type=password]");
      if (passwordInput) {
        void trySave(passwordInput);
      }
    },
    true
  );

  // 自动填充：DOM 就绪后执行一次。
  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => void tryAutofill(),
      { once: true }
    );
  } else {
    void tryAutofill();
  }

  // 站点用 JS 延迟渲染登录表单时轮询补填（约 8 秒内）。
  let attempts = 0;
  const poll = window.setInterval(() => {
    attempts += 1;
    if (attempts > 10) {
      window.clearInterval(poll);
      return;
    }
    const passwordInput = findPasswordInput();
    if (
      passwordInput &&
      !passwordInput.value &&
      passwordInput.dataset.snowFilled !== "1"
    ) {
      void tryAutofill();
    }
  }, 800);
};

contextBridge.exposeInMainWorld("snowPasswordBridge", {
  /** 查询当前页面 origin 已保存的凭据（供页面脚本手动触发填充）。 */
  find: (): Promise<{ username: string; password: string } | null> =>
    ipcRenderer.invoke("browser-passwords:find", {
      origin: getOrigin(),
    }),
  /** 保存凭据（供页面脚本自定义逻辑调用）。 */
  save: (payload: {
    origin: string;
    username: string;
    password: string;
  }): Promise<{ id: string; updated: boolean }> =>
    ipcRenderer.invoke("browser-passwords:save", payload),
});

setup();
