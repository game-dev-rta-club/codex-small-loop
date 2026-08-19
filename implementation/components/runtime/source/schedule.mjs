import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { protectPrivateDirectory } from "./private-directory.mjs";

const SCHEDULE_ID_PATTERN = /^codex-small-loop-[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$/;
const ETAG_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_TASK_ID_LENGTH = 512;
const MAX_PROMPT_BYTES = 64 * 1_024;
const MAX_INTERVAL_MINUTES = 1_440;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const UNSUPPORTED_DIRECTORY_SYNC = new Set([
  "EBADF",
  "EINVAL",
  "EISDIR",
  "ENOTSUP",
  "EPERM",
]);

export class ScheduleError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "ScheduleError";
    this.code = code;
  }
}

function scheduleError(code, message, cause) {
  return new ScheduleError(code, message, cause);
}

function requireExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`${label} requires ${wanted.join(", ")}`);
  }
}

function requireAutomationRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError("automationRoot must be an absolute path");
  }
  return path.normalize(value);
}

export function requireScheduleId(value) {
  if (typeof value !== "string" || !SCHEDULE_ID_PATTERN.test(value)) {
    throw new TypeError("scheduleId must be a bounded Codex Small Loop schedule ID");
  }
  return value;
}

function requireTaskId(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_TASK_ID_LENGTH
    || /[\s/\\]/.test(value)
  ) {
    throw new TypeError("targetTaskId must be a non-empty bounded Task ID");
  }
  return value;
}

function requirePrompt(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_PROMPT_BYTES
  ) {
    throw new TypeError("prompt must be a non-empty bounded string");
  }
  return value;
}

function requireIntervalMinutes(value) {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_INTERVAL_MINUTES
  ) {
    throw new TypeError(
      `intervalMinutes must be an integer from 1 to ${MAX_INTERVAL_MINUTES}`,
    );
  }
  return value;
}

function requireNowMs(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("nowMs must be a non-negative safe integer");
  }
  return value;
}

function requireIfMatch(value, { allowAbsent }) {
  if (allowAbsent && value === "absent") return value;
  if (typeof value !== "string" || !ETAG_PATTERN.test(value)) {
    throw new TypeError(
      allowAbsent
        ? "ifMatch must be absent or an opaque schedule etag"
        : "ifMatch must be an opaque schedule etag",
    );
  }
  return value;
}

export function defaultAutomationRoot(env = process.env) {
  const codexDirectory = env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return path.join(codexDirectory, "automations");
}

export function appMessageScheduleId(messageId) {
  if (
    typeof messageId !== "string"
    || messageId.length === 0
    || messageId.length > 1_024
  ) {
    throw new TypeError("messageId must be a non-empty bounded string");
  }
  return `codex-small-loop-message-${
    createHash("sha256").update(messageId).digest("hex").slice(0, 32)
  }`;
}

function location(input) {
  const automationRoot = requireAutomationRoot(input.automationRoot);
  const scheduleId = requireScheduleId(input.scheduleId);
  const directory = path.join(automationRoot, scheduleId);
  const lockDirectory = path.join(
    os.tmpdir(),
    `codex-small-loop-schedule-locks-${
      createHash("sha256")
        .update(String(process.getuid?.() ?? os.userInfo().username))
        .digest("hex")
        .slice(0, 16)
    }`,
  );
  const lockName = createHash("sha256")
    .update(`${automationRoot}\0${scheduleId}`)
    .digest("hex");
  return {
    automationRoot,
    scheduleId,
    directory,
    file: path.join(directory, "automation.toml"),
    lockDirectory,
    lockFile: path.join(lockDirectory, `${lockName}.lock`),
  };
}

