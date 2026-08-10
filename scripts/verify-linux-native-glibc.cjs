/**
 * 校验 Linux .deb 安装包内的 Rust native bridge 的 glibc 兼容性。
 *
 * 背景（issue #61）：native bridge（snow_native.linux-x64-gnu.node）动态
 * 链接宿主 glibc。如果发布构建使用的发行版 glibc 过新（例如 Ubuntu 24.04
 * 的 glibc 2.39），产物在 Debian 12（glibc 2.36）/ Ubuntu 22.04
 * （glibc 2.35）上会因缺少 GLIBC_x.y 符号版本而无法加载，应用回退到
 * native bridge unavailable 分支并报
 * "Rust native bridge is required to list workspace directories"。
 *
 * 本脚本在 CI 打包完成后对产出的 .deb 做发布前校验：
 *   1. 用 dpkg-deb 解包 .deb；
 *   2. 找到其中打包的所有 snow_native*.node 模块（缺失直接判失败）；
 *   3. 用 objdump -T 读取动态符号表，统计其依赖的最高 GLIBC 符号版本；
 *   4. 若超过允许的上限（默认 2.35，可用环境变量 SNOW_LINUX_GLIBC_MAX
 *      覆盖）则报错终止发布流程。
 *
 * 用法：
 *   node scripts/verify-linux-native-glibc.cjs [release 目录或 .deb 路径...]
 *   （不传参数时默认扫描仓库根目录下的 release 目录）
 *
 * 仅在 Linux 环境（CI 的 linux 构建任务）中运行，依赖 dpkg-deb 与 objdump。
 */

const { execFileSync } = require("node:child_process");
const {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} = require("node:fs");
const os = require("node:os");
const { isAbsolute, join, resolve } = require("node:path");

const projectRoot = join(__dirname, "..");
const defaultMaxGlibc = "2.35";
const maxGlibc = (process.env.SNOW_LINUX_GLIBC_MAX || defaultMaxGlibc).trim();

function fail(message) {
  console.error(`[verify-linux-native-glibc] ${message}`);
  process.exit(1);
}

function parseVersion(versionText) {
  const parts = versionText.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part))) {
    throw new Error(`Invalid version string: ${versionText}`);
  }
  return parts;
}

function compareVersions(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function formatVersion(parts) {
  return parts.join(".");
}

/** 递归收集路径下的所有 .deb 文件；若路径本身是 .deb 则直接返回。 */
function collectDebFiles(target) {
  if (!existsSync(target)) {
    fail(`Path does not exist: ${target}`);
  }
  if (statSync(target).isFile()) {
    if (!target.endsWith(".deb")) {
      fail(`Not a .deb file: ${target}`);
    }
    return [target];
  }
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".deb")) {
        found.push(fullPath);
      }
    }
  };
  walk(target);
  return found;
}

/** 在解包目录中递归查找所有 snow_native*.node 模块。 */
function findNativeModules(rootDir) {
  const modules = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.startsWith("snow_native") &&
        entry.name.endsWith(".node")
      ) {
        modules.push(fullPath);
      }
    }
  };
  walk(rootDir);
  return modules;
}

/** 读取 ELF 动态符号表，返回该模块要求的最高 GLIBC 符号版本。 */
function getRequiredGlibcVersion(modulePath) {
  let symbols;
  try {
    symbols = execFileSync("objdump", ["-T", modulePath], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (error) {
    fail(
      `objdump failed for ${modulePath}: ${error?.message ?? String(error)} ` +
        "(binutils is required on the build runner)"
    );
  }

  let highest = null;
  const matches = symbols.match(/GLIBC_(\d+(?:\.\d+)*)/g) ?? [];
  for (const match of matches) {
    const version = parseVersion(match.slice("GLIBC_".length));
    if (!highest || compareVersions(version, highest) > 0) {
      highest = version;
    }
  }
  return highest;
}

function verifyDeb(debPath, maxVersion) {
  const tempDir = mkdtempSync(join(os.tmpdir(), "snow-deb-glibc-verify-"));
  try {
    try {
      execFileSync("dpkg-deb", ["-x", debPath, tempDir], {
        stdio: "ignore",
        maxBuffer: 128 * 1024 * 1024,
      });
    } catch (error) {
      fail(
        `dpkg-deb failed to extract ${debPath}: ${error?.message ?? String(error)} ` +
          "(dpkg-deb is required on the build runner)"
      );
    }

    const modules = findNativeModules(tempDir);
    if (modules.length === 0) {
      fail(
        `No snow_native*.node module found inside ${debPath}; ` +
          "the app would fail with \"Rust native bridge is required\" on every Linux machine"
      );
    }

    for (const modulePath of modules) {
      const required = getRequiredGlibcVersion(modulePath);
      const relativeName = modulePath.slice(tempDir.length + 1);
      if (!required) {
        // 未发现任何 GLIBC 版本引用（静态链接等），视为通过。
        console.log(
          `[verify-linux-native-glibc] ${debPath}: ${relativeName} has no versioned GLIBC requirements`
        );
        continue;
      }
      if (compareVersions(required, maxVersion) > 0) {
        fail(
          `${debPath}: ${relativeName} requires GLIBC_${formatVersion(required)}, ` +
            `which is above the supported baseline GLIBC_${formatVersion(maxVersion)} ` +
            "(Debian 12 / Ubuntu 22.04). Build the Linux native bridge on an older " +
            "baseline distribution (see the linux entry in .github/workflows/release.yml)."
        );
      }
      console.log(
        `[verify-linux-native-glibc] ${debPath}: ${relativeName} requires at most ` +
          `GLIBC_${formatVersion(required)} (baseline GLIBC_${formatVersion(maxVersion)}) - OK`
      );
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function main() {
  const maxVersion = parseVersion(maxGlibc);
  const inputs = process.argv.slice(2);
  const targets = inputs.length > 0
    ? inputs.map((input) => resolve(process.cwd(), input))
    : [join(projectRoot, "release")];

  const debFiles = [];
  for (const target of targets) {
    debFiles.push(...collectDebFiles(target));
  }
  if (debFiles.length === 0) {
    fail(`No .deb package found under: ${targets.join(", ")}`);
  }

  console.log(
    `[verify-linux-native-glibc] Checking ${debFiles.length} .deb package(s) ` +
      `against baseline GLIBC_${formatVersion(maxVersion)}`
  );
  for (const debPath of debFiles) {
    verifyDeb(debPath, maxVersion);
  }
  console.log(
    "[verify-linux-native-glibc] All Linux .deb packages satisfy the glibc baseline"
  );
}

main();
