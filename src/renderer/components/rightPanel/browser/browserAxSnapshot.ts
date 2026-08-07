/**
 * 无障碍快照（AX tree）序列化与 uid 管理。
 *
 * 数据源：CDP Accessibility.getFullAXTree（引擎级无障碍树，可穿透 closed shadow DOM，
 * 与浏览器渲染一致）。本模块负责：
 * - 把 AXNode[] 序列化为 YAML 风格的缩进文本树（对齐 Playwright ariaSnapshot / CDP MCP 心智）；
 * - 为每个可回指元素（有 backendDOMNodeId）分配稳定 uid（e1, e2, ...）：
 *   同一元素跨快照 uid 不变（key = frameId + backendDOMNodeId），页面重载后重新分配；
 * - 暴露 uid → backendDOMNodeId 映射，供 browser-click / browser-type 的 ref 回指。
 *
 * 安全：默认不输出 input/textarea 的 value（可能含敏感输入），仅 verbose 时输出。
 */

export type AxNode = {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  description?: { value?: string };
  childIds?: string[];
  frameId?: string;
  backendDOMNodeId?: number;
  backendNodeId?: number;
};

export type AxSnapshotResult = {
  tree: string;
  totalNodes: number;
  emitted: number;
  truncated: boolean;
};

/** 默认保留的角色（interestingOnly）：交互元素 + 结构角色 + 有名称的文本类节点。 */
const INTERESTING_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "heading", "banner",
  "navigation", "main", "dialog", "alert", "listbox", "option", "switch",
  "slider", "table", "row", "columnheader", "rowheader", "grid", "tree",
  "img", "form", "search", "toolbar", "tablist", "menu", "menu bar", "complementary",
  "contentinfo", "region", "article", "list", "listitem", "group", "progressbar",
  "status", "timer", "text",
]);

const NAME_ONLY_ROLES = new Set(["text", "img", "heading", "link"]);

// ===== uid 分配（模块级缓存，跨快照稳定）=====

let axUidCounter = 0;
/** key: `${frameId}:${backendDOMNodeId}` → uid（同一 DOM 节点跨快照复用）。 */
const axUidByDomKey = new Map<string, string>();
/** uid → backendDOMNodeId（供 ref 回指定位元素）。 */
const axUidToBackend = new Map<string, number>();

const domKeyOf = (node: AxNode): string | null => {
  const backend = node.backendDOMNodeId ?? node.backendNodeId;
  if (typeof backend !== "number") {
    return null;
  }
  return `${node.frameId ?? "root"}:${backend}`;
};

const uidOf = (node: AxNode): string | null => {
  const key = domKeyOf(node);
  if (key === null) {
    return null;
  }
  let uid = axUidByDomKey.get(key);
  if (uid === undefined) {
    uid = `e${++axUidCounter}`;
    axUidByDomKey.set(key, uid);
    const backend = node.backendDOMNodeId ?? node.backendNodeId;
    if (typeof backend === "number") {
      axUidToBackend.set(uid, backend);
    }
  }
  return uid;
};

/** 按 ref（uid）解析 backendDOMNodeId；不存在返回 null（提示重新截图）。 */
export const resolveAxRef = (ref: string): number | null => {
  const backend = axUidToBackend.get(ref);
  return backend !== undefined ? backend : null;
};

// ===== 序列化 =====

const isInteresting = (node: AxNode, verbose: boolean): boolean => {
  if (node.ignored) {
    return false;
  }
  if (verbose) {
    return true;
  }
  const role = node.role?.value ?? "";
  if (INTERESTING_ROLES.has(role)) {
    return true;
  }
  // 无角色但有名称的节点（如自定义元素）也保留，帮助定位。
  return Boolean(node.name?.value?.trim()) && role === "";
};

const escapeText = (text: string): string => text.replace(/"/g, '\\"');

const formatNode = (
  node: AxNode,
  verbose: boolean,
  depth: number
): string | null => {
  const role = node.role?.value ?? "";
  const name = node.name?.value ?? "";
  const uid = uidOf(node);
  const parts: string[] = [];
  if (role) {
    parts.push(role);
  }
  if (name) {
    parts.push(`"${escapeText(name)}"`);
  }
  if (verbose && node.value?.value !== undefined && node.value.value !== "") {
    parts.push(`value="${escapeText(node.value.value)}"`);
  }
  if (uid) {
    parts.push(`[uid=${uid}]`);
  }
  if (parts.length === 0) {
    return null;
  }
  return `${"  ".repeat(depth)}- ${parts.join(" ")}`;
};

/**
 * 序列化 AX 树。
 * @param nodes getFullAXTree 返回的完整节点数组
 * @param options.verbose true 时保留全部节点与 value（默认只保留可交互/结构角色）
 * @param options.maxNodes 输出节点上限（默认 200），超出截断并标注
 */
export const serializeAxTree = (
  nodes: AxNode[],
  options: { verbose?: boolean; maxNodes?: number } = {}
): AxSnapshotResult => {
  const verbose = options.verbose === true;
  const maxNodes = Math.max(1, Math.floor(options.maxNodes ?? 200));

  const byId = new Map<string, AxNode>();
  for (const node of nodes) {
    byId.set(node.nodeId, node);
  }
  const childrenOf = new Map<string, string[]>();
  const referenced = new Set<string>();
  for (const node of nodes) {
    for (const childId of node.childIds ?? []) {
      const list = childrenOf.get(node.nodeId) ?? [];
      list.push(childId);
      childrenOf.set(node.nodeId, list);
      referenced.add(childId);
    }
  }
  const roots = nodes
    .filter((node) => !referenced.has(node.nodeId))
    .map((node) => node.nodeId);

  const lines: string[] = [];
  let totalNodes = 0;
  let emitted = 0;
  let truncated = false;

  const walk = (nodeId: string, depth: number): void => {
    const node = byId.get(nodeId);
    if (!node || truncated) {
      return;
    }
    if (!isInteresting(node, verbose)) {
      // 被过滤的节点仍向下递归（其子节点可能可交互）。
      for (const childId of childrenOf.get(nodeId) ?? []) {
        walk(childId, depth);
      }
      return;
    }
    totalNodes++;
    if (emitted >= maxNodes) {
      truncated = true;
      return;
    }
    const line = formatNode(node, verbose, depth);
    if (line !== null) {
      lines.push(line);
      emitted++;
    }
    for (const childId of childrenOf.get(nodeId) ?? []) {
      walk(childId, depth + 1);
    }
  };

  for (const rootId of roots) {
    walk(rootId, 0);
  }

  return { tree: lines.join("\n"), totalNodes, emitted, truncated };
};
