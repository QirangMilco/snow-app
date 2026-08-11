import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useI18n } from "../../../../../i18n";

type JsonTreeViewProps = {
  /** 要展示的 JSON 数据（已 parse 的结构化值）。 */
  data: unknown;
  /** 根节点 key 标签（可选，如 "value"）。 */
  rootLabel?: string;
  /** 超过该深度的容器默认折叠（根节点深度为 0，默认 3）。 */
  defaultExpandDepth?: number;
  /** 字符串视为"长文本"的字符阈值（默认 80）。 */
  longStringThreshold?: number;
};

type JsonNodeProps = {
  value: unknown;
  label?: string;
  depth: number;
  defaultExpandDepth: number;
  longStringThreshold: number;
};

/** 数组节点专用 props（value 已收窄）。 */
type JsonArrayProps = Omit<JsonNodeProps, "value"> & { value: unknown[] };

/** 对象节点专用 props（value 已收窄）。 */
type JsonObjectProps = Omit<JsonNodeProps, "value"> & {
  value: Record<string, unknown>;
};

type JsonChildrenProps = {
  label?: string;
  depth: number;
  defaultExpandDepth: number;
  longStringThreshold: number;
  /** 折叠时展示的预览片段（如 { "a", "b", … } 或 [3 项]）。 */
  preview: string;
  openBracket: string;
  closeBracket: string;
  children: ReactNode;
};

/**
 * 将转义存储的 `\n` / `\r\n` / `\t` 还原为真实字符（仅在字符串不含真实换行时）。
 * 例如 personalization 的 role 规则全文以转义形式落盘，直接展示会挤成一行。
 */
export const decodeEscapedNewlines = (text: string): string => {
  if (text.includes("\n") || !text.includes("\\n")) {
    return text;
  }
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
};

/** key 展示：JSON.stringify 自动处理引号/反斜杠转义。 */
const KeyPart = ({ label }: { label?: string }): ReactNode =>
  label === undefined ? null : (
    <>
      <span className="json-tree-key">{JSON.stringify(label)}</span>
      <span className="json-tree-punct">:&nbsp;</span>
    </>
  );

type JsonStringProps = {
  value: string;
  threshold: number;
};

/** 字符串值：短值单行展示；长值（超阈值或含换行）折叠为摘要，点击展开全文。 */
const JsonString = ({ value, threshold }: JsonStringProps): ReactNode => {
  const { t } = useI18n();
  const text = useMemo(() => decodeEscapedNewlines(value), [value]);
  const [expanded, setExpanded] = useState(false);

  if (text.length <= threshold && !text.includes("\n")) {
    return <span className="json-tree-string">{JSON.stringify(text)}</span>;
  }
  if (expanded) {
    return (
      <span
        className="json-tree-string json-tree-string-expanded"
        title={t("toolCall.jsonTree.collapse")}
        onClick={() => setExpanded(false)}
      >
        {JSON.stringify(text)}
      </span>
    );
  }
  const preview = text.replace(/\s+/g, " ").trim().slice(0, threshold);
  return (
    <span
      className="json-tree-string json-tree-string-collapsed"
      title={t("toolCall.jsonTree.expand")}
      onClick={() => setExpanded(true)}
    >
      {JSON.stringify(`${preview}…`)}
      <span className="json-tree-string-badge">
        {t("toolCall.common.charCount", {
          values: { count: text.length.toLocaleString() },
        })}
      </span>
    </span>
  );
};

