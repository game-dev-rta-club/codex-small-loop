import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { resolveCodexRuntime } from "./codex-runtime-resolver.mjs";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 16 * 1_024;
const COMMAND_TIMEOUT_MS = 10_000;
export const MINIMUM_NODE_MAJOR = 24;

function bounded(value) {
  return String(value ?? "Runtime check failed").slice(0, 512);
}

function failure(error, check) {
  return Object.freeze({
    run: "failed",
    check,
    code: typeof error?.code === "string"
      ? error.code
      : "RUNTIME_DOCTOR_FAILED",
    message: bounded(error?.message),
  });
}

function doctorError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

async function runCodexCheck(runtime, args, execute) {
  return execute(runtime.executablePath, args, {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
}

function authenticationMethod(output) {
  const source = `${output?.stdout ?? ""}\n${output?.stderr ?? ""}`;
  if (/logged in using chatgpt/i.test(source)) return "chatgpt";
  if (/logged in using (?:an? )?api key/i.test(source)) return "api-key";
  return null;
}

function requiredAppServerCapability(platform, help) {
  if (platform === "darwin") {
    if (!/unix:\/\//i.test(help)) {
      throw doctorError(
        "CODEX_APP_SERVER_UNIX_UNAVAILABLE",
        "Codex App Server does not advertise Unix socket transport.",
      );
    }
    return Object.freeze({ transport: "unix-websocket" });
  }
  if (platform === "win32") {
    if (
      !/ws:\/\/IP:PORT/i.test(help)
      || !/--ws-auth\s+<MODE>/i.test(help)
      || !/capability-token/i.test(help)
      || !/--ws-token-file\s+<PATH>/i.test(help)
    ) {
      throw doctorError(
        "CODEX_APP_SERVER_LOOPBACK_AUTH_UNAVAILABLE",
        "Codex App Server does not advertise authenticated WebSocket transport.",
      );
    }
    return Object.freeze({
      transport: "loopback-websocket",
      authentication: "capability-token",
    });
  }
  throw doctorError(
    "CODEX_APP_SERVER_PLATFORM_UNSUPPORTED",
    `Codex App Server transport is unsupported on ${platform}.`,
  );
}

export async function diagnoseCodexRuntime({
  platform = process.platform,
  nodeExecutable = process.execPath,
  nodeVersion = process.version,
  resolveRuntime = resolveCodexRuntime,
  execute = execFileAsync,
} = {}) {
  const pathImplementation = platform === "win32" ? path.win32 : path.posix;
  const nodeMatch = typeof nodeVersion === "string"
    ? nodeVersion.match(/^v(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/)
    : null;
  if (
    typeof nodeExecutable !== "string"
    || !pathImplementation.isAbsolute(nodeExecutable)
    || !nodeMatch
  ) {
    return failure(
      Object.assign(new Error("The active Node.js runtime is invalid."), {
        code: "NODE_RUNTIME_INVALID",
      }),
      "node",
    );
  }
  if (Number(nodeMatch[1]) < MINIMUM_NODE_MAJOR) {
    return failure(
      doctorError(
        "NODE_VERSION_UNSUPPORTED",
        `Codex Small Loop requires Node.js ${MINIMUM_NODE_MAJOR} or newer.`,
      ),
      "node",
    );
  }

  let runtime;
  try {
    runtime = await resolveRuntime({ platform });
  } catch (error) {
    return failure(error, "codex");
  }

  let authOutput;
  try {
    authOutput = await runCodexCheck(runtime, ["login", "status"], execute);
  } catch (error) {
    return failure(
      doctorError(
        "CODEX_AUTH_STATUS_FAILED",
        "Codex authentication status could not be read.",
        error,
      ),
      "authentication",
    );
  }
  const method = authenticationMethod(authOutput);
  if (!method) {
    return failure(
      Object.assign(new Error("Codex CLI is not authenticated."), {
        code: "CODEX_NOT_AUTHENTICATED",
      }),
      "authentication",
    );
  }

  let appServerOutput;
  try {
    appServerOutput = await runCodexCheck(
      runtime,
      ["app-server", "--help"],
      execute,
    );
  } catch (error) {
    return failure(
      doctorError(
        "CODEX_APP_SERVER_UNAVAILABLE",
        "Codex App Server capabilities could not be read.",
        error,
      ),
      "app-server",
    );
  }
  const appServerHelp = `${appServerOutput?.stdout ?? ""}\n${appServerOutput?.stderr ?? ""}`;
  let appServer;
  try {
    appServer = requiredAppServerCapability(platform, appServerHelp);
  } catch (error) {
    return failure(
      error,
      "app-server",
    );
  }

  return Object.freeze({
    run: "ok",
    platform,
    node: Object.freeze({
      executablePath: nodeExecutable,
      version: nodeVersion.slice(1),
    }),
    codex: Object.freeze({
      executablePath: runtime.executablePath,
      version: runtime.version,
      source: runtime.source,
      ...(runtime.publisher ? { publisher: runtime.publisher } : {}),
    }),
    authentication: Object.freeze({ method }),
    appServer,
  });
}
