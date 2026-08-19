import { StringDecoder } from "node:string_decoder";
import path from "node:path";

import { pathsEqual } from "./path-identity.mjs";

export const MAX_JSONL_LINE_LENGTH = 8 * 1024 * 1024;
export const MAX_TASK_ID_LENGTH = 512;
export const MAX_TURN_ID_LENGTH = 512;

const MAX_DIAGNOSTIC_LENGTH = 512;
const SUPPORTED_EVENT_TYPES = new Set([
  "task_started",
  "task_complete",
  "turn_aborted",
]);
const REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const SESSION_SANDBOX_TYPES = new Map([
  ["danger-full-access", "dangerFullAccess"],
  ["external-sandbox", "externalSandbox"],
  ["read-only", "readOnly"],
  ["workspace-write", "workspaceWrite"],
]);

function bounded(value, maximum = MAX_DIAGNOSTIC_LENGTH) {
  const text = String(value);
  return text.length <= maximum
    ? text
    : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function createError(code, message, details = {}) {
  const error = new Error(bounded(message));
  error.name = "CodexJsonlError";
  error.code = code;
  Object.assign(error, details);
  return error;
}

function diagnostic(code, message) {
  return {
    code,
    message: bounded(message),
  };
}

function validTurnId(turnId) {
  return typeof turnId === "string"
    && turnId.trim().length > 0
    && turnId.length <= MAX_TURN_ID_LENGTH;
}

function assertTurnId(turnId, details = {}) {
  if (!validTurnId(turnId)) {
    throw createError(
      "TASK_EVENT_INVALID",
      `Codex task event has an invalid Turn ID${details.lineNumber ? ` at line ${details.lineNumber}` : ""}`,
      details,
    );
  }
}

function normalizeRecord(
  record,
  lineNumber,
  { includeFinalAnswer = false } = {},
) {
  if (
    record === null
    || typeof record !== "object"
    || Array.isArray(record)
    || record.type !== "event_msg"
  ) {
    return null;
  }

  const payload = record.payload;
  if (
    payload === null
    || typeof payload !== "object"
    || Array.isArray(payload)
    || !SUPPORTED_EVENT_TYPES.has(payload.type)
  ) {
    return null;
  }

  assertTurnId(payload.turn_id, { lineNumber });
  const event = {
    type: payload.type,
    turnId: payload.turn_id,
  };
  if (includeFinalAnswer && payload.type === "task_complete") {
    if (
      payload.last_agent_message !== undefined
      && payload.last_agent_message !== null
      && typeof payload.last_agent_message !== "string"
    ) {
      throw createError(
        "TASK_EVENT_INVALID",
        `Codex task completion has an invalid final answer at line ${lineNumber}`,
        { lineNumber },
      );
    }
    event.finalAnswer = payload.last_agent_message ?? null;
  }
  return event;
}

function parseLine(line, lineNumber, {
  incompleteTail = false,
  includeFinalAnswer = false,
} = {}) {
  if (!line.trim()) {
    return {
      event: null,
      ignoredIncompleteTail: false,
    };
  }

  let record;
  try {
    record = JSON.parse(line);
  } catch (cause) {
    if (incompleteTail) {
      return {
        event: null,
        ignoredIncompleteTail: true,
      };
    }

    throw createError(
      "TASK_JSONL_MALFORMED",
      `Malformed Codex JSONL at line ${lineNumber}: ${cause.message}`,
      { cause, lineNumber },
    );
  }

  return {
    event: normalizeRecord(record, lineNumber, { includeFinalAnswer }),
    ignoredIncompleteTail: false,
  };
}

function assertLineLength(line, lineNumber) {
  if (line.length > MAX_JSONL_LINE_LENGTH) {
    throw createError(
      "TASK_JSONL_LINE_TOO_LARGE",
      `Codex JSONL line ${lineNumber} exceeds the supported size`,
      { lineNumber },
    );
  }
}

function assertReadable(readable) {
  if (
    readable === null
    || typeof readable !== "object"
    || typeof readable[Symbol.asyncIterator] !== "function"
  ) {
    throw new TypeError("readable must be an async iterable");
  }
}

function assertReducer(reducer) {
  if (typeof reducer !== "function") {
    throw new TypeError("reducer must be a function");
  }
}

export async function readCodexSessionMetadata(readable, expectedTaskId) {
  assertReadable(readable);
  if (
    typeof expectedTaskId !== "string"
    || expectedTaskId.trim().length === 0
    || expectedTaskId.length > MAX_TASK_ID_LENGTH
  ) {
    throw new TypeError("expectedTaskId must be a non-empty bounded string");
  }

  const decoder = new StringDecoder("utf8");
  let fragment = "";
  let lineCount = 0;

  function inspectLine(rawLine) {
    lineCount += 1;
    const line = rawLine.endsWith("\r")
      ? rawLine.slice(0, -1)
      : rawLine;
    assertLineLength(line, lineCount);
    if (!line.trim()) {
      return null;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch (cause) {
      throw createError(
        "TASK_JSONL_MALFORMED",
        `Malformed Codex JSONL at line ${lineCount}: ${cause.message}`,
        { cause, lineNumber: lineCount },
      );
    }

    if (record?.type !== "session_meta") {
      return null;
    }
    const taskId = record.payload?.id;
    const cwd = record.payload?.cwd;
    const threadSource = record.payload?.thread_source ?? null;
    if (
      taskId !== expectedTaskId
      || typeof cwd !== "string"
      || !path.isAbsolute(cwd)
      || (
        threadSource !== null
        && (
          typeof threadSource !== "string"
          || threadSource.length === 0
          || threadSource.length > MAX_TASK_ID_LENGTH
        )
      )
    ) {
      throw createError(
        "TASK_SESSION_META_INVALID",
        "Codex session metadata does not match the expected Task and project",
        { lineNumber: lineCount },
      );
    }
    return Object.freeze({
      taskId,
      cwd: path.normalize(cwd),
      threadSource,
    });
  }

  try {
    for await (const chunk of readable) {
      const bytes = typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk);
      fragment += decoder.write(bytes);
      let newlineIndex = fragment.indexOf("\n");

      while (newlineIndex !== -1) {
        const metadata = inspectLine(fragment.slice(0, newlineIndex));
        if (metadata) {
          return metadata;
        }
        fragment = fragment.slice(newlineIndex + 1);
        newlineIndex = fragment.indexOf("\n");
      }
      assertLineLength(
        fragment.endsWith("\r") ? fragment.slice(0, -1) : fragment,
        lineCount + 1,
      );
    }

    fragment += decoder.end();
    if (fragment.length > 0) {
      const metadata = inspectLine(fragment);
      if (metadata) {
        return metadata;
      }
    }
    throw createError(
      "TASK_SESSION_META_MISSING",
      "Codex session metadata was not found",
    );
  } finally {
    if (typeof readable.destroy === "function" && !readable.destroyed) {
      readable.destroy();
    }
  }
}

function invalidTurnContext(message, details = {}) {
  return createError(
    "TASK_TURN_CONTEXT_INVALID",
    message,
    details,
  );
}

function normalizeServiceTier(value, lineNumber, source) {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_TASK_ID_LENGTH
    || /\s/.test(value)
  ) {
    throw invalidTurnContext(
      `Codex ${source} has an invalid service tier at line ${lineNumber}`,
      { lineNumber },
    );
  }
  return value;
}

