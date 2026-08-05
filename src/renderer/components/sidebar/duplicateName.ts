/**
 * 复制配置时的命名工具。
 *
 * 命名规则：以被复制配置的名称（去除已有的「-Copy-n」后缀）为基数，
 * 追加 `-Copy-{n}`（n 从 1 递增），直到得到一个不在既有名称集合中的唯一名。
 *
 * 例如：
 *   - 「deepseek」 -> 「deepseek-Copy-1」
 *   - 「deepseek-Copy-1」 -> 「deepseek-Copy-2」
 */

const COPY_SUFFIX_PATTERN = /-Copy-(\d+)$/;

/** 去除名称末尾的「-Copy-n」后缀，得到复制基数名。 */
const stripCopySuffix = (name: string): string => {
  const match = name.match(COPY_SUFFIX_PATTERN);
  if (match) {
    return name.slice(0, match.index);
  }
  return name;
};

/**
 * 为复制后的配置生成唯一名称。
 *
 * @param sourceName 被复制的配置名（可能已带「-Copy-n」后缀）。
 * @param existingNames 既有名称集合（用于判定唯一性）。
 * @returns 不与既有名称冲突的 `{base}-Copy-{n}` 名称。
 */
export const buildDuplicateName = (
  sourceName: string,
  existingNames: ReadonlyArray<string> | ReadonlySet<string>
): string => {
  const base = stripCopySuffix(sourceName);
  const taken = new Set(existingNames);
  let n = 1;
  while (taken.has(`${base}-Copy-${n}`)) {
    n += 1;
  }
  return `${base}-Copy-${n}`;
};
