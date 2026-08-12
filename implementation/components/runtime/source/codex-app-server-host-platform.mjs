import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { readMacProcess } from "./codex-desktop-runtime.mjs";
import {
  normalizeCodexAppServerEndpoint,
  probeCodexAppServerWebSocket,
} from "./codex-app-server-websocket.mjs";
import { readWindowsProcess } from "./codex-windows-runtime.mjs";
import { protectPrivateDirectory } from "./private-directory.mjs";

const execFileAsync = promisify(execFile);
const MAX_STARTUP_DIAGNOSTIC_BYTES = 16 * 1_024;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;
const WINDOWS_CODEX_EXECUTABLE_VARIABLE = "CODEX_SMALL_LOOP_CODEX_EXECUTABLE";
const WINDOWS_CODEX_ARGUMENTS_VARIABLE = "CODEX_SMALL_LOOP_CODEX_ARGUMENTS";
const WINDOWS_CODEX_DIRECTORY_VARIABLE = "CODEX_SMALL_LOOP_CODEX_DIRECTORY";
const WINDOWS_HIDDEN_HOST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$startInfo = New-Object System.Diagnostics.ProcessStartInfo",
  `$startInfo.FileName = $env:${WINDOWS_CODEX_EXECUTABLE_VARIABLE}`,
  `$startInfo.Arguments = $env:${WINDOWS_CODEX_ARGUMENTS_VARIABLE}`,
  `$startInfo.WorkingDirectory = $env:${WINDOWS_CODEX_DIRECTORY_VARIABLE}`,
  "$startInfo.UseShellExecute = $false",
  "$startInfo.CreateNoWindow = $false",
  "$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden",
  "$startInfo.RedirectStandardError = $true",
  "$codexProcess = New-Object System.Diagnostics.Process",
  "$codexProcess.StartInfo = $startInfo",
  "[void]$codexProcess.Start()",
  "[Console]::Out.WriteLine('PID ' + $codexProcess.Id)",
  "[Console]::Out.Flush()",
  "try {",
  "  $reported = $false",
  "  while (($line = $codexProcess.StandardError.ReadLine()) -ne $null) {",
  "    if (-not $reported -and $line -match '^\\s*listening on: (ws://127\\.0\\.0\\.1:\\d{1,5})\\s*$') {",
  "      [Console]::Out.WriteLine('ENDPOINT ' + $Matches[1])",
  "      [Console]::Out.Flush()",
  "      $reported = $true",
  "    }",
  "  }",
  "  $codexProcess.WaitForExit()",
  "  exit $codexProcess.ExitCode",
  "} finally {",
  "  $codexProcess.Dispose()",
  "}",
].join("\r\n");

function platformError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "CodexAppServerHostPlatformError";
  error.code = code;
  return error;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function requireChild(child) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) {
    throw platformError(
      "APP_SERVER_HOST_START_FAILED",
      "The Codex app-server returned no process ID.",
    );
  }
  return child;
}

async function waitUntilReady({
  child,
  endpoint,
  probe,
  timeoutMs,
  retryIntervalMs,
  startupFailure = () => null,
  beforeProbe = async () => {},
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const failure = startupFailure();
    if (failure) throw failure;
    if (childExited(child)) {
      throw platformError(
        "APP_SERVER_HOST_EXITED",
        "The Codex app-server exited before becoming ready.",
      );
    }
    await beforeProbe();
    const remaining = Math.max(1, deadline - Date.now());
    if (await probe(endpoint, { timeoutMs: remaining })) return endpoint;
    await sleep(retryIntervalMs);
  }
  throw platformError(
    "APP_SERVER_HOST_NOT_READY",
    "The Codex Small Loop app-server host did not become ready in time.",
  );
}

function spawnHost(spawnProcess, executablePath, args, options) {
  try {
    return requireChild(spawnProcess(executablePath, args, options));
  } catch (cause) {
    if (cause?.code === "APP_SERVER_HOST_START_FAILED") throw cause;
    throw platformError(
      "APP_SERVER_HOST_START_FAILED",
      "Could not start the Codex app-server.",
      cause,
    );
  }
}

function childFailureTracker(child) {
  let failure = null;
  child.once("error", (cause) => {
    failure = platformError(
      "APP_SERVER_HOST_START_FAILED",
      "The Codex app-server process failed to start.",
      cause,
    );
  });
  return () => failure;
}

function windowsPowerShellPath(env) {
  const systemRoot = env?.SystemRoot ?? env?.SYSTEMROOT;
  if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) {
    throw platformError(
      "APP_SERVER_HOST_START_FAILED",
      "Windows SystemRoot is unavailable for the Codex app-server launcher.",
    );
  }
  return path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function quoteWindowsArgument(value) {
  if (typeof value !== "string") {
    throw new TypeError("Windows argument must be a string.");
  }
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  return `"${value
    .replace(/(\\*)"/gu, "$1$1\\\"")
    .replace(/(\\+)$/u, "$1$1")}"`;
}

