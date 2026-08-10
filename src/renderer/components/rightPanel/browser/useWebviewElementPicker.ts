import { useCallback, useRef, useState } from "react";
import {
  INSERT_ELEMENT_TAG_EVENT,
  type ElementTag,
} from "../../mainContent/chatInput/fileTagUtils";

export type PickedElement = {
  /** 元素所在页面 URL */
  url: string;
  /** 元素标签名（小写，如 button） */
  tag: string;
  /** 元素选择器描述（如 button#search） */
  label: string;
  /** 元素文本内容摘要 */
  text: string;
  /** 元素在 guest 视口内的矩形（CSS 像素） */
  rect: { x: number; y: number; width: number; height: number };
  /** 元素关键计算样式快照（属性名 -> 计算值），用于样式编辑 */
  style: Record<string, string>;
  /** 用于样式应用时元素引用失效后的兜底重查选择器 */
  selector: string;
};

/**
 * 注入到 webview guest 页面的元素选择脚本。
 *
 * 以 Promise 形式运行：监听鼠标移动高亮悬停元素、点击选中元素（返回其
 * 描述与视口矩形）、Escape 取消（resolve null）。点击使用捕获阶段并
 * preventDefault/stopPropagation，避免选中链接时触发页面跳转。
 *
 * 选择期间通过注入的 !important 样式把整页光标强制为醒目的自定义鼠标指针
 * （白色描边箭头 + 十字准星方框），因此光标不随页面自身的悬停样式变化。
 */
