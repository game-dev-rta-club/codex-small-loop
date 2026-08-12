import { createReadStream } from "node:fs";

import {
  locateTaskHistories,
  resolveCodexSessionRoots,
} from "./codex-session-locator.mjs";
import {
  createTaskEventReducer,
  MAX_TURN_ID_LENGTH,
  scanCodexTaskEvents,
} from "./codex-jsonl.mjs";

const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 32;
const MAX_DIAGNOSTIC_LENGTH = 512;
const MAX_TASK_ID_LENGTH = 512;
const MODES = new Set(["latest", "exact"]);
const TERMINAL_TURN_STATES = new Set(["ended", "aborted"]);
const JSONL_ERROR_CODES = new Set([
  "TASK_JSONL_MALFORMED",
  "TASK_JSONL_LINE_TOO_LARGE",
  "TASK_EVENT_INVALID",
]);

function bounded(value, maximum = MAX_DIAGNOSTIC_LENGTH) {
  const text = String(value);
  return text.length <= maximum
    ? text
    : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function createError(code, message, details = {}) {
  const error = new Error(bounded(message));
  error.name = "TaskStateObserverError";
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

function validIdentifier(value, maximum) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maximum
    && !value.includes("/")
    && !value.includes("\\");
}

function validateRequests(requests) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw createError(
      "TASK_EVENT_INVALID",
      "Task observation requires at least one request",
    );
  }

  return requests.map((request) => {
    if (
      request === null
      || typeof request !== "object"
      || Array.isArray(request)
      || !validIdentifier(request.taskId, MAX_TASK_ID_LENGTH)
      || !MODES.has(request.mode)
    ) {
      throw createError(
        "TASK_EVENT_INVALID",
        "Task observation received an invalid request",
      );
    }

    if (
      request.mode === "exact"
      && !validIdentifier(request.turnId, MAX_TURN_ID_LENGTH)
    ) {
      throw createError(
        "TASK_EVENT_INVALID",
        "Exact task observation requires a valid Turn ID",
      );
    }

    return request.mode === "exact"
      ? {
        taskId: request.taskId,
        mode: "exact",
        turnId: request.turnId,
      }
      : {
        taskId: request.taskId,
        mode: "latest",
      };
  });
}

function validateConcurrency(value) {
  const concurrency = value ?? DEFAULT_CONCURRENCY;
  if (
    !Number.isInteger(concurrency)
    || concurrency < 1
    || concurrency > MAX_CONCURRENCY
  ) {
    throw createError(
      "TASK_EVENT_INVALID",
      `Task observation concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`,
    );
  }
  return concurrency;
}

function validateOpenHistory(openHistory) {
  if (typeof openHistory !== "function") {
    throw new TypeError("openHistory must be a function");
  }
  return openHistory;
}

function defaultOpenHistory(historyFile) {
  return createReadStream(historyFile);
}

function snapshotFromLocation(request, location, result = null) {
  const common = {
    taskId: request.taskId,
    location: location.location,
    historyFile: location.historyFile,
  };

  if (request.mode === "exact") {
    return {
      ...common,
      turnId: request.turnId,
      turnState: result?.turnState ?? "unknown",
      diagnostics: result?.diagnostics ?? [...location.diagnostics],
    };
  }

  return {
    ...common,
    latestTurnId: result?.turnId ?? null,
    turnState: result?.turnState ?? "unknown",
    diagnostics: result?.diagnostics ?? [...location.diagnostics],
  };
}

function degradedDiagnostic(error) {
  if (JSONL_ERROR_CODES.has(error?.code)) {
    return diagnostic(error.code, error.message);
  }

  return diagnostic(
    "TASK_HISTORY_UNREADABLE",
    "Codex task history could not be read",
  );
}

async function runBounded(jobs, concurrency, run) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, jobs.length);

  async function worker() {
    while (nextIndex < jobs.length) {
      const index = nextIndex;
      nextIndex += 1;
      await run(jobs[index]);
    }
  }

  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );
}

export async function observeTasks(requests, options = {}) {
  const normalizedRequests = validateRequests(requests);
  const concurrency = validateConcurrency(options.concurrency);
  const openHistory = validateOpenHistory(
    options.openHistory ?? defaultOpenHistory,
  );
  const taskIds = [...new Set(
    normalizedRequests.map(({ taskId }) => taskId),
  )];
  const locations = await locateTaskHistories(taskIds, {
    roots: options.roots ?? resolveCodexSessionRoots(),
    cachedPaths: options.cachedPaths,
    fileSystem: options.fileSystem,
  });
  const groups = new Map();

  for (const [index, request] of normalizedRequests.entries()) {
    const entries = groups.get(request.taskId) ?? [];
    entries.push({
      index,
      request,
      reducer: createTaskEventReducer(
        request.mode === "exact"
          ? { mode: "exact", turnId: request.turnId }
          : { mode: "latest" },
      ),
    });
    groups.set(request.taskId, entries);
  }

  const snapshots = new Array(normalizedRequests.length);
  const jobs = [];

  for (const taskId of taskIds) {
    const location = locations.get(taskId);
    const entries = groups.get(taskId);

    if (location.historyFile === null) {
      for (const entry of entries) {
        snapshots[entry.index] = snapshotFromLocation(
          entry.request,
          location,
        );
      }
      continue;
    }

    jobs.push({
      entries,
      location,
    });
  }

  await runBounded(jobs, concurrency, async ({ entries, location }) => {
    try {
      const readable = await openHistory(location.historyFile);
      await scanCodexTaskEvents(readable, (event) => {
        for (const entry of entries) {
          entry.reducer.accept(event);
        }
      });

      for (const entry of entries) {
        snapshots[entry.index] = snapshotFromLocation(
          entry.request,
          location,
          entry.reducer.result(),
        );
      }
    } catch (error) {
      const failure = degradedDiagnostic(error);
      for (const entry of entries) {
        snapshots[entry.index] = snapshotFromLocation(
          entry.request,
          location,
          {
            turnId: null,
            turnState: "unknown",
            diagnostics: [failure],
          },
        );
      }
    }
  });

  return snapshots;
}

export async function observeLatestTask(taskId, options = {}) {
  const snapshots = await observeTasks(
    [{ taskId, mode: "latest" }],
    options,
  );
  return snapshots[0];
}

export async function observeExactTurn(taskId, turnId, options = {}) {
  const snapshots = await observeTasks(
    [{ taskId, mode: "exact", turnId }],
    options,
  );
  return snapshots[0];
}

export function sameTurnBoundary(left, right) {
  if (
    left === null
    || right === null
    || typeof left !== "object"
    || typeof right !== "object"
  ) {
    return false;
  }

  return left.taskId === right.taskId
    && left.location === "active"
    && right.location === "active"
    && validIdentifier(left.latestTurnId, MAX_TURN_ID_LENGTH)
    && left.latestTurnId === right.latestTurnId
    && TERMINAL_TURN_STATES.has(left.turnState)
    && left.turnState === right.turnState;
}
