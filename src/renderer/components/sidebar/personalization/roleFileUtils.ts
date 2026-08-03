import type { SshConnectParams } from "../../../../preload";

export type ProjectDirectoryInfo = {
  path: string;
  isSsh: boolean;
};

const ROLE_FILE_NAME = "ROLE.md";
const SETTINGS_FILE_PATH = ".snow/settings.json";

/** 构建 SSH 连接参数（复用 RoleEditorPanel 的凭证解析链路）。 */
export const buildSshConnectParams = async (
  sshUrl: string
): Promise<SshConnectParams | null> => {
  const parsed = await window.snow.sshParseUrl(sshUrl);
  const credential = await window.snow.sshGetCredential(
    parsed.host,
    parsed.port,
    parsed.username
  );

  const connectParams: SshConnectParams = {
    host: parsed.host,
    port: parsed.port,
    username: parsed.username,
    authMethod: credential?.authMethod ?? "password",
  };

  if (credential?.privateKeyPath) {
    connectParams.privateKeyPath = credential.privateKeyPath;
  }

  const secret = credential?.encryptedSecret
    ? await window.snow.sshGetDecryptedSecret(
        parsed.host,
        parsed.port,
        parsed.username
      )
    : null;

  if (secret) {
    if (connectParams.authMethod === "password") {
      connectParams.password = secret;
    } else {
      connectParams.passphrase = secret;
    }
  }

  return connectParams;
};

/** 构建项目 ROLE.md 的完整路径（SSH 工作区为远程路径）。 */
export const buildRoleFilePath = (info: ProjectDirectoryInfo): string => {
  if (info.isSsh) {
    return `${info.path.replace(/^ssh:\/\/[^/]+/, "")}/${ROLE_FILE_NAME}`;
  }
  return `${info.path}/${ROLE_FILE_NAME}`.replace(/\/+/g, "/");
};

export const buildRoleSettingsPath = (info: ProjectDirectoryInfo): string => {
  if (info.isSsh) {
    return `${info.path.replace(/^ssh:\/\/[^/]+/, "").replace(/\/+$/, "")}/${SETTINGS_FILE_PATH}`;
  }
  return `${info.path}/${SETTINGS_FILE_PATH}`.replace(/\/+/g, "/");
};

export const readIncludeGlobalRules = (content: string): boolean => {
  if (!content.trim()) return true;
  const settings = JSON.parse(content) as {
    role?: { includeGlobalRules?: unknown };
  };
  return typeof settings.role?.includeGlobalRules === "boolean"
    ? settings.role.includeGlobalRules
    : true;
};

export const writeIncludeGlobalRules = (
  content: string,
  includeGlobalRules: boolean
): string => {
  const settings = content.trim()
    ? (JSON.parse(content) as Record<string, unknown>)
    : {};
  const existingRole =
    typeof settings.role === "object" &&
    settings.role !== null &&
    !Array.isArray(settings.role)
      ? (settings.role as Record<string, unknown>)
      : {};

  return `${JSON.stringify(
    {
      ...settings,
      role: { ...existingRole, includeGlobalRules },
    },
    null,
    2
  )}\n`;
};