const ELEMENT_PICKER_SCRIPT = `(() => {
  window.__snowElementPickerActive = true;
  // 清除上一次选择残留的高亮框与元素引用（若有）。
  window.__snowClearPickerOverlay && window.__snowClearPickerOverlay();
  delete window.__snowPickedElement;
  delete window.__snowPickedOriginalStyle;
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-snow-element-picker", "overlay");
    overlay.style.cssText =
      "position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:2px solid #1a73e8;background:rgba(26,115,232,0.12);display:none;";
    document.documentElement.appendChild(overlay);

    // 醒目的自定义鼠标指针：白色描边箭头 + 十字准星方框，任何背景下都清晰可见。
    // 热点位于箭头尖端 (7,3)。通过注入 !important 规则强制所有元素使用该光标，
    // 选择器状态下光标不随页面自身的悬停样式（如链接的 pointer）变化。
    const CURSOR_SVG =
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none">' +
      '<path d="M7 2 L7 21 L11.8 18.2 L14.5 25.5 L17.7 24.3 L15.2 17.6 L21 17.6 Z" fill="#ffffff" stroke="#111827" stroke-width="1.8"/>' +
      '<rect x="17" y="3" width="12" height="12" rx="1" fill="#ffffff" stroke="#111827" stroke-width="2"/>' +
      '<path d="M23 3 V15 M17 9 H29" stroke="#111827" stroke-width="1.6"/>' +
      "</svg>";
    const CURSOR_URL =
      "url('data:image/svg+xml," +
      encodeURIComponent(CURSOR_SVG) +
      "') 7 3, default";
    const cursorStyle = document.createElement("style");
    cursorStyle.id = "snow-element-picker-cursor";
    cursorStyle.textContent =
      "html[data-snow-picker-active] *,html[data-snow-picker-active]{cursor:" +
      CURSOR_URL +
      " !important}";
    document.documentElement.appendChild(cursorStyle);
    document.documentElement.setAttribute("data-snow-picker-active", "true");

    // 供宿主在弹窗关闭/确认后清除高亮框；导航后随页面自动销毁。
    window.__snowClearPickerOverlay = function () {
      var el = document.querySelector("[data-snow-element-picker]");
      if (el) el.remove();
    };

    let current = null;

    const isActive = () => window.__snowElementPickerActive !== false;

    const describe = (el) => {
      let label = el.tagName.toLowerCase();
      if (el.id) {
        label += "#" + el.id;
      } else {
        const classes = Array.prototype.slice
          .call(el.classList || [])
          .slice(0, 3)
          .join(".");
        if (classes) {
          label += "." + classes;
        }
      }
      const rect = el.getBoundingClientRect();
      const text = (el.textContent || "")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, 200);
      // 收集关键计算样式快照，供弹窗中的样式编辑器使用。
      // 注意：border / padding / margin / border-radius 是 shorthand 属性，
      // getComputedStyle 对 shorthand 返回空串，必须用 longhand 逐边拼接。
      const computed = window.getComputedStyle(el);
      const style = {};

      // 四值相同则简写为单值，否则输出 "上 右 下 左" 展开形式。
      const joinFour = (top, right, bottom, left) => {
        if (top === right && top === bottom && top === left) return top;
        return top + " " + right + " " + bottom + " " + left;
      };

      // 边框：取四边 width/style/color 拼接（如 "1px solid rgb(0, 0, 0)"），
      // 仅当四边样式一致时才有意义，否则给出 top 边简写。
      const btW = computed.getPropertyValue("border-top-width");
      const btS = computed.getPropertyValue("border-top-style");
      const btC = computed.getPropertyValue("border-top-color");
      if (btS && btS !== "none") {
        style.border = (btW + " " + btS + " " + btC).trim();
      }

      const pad = joinFour(
        computed.getPropertyValue("padding-top"),
        computed.getPropertyValue("padding-right"),
        computed.getPropertyValue("padding-bottom"),
        computed.getPropertyValue("padding-left")
      );
      if (pad) style.padding = pad;

      const margin = joinFour(
        computed.getPropertyValue("margin-top"),
        computed.getPropertyValue("margin-right"),
        computed.getPropertyValue("margin-bottom"),
        computed.getPropertyValue("margin-left")
      );
      if (margin) style.margin = margin;

      const radius = joinFour(
        computed.getPropertyValue("border-top-left-radius"),
        computed.getPropertyValue("border-top-right-radius"),
        computed.getPropertyValue("border-bottom-right-radius"),
        computed.getPropertyValue("border-bottom-left-radius")
      );
      if (radius && radius !== "0px") style.borderRadius = radius;

      // 透明背景/前景（rgba(x,x,x,0) 或 transparent）不收录，
      // 避免编辑器选色板把透明误显示为黑色。
      const isTransparent = (v) =>
        v === "transparent" || /^rgba?\([^)]*,\s*0(?:\.0+)?\)$/.test(v);
      const color = computed.getPropertyValue("color");
      const bg = computed.getPropertyValue("background-color");
      if (color && !isTransparent(color)) style.color = color;
      if (bg && !isTransparent(bg)) style.backgroundColor = bg;

      for (const key of ["fontSize", "fontWeight", "fontFamily", "textAlign", "opacity"]) {
        const value = computed.getPropertyValue(key).trim();
        if (value) style[key] = value;
      }

      // 生成一个尽量简单的选择器，供样式应用时在元素引用失效后兜底重查。
      let selector = el.tagName.toLowerCase();
      if (el.id) {
        selector += "#" + CSS.escape(el.id);
      } else if (el.classList && el.classList.length > 0) {
        selector += "." + Array.prototype.slice
          .call(el.classList)
          .slice(0, 3)
          .map((c) => CSS.escape(c))
          .join(".");
      }
      return {
        tag: el.tagName.toLowerCase(),
        label,
        text,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        style,
        selector,
      };
    };

    const cleanup = (result, keepOverlay) => {
      document.documentElement.removeAttribute("data-snow-picker-active");
      cursorStyle.remove();
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      if (!keepOverlay) {
        window.__snowClearPickerOverlay();
      }
      resolve(result);
    };

    const onMove = (event) => {
      if (!isActive()) {
        cleanup(null);
        return;
      }
      const el = document.elementFromPoint(event.clientX, event.clientY);
      if (!el || el === current || el.closest("[data-snow-element-picker]")) {
        return;
      }
      current = el;
      const rect = el.getBoundingClientRect();
      overlay.style.display = "block";
      overlay.style.left = rect.left + "px";
      overlay.style.top = rect.top + "px";
      overlay.style.width = rect.width + "px";
      overlay.style.height = rect.height + "px";
    };

    const onClick = (event) => {
      if (!isActive()) {
        cleanup(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const target =
        event.target instanceof Element ? event.target : event.target.parentElement;
      const pickedEl = target || current || document.body;
      // 保存元素引用、原始内联样式与兜底选择器：供样式编辑即时预览
      //（保留蓝色高亮框）。
      const info = describe(pickedEl);
      window.__snowPickedElement = pickedEl;
      window.__snowPickedOriginalStyle = pickedEl.getAttribute("style") || "";
      window.__snowPickedSelector = info.selector || "";
      cleanup(info, true);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup(null);
      }
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
  });
})()`;

