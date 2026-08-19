import { spawn } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import path from "node:path";

import { readMacProcess } from "./codex-desktop-runtime.mjs";
import {
  childExited,
  childFailureTracker,
  platformError,
  spawnHost,
  waitUntilReady,
} from "./codex-app-server-host-platform-shared.mjs";
import {
  normalizeCodexAppServerEndpoint,
  probeCodexAppServerWebSocket,
} from "./codex-app-server-websocket.mjs";

const MAX_UNIX_SOCKET_PATH_BYTES = 100;

function exactUnixEndpoint(endpoint, socketPath) {
  const normalized = normalizeCodexAppServerEndpoint(endpoint, {
    pathApi: path.posix,
  });
  if (
    normalized.type !== "unix"
    || normalized.socketPath !== path.posix.normalize(socketPath)
  ) {
    throw platformError(
      "APP_SERVER_HOST_STATE_INVALID",
      "The recorded Codex app-server Unix endpoint is invalid.",
    );
  }
  return normalized;
}

export function createDarwinCodexAppServerHostAdapter({
  spawnProcess = spawn,
  probeEndpoint = probeCodexAppServerWebSocket,
  inspectMacProcess = readMacProcess,
  chmodSocket = chmod,
  remove = rm,
} = {}) {
  return Object.freeze({
    platform: "darwin",
    prepareDirectory: async () => {},
    expectedEndpoint(directory) {
      const socketPath = path.posix.join(directory, "server.sock");
      if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
        throw platformError(
          "APP_SERVER_HOST_SOCKET_PATH_TOO_LONG",
          "The Codex Small Loop app-server Unix socket path is too long.",
        );
      }
      return Object.freeze({ type: "unix", socketPath });
    },
    validateEndpoint(endpoint, directory) {
      return exactUnixEndpoint(
        endpoint,
        path.posix.join(directory, "server.sock"),
      );
    },
    migrateLegacyHost(host, directory) {
      if (host?.socketPath !== path.posix.join(directory, "server.sock")) {
        return null;
      }
      const { socketPath, ...rest } = host;
      return { ...rest, endpoint: { type: "unix", socketPath } };
    },
    async launch({ runtime, directory, timeoutMs, retryIntervalMs }) {
      const endpoint = this.expectedEndpoint(directory);
      const child = spawnHost(
        spawnProcess,
        runtime.executablePath,
        ["app-server", "--listen", `unix://${endpoint.socketPath}`],
        {
          cwd: directory,
          detached: true,
          shell: false,
          stdio: "ignore",
        },
      );
      const startupFailure = childFailureTracker(child);
      try {
        await waitUntilReady({
          child,
          endpoint,
          probe: probeEndpoint,
          timeoutMs,
          retryIntervalMs,
          startupFailure,
          beforeProbe: async () => {
            try {
              await chmodSocket(endpoint.socketPath, 0o600);
            } catch (cause) {
              if (cause?.code !== "ENOENT") throw cause;
            }
          },
        });
      } catch (cause) {
        if (!childExited(child)) child.kill();
        throw cause;
      }
      child.unref();
      return Object.freeze({ pid: child.pid, endpoint });
    },
    probe: probeEndpoint,
    inspectProcess: inspectMacProcess,
    sameExecutable(left, right) {
      return left === right;
    },
    async cleanup(endpoint, directory) {
      const normalized = endpoint
        ? this.validateEndpoint(endpoint, directory)
        : this.expectedEndpoint(directory);
      await remove(normalized.socketPath, { force: true });
    },
  });
}
