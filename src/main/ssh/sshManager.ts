import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require2 = createRequire(import.meta.url);
const ssh2 = require2("ssh2") as typeof import("ssh2");
const { Client } = ssh2;

export type SshAuthMethod = "password" | "privateKey" | "agent";

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

export type SshSession = {
  id: string;
  client: import("ssh2").Client;
  sftp: import("ssh2").SFTPWrapper;
  params: SshConnectParams;
};

const sessions = new Map<string, SshSession>();

const generateSessionId = (): string =>
  `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const getSshProfileKey = (params: {
  host: string;
  port: number;
  username: string;
}): string => `${params.username}@${params.host}:${params.port}`;

export const connectSsh = (params: SshConnectParams): Promise<string> => {
  return new Promise((resolve, reject) => {
    let settled = false;
    const client = new Client();

    const connectConfig: Record<string, unknown> = {
      host: params.host,
      port: params.port,
      username: params.username,
      readyTimeout: 15000,
    };

    if (params.authMethod === "password" && params.password) {
      connectConfig.password = params.password;
    } else if (params.authMethod === "privateKey" && params.privateKeyPath) {
      try {
        connectConfig.privateKey = readFileSync(params.privateKeyPath, "utf-8");
      } catch {
        reject(
          new Error(`Failed to read private key file: ${params.privateKeyPath}`)
        );
        return;
      }
      if (params.passphrase) {
        connectConfig.passphrase = params.passphrase;
      }
    } else if (params.authMethod === "agent") {
      const https = require2("node:https") as typeof import("node:https");
      connectConfig.agent = new https.Agent();
    } else {
      reject(new Error("Invalid authentication method or missing credentials"));
      return;
    }

    client.on("ready", () => {
      client.sftp(
        (err: Error | undefined, sftp: import("ssh2").SFTPWrapper) => {
          if (err) {
            if (!settled) {
              settled = true;
              client.end();
              reject(new Error(`SFTP initialization failed: ${err.message}`));
            }
            return;
          }

          const id = generateSessionId();
          const session: SshSession = { id, client, sftp, params };
          sessions.set(id, session);
          if (!settled) {
            settled = true;
            resolve(id);
          }
        }
      );
    });

    client.on("error", (err: Error) => {
      if (!settled) {
        settled = true;
        reject(new Error(err.message));
      }
    });

    client.on("close", () => {
      for (const [id, session] of sessions) {
        if (session.client === client) {
          sessions.delete(id);
          break;
        }
      }
      if (!settled) {
        settled = true;
        reject(new Error("SSH connection closed before establishing session"));
      }
    });

    try {
      client.connect(connectConfig);
    } catch (err) {
      if (!settled) {
        settled = true;
        reject(new Error(err instanceof Error ? err.message : String(err)));
      }
    }
  });
};

export const listSshDirectory = (
  sessionId: string,
  remotePath: string
): Promise<SshDirectoryEntry[]> => {
  return new Promise((resolve, reject) => {
    const session = sessions.get(sessionId);
    if (!session) {
      reject(new Error("SSH session not found. Please reconnect."));
      return;
    }

    session.sftp.readdir(remotePath, (err, list) => {
      if (err) {
        reject(new Error(`Failed to read remote directory: ${err.message}`));
        return;
      }

      const entries: SshDirectoryEntry[] = list.map((item) => {
        const isDirectory = item.attrs.isDirectory();
        const name = item.filename;
        const fullPath =
          remotePath === "/" ? `/${name}` : `${remotePath}/${name}`;
        return {
          name,
          path: fullPath,
          isDirectory,
          size: isDirectory ? 0 : item.attrs.size,
        };
      });

      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      resolve(entries);
    });
  });
};

export type SshCommandOptions = {
  /** Upper bound for the command lifetime; the exec channel is closed and the
   *  remote process signalled on timeout. Defaults to 5 minutes as an absolute
   *  safety net so an SSH exec can never hang forever. */
  timeoutMs?: number;
  /** External cancellation (e.g. conversation stop); aborts the same way as a
   *  timeout. */
  signal?: AbortSignal;
};

export const executeSshCommand = (
  sessionId: string,
  command: string,
  options?: SshCommandOptions
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const session = sessions.get(sessionId);
    if (!session) {
      reject(new Error("SSH session not found. Please reconnect."));
      return;
    }

    const { timeoutMs = 300_000, signal } = options ?? {};
    let settled = false;
    let streamRef: import("ssh2").ClientChannel | undefined;
    let timer: NodeJS.Timeout | undefined;

    // Single-settlement state machine: exactly one of exec callback failure,
    // stream error, stream close, client error, client close, timeout or
    // cancellation resolves the Promise. Any later event is ignored.
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      session.client.removeListener("error", onClientError);
      session.client.removeListener("close", onClientClose);
    };

    const terminate = (): void => {
      // Best-effort: signal the remote process group and close the exec
      // channel so the pending wait settles instead of hanging forever.
      try {
        streamRef?.signal("KILL");
      } catch {
        // Channel may already be gone.
      }
      try {
        streamRef?.close();
      } catch {
        // Channel may already be gone.
      }
    };

    const settleAndReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      terminate();
      reject(error);
    };

    const onAbort = (): void => {
      settleAndReject(new Error("Remote command cancelled"));
    };
    const onClientError = (err: Error): void => {
      settleAndReject(new Error(`SSH connection error: ${err.message}`));
    };
    const onClientClose = (): void => {
      settleAndReject(new Error("SSH connection closed before command completed"));
    };

    if (signal?.aborted) {
      reject(new Error("Remote command cancelled"));
      return;
    }
    session.client.on("error", onClientError);
    session.client.on("close", onClientClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      settleAndReject(new Error(`Remote command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    session.client.exec(command, (err, stream) => {
      if (err) {
        settleAndReject(
          new Error(`Failed to execute remote command: ${err.message}`)
        );
        return;
      }
      streamRef = stream;

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => {
        if (!settled) {
          stdout.push(chunk);
        }
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        if (!settled) {
          stderr.push(chunk);
        }
      });
      stream.on("close", (exitCode: number | null) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        const errorOutput = Buffer.concat(stderr).toString("utf-8").trim();
        if (exitCode !== 0) {
          reject(
            new Error(
              errorOutput || `Remote command failed with exit code ${exitCode}`
            )
          );
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf-8"));
      });
      stream.on("error", (streamError: Error) => {
        settleAndReject(
          new Error(`Failed to execute remote command: ${streamError.message}`)
        );
      });
    });
  });
};

