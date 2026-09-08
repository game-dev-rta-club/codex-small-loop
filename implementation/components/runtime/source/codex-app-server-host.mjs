import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { AtomicJsonStore } from "./atomic-json-store.mjs";
import {
  createCodexAppServerHostPlatform,
} from "./codex-app-server-host-platform.mjs";
import { resolveCodexRuntime } from "./codex-runtime-resolver.mjs";

const HOST_STATE_VERSION = 2;
const START_TIMEOUT_MS = 10_000;
const RETRY_INTERVAL_MS = 25;

function hostError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "CodexAppServerHostError";
  error.code = code;
  return error;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function probeProcess(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause?.code === "ESRCH") return false;
    throw hostError(
      "APP_SERVER_HOST_IDENTITY_UNCERTAIN",
      `Could not verify Codex Small Loop app-server PID ${pid}.`,
      cause,
    );
  }
}

function normalizeHost(host, { directory, hostPlatform }) {
  if (
    host === null
    || typeof host !== "object"
    || Array.isArray(host)
    || !Number.isSafeInteger(host.pid)
    || host.pid <= 0
    || typeof host.executablePath !== "string"
    || !path.isAbsolute(host.executablePath)
    || typeof host.executableVersion !== "string"
    || host.executableVersion.length === 0
    || typeof host.startedAt !== "string"
    || Number.isNaN(Date.parse(host.startedAt))
  ) {
    throw hostError(
      "APP_SERVER_HOST_STATE_INVALID",
      "The Codex Small Loop app-server host state is invalid.",
    );
  }
  let endpoint;
  try {
    endpoint = hostPlatform.validateEndpoint(host.endpoint, directory);
  } catch (cause) {
    throw hostError(
      "APP_SERVER_HOST_STATE_INVALID",
      "The Codex Small Loop app-server endpoint state is invalid.",
      cause,
    );
  }
  return {
    pid: host.pid,
    executablePath: host.executablePath,
    executableVersion: host.executableVersion,
    endpoint,
    startedAt: host.startedAt,
  };
}

function normalizeState(state, { directory, hostPlatform }) {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw hostError(
      "APP_SERVER_HOST_STATE_INVALID",
      "The Codex Small Loop app-server host state is invalid.",
    );
  }
  let candidate = state;
  let migrated = false;
  if (state.version === 1) {
    const legacyHost = state.host === null
      ? null
      : hostPlatform.migrateLegacyHost(state.host, directory);
    if (state.host !== null && legacyHost === null) {
      throw hostError(
        "APP_SERVER_HOST_STATE_INVALID",
        "The legacy Codex Small Loop app-server host state cannot be migrated on this platform.",
      );
    }
    candidate = { version: HOST_STATE_VERSION, host: legacyHost };
    migrated = true;
  }
  if (
    candidate.version !== HOST_STATE_VERSION
    || (candidate.host !== null && typeof candidate.host !== "object")
  ) {
    throw hostError(
      "APP_SERVER_HOST_STATE_INVALID",
      "The Codex Small Loop app-server host state is invalid.",
    );
  }
  const host = candidate.host === null
    ? null
    : normalizeHost(candidate.host, { directory, hostPlatform });
  return {
    state: { version: HOST_STATE_VERSION, host },
    migrated,
  };
}

async function waitForRecordedHost(host, {
  hostPlatform,
  timeoutMs,
  retryIntervalMs,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await hostPlatform.probe(host.endpoint)) return;
    await sleep(retryIntervalMs);
  }
  throw hostError(
    "APP_SERVER_HOST_NOT_READY",
    "The recorded Codex Small Loop app-server host did not become ready in time.",
  );
}

