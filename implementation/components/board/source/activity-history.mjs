export const MAX_ACTIVITY_JSONL_LINE_BYTES = 8 * 1024 * 1024;
export const MAX_ACTIVITY_TEXT_BYTES = 512 * 1024;
export const MAX_ACTIVITY_RECORDS = 200_000;
export const COMPACTION_PAIR_WINDOW_MS = 100;

function activityError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "ActivityHistoryError";
  error.code = code;
  Object.assign(error, details);
  return error;
}

function iso(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = typeof value === "number" && value < 10_000_000_000
    ? value * 1_000
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function boundedText(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return Buffer.byteLength(value, "utf8") <= MAX_ACTIVITY_TEXT_BYTES
    ? value
    : null;
}

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function emptyHistory() {
  return {
    metadata: null,
    records: [],
    taskEvents: [],
    lifecycleStartedAt: null,
    lifecycleEndedAt: null,
    lifecycleState: "unknown",
    startedAt: null,
    endedAt: null,
    cumulativeTokens: 0,
    hasTokenUsage: false,
    retainedContextTokens: null,
    contextWindow: null,
    compactions: 0,
    partial: false,
    owningHistoryStarted: false,
    lastTopCompactionAt: null,
    diagnostics: [],
  };
}

function timestampFor(record) {
  return iso(record?.timestamp)
    ?? iso(record?.payload?.started_at)
    ?? iso(record?.payload?.completed_at);
}

function lifecycleTimestampFor(record, eventType) {
  if (eventType === "task_started") {
    return iso(record?.payload?.started_at) ?? iso(record?.timestamp);
  }
  if (eventType === "task_complete" || eventType === "turn_aborted") {
    return iso(record?.payload?.completed_at) ?? iso(record?.timestamp);
  }
  return null;
}

function noteTime(history, timestamp) {
  if (!timestamp) return;
  if (!history.startedAt || timestamp < history.startedAt) {
    history.startedAt = timestamp;
  }
  if (!history.endedAt || timestamp > history.endedAt) {
    history.endedAt = timestamp;
  }
}

function markPartial(history, code = "ACTIVITY_HISTORY_AGGREGATE_BOUNDED") {
  history.partial = true;
  if (!history.diagnostics.some((item) => item.code === code)) {
    history.diagnostics.push({
      code,
      message: "Some complete history entries were omitted by the Activity safety budget.",
    });
  }
}

function chargeProjection(history, budget, entry, event = false) {
  if (!budget) return true;
  const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
  if (
    budget.historyJsonBytes + bytes > budget.maxHistoryJsonBytes
    || (event && budget.timelineEvents + 1 > budget.maxTimelineEvents)
  ) {
    if (budget.omissionMode === "reject") {
      throw activityError("ACTIVITY_LIVE_PROJECTION_BOUNDED", "A live history append exceeded the retained projection bound.");
    }
    markPartial(history);
    budget.partial = true;
    budget.omittedHistoryEntries += 1;
    return false;
  }
  budget.historyJsonBytes += bytes;
  if (event) budget.timelineEvents += 1;
  return true;
}

function addVisibleRecord(history, kind, text, timestamp, sequence, budget) {
  const retained = boundedText(text);
  if (!retained) {
    if (typeof text === "string" && text.length > 0) {
      if (budget?.omissionMode === "reject") {
        throw activityError("ACTIVITY_LIVE_PROJECTION_BOUNDED", "A live visible history record exceeded the text bound.");
      }
      history.diagnostics.push({
        code: "ACTIVITY_TEXT_TOO_LARGE",
        message: "A visible history text record exceeded the Activity limit.",
      });
      markPartial(history, "ACTIVITY_TEXT_TOO_LARGE");
    }
    return;
  }
  const projected = { kind, text: retained, timestamp, sequence };
  if (!chargeProjection(history, budget, projected)) return null;
  history.records.push(projected);
  return projected;
}

function consumeRecord(history, record, sequence, budget) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return;
  const timestamp = timestampFor(record);

  if (record.type === "session_meta") {
    const payload = record.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw activityError("ACTIVITY_SESSION_META_INVALID", "Session metadata is invalid.");
    }
    const metadata = {
      taskId: payload.id,
      cwd: payload.cwd,
      parentTaskId: typeof payload.forked_from_id === "string"
        ? payload.forked_from_id
        : null,
      threadSource: typeof payload.thread_source === "string"
        ? payload.thread_source
        : null,
      timestamp: iso(payload.timestamp) ?? timestamp,
    };
    if (history.metadata) {
      // Forked and compacted histories may replay ancestor metadata. The first
      // session_meta is the owning envelope; later metadata is history content.
      return;
    }
    history.metadata = metadata;
    noteTime(history, metadata.timestamp);
    return;
  }

  if (record.type === "compacted") {
    if (history.owningHistoryStarted) {
      history.compactions += 1;
      history.lastTopCompactionAt = timestamp ? Date.parse(timestamp) : null;
    }
    return;
  }
  if (record.type !== "event_msg") return;

  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  if (!history.owningHistoryStarted) {
    const eventStartedAt = payload.type === "task_started"
      ? lifecycleTimestampFor(record, payload.type)
      : null;
    if (
      !eventStartedAt
      || !history.metadata?.timestamp
      || eventStartedAt < history.metadata.timestamp
    ) {
      return;
    }
    history.owningHistoryStarted = true;
  }
  noteTime(history, timestamp);
  switch (payload.type) {
    case "user_message":
      addVisibleRecord(history, "input", payload.message, timestamp, sequence, budget);
      break;
    case "agent_reasoning":
      // Hidden or summarized reasoning is not Activity content. Only visible
      // Agent messages participate in the Think/Output contract.
      break;
    case "agent_message": {
      // Charge the longest possible kind spelling. Finalization below changes
      // at most one retained message to Output after matching completion proof.
      const projected = addVisibleRecord(history, "output", payload.message, timestamp, sequence, budget);
      if (!projected) {
        history.finalityProven = false;
        break;
      }
      projected.kind = "think";
      if (history.activeTurn) history.activeTurn.messageSequences.push(sequence);
      break;
    }
    case "task_started":
    case "task_complete":
    case "turn_aborted": {
      const eventTimestamp = lifecycleTimestampFor(record, payload.type);
      const taskEvent = {
        type: payload.type,
        turnId: typeof payload.turn_id === "string" ? payload.turn_id : null,
        timestamp: eventTimestamp,
        sequence,
      };
      if (chargeProjection(history, budget, taskEvent, true)) {
        history.taskEvents.push(taskEvent);
      } else {
        history.finalityProven = false;
      }
      noteTime(history, iso(payload.started_at));
      noteTime(history, iso(payload.completed_at));
      if (payload.type === "task_started") {
        if (history.activeTurn) history.finalityProven = false;
        history.activeTurn = {
          turnId: taskEvent.turnId,
          messageSequences: [],
        };
        history.lifecycleStartedAt ??= taskEvent.timestamp;
        history.lifecycleEndedAt = null;
        history.lifecycleState = "running";
      } else {
        const turnMatches = history.activeTurn
          && (!history.activeTurn.turnId || !taskEvent.turnId || history.activeTurn.turnId === taskEvent.turnId);
        if (!turnMatches) {
          history.finalityProven = false;
        } else if (payload.type === "task_complete") {
          const messages = history.activeTurn.messageSequences;
          if (messages.length > 0) {
            history.latestConfirmedSequence = messages[messages.length - 1];
          }
        }
        history.activeTurn = null;
        history.lifecycleEndedAt = taskEvent.timestamp;
        history.lifecycleState = payload.type === "task_complete" ? "complete" : "aborted";
      }
      break;
    }
    case "token_count": {
      const used = finiteNonnegative(payload.info?.last_token_usage?.total_tokens);
      const retained = finiteNonnegative(payload.info?.last_token_usage?.input_tokens);
      const contextWindow = finiteNonnegative(payload.info?.model_context_window);
      if (used !== null) {
        history.cumulativeTokens += used;
        history.hasTokenUsage = true;
      }
      if (retained !== null) history.retainedContextTokens = retained;
      if (contextWindow !== null) history.contextWindow = contextWindow;
      break;
    }
    case "context_compacted": {
      const eventAt = timestamp ? Date.parse(timestamp) : null;
      const paired = Number.isFinite(eventAt)
        && Number.isFinite(history.lastTopCompactionAt)
        && eventAt >= history.lastTopCompactionAt
        && eventAt - history.lastTopCompactionAt <= COMPACTION_PAIR_WINDOW_MS;
      if (!paired) history.compactions += 1;
      history.lastTopCompactionAt = null;
      break;
    }
    default:
      // Tool, shell, command, patch, MCP and unknown payloads are excluded.
      break;
  }
}

