import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { AtomicJsonStore } from "./atomic-json-store.mjs";
import { protectPrivateDirectory } from "./private-directory.mjs";
import { resolveProject } from "./project.mjs";
import {
  readRecoverySupervisorDiagnostic,
} from "./recovery-supervisor-diagnostic.mjs";
import {
  compactTaskLedger,
  initializeTaskLedger,
  readTaskLedger,
  transactTaskLedger,
} from "./task-ledger.mjs";

const IGNORE_ENTRY = "/.codex-small-loop/";

function unsafeRuntimeDirectory(cause) {
  const error = new Error("Project private runtime must be a real directory.", cause ? { cause } : undefined);
  error.name = "ProjectRuntimeError";
  error.code = "PROJECT_RUNTIME_DIRECTORY_UNSAFE";
  return error;
}

async function inspectRuntimeDirectory(directory) {
  let status;
  try {
    status = await lstat(directory, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw unsafeRuntimeDirectory(error);
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw unsafeRuntimeDirectory();
  }
  return status;
}

async function ensurePrivateProjectRuntime(project) {
  let status = await inspectRuntimeDirectory(project.directory);
  if (!status) {
    try {
      await mkdir(project.directory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    status = await inspectRuntimeDirectory(project.directory);
  }
  if (!status) throw unsafeRuntimeDirectory();
  await protectPrivateDirectory(project.directory);
  const verified = await inspectRuntimeDirectory(project.directory);
  if (!verified || verified.dev !== status.dev || verified.ino !== status.ino) {
    throw unsafeRuntimeDirectory();
  }
}

async function readOptionalText(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function writeTextAtomically(file, source) {
  const temporary = `${file}.${process.pid}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o644);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

export async function ensureProjectIgnored(projectRoot) {
  const file = path.join(projectRoot, ".gitignore");
  const source = await readOptionalText(file);
  const matches = source
    .split(/\r?\n/)
    .filter((line) => line === IGNORE_ENTRY)
    .length;
  if (matches === 1) {
    return false;
  }
  if (matches === 0) {
    const prefix = source.length === 0 || source.endsWith("\n")
      ? source
      : `${source}\n`;
    await writeTextAtomically(file, `${prefix}${IGNORE_ENTRY}\n`);
    return true;
  }

  let retained = false;
  const next = source
    .split(/\r?\n/)
    .filter((line) => {
      if (line !== IGNORE_ENTRY) return true;
      if (retained) return false;
      retained = true;
      return true;
    })
    .join("\n");
  await writeTextAtomically(file, next.endsWith("\n") ? next : `${next}\n`);
  return true;
}

export async function prepareProjectRuntime(project) {
  await ensurePrivateProjectRuntime(project);
  const gitignoreChanged = await ensureProjectIgnored(project.root);
  return {
    directory: project.directory,
    gitignoreFile: path.join(project.root, ".gitignore"),
    gitignoreChanged,
  };
}

function legacyAutomationFiles(project) {
  return [
    path.join(project.directory, "automation.toml"),
    path.join(project.directory, "message-automation.toml"),
  ];
}

async function initializeLocalLedger(project, store, now) {
  return initializeTaskLedger(store, project, now);
}

export async function assertRuntimeAvailable(project, options = {}) {
  await prepareProjectRuntime(project);
  const store = options.store ?? new AtomicJsonStore(project.stateFile);
  let ledger;
  try {
    ledger = await readTaskLedger(store, project);
  } catch (error) {
    if (error?.code !== "LEDGER_NOT_FOUND") throw error;
    ledger = await initializeLocalLedger(
      project,
      store,
      options.now ?? new Date().toISOString(),
    );
  }
  return { project, ledger };
}

function summarizeWork(ledger) {
  return {
    pendingLaunches: ledger.pendingLaunches.length,
    openLinks: ledger.links.filter(({ lifecycle }) => lifecycle === "open")
      .length,
    stoppedLinks: ledger.links.filter(({ lifecycle }) =>
      lifecycle === "stopped"
    ).length,
    pendingDeliveries: ledger.deliveries.filter(({ status }) =>
      status === "ready" || status === "leased"
    ).length,
    pendingAppMessages: ledger.appMessages.filter(({ status }) =>
      status === "ready"
      || status === "leased"
      || status === "scheduled"
    ).length,
  };
}

export async function inspectProjectRuntime(projectRoot, options = {}) {
  const project = await resolveProject(projectRoot);
  const store = options.store ?? new AtomicJsonStore(project.stateFile);
  try {
    const ledger = await readTaskLedger(store, project);
    const readDiagnostic = options.readRecoverySupervisorDiagnostic
      ?? readRecoverySupervisorDiagnostic;
    let diagnostic;
    try {
      diagnostic = await readDiagnostic(project.root);
    } catch (error) {
      return {
        run: "degraded",
        configured: true,
        readiness: "repair_required",
        projectRoot: project.root,
        projectKey: project.key,
        work: summarizeWork(ledger),
        issues: [{
          code: error?.code
            ?? "RECOVERY_SUPERVISOR_DIAGNOSTIC_INVALID",
          message: error?.message
            ?? "Recovery Supervisor diagnostic could not be read.",
        }],
      };
    }
    if (diagnostic) {
      return {
        run: "degraded",
        configured: true,
        readiness: "repair_required",
        projectRoot: project.root,
        projectKey: project.key,
        work: summarizeWork(ledger),
        issues: [{
          code: "RECOVERY_SUPERVISOR_HEARTBEAT_FAILED",
          message: diagnostic.message,
          details: {
            causeCode: diagnostic.code,
            consecutiveFailures: diagnostic.consecutiveFailures,
            updatedAt: diagnostic.updatedAt,
            ...(diagnostic.events
              ? { events: diagnostic.events }
              : {}),
          },
        }],
      };
    }
    return {
      run: "ok",
      configured: true,
      readiness: "ready",
      projectRoot: project.root,
      projectKey: project.key,
      work: summarizeWork(ledger),
      issues: [],
    };
  } catch (error) {
    if (error?.code !== "LEDGER_NOT_FOUND") throw error;
    return {
      run: "degraded",
      configured: false,
      readiness: "setup_required",
      projectRoot: project.root,
      projectKey: project.key,
      work: {
        pendingLaunches: 0,
        openLinks: 0,
        stoppedLinks: 0,
        pendingDeliveries: 0,
        pendingAppMessages: 0,
      },
      issues: [{
        code: "RUNTIME_NOT_CONFIGURED",
        message: "Codex Small Loop local runtime has not been initialized.",
      }],
    };
  }
}

export async function repairProjectRuntime(projectRoot, options = {}) {
  const project = await resolveProject(projectRoot);
  await prepareProjectRuntime(project);
  const store = options.store ?? new AtomicJsonStore(project.stateFile);
  const now = options.now ?? new Date().toISOString();
  const actions = [];
  try {
    await readTaskLedger(store, project);
  } catch (error) {
    if (error?.code !== "LEDGER_NOT_FOUND") throw error;
    await initializeLocalLedger(project, store, now);
    actions.push("runtime_initialized");
  }
  await transactTaskLedger(
    store,
    project,
    (state) => ({ state: compactTaskLedger(state), result: null }),
    { now },
  );
  await Promise.all(
    legacyAutomationFiles(project).map((file) => rm(file, { force: true })),
  );
  const inspection = await inspectProjectRuntime(project.root, {
    store,
    readRecoverySupervisorDiagnostic:
      options.readRecoverySupervisorDiagnostic,
  });
  return {
    run: inspection.run,
    actions,
    issues: inspection.issues,
    inspection,
  };
}