function normalizeTurnContext(payload, lineNumber) {
  if (
    payload === null
    || typeof payload !== "object"
    || Array.isArray(payload)
  ) {
    throw invalidTurnContext(
      `Codex turn context is invalid at line ${lineNumber}`,
      { lineNumber },
    );
  }
  const cwd = payload.cwd;
  const model = payload.model;
  const reasoningEffort = payload.effort ?? null;
  const serviceTier = normalizeServiceTier(
    payload.service_tier ?? null,
    lineNumber,
    "turn context",
  );
  const approvalPolicy = payload.approval_policy;
  const sessionSandboxType = payload.sandbox_policy?.type;
  const sandboxType = SESSION_SANDBOX_TYPES.get(sessionSandboxType);
  const permissionProfile = payload.permission_profile;
  if (
    typeof cwd !== "string"
    || !path.isAbsolute(cwd)
    || typeof model !== "string"
    || model.length === 0
    || model.length > MAX_TASK_ID_LENGTH
    || /\s/.test(model)
    || (
      reasoningEffort !== null
      && !REASONING_EFFORTS.has(reasoningEffort)
    )
    || approvalPolicy === undefined
    || sandboxType === undefined
    || permissionProfile === null
    || typeof permissionProfile !== "object"
    || Array.isArray(permissionProfile)
  ) {
    throw invalidTurnContext(
      `Codex turn context cannot preserve execution settings at line ${lineNumber}`,
      { lineNumber },
    );
  }

  let activePermissionProfile = null;
  if (permissionProfile.type !== "disabled") {
    if (
      typeof permissionProfile.id !== "string"
      || permissionProfile.id.length === 0
      || permissionProfile.id.length > MAX_TASK_ID_LENGTH
      || /\s/.test(permissionProfile.id)
    ) {
      throw invalidTurnContext(
        `Codex turn context cannot preserve its managed permission profile at line ${lineNumber}`,
        { lineNumber },
      );
    }
    activePermissionProfile = {
      id: permissionProfile.id,
      extends: permissionProfile.extends ?? null,
    };
  }

  return {
    cwd: path.normalize(cwd),
    settings: {
      activePermissionProfile,
      approvalPolicy: structuredClone(approvalPolicy),
      model,
      reasoningEffort,
      sandboxPolicy: { type: sandboxType },
      serviceTier,
    },
  };
}