export function createActivityHistoryContinuation({ budget = null, omissionMode = "partial" } = {}) {
  if (!["partial", "reject"].includes(omissionMode)) throw new TypeError("omissionMode must be partial or reject");
  if (budget) budget.omissionMode = omissionMode;
  const history = emptyHistory();
  history.activeTurn = null;
  history.latestConfirmedSequence = null;
  history.finalityProven = true;
  return {
    history,
    budget,
    omissionMode,
    fragment: Buffer.alloc(0),
    lineNumber: 0,
    sequence: 0,
  };
}

function consumeContinuationLine(continuation, line, incompleteTail = false) {
  continuation.lineNumber += 1;
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (Buffer.byteLength(normalized, "utf8") > MAX_ACTIVITY_JSONL_LINE_BYTES) {
      throw activityError("ACTIVITY_JSONL_LINE_TOO_LARGE", "A history line exceeded the Activity limit.", { lineNumber: continuation.lineNumber });
    }
    if (!normalized.trim()) return;
    let record;
    try {
      record = JSON.parse(normalized);
    } catch (cause) {
      if (incompleteTail) {
        continuation.history.diagnostics.push({
          code: "ACTIVITY_JSONL_INCOMPLETE_TAIL",
          message: "An incomplete final history record was ignored.",
        });
        markPartial(continuation.history, "ACTIVITY_JSONL_INCOMPLETE_TAIL");
        continuation.history.finalityProven = false;
        return;
      }
      throw activityError("ACTIVITY_JSONL_MALFORMED", "A complete history record is malformed.", { cause, lineNumber: continuation.lineNumber });
    }
    continuation.sequence += 1;
    if (continuation.sequence > MAX_ACTIVITY_RECORDS) {
      throw activityError("ACTIVITY_HISTORY_RECORD_LIMIT", "History exceeded the Activity record limit.");
    }
    consumeRecord(
      continuation.history,
      record,
      continuation.sequence,
      continuation.budget,
    );
}

