import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { deleteSchedule, requireScheduleId } from "./schedule.mjs";

const MAX_BYTES = 4096;
const RETRY_MS = 30_000;
const MAX_ATTEMPTS = 3;
const TRANSIENT = new Set(["SCHEDULE_WRITE_FAILED", "SCHEDULE_LOCKED", "SCHEDULE_READ_FAILED"]);
const ID = /^[a-f0-9]{64}\.json$/;

function failure(code, message) { return Object.assign(new Error(message), { code }); }

function requestIdentity(value) {
  requireScheduleId(value.scheduleId);
  if (typeof value.targetTaskId !== "string" || !value.targetTaskId.length
      || value.targetTaskId.length > 512 || /[\s/\\]/.test(value.targetTaskId)
      || !/^sha256:[a-f0-9]{64}$/.test(value.ifMatch)) {
    throw failure("SCHEDULE_DELETE_REQUEST_INVALID", "A valid target Task and schedule etag are required.");
  }
  return createHash("sha256").update(JSON.stringify([
    value.scheduleId, value.targetTaskId, value.ifMatch,
  ])).digest("hex");
}

async function directory(project, create = false) {
  const root = await realpath(project.root).catch((error) => {
    if (error.code === "ENOENT" && !create) return null;
    throw error;
  });
  if (root === null) return null;
  const runtime = path.join(root, ".codex-small-loop");
  const queue = path.join(runtime, "schedule-deletions");
  for (const target of [runtime, queue]) {
    let metadata = await lstat(target).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (!metadata && target === queue && create) {
      await mkdir(queue, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
      metadata = await lstat(queue);
    }
    if (!metadata) {
      if (!create) return null;
      throw failure("SCHEDULE_RUNTIME_MISSING", "This project has no Small Loop runtime; no deletion was queued.");
    }
    if (!metadata.isDirectory() || await realpath(target) !== target) {
      throw failure("SCHEDULE_DELETE_QUEUE_UNSAFE", "The deletion queue must be a project-local directory without links.");
    }
  }
  return queue;
}

async function readRecord(filename) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.size > MAX_BYTES) {
    throw failure("SCHEDULE_DELETE_REQUEST_INVALID", "Invalid deletion request file.");
  }
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== metadata.ino || opened.dev !== metadata.dev || opened.size > MAX_BYTES) throw failure("SCHEDULE_DELETE_REQUEST_INVALID", "Deletion request changed while opening.");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BYTES) throw failure("SCHEDULE_DELETE_REQUEST_INVALID", "Deletion request exceeds its size limit.");
    const value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (value.version !== 1 || `${requestIdentity(value)}.json` !== path.basename(filename)
        || !["queued", "completed", "failed"].includes(value.status)
        || !Number.isInteger(value.attempts) || value.attempts < 0 || value.attempts > MAX_ATTEMPTS
        || !Number.isFinite(value.nextAttemptAt)) throw failure("SCHEDULE_DELETE_REQUEST_INVALID", "Invalid deletion request contents.");
    return value;
  } finally { await handle.close(); }
}

async function publish(filename, value, exclusive = false) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    if (exclusive) {
      // A complete record becomes visible at once; an existing receipt wins.
      await link(temporary, filename).catch((error) => { if (error.code !== "EEXIST") throw error; });
    } else await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}

function result(value) {
  return {
    scheduleId: value.scheduleId, targetTaskId: value.targetTaskId,
    requestId: requestIdentity(value),
    change: value.status === "queued" ? "deletion_queued" : value.status === "completed" ? "deleted" : "deletion_failed",
    completed: value.status === "completed",
    ...(value.code ? { code: value.code } : {}),
  };
}

export async function queueScheduleDeletion({ project, scheduleId, targetTaskId, ifMatch }) {
  const request = { scheduleId, targetTaskId, ifMatch };
  const requestId = requestIdentity(request);
  const queue = await directory(project, true);
  const filename = path.join(queue, `${requestId}.json`);
  await publish(filename, { version: 1, ...request, status: "queued", attempts: 0, nextAttemptAt: 0 }, true);
  const value = await readRecord(filename);
  if (value.status === "failed") throw failure(value.code ?? "SCHEDULE_DELETE_FAILED", "Runtime could not delete this schedule; inspect the project-local deletion receipt.");
  return result(value);
}

export async function processScheduleDeletions(project, {
  automationRoot, remove = deleteSchedule, now = Date.now(), limit = 32,
} = {}) {
  const queue = await directory(project);
  const report = { pending: 0, events: [] };
  if (!queue) return report;
  let processed = 0;
  for (const name of (await readdir(queue)).filter((name) => ID.test(name)).sort()) {
    const filename = path.join(queue, name);
    let value;
    try { value = await readRecord(filename); }
    catch { report.events.push({ type: "schedule_delete_invalid", requestId: name.slice(0, -5) }); continue; }
    if (value.status !== "queued") continue;
    if (processed >= limit || now < value.nextAttemptAt) { report.pending++; continue; }
    processed++;
    try {
      // The runtime supplies its own automation root. Requests cannot select
      // filesystem paths. No creator-runtime or ledger membership restriction.
      await remove({ automationRoot, scheduleId: value.scheduleId, targetTaskId: value.targetTaskId, ifMatch: value.ifMatch });
      value = { ...value, status: "completed", code: undefined };
      report.events.push({ type: "schedule_deleted", requestId: name.slice(0, -5) });
    } catch (error) {
      const attempts = value.attempts + 1;
      const retry = TRANSIENT.has(error.code) && attempts < MAX_ATTEMPTS;
      value = { ...value, attempts, status: retry ? "queued" : "failed", nextAttemptAt: now + RETRY_MS,
        code: /^[A-Z0-9_]{1,128}$/.test(error.code ?? "") ? error.code : "SCHEDULE_DELETE_FAILED" };
      if (retry) report.pending++;
      report.events.push({ type: retry ? "schedule_delete_retry" : "schedule_delete_failed", requestId: name.slice(0, -5), code: value.code });
    }
    await publish(filename, value);
  }
  return report;
}
