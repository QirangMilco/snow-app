export type SshAuthMethod = "password" | "privateKey" | "agent";

/**
 * SSH 连接失败的错误码，由主进程 `ssh:connect` handler 分类产生，
 * 渲染层据此展示本地化的友好提示。
 */
export type SshConnectErrorCode =
  | "network"
  | "timeout"
  | "auth"
  | "sftp"
  | "invalid"
  | "unknown";

/** preload 抛出的 SSH 连接错误：携带错误码与原始技术细节。 */
export type SshConnectError = Error & {
  code?: SshConnectErrorCode;
  detail?: string;
};

/**
 * `ssh:connect` 的结构化返回结果。注意：contextBridge 序列化 Error 时
 * 会丢弃自定义属性（code/detail），因此需要完整错误信息的调用方
 * （如连接向导）应使用 `sshConnectDetailed` 直接消费本类型。
 */
export type SshConnectResult =
  | { ok: true; sessionId: string }
  | { ok: false; code: SshConnectErrorCode; message: string; detail: string };

export type SshConnectParams = {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
};

export type SshDirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

export type RemoteWorkspaceFileSearchOptions = {
  query: string;
  listChildren: boolean;
};

export type SshCredentialRecord = {
  profileKey: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
  encryptedSecret?: string;
};

export type ParsedSshUrl = {
  host: string;
  port: number;
  username: string;
  remotePath: string;
};

/** 本地 ~/.ssh/config 中解析出的主机条目。 */
export type SshConfigHost = {
  /** `Host` 关键字的值（别名） */
  alias: string;
  /** 实际主机名（HostName，缺失时回退为 alias） */
  host: string;
  /** 登录用户名（User） */
  user?: string;
  /** 端口（Port），默认 22 */
  port: number;
  /** 私钥文件路径（IdentityFile） */
  identityFile?: string;
};