export function appendActivityHistoryContinuation(continuation, chunk) {
  if (!continuation || typeof continuation !== "object") {
    throw new TypeError("continuation must be an Activity history continuation");
  }
  const input = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
  let source = continuation.fragment.length > 0
    ? Buffer.concat([continuation.fragment, input])
    : input;
  let newline = source.indexOf(0x0a);
  while (newline >= 0) {
    consumeContinuationLine(continuation, source.subarray(0, newline).toString("utf8"));
    source = source.subarray(newline + 1);
    newline = source.indexOf(0x0a);
  }
  if (source.length > MAX_ACTIVITY_JSONL_LINE_BYTES) {
    throw activityError("ACTIVITY_JSONL_LINE_TOO_LARGE", "A history line exceeded the Activity limit.");
  }
  continuation.fragment = Buffer.from(source);
  return continuation;
}

export function cloneActivityHistoryContinuation(continuation, { budget = continuation?.budget ?? null, omissionMode = continuation?.omissionMode ?? "partial" } = {}) {
  if (!continuation || typeof continuation !== "object") {
    throw new TypeError("continuation must be an Activity history continuation");
  }
  if (!["partial", "reject"].includes(omissionMode)) throw new TypeError("omissionMode must be partial or reject");
  if (budget) budget.omissionMode = omissionMode;
  return {
    history: structuredClone(continuation.history),
    budget,
    omissionMode,
    fragment: Buffer.from(continuation.fragment),
    lineNumber: continuation.lineNumber,
    sequence: continuation.sequence,
  };
}

export function snapshotActivityHistoryContinuation(continuation) {
  if (!continuation || typeof continuation !== "object") {
    throw new TypeError("continuation must be an Activity history continuation");
  }
  const history = structuredClone(continuation.history);
  if (!history.metadata) {
    throw activityError("ACTIVITY_SESSION_META_MISSING", "Session metadata is missing.");
  }
  let finalityProven = history.finalityProven;
  if (continuation.fragment.length > 0) {
    history.diagnostics.push({
      code: "ACTIVITY_JSONL_INCOMPLETE_TAIL",
      message: "An incomplete final history record was ignored.",
    });
    markPartial(history, "ACTIVITY_JSONL_INCOMPLETE_TAIL");
    finalityProven = false;
  }
  if (history.partial) finalityProven = false;
  if (finalityProven && history.latestConfirmedSequence !== null) {
    const output = history.records.find((record) => record.sequence === history.latestConfirmedSequence);
    if (output?.kind === "think") output.kind = "output";
  }
  if (history.activeTurn) history.lifecycleState = "running";
  delete history.owningHistoryStarted;
  delete history.lastTopCompactionAt;
  delete history.activeTurn;
  delete history.latestConfirmedSequence;
  delete history.finalityProven;
  return history;
}

export function finalizeActivityHistoryContinuation(continuation) {
  if (continuation.fragment.length > 0) {
    const fragment = continuation.fragment.toString("utf8");
    continuation.fragment = Buffer.alloc(0);
    consumeContinuationLine(continuation, fragment, true);
  }
  return snapshotActivityHistoryContinuation(continuation);
}

export async function scanActivityHistory(readable, { budget = null } = {}) {
  if (!readable || typeof readable[Symbol.asyncIterator] !== "function") {
    throw new TypeError("readable must be an async iterable");
  }
  const continuation = createActivityHistoryContinuation({ budget });
  for await (const chunk of readable) {
    appendActivityHistoryContinuation(continuation, chunk);
  }
  return finalizeActivityHistoryContinuation(continuation);
}
