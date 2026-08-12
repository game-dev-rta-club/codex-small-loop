import { constants } from "node:fs";
import { lstat, open, opendir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { resolveProject } from "../../runtime/source/project.mjs";
import { listReviewSnapshots } from "../../runtime/source/review-snapshot.mjs";
import { validateTaskLedger } from "../../runtime/source/task-ledger.mjs";
import {
  appendActivityHistoryContinuation,
  cloneActivityHistoryContinuation,
  createActivityHistoryContinuation,
  scanActivityHistory,
  snapshotActivityHistoryContinuation,
} from "./activity-history.mjs";
import { readActivitySignals } from "./activity-signal-reader.mjs";
import { readActivityThreadTitles } from "./activity-thread-titles.mjs";

export const MAX_ACTIVITY_AUTHORIZED_TASKS = 256;
export const MAX_ACTIVITY_SESSION_SOURCE_BYTES = 256 * 1024 * 1024;
export const MAX_ACTIVITY_PROJECTED_HISTORY_JSON_BYTES = 16 * 1024 * 1024;
export const MAX_ACTIVITY_TIMELINE_EVENTS = 50_000;
export const MAX_ACTIVITY_SIGNAL_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_ACTIVITY_DATA_REQUESTS_IN_FLIGHT = 1;

const MAX_DISCOVERY_ENTRIES = 12_000;
const MAX_SESSION_CANDIDATES = 1_024;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SIGNAL_BYTES = 256 * 1024;
const MAX_SIGNALS = 1_000;
const MAX_CONVERSATION_ACTIVITY_EVENTS = 4_096;
const TASK_FILE_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
export const MAX_ACTIVITY_LIVE_APPEND_BYTES = 2 * 1024 * 1024;
const liveContexts = new WeakMap();

export class ActivityDataError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "ActivityDataError";
    this.code = code;
  }
}

function diagnostic(code, message, taskId = null, details = {}) {
  return { code, message, taskId, ...details };
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function safeTaskId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function safeName(text, fallback) {
  const first = String(text ?? "").split(/\r?\n/u).find((line) => line.trim())?.trim();
  return first ? first.slice(0, 160) : fallback;
}

function createLoadBudget(overrides = {}) {
  return {
    maxAuthorizedTasks: overrides.maxAuthorizedTasks ?? MAX_ACTIVITY_AUTHORIZED_TASKS,
    maxSessionSourceBytes: overrides.maxSessionSourceBytes ?? MAX_ACTIVITY_SESSION_SOURCE_BYTES,
    maxHistoryJsonBytes: overrides.maxHistoryJsonBytes ?? MAX_ACTIVITY_PROJECTED_HISTORY_JSON_BYTES,
    maxTimelineEvents: overrides.maxTimelineEvents ?? MAX_ACTIVITY_TIMELINE_EVENTS,
    maxSignalJsonBytes: overrides.maxSignalJsonBytes ?? MAX_ACTIVITY_SIGNAL_JSON_BYTES,
    authorizedTasks: 0,
    sessionSourceBytes: 0,
    historyJsonBytes: 0,
    timelineEvents: 0,
    signalJsonBytes: 0,
    omittedTasks: 0,
    omittedSourceBytes: 0,
    rejectedTasks: 0,
    rejectedSourceBytes: 0,
    omittedHistoryEntries: 0,
    omittedSignals: 0,
    partial: false,
    omissionKeys: new Set(),
  };
}

function pushBoundedDiagnostic(diagnostics, entry, maximum = 100) {
  if (diagnostics.length < maximum) diagnostics.push(entry);
}

function markActivityOmission(budget, diagnostics, {
  code,
  message,
  taskId = null,
  sourceBytes = 0,
  count = 1,
  key = `${code}:${taskId ?? "global"}`,
  signal = false,
} = {}) {
  if (budget.omissionKeys.has(key)) return false;
  budget.omissionKeys.add(key);
  budget.partial = true;
  if (signal) {
    budget.omittedSignals += count;
  } else {
    budget.omittedTasks += count;
    budget.omittedSourceBytes += sourceBytes;
  }
  pushBoundedDiagnostic(diagnostics, diagnostic(code, message, taskId));
  return true;
}

function compareConversation(left, right) {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function buildActivityAssignmentForest(ledger) {
  const earliestByResponder = new Map();
  for (const conversation of [...ledger.conversations].sort(compareConversation)) {
    if (!earliestByResponder.has(conversation.responderTaskId)) {
      earliestByResponder.set(conversation.responderTaskId, conversation);
    }
  }
  const edgesByParent = new Map();
  const edgeByChild = new Map();
  for (const conversation of earliestByResponder.values()) {
    const edge = {
      parentTaskId: conversation.initiatorTaskId,
      parentRole: conversation.initiatorRole,
      childTaskId: conversation.responderTaskId,
      childRole: conversation.responderRole,
      createdAt: conversation.createdAt,
      conversationId: conversation.id,
    };
    edgeByChild.set(edge.childTaskId, edge);
    const children = edgesByParent.get(edge.parentTaskId) ?? [];
    children.push(edge);
    edgesByParent.set(edge.parentTaskId, children);
  }
  for (const children of edgesByParent.values()) {
    children.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.childTaskId.localeCompare(right.childTaskId));
  }
  const activityCreatedAt = new Map();
  for (const edge of edgeByChild.values()) {
    if (edge.parentRole === "controller" && edge.childRole === "primary") {
      const current = activityCreatedAt.get(edge.childTaskId);
      if (!current || edge.createdAt > current) activityCreatedAt.set(edge.childTaskId, edge.createdAt);
    }
  }
  const activities = [...activityCreatedAt].map(([taskId, createdAt]) => ({ taskId, createdAt }));
  activities.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.taskId.localeCompare(right.taskId));

  const authorizedTaskIds = new Set();
  const roleByTask = new Map();
  const parentByTask = new Map();
  const childrenByParent = new Map();
  const pending = activities.map((activity) => ({ taskId: activity.taskId, role: "primary", parentTaskId: null }));
  while (pending.length > 0) {
    const current = pending.shift();
    if (authorizedTaskIds.has(current.taskId)) continue;
    authorizedTaskIds.add(current.taskId);
    roleByTask.set(current.taskId, current.role);
    if (current.parentTaskId) parentByTask.set(current.taskId, current.parentTaskId);
    for (const edge of edgesByParent.get(current.taskId) ?? []) {
      const children = childrenByParent.get(current.taskId) ?? [];
      children.push(edge.childTaskId);
      childrenByParent.set(current.taskId, children);
      pending.push({ taskId: edge.childTaskId, role: edge.childRole, parentTaskId: current.taskId });
    }
  }

  const assignmentAuthorizedTaskIds = new Set(authorizedTaskIds);
  const excluded = new Set();
  const diagnostics = [];
  const linkByChild = new Map(ledger.links.map((link) => [link.childTaskId, link]));
  for (const taskId of authorizedTaskIds) {
    const edge = edgeByChild.get(taskId);
    const link = linkByChild.get(taskId);
    if (!edge || !link) continue;
    if (link.parentTaskId !== edge.parentTaskId || link.role !== edge.childRole) {
      excluded.add(taskId);
      diagnostics.push(diagnostic(
        "ACTIVITY_LEDGER_LINEAGE_MISMATCH",
        "A current Task link disagrees with its earliest assignment Conversation.",
        taskId,
      ));
    }
  }
  const excludeStack = [...excluded];
  while (excludeStack.length > 0) {
    const taskId = excludeStack.pop();
    for (const child of childrenByParent.get(taskId) ?? []) {
      if (!excluded.has(child)) {
        excluded.add(child);
        excludeStack.push(child);
      }
    }
  }
  for (const taskId of excluded) {
    authorizedTaskIds.delete(taskId);
    roleByTask.delete(taskId);
    parentByTask.delete(taskId);
  }
  for (const [parent, children] of childrenByParent) {
    childrenByParent.set(parent, children.filter((child) => !excluded.has(child)));
  }
  return {
    activities: activities.filter((activity) => authorizedTaskIds.has(activity.taskId)),
    assignmentAuthorizedTaskIds,
    authorizedTaskIds,
    excludedAuthorizedTaskIds: excluded,
    roleByTask,
    parentByTask,
    childrenByParent,
    edgeByChild,
    linkByChild,
    diagnostics,
    partial: excluded.size > 0,
  };
}

