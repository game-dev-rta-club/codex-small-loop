import { randomUUID } from "node:crypto";
import { spawn as spawnProcess } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as waitFor } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { runHeartbeat } from "./heartbeat.mjs";
import {
  clearRecoverySupervisorDiagnostic,
  writeRecoverySupervisorDiagnostic,
} from "./recovery-supervisor-diagnostic.mjs";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_START_TIMEOUT_MS = 2_000;
const DEFAULT_START_POLL_INTERVAL_MS = 25;
const MIN_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 60_000;
const SUPERVISOR_SCRIPT = fileURLToPath(
  new URL("../internal/recovery-supervisor.mjs", import.meta.url),
);

function supervisorError(code, message, cause) {
  const error = new Error(message);
  error.name = "RecoverySupervisorError";
  error.code = code;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function requireProjectRoot(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || !path.isAbsolute(value)
  ) {
    throw supervisorError(
      "RECOVERY_SUPERVISOR_INVALID",
      "Recovery Supervisor requires an absolute project root.",
    );
  }
  return path.normalize(value);
}

function requireInterval(value) {
  const intervalMs = value ?? DEFAULT_INTERVAL_MS;
  if (
    !Number.isSafeInteger(intervalMs)
    || intervalMs < MIN_INTERVAL_MS
    || intervalMs > MAX_INTERVAL_MS
  ) {
    throw supervisorError(
      "RECOVERY_SUPERVISOR_INVALID",
      `Recovery Supervisor interval must be from ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS} milliseconds.`,
    );
  }
  return intervalMs;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function stopOwnedChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill();
  } catch {
    // The exact child owned by this caller may already have exited.
  }
}

function parseOwner(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !Number.isSafeInteger(value.pid)
    || value.pid < 1
    || typeof value.token !== "string"
    || value.token.length === 0
    || value.token.length > 512
  ) {
    return null;
  }
  return { pid: value.pid, token: value.token };
}

async function inspectOwner(lockFile, read = readFile) {
  let source;
  try {
    source = await read(lockFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { state: "absent" };
    }
    throw supervisorError(
      "RECOVERY_SUPERVISOR_LOCK_INVALID",
      "Recovery Supervisor lock ownership could not be read and was retained.",
      error,
    );
  }
  const owner = parseOwner(source);
  if (!owner) {
    throw supervisorError(
      "RECOVERY_SUPERVISOR_LOCK_INVALID",
      "Recovery Supervisor lock ownership is malformed and was retained.",
    );
  }
  return { state: "present", owner, source };
}

async function readOwner(lockFile, read = readFile) {
  const observation = await inspectOwner(lockFile, read);
  return observation.state === "present" ? observation.owner : null;
}