export async function readCodexTaskRunSettings(readable, expectedTaskId) {
  assertReadable(readable);
  if (
    typeof expectedTaskId !== "string"
    || expectedTaskId.trim().length === 0
    || expectedTaskId.length > MAX_TASK_ID_LENGTH
  ) {
    throw new TypeError("expectedTaskId must be a non-empty bounded string");
  }

  const decoder = new StringDecoder("utf8");
  let fragment = "";
  let lineCount = 0;
  let metadata = null;
  let sawSessionMetadata = false;
  let latestContext = null;
  let latestAppliedServiceTier;

  function consumeLine(rawLine, { incompleteTail = false } = {}) {
    lineCount += 1;
    const line = rawLine.endsWith("\r")
      ? rawLine.slice(0, -1)
      : rawLine;
    assertLineLength(line, lineCount);
    if (!line.trim()) return;

    let record;
    try {
      record = JSON.parse(line);
    } catch (cause) {
      if (incompleteTail) return;
      throw createError(
        "TASK_JSONL_MALFORMED",
        `Malformed Codex JSONL at line ${lineCount}: ${cause.message}`,
        { cause, lineNumber: lineCount },
      );
    }

    if (record?.type === "session_meta") {
      sawSessionMetadata = true;
      const taskId = record.payload?.id;
      const cwd = record.payload?.cwd;
      if (taskId !== expectedTaskId) {
        return;
      }
      if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
        throw createError(
          "TASK_SESSION_META_INVALID",
          `Codex session metadata does not match Task ID ${bounded(expectedTaskId, 256)}`,
          { lineNumber: lineCount },
        );
      }
      const matching = {
        taskId,
        cwd: path.normalize(cwd),
      };
      if (metadata && !pathsEqual(metadata.cwd, matching.cwd)) {
        throw createError(
          "TASK_SESSION_META_INVALID",
          `Codex session metadata does not match Task ID ${bounded(expectedTaskId, 256)}`,
          { lineNumber: lineCount },
        );
      }
      metadata = matching;
      return;
    }
    if (record?.type === "turn_context") {
      latestContext = normalizeTurnContext(record.payload, lineCount);
      return;
    }
    if (
      record?.type === "event_msg"
      && record.payload?.type === "thread_settings_applied"
    ) {
      const settings = record.payload.thread_settings;
      if (
        settings !== null
        && typeof settings === "object"
        && !Array.isArray(settings)
        && Object.hasOwn(settings, "service_tier")
      ) {
        latestAppliedServiceTier = normalizeServiceTier(
          settings.service_tier,
          lineCount,
          "applied thread settings",
        );
      }
    }
  }

  function consumeDecoded(text) {
    fragment += text;
    let newlineIndex = fragment.indexOf("\n");
    while (newlineIndex !== -1) {
      consumeLine(fragment.slice(0, newlineIndex));
      fragment = fragment.slice(newlineIndex + 1);
      newlineIndex = fragment.indexOf("\n");
    }
    assertLineLength(
      fragment.endsWith("\r") ? fragment.slice(0, -1) : fragment,
      lineCount + 1,
    );
  }

  try {
    for await (const chunk of readable) {
      consumeDecoded(
        decoder.write(
          typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
        ),
      );
    }
    consumeDecoded(decoder.end());
    if (fragment.length > 0) {
      consumeLine(fragment, { incompleteTail: true });
    }
    if (!metadata) {
      throw createError(
        sawSessionMetadata
          ? "TASK_SESSION_META_INVALID"
          : "TASK_SESSION_META_MISSING",
        sawSessionMetadata
          ? `Codex session metadata does not match Task ID ${bounded(expectedTaskId, 256)}`
          : "Codex session metadata was not found",
      );
    }
    if (!latestContext) {
      throw createError(
        "TASK_TURN_CONTEXT_MISSING",
        "Codex Task has no persisted turn context",
      );
    }
    if (!pathsEqual(latestContext.cwd, metadata.cwd)) {
      throw invalidTurnContext(
        "Codex Task turn context cwd does not match its session metadata",
      );
    }
    return {
      taskId: metadata.taskId,
      cwd: latestContext.cwd,
      settings: {
        ...latestContext.settings,
        ...(latestAppliedServiceTier === undefined
          ? {}
          : { serviceTier: latestAppliedServiceTier }),
      },
    };
  } finally {
    if (typeof readable.destroy === "function" && !readable.destroyed) {
      readable.destroy();
    }
  }
}