async function readLedger(project) {
  try {
    const fileStat = await stat(project.stateFile);
    if (!fileStat.isFile() || fileStat.size > 8 * 1024 * 1024) throw new Error("invalid ledger file");
    return validateTaskLedger(JSON.parse(await readFile(project.stateFile, "utf8")), project, "activity-read");
  } catch (cause) {
    throw new ActivityDataError(
      "ACTIVITY_LEDGER_UNAVAILABLE",
      "The version-10 project ledger is unavailable or does not match this canonical project.",
      cause,
    );
  }
}

async function discoverSessionFiles(roots, authorizedTaskIds) {
  const candidates = [];
  const omissions = [];
  const observedAuthorizedTaskIds = new Set();
  let entriesSeen = 0;
  let truncated = false;
  for (const root of roots) {
    const pending = [root];
    while (pending.length > 0 && entriesSeen < MAX_DISCOVERY_ENTRIES) {
      const directory = pending.pop();
      try {
        const handle = await opendir(directory);
        for await (const entry of handle) {
          entriesSeen += 1;
          if (entriesSeen > MAX_DISCOVERY_ENTRIES) {
            truncated = true;
            break;
          }
          const entryPath = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            pending.push(entryPath);
            continue;
          }
          const taskId = entry.name.match(TASK_FILE_PATTERN)?.[1];
          if (!taskId || !authorizedTaskIds.has(taskId)) continue;
          observedAuthorizedTaskIds.add(taskId);
          if (!entry.isFile()) {
            omissions.push({ taskId, code: "ACTIVITY_AUTHORIZED_SESSION_NON_REGULAR", sourceBytes: 0 });
            continue;
          }
          try {
            const fileStat = await stat(entryPath);
            if (!fileStat.isFile()) {
              omissions.push({ taskId, code: "ACTIVITY_AUTHORIZED_SESSION_NON_REGULAR", sourceBytes: 0 });
            } else if (fileStat.size <= 0 || fileStat.size > MAX_SESSION_BYTES) {
              omissions.push({ taskId, code: "ACTIVITY_AUTHORIZED_SESSION_OVERSIZED", sourceBytes: fileStat.size });
            } else if (candidates.length >= MAX_SESSION_CANDIDATES) {
              truncated = true;
              omissions.push({ taskId, code: "ACTIVITY_SESSION_CANDIDATE_BOUNDED", sourceBytes: fileStat.size });
            } else {
              candidates.push({ taskId, file: entryPath, mtimeMs: fileStat.mtimeMs, size: fileStat.size });
            }
          } catch {
            omissions.push({ taskId, code: "ACTIVITY_AUTHORIZED_SESSION_STAT_FAILED", sourceBytes: 0 });
          }
        }
      } catch (error) {
        if (error?.code !== "ENOENT") truncated = true;
      }
    }
  }
  if (entriesSeen >= MAX_DISCOVERY_ENTRIES) truncated = true;
  return {
    candidates: candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file)),
    omissions,
    observedAuthorizedTaskIds,
    truncated,
  };
}

function reserveSessionAttempt(budget, sourceBytes) {
  if (
    budget.authorizedTasks + 1 > budget.maxAuthorizedTasks
    || budget.sessionSourceBytes + sourceBytes > budget.maxSessionSourceBytes
  ) {
    budget.partial = true;
    budget.omittedTasks += 1;
    budget.omittedSourceBytes += sourceBytes;
    return false;
  }
  budget.authorizedTasks += 1;
  budget.sessionSourceBytes += sourceBytes;
  return true;
}


function rejectReservedSession(budget, sourceBytes) {
  budget.partial = true;
  budget.omittedTasks += 1;
  budget.rejectedTasks += 1;
  budget.rejectedSourceBytes += sourceBytes;
}