function windowsCommandLine(args) {
  return args.map(quoteWindowsArgument).join(" ");
}

function encodedPowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function waitForWindowsStartup(child, tokenPath, {
  timeoutMs,
  retryIntervalMs,
  startupFailure,
  onPid = () => {},
}) {
  if (!child.stdout || typeof child.stdout.on !== "function") {
    throw platformError(
      "APP_SERVER_HOST_START_FAILED",
      "The Codex app-server launcher process ID is unavailable.",
    );
  }
  let output = "";
  let errorOutput = "";
  let outputTooLarge = false;
  let observedPid = null;
  const onData = (chunk) => {
    output += chunk.toString("utf8");
    if (observedPid === null) {
      const match = output.match(/(?:^|\r?\n)PID (\d+)(?=\r?\n|$)/u);
      if (match) {
        const pid = Number(match[1]);
        if (Number.isSafeInteger(pid) && pid > 0) {
          observedPid = pid;
          onPid(pid);
        }
      }
    }
    if (Buffer.byteLength(output) > MAX_STARTUP_DIAGNOSTIC_BYTES) outputTooLarge = true;
  };
  const onErrorData = (chunk) => {
    const remaining = MAX_STARTUP_DIAGNOSTIC_BYTES
      - Buffer.byteLength(errorOutput);
    if (remaining <= 0) return;
    errorOutput += chunk.toString("utf8").slice(0, remaining);
  };
  child.stdout.on("data", onData);
  child.stderr?.on("data", onErrorData);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() <= deadline) {
      const failure = startupFailure();
      if (failure) throw failure;
      if (outputTooLarge) {
        throw platformError(
          "APP_SERVER_HOST_START_FAILED",
          "The Codex app-server launcher protocol exceeded its size limit.",
        );
      }
      const pidMatches = [...output.matchAll(/(?:^|\r?\n)PID (\d+)(?=\r?\n|$)/gu)];
      const endpointMatches = [...output.matchAll(/(?:^|\r?\n)ENDPOINT (ws:\/\/127\.0\.0\.1:\d{1,5})(?=\r?\n|$)/gu)];
      if (pidMatches.length > 1 || endpointMatches.length > 1) {
        throw platformError(
          "APP_SERVER_HOST_START_FAILED",
          "The Codex app-server launcher returned duplicate protocol records.",
        );
      }
      if (pidMatches.length === 1 && endpointMatches.length === 1) {
        const pid = Number(pidMatches[0][1]);
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          throw platformError(
            "APP_SERVER_HOST_START_FAILED",
            "The Codex app-server launcher returned an invalid process ID.",
          );
        }
        if (observedPid === null) {
          observedPid = pid;
          onPid(pid);
        }
        const endpoint = exactLoopbackEndpoint({
          type: "loopback-websocket",
          url: endpointMatches[0][1],
          tokenPath,
        }, tokenPath);
        return Object.freeze({ pid, endpoint });
      }
      if (pidMatches.length === 1 && observedPid === null) {
        const pid = Number(pidMatches[0][1]);
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          throw platformError(
            "APP_SERVER_HOST_START_FAILED",
            "The Codex app-server launcher returned an invalid process ID.",
          );
        }
        observedPid = pid;
        onPid(pid);
      }
      if (childExited(child)) {
        const details = errorOutput.trim();
        throw platformError(
          "APP_SERVER_HOST_EXITED",
          details.length > 0
            ? `The Codex app-server launcher exited before readiness: ${details}`
            : "The Codex app-server launcher exited before readiness.",
        );
      }
      await sleep(retryIntervalMs);
    }
    throw platformError(
      "APP_SERVER_HOST_NOT_READY",
      "The Codex app-server launcher did not report readiness in time.",
    );
  } finally {
    child.stdout.off("data", onData);
    child.stderr?.off("data", onErrorData);
  }
}

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