export async function scanCodexTaskEvents(readable, reducer, options = {}) {
  assertReadable(readable);
  assertReducer(reducer);
  if (
    options === null
    || typeof options !== "object"
    || Array.isArray(options)
    || Object.keys(options).some((key) => key !== "includeFinalAnswer")
    || (
      options.includeFinalAnswer !== undefined
      && typeof options.includeFinalAnswer !== "boolean"
    )
  ) {
    throw new TypeError("options may contain only boolean includeFinalAnswer");
  }
  const includeFinalAnswer = options.includeFinalAnswer ?? false;

  const decoder = new StringDecoder("utf8");
  let fragment = "";
  let eventCount = 0;
  let ignoredIncompleteTail = false;
  let lineCount = 0;

  async function consumeCompleteLine(rawLine) {
    lineCount += 1;
    const line = rawLine.endsWith("\r")
      ? rawLine.slice(0, -1)
      : rawLine;
    assertLineLength(line, lineCount);

    const parsed = parseLine(line, lineCount, { includeFinalAnswer });
    if (parsed.event) {
      await reducer(parsed.event);
      eventCount += 1;
    }
  }

  async function consumeDecoded(text) {
    fragment += text;
    let newlineIndex = fragment.indexOf("\n");

    while (newlineIndex !== -1) {
      const rawLine = fragment.slice(0, newlineIndex);
      await consumeCompleteLine(rawLine);
      fragment = fragment.slice(newlineIndex + 1);
      newlineIndex = fragment.indexOf("\n");
    }

    assertLineLength(
      fragment.endsWith("\r") ? fragment.slice(0, -1) : fragment,
      lineCount + 1,
    );
  }

  try {
    for await (const chunk of readable) {
      const bytes = typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk);
      await consumeDecoded(decoder.write(bytes));
    }

    await consumeDecoded(decoder.end());

    if (fragment.length > 0) {
      lineCount += 1;
      const finalLine = fragment.endsWith("\r")
        ? fragment.slice(0, -1)
        : fragment;
      assertLineLength(finalLine, lineCount);
      const parsed = parseLine(finalLine, lineCount, {
        incompleteTail: true,
        includeFinalAnswer,
      });
      ignoredIncompleteTail = parsed.ignoredIncompleteTail;

      if (parsed.event) {
        await reducer(parsed.event);
        eventCount += 1;
      }
    }

    return {
      eventCount,
      ignoredIncompleteTail,
      lineCount,
    };
  } finally {
    if (typeof readable.destroy === "function" && !readable.destroyed) {
      readable.destroy();
    }
  }
}

function validateNormalizedEvent(event) {
  if (
    event === null
    || typeof event !== "object"
    || Array.isArray(event)
    || !SUPPORTED_EVENT_TYPES.has(event.type)
  ) {
    throw createError(
      "TASK_EVENT_INVALID",
      "Task event reducer received an unsupported event",
    );
  }

  assertTurnId(event.turnId);
  if (
    Object.hasOwn(event, "finalAnswer")
    && (
      event.type !== "task_complete"
      || (
        event.finalAnswer !== null
        && typeof event.finalAnswer !== "string"
      )
    )
  ) {
    throw createError(
      "TASK_EVENT_INVALID",
      "Task event reducer received an invalid final answer",
    );
  }
}