async function readVerifiedHistory(candidate, project, budget, options = {}) {
  const expectedTaskId = candidate.taskId ?? path.basename(candidate.file).match(TASK_FILE_PATTERN)?.[1];
  if (!safeTaskId(expectedTaskId)) {
    return { taskId: expectedTaskId, omitted: true, code: "ACTIVITY_SESSION_ID_INVALID", accounted: false };
  }
  let handle;
  let reservedBytes = 0;
  let reserved = false;
  const reject = (code) => {
    if (reserved) rejectReservedSession(budget, reservedBytes);
    return { taskId: expectedTaskId, omitted: true, rejected: code, accounted: reserved, reservedBytes };
  };
  try {
    handle = await open(candidate.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const firstStat = await handle.stat();
    if (!firstStat.isFile()) return { taskId: expectedTaskId, omitted: true, code: "ACTIVITY_AUTHORIZED_SESSION_NON_REGULAR", accounted: false };
    if (firstStat.size <= 0 || firstStat.size > MAX_SESSION_BYTES) {
      return { taskId: expectedTaskId, omitted: true, code: "ACTIVITY_AUTHORIZED_SESSION_OVERSIZED", sourceBytes: firstStat.size, accounted: false };
    }
    reservedBytes = firstStat.size;
    if (!reserveSessionAttempt(budget, reservedBytes)) {
      return { taskId: expectedTaskId, omitted: true, code: "ACTIVITY_SESSION_SOURCE_BOUNDED", accounted: true, reservedBytes: 0 };
    }
    reserved = true;
    await options.afterOpenBeforeScan?.({ candidate, firstStat, handle });
    let history;
    let continuation = null;
    try {
      if (options.scanActivityHistory) {
        history = await options.scanActivityHistory(
          handle.createReadStream({ start: 0, end: firstStat.size - 1, autoClose: false }),
          { budget },
        );
      } else {
        continuation = createActivityHistoryContinuation({ budget });
        for await (const chunk of handle.createReadStream({ start: 0, end: firstStat.size - 1, autoClose: false })) {
          appendActivityHistoryContinuation(continuation, chunk);
        }
        history = snapshotActivityHistoryContinuation(continuation);
      }
    } catch (error) {
      const result = reject(error?.code ?? "ACTIVITY_HISTORY_UNAVAILABLE");
      result.cause = error;
      return result;
    }
    if (history.metadata?.taskId !== expectedTaskId) return reject("ACTIVITY_SESSION_TASK_MISMATCH");
    if (typeof history.metadata.cwd !== "string") return reject("ACTIVITY_SESSION_CWD_INVALID");
    let canonicalCwd;
    try {
      canonicalCwd = await realpath(history.metadata.cwd);
    } catch {
      return reject("ACTIVITY_SESSION_CWD_INVALID");
    }
    if (canonicalCwd !== project.root) return reject("ACTIVITY_SESSION_CWD_MISMATCH");
    return {
      taskId: expectedTaskId,
      history,
      metadata: history.metadata,
      file: candidate.file,
      reservedBytes,
      live: continuation ? {
        continuation,
        offset: firstStat.size,
        identity: { dev: firstStat.dev, ino: firstStat.ino },
      } : null,
    };
  } catch (error) {
    if (reserved) return reject(error?.code ?? "ACTIVITY_HISTORY_UNAVAILABLE");
    return { taskId: expectedTaskId, omitted: true, code: error?.code === "ENOENT" ? "ACTIVITY_AUTHORIZED_SESSION_MISSING" : "ACTIVITY_AUTHORIZED_SESSION_OPEN_FAILED", accounted: false };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function orderedAuthorizedTasks(forest) {
  const ordered = [];
  for (const activity of forest.activities) {
    const pending = [activity.taskId];
    while (pending.length > 0) {
      const taskId = pending.shift();
      ordered.push(taskId);
      pending.unshift(...(forest.childrenByParent.get(taskId) ?? []));
    }
  }
  return ordered;
}

function frontmatterMarker(raw, key, fallback) {
  const match = raw.match(new RegExp(`^${key}:\\s*([^\\r\\n]+)$`, "mi"));
  return match?.[1]?.trim().replace(/^['\"]|['\"]$/g, "") || fallback;
}

async function readAllSignals(project, authorizedPrimaryIds, budget, options = {}) {
  const result = [];
  const diagnostics = [];
  const omitSignal = ({ code, primaryTaskId }, index) => {
    markActivityOmission(budget, diagnostics, {
      code,
      message: "An authorized Signal was omitted because it could not be inspected safely.",
      taskId: primaryTaskId,
      signal: true,
      key: `signal-reader:${index}:${code}:${primaryTaskId ?? "container"}`,
    });
  };
  const reader = options.signalReader ?? readActivitySignals;
  let inspected;
  try {
    inspected = await reader({
      project,
      authorizedPrimaryIds,
      maxSignals: MAX_SIGNALS,
      maxSignalBytes: MAX_SIGNAL_BYTES,
      helperPath: options.signalReaderPath,
      timeoutMs: options.signalReaderTimeoutMs,
      platform: options.platform ?? process.platform,
    });
  } catch {
    inspected = { entries: [], omissions: [{ code: "ACTIVITY_SIGNAL_READER_UNAVAILABLE", primaryTaskId: null }] };
  }
  (inspected.omissions ?? []).forEach(omitSignal);
  const entries = [...(inspected.entries ?? [])].sort((left, right) => left.primaryTaskId.localeCompare(right.primaryTaskId)
    || left.snapshot.localeCompare(right.snapshot) || left.name.localeCompare(right.name));
  for (const entry of entries) {
    const signal = {
      id: `${entry.primaryTaskId}:${entry.snapshot}:${entry.name}`,
      name: entry.name.slice(0, -3),
      snapshot: entry.snapshot,
      primaryTaskId: entry.primaryTaskId,
      severity: frontmatterMarker(entry.raw, "severity", "unknown"),
      raw: entry.raw,
      timestamp: entry.timestamp,
    };
    const bytes = Buffer.byteLength(JSON.stringify(signal), "utf8");
    if (budget.signalJsonBytes + bytes > budget.maxSignalJsonBytes) {
      markActivityOmission(budget, diagnostics, {
        code: "ACTIVITY_SIGNAL_AGGREGATE_BOUNDED",
        message: "Some complete Signals were omitted by the Activity safety budget.",
        taskId: entry.primaryTaskId,
        signal: true,
        key: `ACTIVITY_SIGNAL_AGGREGATE_BOUNDED:${entry.primaryTaskId}:${entry.snapshot}:${entry.name}`,
      });
      continue;
    }
    budget.signalJsonBytes += bytes;
    result.push(signal);
  }
  return { signals: result, diagnostics };
}

function descendantIds(activityTaskId, childrenByParent) {
  const result = new Set();
  const pending = [activityTaskId];
  while (pending.length > 0) {
    const taskId = pending.pop();
    if (result.has(taskId)) continue;
    result.add(taskId);
    for (const child of childrenByParent.get(taskId) ?? []) pending.push(child);
  }
  return result;
}

function conversationActivity(ledger, forest, selected, agentsById) {
  const byTask = new Map([...selected].map((taskId) => [taskId, []]));
  let retained = 0;
  let bounded = false;
  const append = (taskId, event) => {
    if (!byTask.has(taskId)) return;
    if (retained >= MAX_CONVERSATION_ACTIVITY_EVENTS) { bounded = true; return; }
    byTask.get(taskId).push(event); retained += 1;
  };
  const authorized = forest.authorizedTaskIds;
  [...ledger.conversations].sort(compareConversation).forEach((conversation, sortedSequence) => {
    const conversationSequence = Number.isSafeInteger(conversation.activitySequence)
      ? conversation.activitySequence
      : sortedSequence;
    const initiator = conversation.initiatorTaskId; const responder = conversation.responderTaskId;
    if (!authorized.has(initiator) || !authorized.has(responder)) return;
    const transitions = [
      { timestamp: conversation.createdAt, sender: initiator, receiver: responder, transition: "send" },
      ...(conversation.repliedAt ? [{ timestamp: conversation.repliedAt, sender: responder, receiver: initiator, transition: "reply" }] : []),
    ];
    transitions.forEach((transition, transitionSequence) => {
      const base = { kind: "conversation", conversationId: conversation.id, transition: transition.transition,
        timestamp: transition.timestamp, sequence: conversationSequence * 2 + transitionSequence };
      append(transition.sender, { ...base, taskId: transition.sender, direction: "SENT", counterpartyTaskId: transition.receiver });
      append(transition.receiver, { ...base, taskId: transition.receiver, direction: "RECEIVED", counterpartyTaskId: transition.sender });
    });
  });
  for (const [taskId, taskEvents] of byTask) {
    for (const event of taskEvents) {
      event.counterpartyName = agentsById.get(event.counterpartyTaskId)?.name
          ?? `Task ${event.counterpartyTaskId.slice(0, 8)}`;
      const counterpartEvents = byTask.get(event.counterpartyTaskId) ?? [];
      event.counterpartyAvailable = agentsById.get(event.counterpartyTaskId)?.available !== false
          && counterpartEvents.some((candidate) => candidate.conversationId === event.conversationId
            && candidate.transition === event.transition
            && candidate.counterpartyTaskId === taskId
            && candidate.direction !== event.direction);
    }
  }
  return { byTask, bounded };
}

function activityOrder(left, right) {
  return String(left.timestamp).localeCompare(String(right.timestamp))
    || left.sequence - right.sequence
    || String(left.kind).localeCompare(String(right.kind))
    || String(left.conversationId ?? "").localeCompare(String(right.conversationId ?? ""));
}

function lifecycleStartFor(history) {
  if (history.lifecycleStartedAt) return history.lifecycleStartedAt;
  const hasStartEvidence = history.taskEvents?.some((event) => event.type === "task_started");
  return hasStartEvidence ? null : history.startedAt ?? null;
}

function lifecycleEndFor(history, lifecycleState) {
  if (lifecycleState === "running") return null;
  if (lifecycleState === "complete" || lifecycleState === "aborted") {
    return history.lifecycleEndedAt ?? null;
  }
  return history.lifecycleEndedAt ?? history.endedAt ?? null;
}

function turnIntervalsFor(history, observedAt) {
  const turns = [];
  let active = null;
  for (const event of [...(history.taskEvents ?? [])].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type === "task_started") {
      active = event.timestamp ? {
        id: event.turnId ?? `sequence-${event.sequence}`,
        turnId: event.turnId,
        startedAt: event.timestamp,
        startSequence: event.sequence,
      } : null;
      continue;
    }
    if (event.type !== "task_complete" && event.type !== "turn_aborted") continue;
    const matches = active
      && (!active.turnId || !event.turnId || active.turnId === event.turnId);
    if (matches && event.timestamp && event.timestamp >= active.startedAt) {
      turns.push({
        id: active.id,
        turnId: active.turnId,
        startedAt: active.startedAt,
        endedAt: event.timestamp,
        state: event.type === "task_complete" ? "complete" : "aborted",
        startSequence: active.startSequence,
        endSequence: event.sequence,
      });
    }
    active = null;
  }
  if (active && history.lifecycleState === "running" && observedAt >= active.startedAt) {
    turns.push({
      id: active.id,
      turnId: active.turnId,
      startedAt: active.startedAt,
      endedAt: observedAt,
      state: "running",
      startSequence: active.startSequence,
      endSequence: null,
    });
  }
  return turns;
}

function conversationTurnIntervalsFor(ledger, selected, taskId) {
  return [...ledger.conversations]
    .sort(compareConversation)
    .filter((conversation) => conversation.responderTaskId === taskId
      && selected.has(conversation.initiatorTaskId)
      && selected.has(conversation.responderTaskId)
      && conversation.createdAt
      && conversation.repliedAt
      && conversation.repliedAt >= conversation.createdAt)
    .map((conversation, sequence) => ({
      id: `conversation-${conversation.id}`,
      turnId: null,
      startedAt: conversation.createdAt,
      endedAt: conversation.repliedAt,
      state: "complete",
      evidence: "conversation",
      startSequence: sequence * 2,
      endSequence: sequence * 2 + 1,
    }));
}

function firstTimelineInvocationFor(agent) {
  return (agent.turns ?? [])
    .map((turn) => turn.startedAt)
    .filter(Boolean)
    .sort()[0] ?? agent.startedAt ?? null;
}

function buildModel({ project, histories, ledger, forest, signals, snapshotChains, threadTitles = new Map(), diagnostics, partial = false, observedAt = new Date().toISOString() }) {
  const managedById = new Map(ledger.managedTasks.map((item) => [item.taskId, item]));
  const activityIds = forest.activities.map((activity) => activity.taskId).filter((taskId) => histories.has(taskId));
  const activities = activityIds.map((activityTaskId) => {
    const history = histories.get(activityTaskId);
    const firstInput = history.records.find((record) => record.kind === "input")?.text;
    return { id: activityTaskId, name: threadTitles.get(activityTaskId)
      ?? safeName(managedById.get(activityTaskId)?.name ?? firstInput, `Primary ${activityTaskId.slice(0, 8)}`), startedAt: lifecycleStartFor(history) };
  });
  return {
    project: { key: project.key, rootName: path.basename(project.root) },
    activities,
    partial,
    detail(activityTaskId) {
      if (!activityIds.includes(activityTaskId)) return null;
      const selected = descendantIds(activityTaskId, forest.childrenByParent);
      const agents = [...selected].map((taskId) => {
        const managed = managedById.get(taskId);
        const history = histories.get(taskId);
        const role = forest.roleByTask.get(taskId);
        if (!history) {
          const turns = conversationTurnIntervalsFor(ledger, selected, taskId);
          return {
            id: taskId,
            name: safeName(managed?.name, `Task ${taskId.slice(0, 8)}`),
            role,
            parentTaskId: forest.parentByTask.get(taskId) ?? null,
            available: false,
            startedAt: null,
            endedAt: null,
            timelineEndedAt: null,
            lifecycleState: "unavailable",
            turns,
            records: [],
            taskEvents: [],
            cumulativeTokens: 0,
            hasTokenUsage: false,
            retainedContextTokens: null,
            contextWindow: null,
            compactions: 0,
            partial: true,
            diagnostics: diagnostics.filter((item) => item.taskId === taskId),
          };
        }
        const lifecycleState = history.lifecycleState ?? (history.endedAt ? "complete" : "unknown");
        const lifecycleStartedAt = lifecycleStartFor(history);
        const lifecycleEndedAt = lifecycleEndFor(history, lifecycleState);
        const firstInput = history.records.find((record) => record.kind === "input")?.text;
        const activityTitle = activityIds.includes(taskId) && forest.roleByTask.get(taskId) === "primary"
          ? threadTitles.get(taskId)
          : null;
        return {
          id: taskId,
          name: activityTitle ?? safeName(managed?.name ?? firstInput, `Task ${taskId.slice(0, 8)}`),
          role,
          parentTaskId: forest.parentByTask.get(taskId) ?? null,
          available: true,
          startedAt: lifecycleStartedAt,
          endedAt: lifecycleState === "running" ? null : lifecycleEndedAt,
          timelineEndedAt: lifecycleState === "running" ? observedAt : lifecycleEndedAt,
          lifecycleState,
          turns: turnIntervalsFor(history, observedAt),
          records: history.records, taskEvents: history.taskEvents,
          cumulativeTokens: history.cumulativeTokens, hasTokenUsage: history.hasTokenUsage,
          retainedContextTokens: history.retainedContextTokens, contextWindow: history.contextWindow,
          compactions: history.compactions, partial: history.partial, diagnostics: history.diagnostics,
        };
      }).sort((left, right) => {
        const leftFirst = firstTimelineInvocationFor(left);
        const rightFirst = firstTimelineInvocationFor(right);
        if (leftFirst && rightFirst) return leftFirst.localeCompare(rightFirst) || left.id.localeCompare(right.id);
        if (leftFirst) return -1;
        if (rightFirst) return 1;
        return left.id.localeCompare(right.id);
      });
      const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
      const conversation = conversationActivity(ledger, forest, selected, agentsById);
      for (const agent of agents) {
        agent.activity = [
          ...agent.records.map((record) => ({ ...record, type: record.kind.toUpperCase() })),
          ...(conversation.byTask.get(agent.id) ?? []),
        ].sort(activityOrder);
      }
      const rootSignals = signals.filter((signal) => selected.has(signal.primaryTaskId));
      const cycleRecords = [];
      for (const agent of agents.filter((item) => item.role === "primary")) {
        for (const snapshot of snapshotChains.get(agent.id)?.snapshots ?? []) {
          cycleRecords.push({ ...snapshot, primaryStartedAt: agent.startedAt });
        }
      }
      cycleRecords.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || String(left.primaryStartedAt).localeCompare(String(right.primaryStartedAt))
        || left.primaryTaskId.localeCompare(right.primaryTaskId)
        || left.sequence - right.sequence);
      const cycleKeys = new Set(cycleRecords.map((item) => `${item.primaryTaskId}:${item.snapshot}`));
      const cycles = cycleRecords.map((snapshot, index) => ({
        id: `${snapshot.primaryTaskId}:${snapshot.snapshot}`,
        primaryTaskId: snapshot.primaryTaskId,
        snapshot: snapshot.snapshot,
        label: `Cycle ${index + 1}`,
        startedAt: snapshot.createdAt,
        sequence: snapshot.sequence,
        signalIds: rootSignals.filter((signal) => signal.primaryTaskId === snapshot.primaryTaskId && signal.snapshot === snapshot.snapshot).map((signal) => signal.id),
      }));
      const unresolvedSignals = rootSignals.filter((signal) => !cycleKeys.has(`${signal.primaryTaskId}:${signal.snapshot}`)).map((signal) => signal.id);
      const timestamps = [
        ...agents.flatMap((agent) => [
          agent.startedAt,
          agent.timelineEndedAt,
          ...(agent.turns ?? []).flatMap((turn) => [turn.startedAt, turn.endedAt]),
        ]),
        ...cycles.map((cycle) => cycle.startedAt),
      ].filter(Boolean).sort();
      const startedAt = timestamps[0] ?? null;
      const endedAt = timestamps.at(-1) ?? null;
      const elapsedMs = startedAt && endedAt ? Math.max(0, new Date(endedAt) - new Date(startedAt)) : 0;
      cycles.forEach((cycle, index) => {
        cycle.endedAt = cycles[index + 1]?.startedAt ?? endedAt;
        cycle.durationMs = cycle.startedAt && cycle.endedAt
          ? Math.max(0, new Date(cycle.endedAt) - new Date(cycle.startedAt))
          : null;
      });
      const elapsedHours = elapsedMs / 3_600_000;
      const detailPartial = partial || conversation.bounded || agents.some((agent) => agent.partial);
      const tokenAgents = agents.filter((agent) => agent.hasTokenUsage);
      const cumulativeTokens = tokenAgents.length ? tokenAgents.reduce((sum, agent) => sum + agent.cumulativeTokens, 0) : null;
      const retainedContexts = agents.map((agent) => agent.retainedContextTokens).filter((value) => value !== null);
      const retainedContextTokens = retainedContexts.length ? retainedContexts.reduce((sum, value) => sum + value, 0) : null;
      const shownResponseCount = agents.reduce((sum, agent) => sum + agent.records.filter((record) => record.kind === "output").length, 0);
      return {
        activity: activities.find((activity) => activity.id === activityTaskId), agents, cycles,
        signals: rootSignals.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)),
        unresolvedSignals,
        partial: detailPartial,
        timeline: { startedAt, endedAt, elapsedMs, responseCount: detailPartial ? null : shownResponseCount, shownResponseCount },
        metrics: {
          agentCount: detailPartial ? null : agents.length,
          shownAgentCount: agents.length,
          agentRatePerHour: !detailPartial && elapsedHours > 0 ? round(agents.length / elapsedHours) : null,
          signalCount: detailPartial ? null : rootSignals.length,
          shownSignalCount: rootSignals.length,
          signalRatePerHour: !detailPartial && elapsedHours > 0 ? round(rootSignals.length / elapsedHours) : null,
          cumulativeTokens: detailPartial ? null : cumulativeTokens,
          tokenThroughputPerHour: !detailPartial && elapsedHours > 0 && cumulativeTokens !== null ? round(cumulativeTokens / elapsedHours) : null,
          retainedContextTokens: detailPartial ? null : retainedContextTokens,
          compactions: detailPartial ? null : agents.reduce((sum, agent) => sum + agent.compactions, 0),
        },
        diagnostics: conversation.bounded
          ? [...diagnostics, diagnostic("ACTIVITY_CONVERSATION_ACTIVITY_BOUNDED", "Some retained Conversation transitions were omitted by the Activity activity bound.")].slice(0, 100)
          : diagnostics,
      };
    },
  };
}

export async function loadActivity(projectRoot, options = {}) {
  const observationDate = new Date(options.observedAt ?? Date.now());
  const observedAt = Number.isNaN(observationDate.valueOf())
    ? new Date().toISOString()
    : observationDate.toISOString();
  const project = await resolveProject(projectRoot);
  const ledger = await (options.readLedger ?? readLedger)(project);
  const forest = buildActivityAssignmentForest(ledger);
  const budget = createLoadBudget(options.budgetLimits);
  const diagnostics = [...forest.diagnostics];
  if (forest.partial) {
    budget.partial = true;
    budget.omittedTasks += forest.excludedAuthorizedTaskIds.size;
    for (const taskId of forest.excludedAuthorizedTaskIds) {
      budget.omissionKeys.add(`authorized-task:${taskId}`);
    }
  }
  const allOrderedTasks = orderedAuthorizedTasks(forest);
  const plannedTasks = allOrderedTasks.slice(0, budget.maxAuthorizedTasks);
  const plannedTaskIds = new Set(plannedTasks);
  if (allOrderedTasks.length > plannedTasks.length) {
    markActivityOmission(budget, diagnostics, {
      code: "ACTIVITY_AUTHORIZED_TASK_PLAN_BOUNDED",
      message: "Some assigned Tasks were omitted by the Activity Task-plan bound.",
      count: allOrderedTasks.length - plannedTasks.length,
      key: "ACTIVITY_AUTHORIZED_TASK_PLAN_BOUNDED",
    });
  }
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const sessionRoots = options.sessionRoots ?? [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  const discovery = await (options.discoverSessionFiles ?? discoverSessionFiles)(sessionRoots, plannedTaskIds);
  const candidatesByTask = new Map(plannedTasks.map((taskId) => [taskId, []]));
  for (const candidate of discovery.candidates ?? []) {
    if (plannedTaskIds.has(candidate.taskId)) candidatesByTask.get(candidate.taskId).push(candidate);
  }
  const omissionByTask = new Map();
  for (const omission of discovery.omissions ?? []) {
    if (plannedTaskIds.has(omission.taskId) && !omissionByTask.has(omission.taskId)) {
      omissionByTask.set(omission.taskId, omission);
    }
  }
  if (discovery.truncated) {
    budget.partial = true;
    pushBoundedDiagnostic(diagnostics, diagnostic("ACTIVITY_SESSION_DISCOVERY_BOUNDED", "Session discovery reached its safety bound; verified available candidates are shown."));
  }
  const histories = new Map();
  const verifiedSessionPaths = new Map();
  const liveSources = new Map();
  const historyReader = options.readVerifiedHistory ?? readVerifiedHistory;
  for (const taskId of plannedTasks) {
    const parent = forest.parentByTask.get(taskId);
    if (parent && !histories.has(parent)) {
      const skippedBytes = candidatesByTask.get(taskId)?.reduce((sum, item) => sum + (item.size ?? 0), 0) ?? 0;
      markActivityOmission(budget, diagnostics, {
        code: "ACTIVITY_AUTHORIZED_SESSION_ANCESTOR_OMITTED",
        message: "An authorized Task history was omitted because its assigned ancestor is unavailable.",
        taskId,
        sourceBytes: skippedBytes,
        key: `authorized-task:${taskId}`,
      });
      continue;
    }
    const taskCandidates = candidatesByTask.get(taskId) ?? [];
    const observed = omissionByTask.get(taskId);
    if (taskCandidates.length !== 1 || observed) {
      const code = taskCandidates.length > 1
        ? "ACTIVITY_SESSION_AMBIGUOUS"
        : observed?.code ?? (discovery.truncated ? "ACTIVITY_AUTHORIZED_SESSION_DISCOVERY_UNCERTAIN" : "ACTIVITY_AUTHORIZED_SESSION_MISSING");
      markActivityOmission(budget, diagnostics, {
        code,
        message: taskCandidates.length > 1
          ? "More than one retained history candidate exists for an authorized Task."
          : "An authorized Task has no single readable retained history candidate.",
        taskId,
        sourceBytes: taskCandidates.reduce((sum, item) => sum + (item.size ?? 0), observed?.sourceBytes ?? 0),
        key: `authorized-task:${taskId}`,
      });
      continue;
    }
    const candidate = taskCandidates[0];
    try {
      const result = await historyReader(candidate, project, budget, options);
      if (!result || result.omitted || result.rejected) {
        const code = result?.rejected ?? result?.code ?? "ACTIVITY_HISTORY_UNAVAILABLE";
        if (!result?.accounted) {
          markActivityOmission(budget, diagnostics, {
            code,
            message: "An authorized Task history could not be inspected safely.",
            taskId,
            sourceBytes: result?.sourceBytes ?? candidate.size ?? 0,
            key: `authorized-task:${taskId}`,
          });
        } else {
          budget.omissionKeys.add(`authorized-task:${taskId}`);
          pushBoundedDiagnostic(diagnostics, diagnostic(code, "An authorized Task history could not be inspected safely.", taskId));
        }
        continue;
      }
      const link = forest.linkByChild.get(taskId);
      if (link?.sourceTaskId && result.metadata.parentTaskId !== link.sourceTaskId) {
        rejectReservedSession(budget, result.reservedBytes ?? candidate.size ?? 0);
        budget.omissionKeys.add(`authorized-task:${taskId}`);
        pushBoundedDiagnostic(diagnostics, diagnostic("ACTIVITY_SESSION_SOURCE_MISMATCH", "A current Task session disagrees with its sourced launch link.", taskId));
        continue;
      }
      if (result.history.partial) budget.partial = true;
      histories.set(taskId, result.history);
      verifiedSessionPaths.set(taskId, result.file ?? candidate.file);
      if (result.live) liveSources.set(taskId, { ...result.live, file: result.file ?? candidate.file });
    } catch (error) {
      markActivityOmission(budget, diagnostics, {
        code: error?.code ?? "ACTIVITY_HISTORY_UNAVAILABLE",
        message: "An authorized Task history could not be inspected safely.",
        taskId,
        sourceBytes: candidate.size ?? 0,
        key: `authorized-task:${taskId}`,
      });
    }
  }
  let threadTitles = new Map();
  try {
    const activityTaskIds = forest.activities.map((activity) => activity.taskId).filter((taskId) => histories.has(taskId));
    const productionDiscovery = !options.sessionRoots && !options.discoverSessionFiles && !options.readVerifiedHistory;
    if (productionDiscovery || options.readActivityThreadTitles) {
      threadTitles = await (options.readActivityThreadTitles ?? readActivityThreadTitles)({
        project, activityTaskIds, verifiedSessionPaths, codexHome,
        databasePath: options.desktopStateDatabasePath,
        openDatabase: options.openDesktopStateDatabase,
      });
    }
    if (!(threadTitles instanceof Map)) threadTitles = new Map();
  } catch { threadTitles = new Map(); }
  if (budget.omittedTasks || budget.omittedHistoryEntries || budget.rejectedTasks) {
    pushBoundedDiagnostic(diagnostics, diagnostic("ACTIVITY_HISTORY_AGGREGATE_BOUNDED", "Some authorized Tasks or complete history entries were omitted by the Activity safety budget.", null, {
      omittedTasks: budget.omittedTasks,
      omittedSourceBytes: budget.omittedSourceBytes,
      rejectedTasks: budget.rejectedTasks,
      rejectedSourceBytes: budget.rejectedSourceBytes,
      omittedHistoryEntries: budget.omittedHistoryEntries,
    }));
  }
  const authorizedPrimaryIds = new Set(plannedTasks.filter((taskId) => forest.roleByTask.get(taskId) === "primary"));
  const signalResult = await (options.readAllSignals ?? readAllSignals)(project, authorizedPrimaryIds, budget, options);
  diagnostics.push(...signalResult.diagnostics);
  const snapshotChains = new Map();
  const snapshotReader = options.listReviewSnapshots ?? listReviewSnapshots;
  for (const primaryTaskId of authorizedPrimaryIds) {
    try {
      const chain = await snapshotReader({ primaryTaskId, projectRoot: project.root });
      snapshotChains.set(primaryTaskId, chain);
      diagnostics.push(...chain.diagnostics.map((item) => diagnostic(item.code, item.message, primaryTaskId)));
      if (chain.partial) budget.partial = true;
    } catch (error) {
      budget.partial = true;
      diagnostics.push(diagnostic(error?.code ?? "REVIEW_SNAPSHOT_HISTORY_INVALID", "Review Cycle history could not be verified for one Primary.", primaryTaskId));
      snapshotChains.set(primaryTaskId, { snapshots: [], diagnostics: [], partial: true });
    }
  }
  const modelArgs = {
    project,
    histories,
    ledger,
    forest,
    signals: signalResult.signals,
    snapshotChains,
    threadTitles,
    diagnostics: diagnostics.slice(0, 100),
    partial: budget.partial,
    observedAt,
  };
  const model = buildModel(modelArgs);
  liveContexts.set(model, { ...modelArgs, budget, liveSources });
  return model;
}

function liveError(reason, message = "Activity changed. Refresh is required.") {
  const error = new ActivityDataError("ACTIVITY_LIVE_REFRESH_REQUIRED", message);
  error.reason = reason;
  return error;
}

function sameTaskSet(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function selectedVisibleConversations(ledger, forest, selected) {
  return ledger.conversations.filter((item) => forest.authorizedTaskIds.has(item.initiatorTaskId)
    && forest.authorizedTaskIds.has(item.responderTaskId)
    && (selected.has(item.initiatorTaskId) || selected.has(item.responderTaskId)));
}

function selectedLedgerProjection(ledger, forest, activityTaskId) {
  const selected = descendantIds(activityTaskId, forest.childrenByParent);
  const managed = new Map(ledger.managedTasks.map((item) => [item.taskId, item]));
  const tasks = [...selected].sort().map((taskId) => ({
    taskId,
    role: forest.roleByTask.get(taskId) ?? null,
    parentTaskId: forest.parentByTask.get(taskId) ?? null,
    name: managed.has(taskId) ? safeName(managed.get(taskId)?.name, null) : null,
    assignment: forest.edgeByChild.has(taskId) ? {
      conversationId: forest.edgeByChild.get(taskId).conversationId,
      parentTaskId: forest.edgeByChild.get(taskId).parentTaskId,
      parentRole: forest.edgeByChild.get(taskId).parentRole,
      childTaskId: forest.edgeByChild.get(taskId).childTaskId,
      childRole: forest.edgeByChild.get(taskId).childRole,
      createdAt: forest.edgeByChild.get(taskId).createdAt,
    } : null,
    link: forest.linkByChild.has(taskId) ? {
      parentTaskId: forest.linkByChild.get(taskId).parentTaskId,
      childTaskId: forest.linkByChild.get(taskId).childTaskId,
      role: forest.linkByChild.get(taskId).role,
      sourceTaskId: forest.linkByChild.get(taskId).sourceTaskId ?? null,
    } : null,
  }));
  const conversations = selectedVisibleConversations(ledger, forest, selected).map((item) => ({
    id: item.id,
    initiatorTaskId: item.initiatorTaskId,
    responderTaskId: item.responderTaskId,
    createdAt: item.createdAt,
    repliedAt: item.repliedAt ?? null,
  })).sort((left, right) => left.id.localeCompare(right.id));
  return JSON.stringify({ activityTaskId, tasks, conversations });
}

function projectionBytes(histories) {
  let historyJsonBytes = 0;
  let timelineEvents = 0;
  for (const history of histories.values()) {
    for (const record of history.records) historyJsonBytes += Buffer.byteLength(JSON.stringify(record));
    for (const event of history.taskEvents) {
      historyJsonBytes += Buffer.byteLength(JSON.stringify(event));
      timelineEvents += 1;
    }
  }
  return { historyJsonBytes, timelineEvents };
}

export function createActivityLiveSession(model, activityTaskId) {
  const full = liveContexts.get(model);
  const initialDetail = model.detail(activityTaskId);
  if (!full || !initialDetail) return null;
  const authorizedSelectedTaskIds = descendantIds(activityTaskId, full.forest.childrenByParent);
  const visibleTaskIds = new Set([...authorizedSelectedTaskIds].filter((taskId) => full.histories.has(taskId)));
  for (const taskId of visibleTaskIds) if (!full.liveSources.has(taskId)) return null;

  const selectedBudget = createLoadBudget({
    maxAuthorizedTasks: full.budget.maxAuthorizedTasks,
    maxSessionSourceBytes: full.budget.maxSessionSourceBytes,
    maxHistoryJsonBytes: full.budget.maxHistoryJsonBytes,
    maxTimelineEvents: full.budget.maxTimelineEvents,
    maxSignalJsonBytes: full.budget.maxSignalJsonBytes,
  });
  const liveSources = new Map();
  const histories = new Map();
  for (const taskId of visibleTaskIds) {
    const original = full.liveSources.get(taskId);
    const continuation = cloneActivityHistoryContinuation(original.continuation, { budget: selectedBudget, omissionMode: "partial" });
    liveSources.set(taskId, { ...original, continuation });
    histories.set(taskId, snapshotActivityHistoryContinuation(continuation));
  }
  const totals = projectionBytes(histories);
  selectedBudget.authorizedTasks = visibleTaskIds.size;
  selectedBudget.sessionSourceBytes = [...liveSources.values()].reduce((sum, item) => sum + item.offset, 0);
  selectedBudget.historyJsonBytes = totals.historyJsonBytes;
  selectedBudget.timelineEvents = totals.timelineEvents;
  const signals = structuredClone(full.signals.filter((item) => item.primaryTaskId === activityTaskId));
  selectedBudget.signalJsonBytes = signals.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
  selectedBudget.partial = initialDetail.partial;

  const conversations = selectedVisibleConversations(full.ledger, full.forest, authorizedSelectedTaskIds);
  const conversationSequences = new Map([...full.ledger.conversations].sort(compareConversation)
    .map((item, index) => [item.id, index]));
  const outsideIds = new Set(conversations.flatMap((item) => [item.initiatorTaskId, item.responderTaskId])
    .filter((taskId) => !authorizedSelectedTaskIds.has(taskId)));
  const retainedIds = new Set([...authorizedSelectedTaskIds, ...outsideIds]);
  const ledger = {
    managedTasks: full.ledger.managedTasks.filter((item) => retainedIds.has(item.taskId)).map((item) => structuredClone(item)),
    conversations: conversations.map((item) => ({ ...structuredClone(item), activitySequence: conversationSequences.get(item.id) })),
    links: full.ledger.links.filter((item) => authorizedSelectedTaskIds.has(item.childTaskId)).map((item) => structuredClone(item)),
  };
  const childrenByParent = new Map();
  for (const taskId of authorizedSelectedTaskIds) {
    const children = (full.forest.childrenByParent.get(taskId) ?? []).filter((child) => authorizedSelectedTaskIds.has(child));
    if (children.length) childrenByParent.set(taskId, [...children]);
  }
  const forest = {
    activities: [{ taskId: activityTaskId, createdAt: full.forest.activities.find((item) => item.taskId === activityTaskId)?.createdAt }],
    authorizedTaskIds: retainedIds,
    assignmentAuthorizedTaskIds: new Set(authorizedSelectedTaskIds),
    excludedAuthorizedTaskIds: new Set(),
    roleByTask: new Map([...authorizedSelectedTaskIds].map((taskId) => [taskId, full.forest.roleByTask.get(taskId)])),
    parentByTask: new Map([...authorizedSelectedTaskIds].filter((taskId) => full.forest.parentByTask.has(taskId))
      .map((taskId) => [taskId, full.forest.parentByTask.get(taskId)])),
    childrenByParent,
    edgeByChild: new Map([...authorizedSelectedTaskIds].filter((taskId) => full.forest.edgeByChild.has(taskId))
      .map((taskId) => [taskId, structuredClone(full.forest.edgeByChild.get(taskId))])),
    linkByChild: new Map([...authorizedSelectedTaskIds].filter((taskId) => full.forest.linkByChild.has(taskId))
      .map((taskId) => [taskId, structuredClone(full.forest.linkByChild.get(taskId))])),
    diagnostics: [], partial: false,
  };
  const snapshotChains = new Map(full.snapshotChains.has(activityTaskId)
    ? [[activityTaskId, structuredClone(full.snapshotChains.get(activityTaskId))]] : []);
  const threadTitles = new Map(full.threadTitles.has(activityTaskId)
    ? [[activityTaskId, full.threadTitles.get(activityTaskId)]] : []);
  const context = {
    project: full.project, histories, ledger, forest, signals, snapshotChains, threadTitles,
    diagnostics: structuredClone(full.diagnostics), partial: initialDetail.partial,
    observedAt: full.observedAt, budget: selectedBudget, liveSources,
  };
  const detachedDetail = buildModel(context).detail(activityTaskId);
  if (!isDeepStrictEqual(detachedDetail, initialDetail)) return null;
  return {
    activityTaskId,
    revision: 1,
    context,
    authorizedSelectedTaskIds,
    visibleTaskIds,
    selectedLedger: selectedLedgerProjection(full.ledger, full.forest, activityTaskId),
  };
}

export async function updateActivityLiveSession(session, options = {}) {
  if (!session?.context || !safeTaskId(session.activityTaskId)) throw liveError("cache_miss");
  const expectedRevision = options.revision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== session.revision) {
    throw liveError("stale_revision");
  }
  const { context } = session;
  let ledger;
  let forest;
  try {
    ledger = await (options.readLedger ?? readLedger)(context.project);
    forest = buildActivityAssignmentForest(ledger);
  } catch {
    throw liveError("ledger_changed");
  }
  if (!forest.activities.some((item) => item.taskId === session.activityTaskId)) {
    throw liveError("ledger_changed");
  }
  const currentTaskIds = descendantIds(session.activityTaskId, forest.childrenByParent);
  if (!sameTaskSet(currentTaskIds, session.authorizedSelectedTaskIds)
      || selectedLedgerProjection(ledger, forest, session.activityTaskId) !== session.selectedLedger) {
    throw liveError("source_set_changed");
  }

  const stagedBudget = structuredClone(context.budget);
  stagedBudget.omissionMode = "reject";
  const baseline = {
    partial: context.budget.partial,
    omittedTasks: context.budget.omittedTasks,
    omittedSourceBytes: context.budget.omittedSourceBytes,
    rejectedTasks: context.budget.rejectedTasks,
    rejectedSourceBytes: context.budget.rejectedSourceBytes,
    omittedHistoryEntries: context.budget.omittedHistoryEntries,
    omittedSignals: context.budget.omittedSignals,
    omissionKeys: [...context.budget.omissionKeys].sort(),
  };
  const stagedSources = new Map();
  let changed = false;
  let appendedBytes = 0;
  for (const taskId of session.visibleTaskIds) {
    const source = context.liveSources.get(taskId);
    if (!source) throw liveError("cache_miss");
    const staged = {
      ...source,
      continuation: cloneActivityHistoryContinuation(source.continuation, { budget: stagedBudget, omissionMode: "reject" }),
    };
    let handle;
    try {
      const beforePathStat = await lstat(source.file);
      if (beforePathStat.isSymbolicLink() || !beforePathStat.isFile()
          || beforePathStat.dev !== source.identity.dev || beforePathStat.ino !== source.identity.ino) {
        throw liveError("source_replaced");
      }
      handle = await open(source.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const firstStat = await handle.stat();
      if (!firstStat.isFile() || firstStat.dev !== source.identity.dev || firstStat.ino !== source.identity.ino) {
        throw liveError("source_replaced");
      }
      if (firstStat.size < source.offset) throw liveError("source_shrunk");
      const deltaBytes = firstStat.size - source.offset;
      if (firstStat.size > MAX_SESSION_BYTES
          || appendedBytes + deltaBytes > (options.maxAppendBytes ?? MAX_ACTIVITY_LIVE_APPEND_BYTES)) {
        throw liveError("append_bounded");
      }
      if (stagedBudget.sessionSourceBytes + deltaBytes > stagedBudget.maxSessionSourceBytes) {
        throw liveError("append_bounded");
      }
      stagedBudget.sessionSourceBytes += deltaBytes;
      if (deltaBytes > 0) {
        for await (const chunk of handle.createReadStream({ start: source.offset, end: firstStat.size - 1, autoClose: false })) {
          appendedBytes += chunk.length;
          appendActivityHistoryContinuation(staged.continuation, chunk);
        }
        changed = true;
      }
      const finalStat = await handle.stat();
      if (finalStat.dev !== source.identity.dev || finalStat.ino !== source.identity.ino || finalStat.size < firstStat.size) {
        throw liveError("source_changed_during_read");
      }
      const afterPathStat = await lstat(source.file);
      if (afterPathStat.isSymbolicLink() || !afterPathStat.isFile()
          || afterPathStat.dev !== source.identity.dev || afterPathStat.ino !== source.identity.ino) {
        throw liveError("source_replaced");
      }
      staged.offset = firstStat.size;
      stagedSources.set(taskId, staged);
    } catch (error) {
      if (error?.code === "ACTIVITY_LIVE_REFRESH_REQUIRED") throw error;
      if (error?.code === "ACTIVITY_LIVE_PROJECTION_BOUNDED") throw liveError("append_bounded");
      if (error?.code === "ACTIVITY_JSONL_MALFORMED" || error?.code === "ACTIVITY_JSONL_LINE_TOO_LARGE" || error?.code === "ACTIVITY_HISTORY_RECORD_LIMIT") {
        throw liveError("append_invalid");
      }
      throw liveError(error?.code === "ENOENT" ? "source_missing" : "source_unavailable");
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  if (!changed) return { status: "unchanged", revision: session.revision, appendedBytes: 0 };

  const stagedHistories = new Map(context.histories);
  for (const [taskId, source] of stagedSources) {
    const history = snapshotActivityHistoryContinuation(source.continuation);
    if (source.continuation.history.partial
        && !context.liveSources.get(taskId)?.continuation.history.partial) throw liveError("append_bounded");
    stagedHistories.set(taskId, history);
  }
  const after = {
    partial: stagedBudget.partial,
    omittedTasks: stagedBudget.omittedTasks,
    omittedSourceBytes: stagedBudget.omittedSourceBytes,
    rejectedTasks: stagedBudget.rejectedTasks,
    rejectedSourceBytes: stagedBudget.rejectedSourceBytes,
    omittedHistoryEntries: stagedBudget.omittedHistoryEntries,
    omittedSignals: stagedBudget.omittedSignals,
    omissionKeys: [...stagedBudget.omissionKeys].sort(),
  };
  if (!isDeepStrictEqual(after, baseline)
      || stagedBudget.historyJsonBytes > stagedBudget.maxHistoryJsonBytes
      || stagedBudget.timelineEvents > stagedBudget.maxTimelineEvents
      || stagedBudget.sessionSourceBytes > stagedBudget.maxSessionSourceBytes
      || stagedBudget.signalJsonBytes > stagedBudget.maxSignalJsonBytes) throw liveError("append_bounded");
  const stagedContext = { ...context, histories: stagedHistories, budget: stagedBudget, observedAt: new Date().toISOString() };
  const detail = buildModel(stagedContext).detail(session.activityTaskId);
  if (!detail) throw liveError("projection_invalid");

  for (const [taskId, source] of stagedSources) {
    context.liveSources.set(taskId, source);
    context.histories.set(taskId, stagedHistories.get(taskId));
  }
  context.budget = stagedBudget;
  context.observedAt = stagedContext.observedAt;
  session.revision += 1;
  return {
    status: "changed",
    revision: session.revision,
    appendedBytes,
    detail,
  };
}

export {
  buildModel as buildActivityModel,
  createLoadBudget,
  discoverSessionFiles,
  readAllSignals,
  readVerifiedHistory,
  reserveSessionAttempt,
  reserveSessionAttempt as chargeSession,
  selectedLedgerProjection,
};
