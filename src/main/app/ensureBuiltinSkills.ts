import { app } from "electron";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { snowLog } from "../../utils/snowLogger";

const SKILLS_DIR_NAME = "skills";
const DOCS_DIR_NAME = "docs";
const SKILL_FILE_NAME = "SKILL.md";
const DOCS_VERSION_FILE_NAME = ".snow-docs-version";

/**
 * 应用内置资源的源目录。
 * - 开发模式：项目根目录下的 resources/skills、docs
 * - 打包后：app.asar 内的 resources/skills、docs（electron-builder files 配置）
 */
const builtinSourceDir = (dirName: string): string =>
  join(app.getAppPath(), dirName);

/**
 * 用户全局目录（~/.snow），load_available_skills 会读取其中的 skills/。
 */
const userSnowDir = (): string => join(homedir(), ".snow");

/**
 * 递归复制目录。刻意只使用 readdirSync / copyFileSync / mkdirSync，
 * 不使用 cpSync，确保打包后从 app.asar 内复制资源也能正常工作
 * （Electron 对这三者做了透明的 asar 支持）。
 */
const copyDirRecursive = (sourceDir: string, targetDir: string): void => {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(sourcePath, targetPath);
    } else {
      copyFileSync(sourcePath, targetPath);
    }
  }
};

/**
 * 首次启动时把应用内置 skills（resources/skills/<id>/SKILL.md）逐个复制到
 * 用户目录 ~/.snow/skills/<id>/SKILL.md，使用户能看到并能在 Skills 设置中
 * 开关该技能。
 *
 * 幂等：目标文件已存在时跳过（不覆盖用户可能的编辑）。
 */
export const ensureBuiltinSkills = (): void => {
  const sourceRoot = builtinSourceDir(join("resources", SKILLS_DIR_NAME));

  let skillIds: string[];
  try {
    skillIds = readdirSync(sourceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    // 打包时资源缺失不应阻断启动，记录后跳过。
    snowLog.warn({
      module: "app/skills",
      func: "ensureBuiltinSkills",
      message: "Builtin skills source dir not found, skipping install",
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const skillId of skillIds) {
    const sourceFile = join(sourceRoot, skillId, SKILL_FILE_NAME);
    if (!existsSync(sourceFile)) {
      continue;
    }

    const targetDir = join(userSnowDir(), SKILLS_DIR_NAME, skillId);
    const targetFile = join(targetDir, SKILL_FILE_NAME);

    if (existsSync(targetFile)) {
      continue;
    }

    try {
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(sourceFile, targetFile);
      snowLog.info({
        module: "app/skills",
        func: "ensureBuiltinSkills",
        message: "Builtin skill installed",
        context: targetFile,
      });
    } catch (error) {
      snowLog.warn({
        module: "app/skills",
        func: "ensureBuiltinSkills",
        message: `Failed to install builtin skill: ${skillId}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

/**
 * 把应用内置文档（项目根 docs/）同步到用户目录 ~/.snow/docs/，供
 * snow-app-docs 技能引导 Agent 阅读。
 *
 * 使用标记文件 `.snow-docs-version` 记录同步时的应用版本：仅当标记缺失
 * 或应用版本变化时整树重同步（先删后复制），避免每次启动重复覆盖；
 * 用户若自行修改 ~/.snow/docs/ 中的文档，会在应用升级时被新版覆盖。
 */
export const ensureBuiltinDocs = (): void => {
  const sourceDir = builtinSourceDir(DOCS_DIR_NAME);
  if (!existsSync(sourceDir)) {
    snowLog.warn({
      module: "app/skills",
      func: "ensureBuiltinDocs",
      message: "Builtin docs source dir not found, skipping sync",
      context: sourceDir,
    });
    return;
  }

  const targetDir = join(userSnowDir(), DOCS_DIR_NAME);
  const versionFile = join(targetDir, DOCS_VERSION_FILE_NAME);
  const currentVersion = app.getVersion();

  try {
    if (
      existsSync(versionFile) &&
      readFileSync(versionFile, "utf8").trim() === currentVersion
    ) {
      return;
    }

    // 版本变化或首次安装：整树重同步（仅操作 ~/.snow/docs，绝不泛化删除）。
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    copyDirRecursive(sourceDir, targetDir);
    writeFileSync(versionFile, currentVersion, "utf8");

    snowLog.info({
      module: "app/skills",
      func: "ensureBuiltinDocs",
      message: "Builtin docs synced",
      context: `${sourceDir} -> ${targetDir} (version ${currentVersion})`,
    });
  } catch (error) {
    snowLog.warn({
      module: "app/skills",
      func: "ensureBuiltinDocs",
      message: "Failed to sync builtin docs",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
