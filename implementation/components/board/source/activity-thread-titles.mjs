import { lstat } from "node:fs/promises";
import path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import { pathsEqual } from "../../runtime/source/path-identity.mjs";

export const MAX_ACTIVITY_THREAD_TITLE_BYTES = 512;
export const MAX_ACTIVITY_THREAD_TITLE_CHARACTERS = 160;
export const MAX_ACTIVITY_THREAD_TITLE_ROWS = 256;
export const MAX_ACTIVITY_THREAD_DATABASE_BYTES = 32 * 1024 * 1024;
export const MAX_ACTIVITY_THREAD_DATABASE_INDEXES = 32;
export const ACTIVITY_THREAD_DATABASE_BUSY_TIMEOUT_MS = 50;
export const ACTIVITY_THREAD_LOOKUP_TIMEOUT_MS = 400;
export const ACTIVITY_THREAD_TERMINATION_TIMEOUT_MS = 100;
let titleWorkerBarrier = null;

function acceptedTitle(value) {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0
      || [...value].length > MAX_ACTIVITY_THREAD_TITLE_CHARACTERS
      || Buffer.byteLength(value, "utf8") > MAX_ACTIVITY_THREAD_TITLE_BYTES
      || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

async function openReadOnlyDatabase(file) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(file, { readOnly: true, allowExtension: false, timeout: ACTIVITY_THREAD_DATABASE_BUSY_TIMEOUT_MS });
}

function identity(metadata) {
  return { dev: String(metadata.dev), ino: String(metadata.ino), size: Number(metadata.size),
    mode: Number(metadata.mode), mtimeNs: String(metadata.mtimeNs ?? BigInt(Math.round(metadata.mtimeMs * 1e6))),
    ctimeNs: String(metadata.ctimeNs ?? BigInt(Math.round(metadata.ctimeMs * 1e6))) };
}

function parentPaths(file) {
  const result = []; let current = path.dirname(file); const root = path.parse(file).root;
  while (current !== root) { result.push(current); current = path.dirname(current); }
  return result.reverse();
}