async function inspectRecordedHost(host, {
  hostPlatform,
  processProbe,
  timeoutMs,
  retryIntervalMs,
}) {
  if (!processProbe(host.pid)) return "dead";

  let processInfo;
  try {
    processInfo = await hostPlatform.inspectProcess(host.pid);
  } catch (cause) {
    throw hostError(
      "APP_SERVER_HOST_IDENTITY_UNCERTAIN",
      "The recorded Codex Small Loop app-server process could not be inspected.",
      cause,
    );
  }
  if (
    typeof processInfo?.executablePath !== "string"
    || !hostPlatform.sameExecutable(
      processInfo.executablePath,
      host.executablePath,
    )
  ) {
    throw hostError(
      "APP_SERVER_HOST_IDENTITY_INVALID",
      "The recorded Codex Small Loop app-server PID belongs to another executable.",
    );
  }
  await waitForRecordedHost(host, {
    hostPlatform,
    timeoutMs,
    retryIntervalMs,
  });
  return "ready";
}

function resultFromHost(host, reused) {
  return Object.freeze({
    endpoint: Object.freeze({ ...host.endpoint }),
    executablePath: host.executablePath,
    executableVersion: host.executableVersion,
    reused,
  });
}

export function codexAppServerHostDirectory(codexHome, runtime) {
  const identity = createHash("sha256")
    .update(JSON.stringify([runtime.executablePath, runtime.version]))
    .digest("hex").slice(0, 16);
  return path.join(codexHome, "codex-small-loop", `app-server-${identity}`);
}

export async function ensureCodexAppServerHost({
  codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
  resolveRuntime = resolveCodexRuntime,
  hostPlatform = createCodexAppServerHostPlatform(),
  processProbe = probeProcess,
  startTimeoutMs = START_TIMEOUT_MS,
  retryIntervalMs = RETRY_INTERVAL_MS,
  now = () => new Date(),
  store,
} = {}) {
  if (typeof codexHome !== "string" || !path.isAbsolute(codexHome)) {
    throw new TypeError("codexHome must be an absolute path");
  }
  // Resolve even when a host is alive: Desktop can replace the binary in place.
  // Separate endpoints preserve old clients while new clients use the new runtime.
  const runtime = await resolveRuntime();
  const directory = codexAppServerHostDirectory(codexHome, runtime);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await hostPlatform.prepareDirectory(directory);

  const stateStore = store ?? new AtomicJsonStore(
    path.join(directory, "host.json"),
    {
      lockTimeoutMs: startTimeoutMs + 2_000,
      lockRetryMs: retryIntervalMs,
    },
  );
  await stateStore.initialize({
    version: HOST_STATE_VERSION,
    host: null,
  });

  const transaction = await stateStore.transact(async (sourceState) => {
    const normalized = normalizeState(sourceState, { directory, hostPlatform });
    const state = normalized.state;
    if (state.host) {
      if (state.host.executablePath !== runtime.executablePath
        || state.host.executableVersion !== runtime.version) {
        throw hostError(
          "APP_SERVER_HOST_RUNTIME_MISMATCH",
          "The recorded app-server does not match the selected Codex runtime.",
        );
      }
      const status = await inspectRecordedHost(state.host, {
        hostPlatform,
        processProbe,
        timeoutMs: startTimeoutMs,
        retryIntervalMs,
      });
      if (status === "ready") {
        return {
          state,
          result: resultFromHost(state.host, true),
          commit: normalized.migrated,
        };
      }
      await hostPlatform.cleanup(state.host.endpoint, directory);
    } else {
      await hostPlatform.cleanup(null, directory);
    }

    const launched = await hostPlatform.launch({
      runtime,
      directory,
      timeoutMs: startTimeoutMs,
      retryIntervalMs,
    });
    const host = normalizeHost({
      pid: launched.pid,
      executablePath: runtime.executablePath,
      executableVersion: runtime.version,
      endpoint: launched.endpoint,
      startedAt: now().toISOString(),
    }, { directory, hostPlatform });
    return {
      state: { version: HOST_STATE_VERSION, host },
      result: resultFromHost(host, false),
    };
  });
  return transaction.result;
}