export async function acquireProjectSupervisorLock(
  projectRoot,
  options = {},
) {
  const root = requireProjectRoot(projectRoot);
  const directory = path.join(root, ".codex-small-loop");
  const lockFile = path.join(directory, "recovery-supervisor.lock");
  const pid = options.pid ?? process.pid;
  const token = options.token ?? randomUUID();
  const isAlive = options.processIsAlive ?? processIsAlive;
  const inspect = options.inspectOwner
    ?? ((file) => inspectOwner(file, options.readFile ?? readFile));
  await (options.mkdir ?? mkdir)(directory, {
    recursive: true,
    mode: 0o700,
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    try {
      handle = await (options.open ?? open)(lockFile, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({
        pid,
        token,
      })}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      return {
        state: "acquired",
        async release() {
          const owner = await readOwner(
            lockFile,
            options.readFile ?? readFile,
          );
          if (owner?.token === token) {
            await (options.rm ?? rm)(lockFile, { force: true });
          }
        },
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== "EEXIST") {
        throw supervisorError(
          "RECOVERY_SUPERVISOR_LOCK_FAILED",
          "Recovery Supervisor could not acquire its project lock.",
          error,
        );
      }
      const observed = await inspect(lockFile);
      if (observed.state === "absent") {
        continue;
      }
      if (isAlive(observed.owner.pid)) {
        return { state: "already_running" };
      }
      const revalidated = await inspect(lockFile);
      if (
        revalidated.state !== "present"
        || revalidated.source !== observed.source
      ) {
        throw supervisorError(
          "RECOVERY_SUPERVISOR_LOCK_CHANGED",
          "Recovery Supervisor lock ownership changed during stale-lock recovery.",
        );
      }
      await (options.rm ?? rm)(lockFile, { force: true });
    }
  }

  throw supervisorError(
    "RECOVERY_SUPERVISOR_LOCK_FAILED",
    "Recovery Supervisor lock changed repeatedly during acquisition.",
  );
}

export function supervisorHasWork(report) {
  const summary = report?.summary;
  return Boolean(
    summary
    && (
      summary.pendingLaunches > 0
      || summary.activeConversations > 0
      || summary.pendingDeliveries > 0
      || summary.pendingAppMessages > 0
      || summary.recoveryCandidates > 0
      || summary.unresolvedRecoveries > 0
    )
  );
}

export async function runRecoverySupervisor(input, options = {}) {
  const projectRoot = requireProjectRoot(input?.projectRoot);
  const intervalMs = requireInterval(options.intervalMs);
  const acquireLock = options.acquireLock
    ?? acquireProjectSupervisorLock;
  const ownership = await acquireLock(projectRoot);

  if (ownership.state === "already_running") {
    return {
      run: "ok",
      state: "already_running",
      iterations: 0,
    };
  }

  const heartbeat = options.heartbeat ?? runHeartbeat;
  const writeDiagnostic = options.writeDiagnostic
    ?? writeRecoverySupervisorDiagnostic;
  const clearDiagnostic = options.clearDiagnostic
    ?? clearRecoverySupervisorDiagnostic;
  const now = options.now ?? (() => new Date().toISOString());
  const wait = options.wait ?? ((duration) =>
    waitFor(duration, undefined, { signal: options.signal }));
  let iterations = 0;
  let consecutiveDiagnostics = 0;
  let consecutiveHeartbeatFailures = 0;

  try {
    while (!options.signal?.aborted) {
      try {
        const report = await heartbeat(
          { projectRoot },
        );
        iterations += 1;
        consecutiveHeartbeatFailures = 0;
        if (report?.run === "partial") {
          consecutiveDiagnostics += 1;
          await writeDiagnostic(
            projectRoot,
            Object.assign(
              new Error("Heartbeat completed with unresolved events."),
              { code: "HEARTBEAT_PARTIAL" },
            ),
            consecutiveDiagnostics,
            now(),
            { events: report.events },
          );
        } else {
          await clearDiagnostic(projectRoot);
          consecutiveDiagnostics = 0;
        }
        if (!supervisorHasWork(report)) {
          return {
            run: "ok",
            state: "idle",
            iterations,
          };
        }
      } catch (error) {
        iterations += 1;
        consecutiveDiagnostics += 1;
        consecutiveHeartbeatFailures += 1;
        await writeDiagnostic(
          projectRoot,
          error,
          consecutiveDiagnostics,
          now(),
        );
      }

      const delayMs = Math.min(
        intervalMs * (2 ** Math.max(0, consecutiveHeartbeatFailures - 1)),
        MAX_INTERVAL_MS,
      );
      try {
        await wait(delayMs);
      } catch (error) {
        if (error?.name !== "AbortError") {
          throw error;
        }
      }
    }

    return {
      run: "ok",
      state: "stopped",
      iterations,
    };
  } finally {
    await ownership.release();
  }
}

export async function waitForSupervisorStart(
  projectRoot,
  child,
  options = {},
) {
  const root = requireProjectRoot(projectRoot);
  const lockFile = path.join(
    root,
    ".codex-small-loop",
    "recovery-supervisor.lock",
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs
    ?? DEFAULT_START_POLL_INTERVAL_MS;
  const inspectOwner = options.readOwner ?? readOwner;
  const isAlive = options.processIsAlive ?? processIsAlive;
  const wait = options.wait ?? waitFor;
  let spawnError = null;
  child.once?.("error", (error) => {
    spawnError = error;
  });

  const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (spawnError) {
      throw supervisorError(
        "RECOVERY_SUPERVISOR_START_FAILED",
        "Recovery Supervisor process could not start.",
        spawnError,
      );
    }
    const owner = await inspectOwner(lockFile);
    if (isAlive(owner?.pid)) {
      return {
        state: owner.pid === child.pid
          ? "started"
          : "already_running",
        pid: owner.pid,
      };
    }
    await wait(pollIntervalMs);
  }

  throw supervisorError(
    "RECOVERY_SUPERVISOR_START_FAILED",
    "Recovery Supervisor did not acquire its project lock before the startup timeout.",
  );
}

export async function startRecoverySupervisor(projectRoot, options = {}) {
  const root = requireProjectRoot(projectRoot);
  const executable = options.executable ?? process.execPath;
  const script = options.script ?? SUPERVISOR_SCRIPT;
  const spawn = options.spawn ?? spawnProcess;
  const lockFile = path.join(
    root,
    ".codex-small-loop",
    "recovery-supervisor.lock",
  );
  const inspectOwner = options.readOwner ?? readOwner;
  const isAlive = options.processIsAlive ?? processIsAlive;
  const currentOwner = await inspectOwner(lockFile);
  if (isAlive(currentOwner?.pid)) {
    return {
      state: "already_running",
      pid: currentOwner.pid,
    };
  }

  const child = spawn(
    executable,
    [script, "--project-root", root],
    {
      cwd: root,
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    },
  );
  child.unref();
  const waitForStart = options.waitForStart ?? waitForSupervisorStart;
  try {
    const result = await waitForStart(root, child, options);
    if (result.pid !== child.pid) {
      stopOwnedChild(child);
    }
    return result;
  } catch (error) {
    stopOwnedChild(child);
    throw error;
  }
}
