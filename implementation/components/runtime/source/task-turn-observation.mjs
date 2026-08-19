import { observeExactTurn } from "./task-state-observer.mjs";

export const DEFAULT_TASK_WAIT_TIMEOUT_MS = 120_000;
export const MAX_TASK_WAIT_TIMEOUT_MS = 300_000;
export const DEFAULT_TASK_WAIT_POLL_INTERVAL_MS = 250;

const MAX_IDENTIFIER_LENGTH = 512;
const TERMINAL_TURN_STATES = new Set(["ended", "aborted"]);
const OBSERVABLE_TURN_STATES = new Set([
  "in_progress",
  "ended",
  "aborted",
]);
const OBSERVABLE_LOCATIONS = new Set(["active", "archived"]);
const INPUT_KEYS = new Set(["taskId", "turnId", "timeoutMs"]);

function observationError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "TaskTurnObservationError";
  error.code = code;
  Object.assign(error, details);
  return error;
}

function requireIdentifier(value, label) {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > MAX_IDENTIFIER_LENGTH
    || value.includes("/")
    || value.includes("\\")
  ) {
    throw observationError(
      "TASK_OBSERVATION_INPUT_INVALID",
      `${label} must be a non-empty bounded identifier`,
    );
  }
  return value;
}

function requireInput(input) {
  if (
    input === null
    || typeof input !== "object"
    || Array.isArray(input)
    || Object.keys(input).some((key) => !INPUT_KEYS.has(key))
  ) {
    throw observationError(
      "TASK_OBSERVATION_INPUT_INVALID",
      "Task observation input is invalid",
    );
  }
  return {
    taskId: requireIdentifier(input.taskId, "taskId"),
    turnId: requireIdentifier(input.turnId, "turnId"),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  };
}

function requireTimeout(value) {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > MAX_TASK_WAIT_TIMEOUT_MS
  ) {
    throw observationError(
      "TASK_WAIT_TIMEOUT_INVALID",
      `timeoutMs must be an integer from 0 to ${MAX_TASK_WAIT_TIMEOUT_MS}`,
    );
  }
  return value;
}

function requirePollInterval(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("pollIntervalMs must be a positive safe integer");
  }
  return value;
}

function resultFromSnapshot(taskId, turnId, snapshot) {
  if (
    snapshot?.taskId !== taskId
    || snapshot?.turnId !== turnId
    || !OBSERVABLE_LOCATIONS.has(snapshot?.location)
  ) {
    throw observationError(
      "TASK_TURN_UNAVAILABLE",
      "The exact Task turn is missing or has no readable Codex history",
      { taskId, turnId },
    );
  }
  if (!OBSERVABLE_TURN_STATES.has(snapshot.turnState)) {
    const diagnostic = Array.isArray(snapshot.diagnostics)
      ? snapshot.diagnostics[0]
      : null;
    throw observationError(
      typeof diagnostic?.code === "string"
        ? diagnostic.code
        : "TASK_TURN_STATE_UNKNOWN",
      typeof diagnostic?.message === "string"
        ? diagnostic.message
        : "The exact Task turn state could not be proven",
      { taskId, turnId },
    );
  }
  if (snapshot.location === "archived" && snapshot.turnState === "in_progress") {
    throw observationError(
      "TASK_TURN_STATE_UNKNOWN",
      "An archived Task turn cannot be proven to make further progress",
      { taskId, turnId },
    );
  }
  if (
    snapshot.finalAnswer !== null
    && typeof snapshot.finalAnswer !== "string"
  ) {
    throw observationError(
      "TASK_FINAL_ANSWER_INVALID",
      "The exact Task turn returned an invalid final answer",
      { taskId, turnId },
    );
  }

  return Object.freeze({
    run: "ok",
    operation: "read",
    taskId,
    turnId,
    location: snapshot.location,
    turnState: snapshot.turnState,
    finalAnswer: snapshot.finalAnswer,
  });
}

export async function readExactTaskTurn(input, options = {}) {
  const parsed = requireInput(input);
  if (parsed.timeoutMs !== undefined) {
    throw observationError(
      "TASK_OBSERVATION_INPUT_INVALID",
      "read does not accept timeoutMs",
      { taskId: parsed.taskId, turnId: parsed.turnId },
    );
  }
  const observe = options.observeExactTurn ?? observeExactTurn;
  if (typeof observe !== "function") {
    throw new TypeError("observeExactTurn must be a function");
  }
  const snapshot = await observe(parsed.taskId, parsed.turnId, {
    ...(options.observerOptions ?? {}),
    includeFinalAnswer: true,
  });
  return resultFromSnapshot(parsed.taskId, parsed.turnId, snapshot);
}

export async function waitForExactTaskTurn(input, options = {}) {
  const parsed = requireInput(input);
  const timeoutMs = requireTimeout(
    parsed.timeoutMs ?? DEFAULT_TASK_WAIT_TIMEOUT_MS,
  );
  const pollIntervalMs = requirePollInterval(
    options.pollIntervalMs ?? DEFAULT_TASK_WAIT_POLL_INTERVAL_MS,
  );
  const nowMs = options.nowMs ?? Date.now;
  const sleep = options.sleep
    ?? ((milliseconds) => new Promise(
      (resolve) => setTimeout(resolve, milliseconds),
    ));
  const read = options.readExactTaskTurn
    ?? ((request) => readExactTaskTurn(request, options));
  if (
    typeof nowMs !== "function"
    || typeof sleep !== "function"
    || typeof read !== "function"
  ) {
    throw new TypeError("Task wait dependencies must be functions");
  }

  const deadline = nowMs() + timeoutMs;
  for (;;) {
    const result = await read({
      taskId: parsed.taskId,
      turnId: parsed.turnId,
    });
    if (TERMINAL_TURN_STATES.has(result.turnState)) {
      return Object.freeze({
        ...result,
        operation: "wait",
        timedOut: false,
      });
    }

    const remaining = deadline - nowMs();
    if (remaining <= 0) {
      return Object.freeze({
        ...result,
        operation: "wait",
        timedOut: true,
      });
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}
