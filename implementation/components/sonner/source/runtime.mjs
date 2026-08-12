import {
  parseRecoverySupervisorDiagnosticSource,
} from "../../runtime/source/recovery-supervisor-diagnostic.mjs";
import { parseTaskLedgerRecord } from "../../runtime/source/task-ledger.mjs";
import { buildTaskForest } from "../../runtime/source/task-forest.mjs";
import { readSonnerRuntimeRecord } from "./sonner-runtime-reader.mjs";
import { observeSonnerTasks } from "./sonner-task-history-reader.mjs";
import { isSonnerOperationAbort } from "./sonner-project-reader.mjs";

const MAX_RUNTIME_TASKS = 512;
const RUNTIME_REASON_ORDER = [
  "history_unavailable",
  "observation_failed",
  "task_aborted",
  "runtime_diagnostic",
];
const VISIBLE_TASK_STATES = new Set(["running", "not_started", "aborted", "unknown"]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readLedger(project, projectSession) {
  if (!projectSession) {
    const error = new Error("Sonner Runtime requires an authorized Project session.");
    error.code = "LEDGER_INVALID";
    throw error;
  }
  const record = await readSonnerRuntimeRecord({ session: projectSession, mode: "ledger" });
  if (record.status === "missing") {
    const error = new Error("Runtime ledger is missing.");
    error.code = "LEDGER_NOT_FOUND";
    throw error;
  }
  if (record.status !== "present") {
    const error = new Error("Runtime ledger is unsafe.");
    error.code = "LEDGER_INVALID";
    throw error;
  }
  return parseTaskLedgerRecord(record.bytes, project);
}

async function readDiagnostic(projectSession) {
  const record = await readSonnerRuntimeRecord({ session: projectSession, mode: "diagnostic" });
  if (record.status === "missing") return null;
  if (record.status !== "present") throw new Error("Runtime diagnostic is unsafe.");
  return parseRecoverySupervisorDiagnosticSource(record.bytes);
}

class RuntimeStructureError extends Error {}

function validateRuntimeForest(ledger) {
  const relationships = ledger.links.map((link) => ({
    parentId: link.parentTaskId,
    childId: link.childTaskId,
  }));
  const retainedEndpoints = new Set(ledger.links.flatMap(({ parentTaskId, childTaskId }) => [
    parentTaskId,
    childTaskId,
  ]));
  for (const launch of ledger.pendingLaunches) {
    if (launch.childTaskId === null) continue;
    if (retainedEndpoints.has(launch.childTaskId)) throw new RuntimeStructureError();
    relationships.push({ parentId: launch.parentTaskId, childId: launch.childTaskId });
  }
  const admitted = new Set();
  for (const { parentId, childId } of relationships) {
    if (typeof parentId !== "string" || parentId.length === 0
      || typeof childId !== "string" || childId.length === 0) throw new RuntimeStructureError();
    admitted.add(parentId);
    admitted.add(childId);
    if (admitted.size > MAX_RUNTIME_TASKS) throw new RuntimeStructureError();
  }
  if (relationships.length === 0) return;
  try {
    buildTaskForest(relationships.map(({ parentId, childId }) => ({
      parentTaskId: parentId,
      childTaskId: childId,
      lifecycle: "open",
    })));
  } catch {
    throw new RuntimeStructureError();
  }
}

function openRuntimeRelationships(ledger) {
  const relationships = ledger.links
    .filter(({ lifecycle }) => lifecycle === "open")
    .map((link) => ({
      parentId: link.parentTaskId,
      childId: link.childTaskId,
      createdAt: link.createdAt,
    }));
  for (const launch of ledger.pendingLaunches) {
    if (launch.childTaskId === null) continue;
    relationships.push({
      parentId: launch.parentTaskId,
      childId: launch.childTaskId,
      createdAt: launch.createdAt,
    });
  }
  relationships.sort((left, right) =>
    compareText(left.parentId, right.parentId)
    || compareText(left.createdAt, right.createdAt)
    || compareText(left.childId, right.childId));
  return relationships;
}

function activeTaskOrder(ledger) {
  const relationships = openRuntimeRelationships(ledger);
  const admitted = new Set();
  const admit = (taskId) => {
    if (typeof taskId !== "string" || taskId.length === 0) throw new RuntimeStructureError();
    admitted.add(taskId);
    if (admitted.size > MAX_RUNTIME_TASKS) throw new RuntimeStructureError();
  };
  for (const { parentId, childId } of relationships) {
    admit(parentId);
    admit(childId);
  }
  for (const launch of ledger.pendingLaunches) {
    admit(launch.parentTaskId);
    if (launch.childTaskId !== null) admit(launch.childTaskId);
  }
  if (relationships.length > 0) {
    try {
      buildTaskForest(relationships.map(({ parentId, childId }) => ({
        parentTaskId: parentId,
        childTaskId: childId,
        lifecycle: "open",
      })));
    } catch {
      throw new RuntimeStructureError();
    }
  }
  return [...admitted].sort(compareText);
}

function publicTurnState(snapshot) {
  if (!snapshot || snapshot.turnState === "unknown" || snapshot.diagnostics?.length > 0) return "unknown";
  if (snapshot.turnState === "in_progress") return "running";
  return new Set(["not_started", "ended", "aborted"]).has(snapshot.turnState)
    ? snapshot.turnState
    : "unknown";
}

function observedSnapshots(taskIds, snapshots) {
  if (!Array.isArray(snapshots)) return new Map();
  const requested = new Set(taskIds);
  const result = new Map();
  for (const snapshot of snapshots) {
    if (
      !snapshot
      || typeof snapshot.taskId !== "string"
      || !requested.has(snapshot.taskId)
      || result.has(snapshot.taskId)
    ) continue;
    result.set(snapshot.taskId, snapshot);
  }
  return result;
}

function taskMetadata(ledger) {
  const metadata = new Map(ledger.managedTasks.map((task) => [task.taskId, task]));
  for (const launch of ledger.pendingLaunches) {
    if (launch.childTaskId !== null && !metadata.has(launch.childTaskId)) {
      metadata.set(launch.childTaskId, {
        taskId: launch.childTaskId,
        name: launch.name,
        role: launch.role,
      });
    }
  }
  return metadata;
}

function orderedReasons(values) {
  const reasons = new Set(values);
  return RUNTIME_REASON_ORDER.filter((reason) => reasons.has(reason));
}

function snapshotReason(snapshot) {
  if (!snapshot) return "observation_failed";
  if (publicTurnState(snapshot) !== "unknown") return null;
  return snapshot.diagnostics?.some(({ code }) => typeof code === "string" && code.includes("HISTORY"))
    ? "history_unavailable"
    : "observation_failed";
}

export async function buildRuntimeProjection(project, options = {}) {
  const loadLedger = options.readLedger ?? ((current) => readLedger(current, options.projectSession));
  let ledger;
  try {
    ledger = await loadLedger(project);
  } catch (error) {
    if (isSonnerOperationAbort(error) || options.projectSession?.signal?.aborted) {
      throw options.projectSession?.signal?.reason ?? error;
    }
    return error?.code === "LEDGER_NOT_FOUND"
      ? { status: "missing" }
      : { status: "invalid" };
  }

  let taskIds;
  try {
    validateRuntimeForest(ledger);
    taskIds = activeTaskOrder(ledger);
  } catch (error) {
    if (error instanceof RuntimeStructureError) return { status: "invalid" };
    throw error;
  }

  const cachedPaths = new Map(
    ledger.links
      .filter(({ childTaskId, historyFile }) => taskIds.includes(childTaskId) && historyFile !== null)
      .map(({ childTaskId, historyFile }) => [childTaskId, historyFile]),
  );
  options.projectSession?.throwIfAborted();
  const observation = taskIds.length === 0
    ? Promise.resolve([])
    : Promise.resolve().then(() => (options.observeTasks ?? observeSonnerTasks)(
      taskIds.map((taskId) => ({ taskId, mode: "latest" })),
      { cachedPaths, ...(options.observerOptions ?? {}), session: options.projectSession },
    ));
  const diagnostic = Promise.resolve().then(() =>
    (options.readDiagnostic ?? (() => readDiagnostic(options.projectSession)))());
  const [observationResult, diagnosticResult] = await Promise.allSettled([observation, diagnostic]);
  if (options.projectSession?.signal?.aborted) throw options.projectSession.signal.reason;
  if (observationResult.status === "rejected" && isSonnerOperationAbort(observationResult.reason)) {
    throw observationResult.reason;
  }
  if (diagnosticResult.status === "rejected" && isSonnerOperationAbort(diagnosticResult.reason)) {
    throw diagnosticResult.reason;
  }

  const snapshots = observationResult.status === "fulfilled"
    ? observationResult.value
    : taskIds.map((taskId) => ({
      taskId,
      location: "missing",
      latestTurnId: null,
      turnState: "unknown",
      diagnostics: [{ code: "TASK_OBSERVATION_FAILED" }],
    }));
  const snapshotByTaskId = observedSnapshots(taskIds, snapshots);
  const metadata = taskMetadata(ledger);
  const tasks = taskIds.map((taskId) => {
    const task = metadata.get(taskId);
    return {
      id: taskId,
      name: task?.name ?? null,
      role: task?.role ?? "controller",
      turnState: publicTurnState(snapshotByTaskId.get(taskId)),
    };
  }).filter(({ turnState }) => VISIBLE_TASK_STATES.has(turnState));
  const reasons = orderedReasons([
    ...taskIds.map((taskId) => snapshotReason(snapshotByTaskId.get(taskId))),
    ...(tasks.some(({ turnState }) => turnState === "aborted") ? ["task_aborted"] : []),
    ...(diagnosticResult.status === "rejected" ? ["observation_failed"] : []),
    ...(diagnosticResult.status === "fulfilled" && diagnosticResult.value !== null
      ? ["runtime_diagnostic"] : []),
  ].filter(Boolean));
  const unknown = observationResult.status === "rejected"
    || diagnosticResult.status === "rejected"
    || tasks.some(({ turnState }) => turnState === "unknown");
  const attention = !unknown && (
    diagnosticResult.value !== null
    || tasks.some(({ turnState }) => turnState === "aborted")
  );
  return {
    status: "available",
    health: unknown ? "unknown" : attention ? "attention" : "ok",
    reasons,
    tasks,
  };
}