function contradictory(turnId) {
  return diagnostic(
    "TASK_EVENT_CONTRADICTORY",
    `Codex task events contain a contradictory sequence for Turn ID ${bounded(turnId, 256)}`,
  );
}

function validateReducerOptions(options) {
  const mode = options?.mode ?? "latest";
  if (mode !== "latest" && mode !== "exact") {
    throw createError(
      "TASK_EVENT_INVALID",
      `Unsupported task event reducer mode: ${bounded(mode)}`,
    );
  }

  if (mode === "exact") {
    assertTurnId(options?.turnId);
  }
  if (
    options?.includeFinalAnswer !== undefined
    && typeof options.includeFinalAnswer !== "boolean"
  ) {
    throw createError(
      "TASK_EVENT_INVALID",
      "includeFinalAnswer must be a boolean",
    );
  }

  return {
    mode,
    turnId: mode === "exact" ? options.turnId : null,
    includeFinalAnswer: options?.includeFinalAnswer ?? false,
  };
}

export function createTaskEventReducer(options = {}) {
  const normalizedOptions = validateReducerOptions(options);
  const exactTurnId = normalizedOptions.turnId;
  let selectedTurnId = exactTurnId;
  let turnState = normalizedOptions.mode === "latest"
    ? "not_started"
    : null;
  let currentDiagnostic = null;
  let finalAnswer = null;

  function markContradictory(turnId) {
    turnState = "unknown";
    finalAnswer = null;
    currentDiagnostic ??= contradictory(turnId);
  }

  function acceptLatest(event) {
    if (event.type === "task_started") {
      if (event.turnId !== selectedTurnId) {
        selectedTurnId = event.turnId;
        turnState = "in_progress";
        currentDiagnostic = null;
        finalAnswer = null;
        return;
      }

      markContradictory(event.turnId);
      return;
    }

    if (event.turnId !== selectedTurnId) {
      return;
    }

    if (turnState !== "in_progress") {
      markContradictory(event.turnId);
      return;
    }

    turnState = event.type === "task_complete"
      ? "ended"
      : "aborted";
    finalAnswer = event.type === "task_complete"
      ? event.finalAnswer ?? null
      : null;
  }

  function acceptExact(event) {
    if (event.turnId !== exactTurnId) {
      return;
    }

    if (event.type === "task_started") {
      if (turnState === null) {
        turnState = "in_progress";
        return;
      }

      markContradictory(event.turnId);
      return;
    }

    if (turnState !== "in_progress") {
      markContradictory(event.turnId);
      return;
    }

    turnState = event.type === "task_complete"
      ? "ended"
      : "aborted";
    finalAnswer = event.type === "task_complete"
      ? event.finalAnswer ?? null
      : null;
  }

  return {
    accept(event) {
      validateNormalizedEvent(event);
      if (normalizedOptions.mode === "latest") {
        acceptLatest(event);
      } else {
        acceptExact(event);
      }
    },

    result() {
      if (normalizedOptions.mode === "exact" && turnState === null) {
        return {
          mode: "exact",
          turnId: exactTurnId,
          turnState: "unknown",
          ...(normalizedOptions.includeFinalAnswer
            ? { finalAnswer: null }
            : {}),
          diagnostics: [
            diagnostic(
              "TASK_TURN_NOT_FOUND",
              `Codex history contains no event for Turn ID ${bounded(exactTurnId, 256)}`,
            ),
          ],
        };
      }

      return {
        mode: normalizedOptions.mode,
        turnId: selectedTurnId,
        turnState,
        ...(normalizedOptions.includeFinalAnswer ? { finalAnswer } : {}),
        diagnostics: currentDiagnostic ? [currentDiagnostic] : [],
      };
    },
  };
}

export function reduceTaskEvents(events, options = {}) {
  if (
    events === null
    || events === undefined
    || typeof events[Symbol.iterator] !== "function"
  ) {
    throw new TypeError("events must be iterable");
  }

  const reducer = createTaskEventReducer(options);
  for (const event of events) {
    reducer.accept(event);
  }
  return reducer.result();
}