function hashSource(source) {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function tomlString(source, field) {
  const match = source.match(new RegExp(`^${field} = (.+)$`, "m"));
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function tomlInteger(source, field) {
  const match = source.match(new RegExp(`^${field} = (\\d+)$`, "m"));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function parseInterval(rrule) {
  const match = rrule?.match(/^(?:RRULE:)?FREQ=MINUTELY;INTERVAL=(\d+)$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1
    && value <= MAX_INTERVAL_MINUTES
    ? value
    : null;
}

function parseSchedule(source, expectedId) {
  const schedule = {
    version: tomlInteger(source, "version"),
    scheduleId: tomlString(source, "id"),
    kind: tomlString(source, "kind"),
    name: tomlString(source, "name"),
    prompt: tomlString(source, "prompt"),
    status: tomlString(source, "status"),
    intervalMinutes: parseInterval(tomlString(source, "rrule")),
    targetTaskId: tomlString(source, "target_thread_id"),
    createdAt: tomlInteger(source, "created_at"),
    updatedAt: tomlInteger(source, "updated_at"),
  };
  if (
    schedule.version !== 1
    || schedule.scheduleId !== expectedId
    || schedule.kind !== "heartbeat"
    || typeof schedule.name !== "string"
    || schedule.name.length === 0
    || typeof schedule.prompt !== "string"
    || schedule.prompt.length === 0
    || schedule.status !== "ACTIVE"
    || schedule.intervalMinutes === null
    || typeof schedule.targetTaskId !== "string"
    || schedule.createdAt === null
    || schedule.updatedAt === null
  ) {
    throw scheduleError(
      "SCHEDULE_CONFLICT",
      "The addressed automation is not a readable Codex Small Loop schedule.",
    );
  }
  return schedule;
}

function renderSchedule(schedule) {
  return [
    "version = 1",
    `id = ${JSON.stringify(schedule.scheduleId)}`,
    'kind = "heartbeat"',
    `name = ${JSON.stringify(`Codex Small Loop — ${schedule.scheduleId}`)}`,
    `prompt = ${JSON.stringify(schedule.prompt)}`,
    'status = "ACTIVE"',
    `rrule = ${JSON.stringify(
      `RRULE:FREQ=MINUTELY;INTERVAL=${schedule.intervalMinutes}`,
    )}`,
    `target_thread_id = ${JSON.stringify(schedule.targetTaskId)}`,
    `created_at = ${schedule.createdAt}`,
    `updated_at = ${schedule.updatedAt}`,
    "",
  ].join("\n");
}

async function inspectDirectory(loc) {
  let metadata;
  try {
    metadata = await lstat(loc.directory);
  } catch (cause) {
    if (cause?.code === "ENOENT") return false;
    throw scheduleError(
      "SCHEDULE_READ_FAILED",
      "The schedule directory could not be inspected.",
      cause,
    );
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw scheduleError(
      "SCHEDULE_CONFLICT",
      "The schedule directory is not a regular directory.",
    );
  }
  return true;
}

async function readCurrent(loc, targetTaskId) {
  if (!await inspectDirectory(loc)) return null;
  let metadata;
  try {
    metadata = await lstat(loc.file);
  } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    throw scheduleError(
      "SCHEDULE_READ_FAILED",
      "The schedule could not be inspected.",
      cause,
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw scheduleError(
      "SCHEDULE_CONFLICT",
      "The schedule path is not a regular file.",
    );
  }
  let source;
  try {
    source = await readFile(loc.file, "utf8");
  } catch (cause) {
    throw scheduleError(
      "SCHEDULE_READ_FAILED",
      "The schedule could not be read.",
      cause,
    );
  }
  const schedule = parseSchedule(source, loc.scheduleId);
  if (schedule.targetTaskId !== targetTaskId) {
    throw scheduleError(
      "SCHEDULE_TARGET_MISMATCH",
      "The schedule belongs to a different Task.",
    );
  }
  return { source, etag: hashSource(source), schedule };
}

function publicResult(loc, current) {
  if (current === null) {
    return Object.freeze({
      present: false,
      scheduleId: loc.scheduleId,
      etag: null,
    });
  }
  return Object.freeze({
    present: true,
    scheduleId: current.schedule.scheduleId,
    targetTaskId: current.schedule.targetTaskId,
    prompt: current.schedule.prompt,
    intervalMinutes: current.schedule.intervalMinutes,
    etag: current.etag,
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

async function acquireLock(loc) {
  await mkdir(loc.lockDirectory, { recursive: true, mode: 0o700 });
  await protectPrivateDirectory(loc.lockDirectory);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = randomUUID();
  const owner = `${JSON.stringify({ pid: process.pid, token })}\n`;
  while (true) {
    try {
      const handle = await open(loc.lockFile, "wx", 0o600);
      try {
        await handle.writeFile(owner, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return token;
    } catch (cause) {
      if (cause?.code !== "EEXIST") {
        throw scheduleError(
          "SCHEDULE_WRITE_FAILED",
          "The schedule lock could not be created.",
          cause,
        );
      }
      try {
        const current = JSON.parse(await readFile(loc.lockFile, "utf8"));
        if (Number.isSafeInteger(current?.pid) && processIsDead(current.pid)) {
          await unlink(loc.lockFile);
          continue;
        }
      } catch (error) {
        if (error?.code === "ENOENT") continue;
      }
      if (Date.now() >= deadline) {
        throw scheduleError(
          "SCHEDULE_LOCKED",
          "The schedule is locked by a live or uncertain writer.",
        );
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function releaseLock(loc, token) {
  try {
    const current = JSON.parse(await readFile(loc.lockFile, "utf8"));
    if (current?.token === token) await unlink(loc.lockFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function withLock(loc, callback) {
  await mkdir(loc.automationRoot, { recursive: true, mode: 0o700 });
  const token = await acquireLock(loc);
  try {
    return await callback();
  } finally {
    await releaseLock(loc, token);
  }
}

async function commit(loc, source) {
  await mkdir(loc.directory, { recursive: true, mode: 0o700 });
  await protectPrivateDirectory(loc.directory);
  const temporary = path.join(
    loc.directory,
    `.automation.toml.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, loc.file);
    await syncDirectory(loc.directory);
  } catch (cause) {
    throw scheduleError(
      "SCHEDULE_WRITE_FAILED",
      "The schedule could not be committed.",
      cause,
    );
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC.has(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function assertWritableDirectory(loc, current) {
  if (!await inspectDirectory(loc)) return;
  let entries;
  try {
    entries = await readdir(loc.directory);
  } catch (cause) {
    throw scheduleError(
      "SCHEDULE_READ_FAILED",
      "The schedule directory could not be read.",
      cause,
    );
  }
  const expected = current === null ? [] : ["automation.toml"];
  if (
    entries.length !== expected.length
    || entries.some((entry, index) => entry !== expected[index])
  ) {
    throw scheduleError(
      "SCHEDULE_CONFLICT",
      "The schedule directory contains unexpected files.",
    );
  }
}

export async function readSchedule(input) {
  requireExactKeys(
    input,
    ["automationRoot", "scheduleId", "targetTaskId"],
    "Schedule read input",
  );
  const loc = location(input);
  const targetTaskId = requireTaskId(input.targetTaskId);
  return publicResult(loc, await readCurrent(loc, targetTaskId));
}

export async function applySchedule(input) {
  requireExactKeys(
    input,
    [
      "automationRoot",
      "ifMatch",
      "intervalMinutes",
      "nowMs",
      "prompt",
      "scheduleId",
      "targetTaskId",
    ],
    "Schedule apply input",
  );
  const loc = location(input);
  const targetTaskId = requireTaskId(input.targetTaskId);
  const prompt = requirePrompt(input.prompt);
  const intervalMinutes = requireIntervalMinutes(input.intervalMinutes);
  const ifMatch = requireIfMatch(input.ifMatch, { allowAbsent: true });
  const nowMs = requireNowMs(input.nowMs);

  return withLock(loc, async () => {
    const current = await readCurrent(loc, targetTaskId);
    await assertWritableDirectory(loc, current);
    const logicallyEqual = current !== null
      && current.schedule.prompt === prompt
      && current.schedule.intervalMinutes === intervalMinutes;
    if (ifMatch === "absent" && current !== null && !logicallyEqual) {
      throw scheduleError(
        "SCHEDULE_ETAG_MISMATCH",
        "The schedule already exists with a different definition.",
      );
    }
    if (ifMatch !== "absent" && current?.etag !== ifMatch) {
      throw scheduleError(
        "SCHEDULE_ETAG_MISMATCH",
        "The schedule changed after it was read.",
      );
    }
    if (logicallyEqual) {
      return Object.freeze({
        ...publicResult(loc, current),
        change: "unchanged",
      });
    }
    const source = renderSchedule({
      scheduleId: loc.scheduleId,
      targetTaskId,
      prompt,
      intervalMinutes,
      createdAt: current?.schedule.createdAt ?? nowMs,
      updatedAt: nowMs,
    });
    await commit(loc, source);
    const next = {
      source,
      etag: hashSource(source),
      schedule: parseSchedule(source, loc.scheduleId),
    };
    return Object.freeze({
      ...publicResult(loc, next),
      change: current === null ? "created" : "updated",
    });
  });
}

export async function deleteSchedule(input) {
  requireExactKeys(
    input,
    ["automationRoot", "ifMatch", "scheduleId", "targetTaskId"],
    "Schedule delete input",
  );
  const loc = location(input);
  const targetTaskId = requireTaskId(input.targetTaskId);
  const ifMatch = requireIfMatch(input.ifMatch, { allowAbsent: false });
  return withLock(loc, async () => {
    const current = await readCurrent(loc, targetTaskId);
    if (current === null) {
      return Object.freeze({
        present: false,
        scheduleId: loc.scheduleId,
        etag: null,
        change: "already_absent",
      });
    }
    if (current.etag !== ifMatch) {
      throw scheduleError(
        "SCHEDULE_ETAG_MISMATCH",
        "The schedule changed after it was read.",
      );
    }
    const entries = await readdir(loc.directory);
    if (entries.length !== 1 || entries[0] !== "automation.toml") {
      throw scheduleError(
        "SCHEDULE_CONFLICT",
        "The schedule directory contains unexpected files.",
      );
    }
    try {
      await unlink(loc.file);
      await rmdir(loc.directory);
      await syncDirectory(loc.automationRoot);
    } catch (cause) {
      throw scheduleError(
        "SCHEDULE_WRITE_FAILED",
        "The schedule could not be deleted.",
        cause,
      );
    }
    return Object.freeze({
      present: false,
      scheduleId: loc.scheduleId,
      etag: null,
      change: "deleted",
    });
  });
}
