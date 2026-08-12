import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { protectPrivateDirectory } from "./private-directory.mjs";

const MESSAGE_ID_LIMIT = 1_024;
const TASK_ID_LIMIT = 1_024;
const MESSAGE_LIMIT = 64 * 1_024;
const AUTOMATION_PREFIX = "codex-small-loop-message-";
const AUTOMATION_ID_PATTERN = /^codex-small-loop-message-[a-f0-9]{32}$/;
const MINUTELY_RRULE = "RRULE:FREQ=MINUTELY;INTERVAL=1";

function scheduleError(code, message, cause) {
  const error = new Error(message);
  error.name = "AppMessageScheduleError";
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function requireBoundedText(value, label, maximum) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
  ) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function requireAutomationRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError("automationRoot must be an absolute path");
  }
  return path.normalize(value);
}

function requireNowMs(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("nowMs must be a non-negative safe integer");
  }
  return value;
}

export function appMessageAutomationId(messageId) {
  const normalized = requireBoundedText(
    messageId,
    "messageId",
    MESSAGE_ID_LIMIT,
  );
  return `${AUTOMATION_PREFIX}${
    createHash("sha256").update(normalized).digest("hex").slice(0, 32)
  }`;
}

function scheduleLocation(messageId, automationRoot) {
  const root = requireAutomationRoot(automationRoot);
  const automationId = appMessageAutomationId(messageId);
  const directory = path.join(root, automationId);
  return {
    automationId,
    directory,
    file: path.join(directory, "automation.toml"),
  };
}

function scheduleLocationFromId(scheduleId, automationRoot) {
  const root = requireAutomationRoot(automationRoot);
  const automationId = requireBoundedText(
    scheduleId,
    "scheduleId",
    MESSAGE_ID_LIMIT,
  );
  if (!AUTOMATION_ID_PATTERN.test(automationId)) {
    throw new TypeError("scheduleId must be a Codex Small Loop message schedule ID");
  }
  const directory = path.join(root, automationId);
  return {
    automationId,
    directory,
    file: path.join(directory, "automation.toml"),
  };
}

function renderAutomation({
  automationId,
  targetTaskId,
  prompt,
  timestamp,
}) {
  return [
    "version = 1",
    `id = ${JSON.stringify(automationId)}`,
    'kind = "heartbeat"',
    `name = ${JSON.stringify(`Codex Small Loop Message — ${automationId}`)}`,
    `prompt = ${JSON.stringify(prompt)}`,
    'status = "ACTIVE"',
    `rrule = ${JSON.stringify(MINUTELY_RRULE)}`,
    `target_thread_id = ${JSON.stringify(targetTaskId)}`,
    `created_at = ${timestamp}`,
    `updated_at = ${timestamp}`,
    "",
  ].join("\n");
}

function tomlString(source, field) {
  const match = source.match(
    new RegExp(`^${field} = (.+)$`, "m"),
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function matchesSchedule(source, expected) {
  return tomlString(source, "id") === expected.automationId
    && tomlString(source, "kind") === "heartbeat"
    && tomlString(source, "prompt") === expected.prompt
    && tomlString(source, "status") === "ACTIVE"
    && tomlString(source, "rrule") === MINUTELY_RRULE
    && tomlString(source, "target_thread_id") === expected.targetTaskId;
}

async function readExisting(file, expected) {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    throw scheduleError(
      "APP_MESSAGE_SCHEDULE_READ_FAILED",
      "App message schedule could not be inspected.",
      cause,
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw scheduleError(
      "APP_MESSAGE_SCHEDULE_CONFLICT",
      "App message schedule path is not a regular file.",
    );
  }
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch (cause) {
    throw scheduleError(
      "APP_MESSAGE_SCHEDULE_READ_FAILED",
      "App message schedule could not be read.",
      cause,
    );
  }
  if (!matchesSchedule(source, expected)) {
    throw scheduleError(
      "APP_MESSAGE_SCHEDULE_CONFLICT",
      "An existing Automation conflicts with this App message.",
    );
  }
  return source;
}

async function ensureDirectory(directory) {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await protectPrivateDirectory(directory);
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Schedule directory is not a regular directory.");
    }
  } catch (cause) {
    throw scheduleError(
      "APP_MESSAGE_SCHEDULE_WRITE_FAILED",
      "App message schedule directory could not be prepared.",
      cause,
    );
  }
}