function createMacAdapter({
  spawnProcess,
  probeEndpoint,
  inspectProcess,
  chmodSocket,
  remove,
}) {
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
    inspectProcess,
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

function exactLoopbackEndpoint(endpoint, tokenPath) {
  const normalized = normalizeCodexAppServerEndpoint(endpoint, {
    pathApi: path.win32,
  });
  if (
    normalized.type !== "loopback-websocket"
    || path.win32.normalize(normalized.tokenPath).toLowerCase()
      !== path.win32.normalize(tokenPath).toLowerCase()
  ) {
    throw platformError(
      "APP_SERVER_HOST_STATE_INVALID",
      "The recorded Codex app-server loopback endpoint is invalid.",
    );
  }
  return normalized;
}

function createWindowsAdapter({
  env,
  execute,
  spawnProcess,
  probeEndpoint,
  inspectProcess,
  remove,
  terminateProcess,
  writeToken,
  tokenBytes,
}) {
  return Object.freeze({
    platform: "win32",
    async prepareDirectory(directory) {
      try {
        await protectPrivateDirectory(directory, {
          platform: "win32",
          env,
          execute,
        });
      } catch (cause) {
        throw platformError(
          cause?.code === "PRIVATE_DIRECTORY_ACL_INVALID"
            ? "APP_SERVER_HOST_ACL_INVALID"
            : "APP_SERVER_HOST_ACL_UNAVAILABLE",
          "The app-server private directory ACL could not be verified.",
          cause,
        );
      }
    },
    expectedEndpoint() {
      return null;
    },
    validateEndpoint(endpoint, directory) {
      return exactLoopbackEndpoint(
        endpoint,
        path.win32.join(directory, "capability-token"),
      );
    },
    migrateLegacyHost() {
      return null;
    },
    async launch({ runtime, directory, timeoutMs, retryIntervalMs }) {
      const tokenPath = path.win32.join(directory, "capability-token");
      await remove(tokenPath, { force: true });
      const token = tokenBytes(32).toString("base64url");
      try {
        await writeToken(tokenPath, token, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (cause) {
        throw platformError(
          "APP_SERVER_HOST_TOKEN_CREATE_FAILED",
          "The Codex app-server capability token could not be created.",
          cause,
        );
      }
      let launcher;
      let appServerPid = null;
      try {
        const appServerArgs = [
          "app-server",
          "--listen",
          "ws://127.0.0.1:0",
          "--ws-auth",
          "capability-token",
          "--ws-token-file",
          tokenPath,
        ];
        launcher = spawnHost(
          spawnProcess,
          windowsPowerShellPath(env),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            encodedPowerShell(WINDOWS_HIDDEN_HOST_SCRIPT),
          ],
          {
            cwd: directory,
            detached: false,
            env: {
              ...env,
              [WINDOWS_CODEX_EXECUTABLE_VARIABLE]: runtime.executablePath,
              [WINDOWS_CODEX_ARGUMENTS_VARIABLE]: windowsCommandLine(appServerArgs),
              [WINDOWS_CODEX_DIRECTORY_VARIABLE]: directory,
            },
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const startupFailure = childFailureTracker(launcher);
        const startup = await waitForWindowsStartup(launcher, tokenPath, {
          timeoutMs,
          retryIntervalMs,
          startupFailure,
          onPid(pid) { appServerPid = pid; },
        });
        appServerPid = startup.pid;
        const endpoint = await waitUntilReady({
          child: launcher,
          endpoint: startup.endpoint,
          probe: probeEndpoint,
          timeoutMs,
          retryIntervalMs,
          startupFailure,
        });
        launcher.stdout.destroy();
        launcher.stderr.destroy();
        launcher.unref();
        return Object.freeze({ pid: appServerPid, endpoint });
      } catch (cause) {
        let terminationFailure = null;
        if (appServerPid !== null) {
          try {
            terminateProcess(appServerPid);
          } catch (terminationCause) {
            if (terminationCause?.code !== "ESRCH") {
              terminationFailure = terminationCause;
            }
          }
        }
        if (launcher && !childExited(launcher)) launcher.kill();
        await remove(tokenPath, { force: true });
        if (terminationFailure) {
          throw platformError(
            "APP_SERVER_HOST_CLEANUP_FAILED",
            "The failed Codex app-server process could not be terminated.",
            terminationFailure,
          );
        }
        throw cause;
      }
    },
    probe: probeEndpoint,
    inspectProcess,
    sameExecutable(left, right) {
      return path.win32.normalize(left).toLowerCase()
        === path.win32.normalize(right).toLowerCase();
    },
    async cleanup(endpoint, directory) {
      if (endpoint) this.validateEndpoint(endpoint, directory);
      await remove(
        path.win32.join(directory, "capability-token"),
        { force: true },
      );
    },
  });
}

export function createCodexAppServerHostPlatform({
  platform = process.platform,
  env = process.env,
  execute = execFileAsync,
  spawnProcess = spawn,
  probeEndpoint = probeCodexAppServerWebSocket,
  inspectMacProcess = readMacProcess,
  inspectWindowsProcess = (pid) => readWindowsProcess(pid, { env, execute }),
  chmodSocket = chmod,
  remove = rm,
  terminateProcess = process.kill,
  writeToken = writeFile,
  tokenBytes = randomBytes,
} = {}) {
  if (platform === "darwin") {
    return createMacAdapter({
      spawnProcess,
      probeEndpoint,
      inspectProcess: inspectMacProcess,
      chmodSocket,
      remove,
    });
  }
  if (platform === "win32") {
    return createWindowsAdapter({
      env,
      execute,
      spawnProcess,
      probeEndpoint,
      inspectProcess: inspectWindowsProcess,
      remove,
      terminateProcess,
      writeToken,
      tokenBytes,
    });
  }
  throw platformError(
    "APP_SERVER_HOST_PLATFORM_UNSUPPORTED",
    `Codex Small Loop has no app-server host transport for ${platform}.`,
  );
}