type PickResult = {
  tag?: string;
  label?: string;
  text?: string;
  rect?: { x: number; y: number; width: number; height: number };
  style?: Record<string, string>;
  selector?: string;
} | null;

/**
 * 浏览器面板的元素选择器：
 *
 *  - 点击工具栏按钮进入/退出选择模式；
 *  - 选择模式下向 webview 注入高亮拾取脚本，用户点击页面元素后收集
 *    元素描述与视口矩形；
 *  - 确认备注后通过 INSERT_ELEMENT_TAG_EVENT 全局事件将 ElementTag
 *    派发给聊天输入框插入 element chip。
 *
 * 页面导航（did-start-loading）会中断进行中的选择，避免脚本失效后
 * 状态残留。
 */
export const useWebviewElementPicker = (
  webviewRef: React.RefObject<Electron.WebviewTag | null>
): {
  isPicking: boolean;
  picked: PickedElement | null;
  togglePicker: () => void;
  cancelPicker: () => void;
  confirmPicker: (note: string) => void;
  applyElementStyle: (styleText: string) => void;
} => {
  const [isPicking, setIsPicking] = useState(false);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const pickingRef = useRef(false);
  const pickedRef = useRef<PickedElement | null>(null);
  // 代数计数器：每次开始/取消选择自增，用于丢弃过期的 executeJavaScript 结果。
  const generationRef = useRef(0);

  /** 在 guest 页面清除选中高亮框并删除元素引用。 */
  const clearPickerOverlay = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }
    webview
      .executeJavaScript(
        "window.__snowClearPickerOverlay && window.__snowClearPickerOverlay();" +
          "delete window.__snowPickedElement; delete window.__snowPickedOriginalStyle;"
      )
      .catch(() => {
        // 页面可能已随导航销毁，忽略。
      });
  }, [webviewRef]);

  const cancelPicker = useCallback(() => {
    generationRef.current += 1;
    pickingRef.current = false;
    setIsPicking(false);
    setPicked(null);
    pickedRef.current = null;
    // 关闭 guest 页面内的选择标志，让运行中的拾取脚本主动清理并 resolve null
    //（否则叠加层高亮与十字光标会残留在页面上，直到用户再次点击页面）。
    const webview = webviewRef.current;
    if (webview) {
      webview.executeJavaScript(
        "window.__snowElementPickerActive = false;"
      ).catch(() => {
        // 页面可能已随导航销毁，忽略。
      });
    }
    // 清除选中后保留的蓝色高亮框与元素引用。
    clearPickerOverlay();
  }, [clearPickerOverlay, webviewRef]);

  /** 将用户编辑的样式声明文本即时应用到 guest 页面的选中元素上（预览）。 */
  const applyElementStyle = useCallback(
    (styleText: string) => {
      const webview = webviewRef.current;
      if (!webview) {
        return;
      }
      // 内联执行完整应用逻辑，不依赖 guest 页面上可能已失效的辅助函数：
      //  1. 元素引用失效时用保存的选择器兜底重查（React/Vue 页面重渲染后引用会脱钩）；
      //  2. 先恢复选中前的内联样式，再叠加用户样式（camelCase -> kebab-case）；
      //  3. 所有属性带 !important，保证预览效果能压过页面自身的样式规则；
      //  4. 长度类属性（font-size/padding/margin/border-radius 等）值为纯数字时
      //     自动补 px 单位——浏览器对无单位的长度值会静默忽略（不抛异常），
      //     导致用户输入 "20" 这类省略单位的写法看似"设置无效"。
      webview
        .executeJavaScript(
          `(() => {
  var LENGTH_KEYS = /^(font-size|padding|padding-top|padding-right|padding-bottom|padding-left|margin|margin-top|margin-right|margin-bottom|margin-left|border-radius|border-width|width|height|min-width|min-height|max-width|max-height|letter-spacing|text-indent|top|right|bottom|left|gap|row-gap|column-gap)$/;
  var el = window.__snowPickedElement || null;
  if (!el || !document.contains(el)) {
    try {
      el = document.querySelector(window.__snowPickedSelector || "");
    } catch (e) {
      el = null;
    }
  }
  if (!el) return;
  el.setAttribute("style", window.__snowPickedOriginalStyle || "");
  if (${JSON.stringify(styleText)}) {
    ${JSON.stringify(styleText)}.split(";").forEach(function (part) {
      var idx = part.indexOf(":");
      if (idx <= 0) return;
      var key = part.slice(0, idx).trim().replace(/[A-Z]/g, function (m) {
        return "-" + m.toLowerCase();
      });
      var value = part.slice(idx + 1).trim();
      if (key && value) {
        if (LENGTH_KEYS.test(key) && /^\\d+(\\.\\d+)?$/.test(value)) {
          value += "px";
        }
        try {
          el.style.setProperty(key, value, "important");
        } catch (e) {
          /* 忽略非法属性 */
        }
      }
    });
  }
})();`
        )
        .catch(() => {
          // 页面可能已随导航销毁，忽略。
        });
    },
    [webviewRef]
  );

  const togglePicker = useCallback(() => {
    if (pickingRef.current) {
      cancelPicker();
      return;
    }
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }
    const generation = ++generationRef.current;
    pickingRef.current = true;
    setIsPicking(true);
    setPicked(null);
    pickedRef.current = null;

    // 选择过程中页面开始导航时自动退出选择模式（注入的脚本已随页面销毁）。
    // 同时递增代数使进行中的 executeJavaScript 结果作废，避免旧页面的
    // 元素被当作新页面的选取结果。
    const handleStartLoading = (): void => {
      if (generationRef.current === generation) {
        generationRef.current += 1;
        pickingRef.current = false;
        setIsPicking(false);
        setPicked(null);
        pickedRef.current = null;
      }
    };
    webview.addEventListener("did-start-loading", handleStartLoading);
    const settle = (): void => {
      webview.removeEventListener("did-start-loading", handleStartLoading);
    };

    webview
      .executeJavaScript(ELEMENT_PICKER_SCRIPT)
      .then((result) => {
        settle();
        if (generationRef.current !== generation) {
          return;
        }
        pickingRef.current = false;
        setIsPicking(false);
        const info = result as PickResult;
        if (!info || !info.label) {
          // Escape 取消或解析失败
          return;
        }
        const rect = info.rect ?? { x: 0, y: 0, width: 0, height: 0 };
        const element: PickedElement = {
          url: webview.getURL(),
          tag: info.tag ?? "",
          label: info.label,
          text: info.text ?? "",
          rect,
          style: info.style ?? {},
          selector: info.selector ?? "",
        };
        pickedRef.current = element;
        setPicked(element);
      })
      .catch(() => {
        settle();
        if (generationRef.current !== generation) {
          return;
        }
        pickingRef.current = false;
        setIsPicking(false);
      });
  }, [cancelPicker, webviewRef]);

  const confirmPicker = useCallback(
    (note: string) => {
      const element = pickedRef.current;
      if (!element) {
        return;
      }
      const tag: ElementTag = {
        url: element.url,
        tag: element.tag,
        label: element.label,
        text: element.text,
        note: note.trim(),
      };
      window.dispatchEvent(
        new CustomEvent<ElementTag>(INSERT_ELEMENT_TAG_EVENT, { detail: tag })
      );
      pickedRef.current = null;
      setPicked(null);
      // 元素已加入输入框，清除蓝色高亮框与元素引用。
      clearPickerOverlay();
    },
    [clearPickerOverlay]
  );

  return {
    isPicking,
    picked,
    togglePicker,
    cancelPicker,
    confirmPicker,
    applyElementStyle,
  };
};