async function createAtomically(directory, file, source) {
  const temporary = path.join(
    directory,
    `.automation.toml.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporary, file);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

export async function createAppMessageSchedule(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("App message schedule input must be an object");
  }
  const expectedKeys = [
    "automationRoot",
    "messageId",
    "nowMs",
    "targetTaskId",
    "text",
  ];
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(
      `App message schedule input requires ${expectedKeys.join(", ")}`,
    );
  }

  const location = scheduleLocation(
    input.messageId,
    input.automationRoot,
  );
  const targetTaskId = requireBoundedText(
    input.targetTaskId,
    "targetTaskId",
    TASK_ID_LIMIT,
  );
  if (/\s/.test(targetTaskId)) {
    throw new TypeError("targetTaskId must not contain whitespace");
  }
  const prompt = requireBoundedText(input.text, "text", MESSAGE_LIMIT);
  const timestamp = Math.max(0, requireNowMs(input.nowMs) - 60_000);
  const expected = {
    automationId: location.automationId,
    targetTaskId,
    prompt,
  };

  await ensureDirectory(location.directory);
  if (await readExisting(location.file, expected) !== null) {
    return Object.freeze({ ...location, created: false });
  }

  const source = renderAutomation({
    ...expected,
    timestamp,
  });
  try {
    await createAtomically(
      location.directory,
      location.file,
      source,
    );
  } catch (cause) {
    if (cause?.code === "EEXIST") {
      await readExisting(location.file, expected);
      return Object.freeze({ ...location, created: false });
    }
    throw scheduleError(
      "APP_MESSAGE_SCHEDULE_WRITE_FAILED",
      "App message schedule could not be committed.",
      cause,
    );
  }
  return Object.freeze({ ...location, created: true });
}

export async function inspectAppMessageSchedule(input) {
  if (
    input === null
    || typeof input !== "object"
    || Array.isArray(input)
    || Object.keys(input).length !== 2
  ) {
    throw new TypeError(
      "App message schedule inspection requires messageId and automationRoot",
    );
  }
  const location = scheduleLocation(
    input.messageId,
    input.automationRoot,
  );
  try {
    const metadata = await lstat(location.file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw scheduleError(
        "APP_MESSAGE_SCHEDULE_CONFLICT",
        "App message schedule path is not a regular file.",
      );
    }
    return Object.freeze({ ...location, present: true });
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      return Object.freeze({ ...location, present: false });
    }
    throw cause;
  }
}

export async function removeAppMessageSchedule(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("App message schedule removal input must be an object");
  }
  const expectedKeys = ["automationRoot", "scheduleId", "targetTaskId"];
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(
      `App message schedule removal requires ${expectedKeys.join(", ")}`,
    );
  }

  const location = scheduleLocationFromId(
    input.scheduleId,
    input.automationRoot,
  );
  const targetTaskId = requireBoundedText(
    input.targetTaskId,
    "targetTaskId",
    TASK_ID_LIMIT,
  );
  if (/\s/.test(targetTaskId)) {
    throw new TypeError("targetTaskId must not contain whitespace");
  }

  let directoryMetadata;
  try {
    directoryMetadata = await lstat(location.directory);
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      return Object.freeze({ ...location, removed: false });
    }
    throw scheduleError(
      "APP_MESSAGE_SCHEDULE_READ_FAILED",
      "App message schedule directory could not be inspected.",
      cause,
    );
  }
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw scheduleError(
      "APP_MESSAGE_SCHEDULE_CONFLICT",
      "App message schedule directory is not a regular directory.",
    );
  }

  let fileMetadata;
  try {
    fileMetadata = await lstat(location.file);
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      return Object.freeze({ ...location, removed: false });
    }
    throw scheduleError(
      "APP_MESSAGE_SCHEDULE_READ_FAILED",
      "App message schedule could not be inspected.",
      cause,
    );
  }
  if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) {
    throw scheduleError(
      "APP_MESSAGE_SCHEDULE_CONFLICT",
      "App message schedule path is not a regular file.",
    );
  }

  let source;
  let entries;
  try {
    [source, entries] = await Promise.all([
      readFile(location.file, "utf8"),
      readdir(location.directory),
    ]);
  } catch (cause) {
    throw scheduleError(
      "APP_MESSAGE_SCHEDULE_READ_FAILED",
      "App message schedule could not be read.",
      cause,
    );
  }
  if (
    tomlString(source, "id") !== location.automationId
    || tomlString(source, "kind") !== "heartbeat"
  ) {
    throw scheduleError(
      "APP_MESSAGE_SCHEDULE_CONFLICT",
      "The addressed Automation is not a Codex Small Loop message schedule.",
    );
  }
  if (tomlString(source, "target_thread_id") !== targetTaskId) {
    throw scheduleError(
      "APP_MESSAGE_SCHEDULE_TARGET_MISMATCH",
      "The App message schedule belongs to a different Task.",
    );
  }
  if (entries.length !== 1 || entries[0] !== "automation.toml") {
    throw scheduleError(
      "APP_MESSAGE_SCHEDULE_CONFLICT",
      "App message schedule directory contains unexpected files.",
    );
  }

  try {
    await unlink(location.file);
    await rmdir(location.directory);
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      return Object.freeze({ ...location, removed: false });
    }
    throw scheduleError(
      "APP_MESSAGE_SCHEDULE_REMOVE_FAILED",
      "App message schedule could not be removed.",
      cause,
    );
  }
  return Object.freeze({ ...location, removed: true });
}
