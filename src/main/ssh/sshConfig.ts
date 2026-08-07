import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SshConfigHost = {
  /** `Host` 关键字的值（别名），多个别名时取第一个非通配符值 */
  alias: string;
  /** 解析后的实际主机名（HostName，缺失时回退为 alias） */
  host: string;
  /** 登录用户名（User） */
  user?: string;
  /** 端口（Port），默认 22 */
  port: number;
  /** 私钥文件路径（IdentityFile，已展开 ~ 与 %d 等 token） */
  identityFile?: string;
};

/**
 * 读取本地 ~/.ssh/config 并解析其中的主机条目。
 *
 * 支持 SSH config 最常用的字段：Host / HostName / User / Port / IdentityFile，
 * 忽略注释与空行；`*` 通配符条目、Include 等高级指令不展开（保持简单）。
 * 文件不存在或不可读时返回空数组，不抛出异常。
 */
export const listSshConfigHosts = (): SshConfigHost[] => {
  const homeDir = homedir();
  const configPath = join(homeDir, ".ssh", "config");

  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch {
    return [];
  }

  const expandPath = (value: string): string => {
    // %d -> home dir, %u -> 当前用户名（本机，非远端），~ -> home dir
    const expanded = value
      .replace(/%d/g, homeDir)
      .replace(/^~(?=[\\/])/, homeDir);
    return expanded.replace(/\\/g, "/");
  };

  const hosts: SshConfigHost[] = [];
  let current: Partial<SshConfigHost> | null = null;

  const pushCurrent = (): void => {
    if (!current?.alias) {
      return;
    }
    hosts.push({
      alias: current.alias,
      host: current.host || current.alias,
      user: current.user,
      port: current.port ?? 22,
      identityFile: current.identityFile,
    });
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.search(/\s/);
    const keyword =
      separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    const value = separatorIndex >= 0 ? line.slice(separatorIndex).trim() : "";

    if (keyword === "Host") {
      pushCurrent();
      current = {};
      // 取第一个非通配符别名作为展示名；整条若只有通配符则跳过
      const alias = value
        .split(/\s+/)
        .filter((item) => item && item !== "*")[0];
      if (alias) {
        current.alias = alias;
      }
      continue;
    }

    if (!current) {
      // Host 关键字之前的散落配置（全局段）不参与条目解析
      continue;
    }

    if (keyword === "HostName" && value) {
      current.host = value;
    } else if (keyword === "User" && value) {
      current.user = value;
    } else if (keyword === "Port" && /^\d+$/.test(value)) {
      current.port = parseInt(value, 10);
    } else if (keyword === "IdentityFile" && value) {
      current.identityFile = expandPath(value);
    }
  }
  pushCurrent();

  return hosts;
};