async function sourceSnapshot(databasePath, inspectPath, transition) {
  const parents = [];
  for (const parent of parentPaths(databasePath)) {
    const metadata = await inspectPath(parent, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("unsafe parent");
    parents.push(identity(metadata)); await transition?.("parent-inspected", { parent });
  }
  const files = []; let total = 0;
  for (const [kind, file] of [["main", databasePath], ["wal", `${databasePath}-wal`], ["shm", `${databasePath}-shm`]]) {
    let metadata;
    try { metadata = await inspectPath(file, { bigint: true }); }
    catch (error) { if (error?.code === "ENOENT" && kind !== "main") { files.push({ kind, state: "absent" }); continue; } throw error; }
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("unsafe source");
    const record = identity(metadata);
    if (!Number.isSafeInteger(record.size) || record.size < 0) throw new Error("invalid size");
    total += record.size; if (total > MAX_ACTIVITY_THREAD_DATABASE_BYTES) throw new Error("source bounded");
    files.push({ kind, state: "present", ...record }); await transition?.("source-inspected", { kind, file });
  }
  return { parents, files, total };
}

function sameSnapshot(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function exactUniqueId(database, columns) {
  const primary = columns.filter((column) => Number(column?.pk) > 0);
  if (primary.length === 1 && primary[0]?.name === "id" && primary[0]?.pk === 1) return true;
  const indexes = database.prepare(`SELECT name, "unique" AS isUnique, partial
    FROM pragma_index_list('threads') LIMIT ?`).all(MAX_ACTIVITY_THREAD_DATABASE_INDEXES + 1);
  if (indexes.length > MAX_ACTIVITY_THREAD_DATABASE_INDEXES) return false;
  return indexes.some((index) => {
    if (index?.isUnique !== 1 || index?.partial !== 0 || typeof index?.name !== "string") return false;
    const fields = database.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno LIMIT 2").all(index.name);
    return fields.length === 1 && fields[0]?.name === "id";
  });
}

async function queryDesktopTitles({ databasePath, projectRoot, authorized }, {
  openDatabase = openReadOnlyDatabase, inspectPath = lstat, transition,
} = {}) {
  let database;
  try {
    const admitted = await sourceSnapshot(databasePath, inspectPath, transition);
    await transition?.("source-admitted", {});
    database = await openDatabase(databasePath);
    await transition?.("database-opened", {});
    if (!sameSnapshot(admitted, await sourceSnapshot(databasePath, inspectPath, transition))) return [];
    const columns = database.prepare("PRAGMA table_info(threads)").all();
    const names = new Set(columns.map((column) => column?.name));
    if (!["id", "cwd", "rollout_path", "title"].every((name) => names.has(name)) || !exactUniqueId(database, columns)) return [];
    await transition?.("before-query", {});
    const placeholders = authorized.map(() => "?").join(", ");
    const query = database.prepare(`SELECT id, cwd, rollout_path,
      CASE WHEN typeof(title) = 'text' AND length(CAST(title AS BLOB)) <= ? THEN title ELSE NULL END AS title
      FROM threads WHERE id IN (${placeholders}) LIMIT ?`);
    const rows = query.all(MAX_ACTIVITY_THREAD_TITLE_BYTES, ...authorized.map((item) => item.taskId), authorized.length + 1);
    await transition?.("after-query", {});
    if (rows.length > authorized.length || !sameSnapshot(admitted, await sourceSnapshot(databasePath, inspectPath, transition))) return [];
    return rows;
  } finally { try { database?.close(); } catch {} }
}

async function runTitleWorker(input, { timeoutMs = ACTIVITY_THREAD_LOOKUP_TIMEOUT_MS,
  terminationTimeoutMs = ACTIVITY_THREAD_TERMINATION_TIMEOUT_MS, WorkerClass = Worker } = {}) {
  if (titleWorkerBarrier) return [];
  let releaseBarrier; const barrier = new Promise((resolve) => { releaseBarrier = resolve; }); titleWorkerBarrier = barrier;
  let worker; let timer; let cleanupTimer; let resultSettled = false; let exited = false; let stopping = false;
  let pendingRows = []; let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const finishResult = (rows) => { if (resultSettled) return; resultSettled = true; resolveResult(rows); };
  const release = () => { if (titleWorkerBarrier === barrier) titleWorkerBarrier = null; releaseBarrier(); };
  try {
    worker = new WorkerClass(new URL(import.meta.url), {
      workerData: { activityThreadTitleLookup: input },
      execArgv: ["--disable-warning=ExperimentalWarning"],
    });
    const terminate = (rows = []) => {
      if (stopping || exited) return; stopping = true; pendingRows = rows;
      clearTimeout(timer);
      let termination;
      try { termination = Promise.resolve(worker.terminate()); } catch { termination = Promise.resolve(); }
      termination.then(() => { exited = true; clearTimeout(cleanupTimer); release(); finishResult(rows); }, () => {
        exited = true; clearTimeout(cleanupTimer); release(); finishResult([]);
      });
      cleanupTimer = setTimeout(() => {
        // Caller fallback stays prompt, while the unresolved barrier prevents a second worker.
        finishResult([]);
      }, terminationTimeoutMs);
    };
    worker.once("message", (message) => terminate(Array.isArray(message?.rows) ? message.rows : []));
    worker.once("error", () => terminate());
    worker.once("exit", () => { exited = true; clearTimeout(timer); clearTimeout(cleanupTimer); release(); finishResult(stopping ? pendingRows : []); });
    timer = setTimeout(() => terminate(), timeoutMs);
    return await result;
  } catch { if (!exited) release(); return []; }
}

export async function readActivityThreadTitles({
  project, activityTaskIds, verifiedSessionPaths, codexHome,
  databasePath = path.join(codexHome, "state_5.sqlite"),
  runLookup = runTitleWorker,
  platform = process.platform,
} = {}) {
  const titles = new Map();
  try {
    if (!project || !Array.isArray(activityTaskIds) || !(verifiedSessionPaths instanceof Map)) return titles;
    const authorized = activityTaskIds.slice(0, MAX_ACTIVITY_THREAD_TITLE_ROWS)
      .filter((taskId) => typeof taskId === "string" && typeof verifiedSessionPaths.get(taskId) === "string")
      .map((taskId) => ({ taskId, rolloutPath: verifiedSessionPaths.get(taskId) }));
    if (authorized.length === 0) return titles;
    const rows = await runLookup({ databasePath, projectRoot: project.root, authorized });
    const rowsById = new Map();
    for (const row of rows) { if (rowsById.has(row?.id)) return new Map(); rowsById.set(row?.id, row); }
    for (const { taskId, rolloutPath } of authorized) {
      const row = rowsById.get(taskId); const title = acceptedTitle(row?.title);
      if (row?.id === taskId
          && pathsEqual(row?.cwd, project.root, platform)
          && pathsEqual(row?.rollout_path, rolloutPath, platform)
          && title) titles.set(taskId, title);
    }
  } catch { /* Optional display metadata never affects Activity authority or partial state. */ }
  return titles;
}

export const __activityThreadTitleTest = Object.freeze({ queryDesktopTitles, runTitleWorker, exactUniqueId, sourceSnapshot,
  workerBarrierActive: () => titleWorkerBarrier !== null });
export { acceptedTitle as validateDesktopThreadTitle };

if (!isMainThread && workerData?.activityThreadTitleLookup) {
  queryDesktopTitles(workerData.activityThreadTitleLookup).then((rows) => parentPort.postMessage({ rows })).catch(() => parentPort.postMessage({ rows: [] }));
}
