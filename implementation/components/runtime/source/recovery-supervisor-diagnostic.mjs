import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

const MAX_DIAGNOSTIC_LENGTH = 512;
const MAX_DIAGNOSTIC_EVENTS = 20;
const MAX_EVENT_IDS = 20;
const EVENT_ID_FIELDS = ["taskIds", "launchIds", "messageIds"];

function diagnosticError(code, message, cause) {
  const error = new Error(message);
  error.name = "RecoverySupervisorDiagnosticError";
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function bounded(value) {
  const text = String(value);
  return text.length <= MAX_DIAGNOSTIC_LENGTH
    ? text
    : `${text.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}

function sanitizeEvent(event) {
  if (
    !event
    || typeof event !== "object"
    || Array.isArray(event)
    || typeof event.type !== "string"
    || event.type.length === 0
  ) {
    return null;
  }
  const sanitized = { type: bounded(event.type) };
  if (typeof event.reason === "string" && event.reason.length > 0) {
    sanitized.reason = bounded(event.reason);
  }
  for (const field of EVENT_ID_FIELDS) {
    if (!Array.isArray(event[field])) continue;
    const ids = event[field]
      .filter((value) => typeof value === "string" && value.length > 0)
      .slice(0, MAX_EVENT_IDS)
      .map((value) => bounded(value));
    if (ids.length > 0) sanitized[field] = ids;
  }
  if (Number.isSafeInteger(event.omitted) && event.omitted > 0) {
    sanitized.omitted = event.omitted;
  }
  return sanitized;
}

function sanitizeEvents(events) {
  if (!Array.isArray(events)) return [];
  return events
    .slice(0, MAX_DIAGNOSTIC_EVENTS)
    .map(sanitizeEvent)
    .filter(Boolean);
}

function validateEvents(events) {
  if (events === undefined) return undefined;
  if (!Array.isArray(events) || events.length > MAX_DIAGNOSTIC_EVENTS) {
    throw diagnosticError(
      "RECOVERY_SUPERVISOR_DIAGNOSTIC_INVALID",
      "Recovery Supervisor diagnostic is malformed and was retained.",
    );
  }
  const sanitized = sanitizeEvents(events);
  if (
    sanitized.length !== events.length
    || events.some((event, index) => {
      const candidate = sanitized[index];
      const keys = Object.keys(event);
      if (
        keys.length !== Object.keys(candidate).length
        || keys.some((key) => !Object.hasOwn(candidate, key))
      ) {
        return true;
      }
      return keys.some((key) => Array.isArray(event[key])
        ? event[key].length !== candidate[key].length
          || event[key].some((value, itemIndex) =>
            value !== candidate[key][itemIndex])
        : event[key] !== candidate[key]);
    })
  ) {
    throw diagnosticError(
      "RECOVERY_SUPERVISOR_DIAGNOSTIC_INVALID",
      "Recovery Supervisor diagnostic is malformed and was retained.",
    );
  }
  return sanitized.map((event) => Object.freeze({
    ...event,
    ...Object.fromEntries(EVENT_ID_FIELDS
      .filter((field) => event[field])
      .map((field) => [field, Object.freeze([...event[field]])])),
  }));
}

function requireProjectRoot(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || !path.isAbsolute(value)
  ) {
    throw diagnosticError(
      "RECOVERY_SUPERVISOR_DIAGNOSTIC_INVALID",
      "Recovery Supervisor diagnostic requires an absolute project root.",
    );
  }
  return path.normalize(value);
}

export function recoverySupervisorDiagnosticFile(projectRoot) {
  return path.join(
    requireProjectRoot(projectRoot),
    ".codex-small-loop",
    "recovery-supervisor-error.json",
  );
}

function validateDiagnostic(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.version !== 1
    || typeof value.code !== "string"
    || value.code.length === 0
    || value.code.length > MAX_DIAGNOSTIC_LENGTH
    || typeof value.message !== "string"
    || value.message.length === 0
    || value.message.length > MAX_DIAGNOSTIC_LENGTH
    || !Number.isSafeInteger(value.consecutiveFailures)
    || value.consecutiveFailures < 1
    || typeof value.updatedAt !== "string"
    || Number.isNaN(Date.parse(value.updatedAt))
    || new Date(value.updatedAt).toISOString() !== value.updatedAt
  ) {
    throw diagnosticError(
      "RECOVERY_SUPERVISOR_DIAGNOSTIC_INVALID",
      "Recovery Supervisor diagnostic is malformed and was retained.",
    );
  }
  const events = validateEvents(value.events);
  return Object.freeze({
    version: 1,
    code: value.code,
    message: value.message,
    consecutiveFailures: value.consecutiveFailures,
    updatedAt: value.updatedAt,
    ...(events ? { events: Object.freeze(events) } : {}),
  });
}

export function parseRecoverySupervisorDiagnosticSource(source) {
  try {
    return validateDiagnostic(JSON.parse(Buffer.isBuffer(source) ? source.toString("utf8") : source));
  } catch (error) {
    if (error?.code === "RECOVERY_SUPERVISOR_DIAGNOSTIC_INVALID") throw error;
    throw diagnosticError(
      "RECOVERY_SUPERVISOR_DIAGNOSTIC_INVALID",
      "Recovery Supervisor diagnostic is malformed and was retained.",
      error,
    );
  }
}

export async function readRecoverySupervisorDiagnostic(
  projectRoot,
  options = {},
) {
  const file = recoverySupervisorDiagnosticFile(projectRoot);
  let source;
  try {
    source = await (options.readFile ?? readFile)(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw diagnosticError(
      "RECOVERY_SUPERVISOR_DIAGNOSTIC_INVALID",
      "Recovery Supervisor diagnostic could not be read.",
      error,
    );
  }
  return parseRecoverySupervisorDiagnosticSource(source);
}

export async function writeRecoverySupervisorDiagnostic(
  projectRoot,
  error,
  consecutiveFailures,
  updatedAt,
  options = {},
) {
  const file = recoverySupervisorDiagnosticFile(projectRoot);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    const events = sanitizeEvents(options.events);
    await handle.writeFile(`${JSON.stringify({
      version: 1,
      code: bounded(error?.code ?? "RECOVERY_HEARTBEAT_FAILED"),
      message: bounded(error?.message ?? "Recovery heartbeat failed."),
      consecutiveFailures,
      updatedAt,
      ...(events.length > 0 ? { events } : {}),
    })}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
  } catch (cause) {
    throw diagnosticError(
      "RECOVERY_SUPERVISOR_DIAGNOSTIC_WRITE_FAILED",
      "Recovery Supervisor could not persist its heartbeat failure.",
      cause,
    );
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function clearRecoverySupervisorDiagnostic(projectRoot) {
  await rm(recoverySupervisorDiagnosticFile(projectRoot), { force: true });
}