export const readSshFile = (
  sessionId: string,
  remotePath: string
): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const session = sessions.get(sessionId);
    if (!session) {
      reject(new Error("SSH session not found. Please reconnect."));
      return;
    }

    const chunks: Buffer[] = [];
    const stream = session.sftp.createReadStream(remotePath);

    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    stream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    stream.on("error", (err: Error) => {
      reject(new Error(`Failed to read remote file: ${err.message}`));
    });

    stream.read();
  });
};

export const writeSshFile = (
  sessionId: string,
  remotePath: string,
  content: string
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const session = sessions.get(sessionId);
    if (!session) {
      reject(new Error("SSH session not found. Please reconnect."));
      return;
    }

    const stream = session.sftp.createWriteStream(remotePath);

    stream.on("error", (err: Error) => {
      reject(new Error(`Failed to write remote file: ${err.message}`));
    });

    stream.on("close", () => {
      resolve();
    });

    stream.end(Buffer.from(content, "utf-8"));
  });
};

export const deleteSshFile = (
  sessionId: string,
  remotePath: string
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const session = sessions.get(sessionId);
    if (!session) {
      reject(new Error("SSH session not found. Please reconnect."));
      return;
    }

    session.sftp.unlink(remotePath, (err) => {
      if (err) {
        reject(new Error(`Failed to delete remote file: ${err.message}`));
        return;
      }
      resolve();
    });
  });
};

export const renameSshFile = (
  sessionId: string,
  oldPath: string,
  newPath: string
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const session = sessions.get(sessionId);
    if (!session) {
      reject(new Error("SSH session not found. Please reconnect."));
      return;
    }

    session.sftp.rename(oldPath, newPath, (err) => {
      if (err) {
        reject(new Error(`Failed to rename remote file: ${err.message}`));
        return;
      }
      resolve();
    });
  });
};

export const deleteSshDirectory = (
  sessionId: string,
  remotePath: string
): Promise<void> => {
  // SFTP rmdir only works on empty directories. For recursive removal we
  // shell out to `rm -rf` via the existing exec channel, which is the most
  // reliable cross-platform approach on remote servers.
  const quoted = `'${remotePath.replace(/'/g, `'\"'\"'`)}'`;
  return executeSshCommand(sessionId, `rm -rf ${quoted}`).then(() => undefined);
};

export const statSshEntry = (
  sessionId: string,
  remotePath: string
): Promise<import("ssh2").Stats | null> => {
  return new Promise((resolve, reject) => {
    const session = sessions.get(sessionId);
    if (!session) {
      reject(new Error("SSH session not found. Please reconnect."));
      return;
    }

    session.sftp.stat(
      remotePath,
      (err: Error | undefined, stats: import("ssh2").Stats) => {
        if (err) {
          // Path may have been removed; return null instead of rejecting.
          resolve(null);
          return;
        }
        resolve(stats);
      }
    );
  });
};

export const disconnectSsh = (sessionId: string): void => {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  try {
    session.sftp.end();
    session.client.end();
  } catch {
    // Ignore
  }
  sessions.delete(sessionId);
};

export const disconnectAllSsh = (): void => {
  for (const [, session] of sessions) {
    try {
      session.sftp.end();
      session.client.end();
    } catch {
      // Ignore
    }
  }
  sessions.clear();
};

export const isSshPath = (path: string): boolean => path.startsWith("ssh://");

export type ParsedSshUrl = {
  host: string;
  port: number;
  username: string;
  remotePath: string;
};

export const parseSshUrl = (sshUrl: string): ParsedSshUrl => {
  const withoutPrefix = sshUrl.replace(/^ssh:\/\//, "");
  const atIndex = withoutPrefix.indexOf("@");
  if (atIndex < 0) {
    throw new Error("Invalid SSH URL: missing username");
  }
  const username = withoutPrefix.slice(0, atIndex);
  const hostPortAndPath = withoutPrefix.slice(atIndex + 1);
  const slashIndex = hostPortAndPath.indexOf("/");
  const hostPort =
    slashIndex >= 0 ? hostPortAndPath.slice(0, slashIndex) : hostPortAndPath;
  const remotePath = slashIndex >= 0 ? hostPortAndPath.slice(slashIndex) : "/";
  const colonIndex = hostPort.indexOf(":");
  const host = colonIndex >= 0 ? hostPort.slice(0, colonIndex) : hostPort;
  const port =
    colonIndex >= 0 ? parseInt(hostPort.slice(colonIndex + 1), 10) : 22;
  return { host, port, username, remotePath };
};

export const buildSshUrl = (parsed: ParsedSshUrl): string =>
  `ssh://${parsed.username}@${parsed.host}:${parsed.port}${parsed.remotePath}`;