/** 对象/数组容器：可折叠行 + 子节点 + 闭合括号。 */
const JsonChildren = ({
  label,
  depth,
  defaultExpandDepth,
  longStringThreshold,
  preview,
  openBracket,
  closeBracket,
  children,
}: JsonChildrenProps): ReactNode => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(depth < defaultExpandDepth);
  const toggle = (): void => setExpanded((v) => !v);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  };
  return (
    <div className="json-tree-node">
      <div
        className="json-tree-row json-tree-row-toggle"
        role="button"
        tabIndex={0}
        title={expanded ? t("toolCall.jsonTree.collapse") : t("toolCall.jsonTree.expand")}
        onClick={toggle}
        onKeyDown={onKeyDown}
      >
        <span
          className={`json-tree-arrow${expanded ? " json-tree-arrow-open" : ""}`}
          aria-hidden="true"
        />
        <KeyPart label={label} />
        {expanded ? (
          <span className="json-tree-punct">{openBracket}</span>
        ) : (
          <span className="json-tree-punct">{preview}</span>
        )}
      </div>
      {expanded ? (
        <div className="json-tree-children">
          {children}
          <div className="json-tree-row">
            <span className="json-tree-punct">{closeBracket}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
};

/** 数组节点：数组元素不展示索引 label，直接渲染值。 */
const JsonArray = ({
  value,
  label,
  depth,
  defaultExpandDepth,
  longStringThreshold,
}: JsonArrayProps): ReactNode => {
  const { t } = useI18n();
  if (value.length === 0) {
    return (
      <div className="json-tree-row">
        <KeyPart label={label} />
        <span className="json-tree-punct">[]</span>
      </div>
    );
  }
  const count = value.length;
  return (
    <JsonChildren
      label={label}
      depth={depth}
      defaultExpandDepth={defaultExpandDepth}
      longStringThreshold={longStringThreshold}
      preview={`[${t("toolCall.jsonTree.itemCount", { values: { count } })}]`}
      openBracket="["
      closeBracket="]"
    >
      {value.map((item, index) => (
        <JsonNode
          key={index}
          value={item}
          depth={depth + 1}
          defaultExpandDepth={defaultExpandDepth}
          longStringThreshold={longStringThreshold}
        />
      ))}
    </JsonChildren>
  );
};

/** 对象节点：折叠时预览前 3 个 key。 */
const JsonObject = ({
  value,
  label,
  depth,
  defaultExpandDepth,
  longStringThreshold,
}: JsonObjectProps): ReactNode => {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return (
      <div className="json-tree-row">
        <KeyPart label={label} />
        <span className="json-tree-punct">{"{}"}</span>
      </div>
    );
  }
  const previewKeys = entries
    .slice(0, 3)
    .map(([key]) => JSON.stringify(key))
    .join(", ");
  return (
    <JsonChildren
      label={label}
      depth={depth}
      defaultExpandDepth={defaultExpandDepth}
      longStringThreshold={longStringThreshold}
      preview={`{ ${previewKeys}${entries.length > 3 ? ", …" : ""} }`}
      openBracket="{"
      closeBracket="}"
    >
      {entries.map(([key, item]) => (
        <JsonNode
          key={key}
          label={key}
          value={item}
          depth={depth + 1}
          defaultExpandDepth={defaultExpandDepth}
          longStringThreshold={longStringThreshold}
        />
      ))}
    </JsonChildren>
  );
};

/** 单个 JSON 节点：按类型分派渲染。 */
const JsonNode = ({
  value,
  label,
  depth,
  defaultExpandDepth,
  longStringThreshold,
}: JsonNodeProps): ReactNode => {
  if (value === null) {
    return (
      <div className="json-tree-row">
        <KeyPart label={label} />
        <span className="json-tree-null">null</span>
      </div>
    );
  }
  if (typeof value === "boolean") {
    return (
      <div className="json-tree-row">
        <KeyPart label={label} />
        <span className="json-tree-bool">{String(value)}</span>
      </div>
    );
  }
  if (typeof value === "number") {
    return (
      <div className="json-tree-row">
        <KeyPart label={label} />
        <span className="json-tree-number">{String(value)}</span>
      </div>
    );
  }
  if (typeof value === "string") {
    return (
      <div className="json-tree-row">
        <KeyPart label={label} />
        <JsonString value={value} threshold={longStringThreshold} />
      </div>
    );
  }
  if (Array.isArray(value)) {
    return (
      <JsonArray
        value={value}
        label={label}
        depth={depth}
        defaultExpandDepth={defaultExpandDepth}
        longStringThreshold={longStringThreshold}
      />
    );
  }
  return (
    <JsonObject
      value={value as Record<string, unknown>}
      label={label}
      depth={depth}
      defaultExpandDepth={defaultExpandDepth}
      longStringThreshold={longStringThreshold}
    />
  );
};

/**
 * 轻量 JSON 树查看器：语法高亮、容器可折叠（默认展开到 defaultExpandDepth 层）、
 * 长字符串折叠为摘要并解码转义换行。用于工具返回的结构化结果展示。
 */
export const JsonTreeView = ({
  data,
  rootLabel,
  defaultExpandDepth = 3,
  longStringThreshold = 80,
}: JsonTreeViewProps): ReactNode => (
  <div className="json-tree">
    <JsonNode
      value={data}
      label={rootLabel}
      depth={0}
      defaultExpandDepth={defaultExpandDepth}
      longStringThreshold={longStringThreshold}
    />
  </div>
);
