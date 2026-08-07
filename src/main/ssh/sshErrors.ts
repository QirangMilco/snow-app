/**
 * SSH 连接错误分类与用户友好化。
 *
 * ssh2 库抛出的原始错误（如 "Connection lost before handshake"、
 * "All configured authentication methods failed"）是面向工程师的技术消息，
 * 直接透传给渲染层会让用户无法判断失败原因。此模块负责把原始错误归类为
 * 稳定的错误码（network / timeout / auth / sftp / invalid / unknown），
 * 并生成用户可读的英文消息（渲染层再按错误码做 i18n 本地化）。
 */

export type SshConnectErrorCode =
  | "network"
  | "timeout"
  | "auth"
  | "sftp"
  | "invalid"
  | "unknown";

export type SshConnectErrorInfo = {
  code: SshConnectErrorCode;
  /** 用户可读的英文消息（渲染层按 code 本地化展示）。 */
  message: string;
  /** ssh2 原始错误消息，用于高级用户排查。 */
  detail: string;
};

const NETWORK_PATTERNS = [
  "connection lost before handshake",
  "econnrefused",
  "connection refused",
  "enetunreach",
  "network is unreachable",
  "ehostunreach",
  "no route to host",
  "econnreset",
  "connection reset",
  "eai_again",
  "getaddrinfo",
  "enotfound",
  "err_connection_closed",
  "socket hang up",
  "connect econn",
  "connection closed",
  "unable to connect",
];

const TIMEOUT_PATTERNS = [
  "timed out",
  "timeout",
  "etimedout",
  "handshake timeout",
];

const AUTH_PATTERNS = [
  "all configured authentication methods failed",
  "permission denied",
  "authentication failed",
  "unable to authenticate",
  "cannot parse privatekey",
  "invalid privatekey",
  "encrypted private key",
  "no passphrase",
  "bad password",
];

const SFTP_PATTERNS = ["sftp"];

const INVALID_PATTERNS = [
  "invalid authentication method or missing credentials",
  "ssh host is required",
  "ssh username is required",
];

const containsAny = (value: string, patterns: string[]): boolean =>
  patterns.some((pattern) => value.includes(pattern));

export const classifySshConnectError = (err: unknown): SshConnectErrorInfo => {
  const detail =
    err instanceof Error && err.message ? err.message : String(err ?? "");
  const lower = detail.toLowerCase();

  if (containsAny(lower, INVALID_PATTERNS)) {
    return {
      code: "invalid",
      message:
        "Invalid authentication settings. Fill in the host, username and credentials.",
      detail,
    };
  }
  if (containsAny(lower, SFTP_PATTERNS)) {
    return {
      code: "sftp",
      message:
        "SSH authentication succeeded, but the SFTP subsystem could not be initialized. The server may not have SFTP enabled.",
      detail,
    };
  }
  if (containsAny(lower, TIMEOUT_PATTERNS)) {
    return {
      code: "timeout",
      message:
        "Timed out while connecting to the SSH server. Check the host, port and network, then retry.",
      detail,
    };
  }
  if (containsAny(lower, AUTH_PATTERNS)) {
    return {
      code: "auth",
      message:
        "SSH authentication failed. Check the username and password or private key.",
      detail,
    };
  }
  if (containsAny(lower, NETWORK_PATTERNS)) {
    return {
      code: "network",
      message:
        "Cannot reach the SSH server: the connection was closed before the handshake completed. Check the host, port and network, then retry.",
      detail,
    };
  }

  return {
    code: "unknown",
    message: "Failed to connect to the SSH server.",
    detail,
  };
};
