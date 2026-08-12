import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ActivityDataError,
  buildActivityAssignmentForest,
  buildActivityModel,
  chargeSession,
  createLoadBudget,
  createActivityLiveSession,
  loadActivity,
  readAllSignals,
  readVerifiedHistory,
  selectedLedgerProjection,
  updateActivityLiveSession,
} from "../source/activity-data.mjs";
import { createReviewSnapshot } from "../../runtime/source/review-snapshot.mjs";
import { compactTaskLedger } from "../../runtime/source/task-ledger.mjs";
import { resolveProject } from "../../runtime/source/project.mjs";

const AT = "2026-08-01T00:00:00.000Z";
const ROOT = "11111111-1111-4111-8111-111111111111";
const PRIMARY = "22222222-2222-4222-8222-222222222222";
const REVIEW_ONE = "33333333-3333-4333-8333-333333333333";
const REVIEW_TWO = "44444444-4444-4444-8444-444444444444";
const ROOT_TWO = "55555555-5555-4555-8555-555555555555";
const PRIMARY_TWO = "66666666-6666-4666-8666-666666666666";

function conversation(id, initiatorTaskId, initiatorRole, responderTaskId, responderRole, createdAt = AT) {
  return { id, initiatorTaskId, initiatorRole, responderTaskId, responderRole, state: "accepted", createdAt, updatedAt: createdAt, repliedAt: createdAt, acceptedAt: createdAt };
}

function link(parentTaskId, childTaskId, role, sourceTaskId = parentTaskId, lifecycle = "open") {
  return { parentTaskId, childTaskId, sourceTaskId, role, lifecycle, acceptanceReason: lifecycle === "accepted" ? "direct" : null, historyFile: null, createdAt: AT, updatedAt: AT, acceptedAt: lifecycle === "accepted" ? AT : null };
}

function ledger(project = { root: "/project", key: "key" }, overrides = {}) {
  return {
    version: 10, projectRoot: project.root, projectKey: project.key, revision: 0, createdAt: AT, updatedAt: AT,
    managedTasks: [{ taskId: PRIMARY, name: "Primary", role: "primary", createdAt: AT }],
    pendingLaunches: [], links: [link(ROOT, PRIMARY, "primary")],
    conversations: [conversation("assign-primary", ROOT, "controller", PRIMARY, "primary")],
    deliveries: [], appMessages: [], ...overrides,
  };
}

function history({ id, startedAt = AT, records = [], tokens = 0, retained = null, compactions = 0, partial = false, lifecycleState = "complete", endedAt = startedAt }) {
  return {
    metadata: { taskId: id, cwd: "/project", parentTaskId: null }, records,
    taskEvents: [], startedAt, endedAt,
    lifecycleStartedAt: startedAt, lifecycleEndedAt: lifecycleState === "running" ? null : endedAt, lifecycleState,
    cumulativeTokens: tokens, hasTokenUsage: tokens > 0 || retained !== null,
    retainedContextTokens: retained, contextWindow: 1000, compactions, partial, diagnostics: [],
  };
}

function session(id, cwd, parent = null, text = id) {
  return [
    JSON.stringify({ type: "session_meta", timestamp: AT, payload: { id, cwd, forked_from_id: parent } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-08-01T00:00:01.000Z", payload: { type: "task_started", turn_id: `${id}-turn`, started_at: "2026-08-01T00:00:01.000Z" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-08-01T00:00:02.000Z", payload: { type: "user_message", message: text } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-08-01T00:00:03.000Z", payload: { type: "agent_reasoning", text: `${text} THINK` } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-08-01T00:00:04.000Z", payload: { type: "agent_message", message: `${text} OUTPUT` } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-08-01T00:00:06.000Z", payload: { type: "task_complete", turn_id: `${id}-turn`, started_at: "2026-08-01T00:00:01.000Z", completed_at: "2026-08-01T00:00:05.000Z" } }),
  ].join("\n") + "\n";
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

test("assignment forest makes every Primary an independent Activity and rejects current-link disagreement", () => {
  const rootB = "55555555-5555-4555-8555-555555555555";
  const primaryB = "66666666-6666-4666-8666-666666666666";
  const conversations = [
    conversation("a-primary", ROOT, "controller", PRIMARY, "primary", "2026-08-01T00:00:00.000Z"),
    conversation("a-review", PRIMARY, "primary", REVIEW_ONE, "review", "2026-08-01T00:01:00.000Z"),
    conversation("later-peer", "interviewer", "interviewer", REVIEW_ONE, "review", "2026-08-01T00:02:00.000Z"),
    conversation("b-primary", rootB, "controller", primaryB, "primary", "2026-08-02T00:00:00.000Z"),
  ];
  const valid = buildActivityAssignmentForest(ledger(undefined, { conversations, links: [link(ROOT, PRIMARY, "primary"), link(PRIMARY, REVIEW_ONE, "review"), link(rootB, primaryB, "primary")] }));
  assert.deepEqual(valid.activities.map((item) => item.taskId), [primaryB, PRIMARY]);
  assert.equal(valid.authorizedTaskIds.has(ROOT), false);
  assert.equal(valid.parentByTask.get(REVIEW_ONE), PRIMARY);
  assert.equal(valid.roleByTask.get(REVIEW_ONE), "review");

  const mismatch = buildActivityAssignmentForest(ledger(undefined, { conversations, links: [link(ROOT, PRIMARY, "primary"), link(ROOT, REVIEW_ONE, "review")] }));
  assert.equal(mismatch.authorizedTaskIds.has(REVIEW_ONE), false);
  assert.ok(mismatch.diagnostics.some((item) => item.code === "ACTIVITY_LEDGER_LINEAGE_MISMATCH"));
});

test("Activity list follows newest assignment order rather than session timestamps", () => {
  const primaryTwo = "77777777-7777-4777-8777-777777777777";
  const currentLedger = ledger(undefined, {
    conversations: [
      conversation("older", ROOT, "controller", PRIMARY, "primary", "2026-08-01T00:00:00.000Z"),
      conversation("newer", ROOT, "controller", primaryTwo, "primary", "2026-08-02T00:00:00.000Z"),
    ],
    links: [link(ROOT, PRIMARY, "primary"), link(ROOT, primaryTwo, "primary")],
  });
  const forest = buildActivityAssignmentForest(currentLedger);
  const histories = new Map([
    [PRIMARY, history({ id: PRIMARY, startedAt: "2026-08-03T00:00:00.000Z" })],
    [primaryTwo, history({ id: primaryTwo, startedAt: "2026-07-31T00:00:00.000Z" })],
  ]);
  const model = buildActivityModel({ project: { key: "key", root: "/project" }, histories, ledger: currentLedger,
    forest, signals: [], snapshotChains: new Map(), diagnostics: [], partial: false });
  assert.deepEqual(model.activities.map((item) => item.id), [primaryTwo, PRIMARY]);
});

test("model extends only a running lifecycle to the fixed observation", () => {
  const currentLedger = ledger();
  const forest = buildActivityAssignmentForest(currentLedger);
  const startedAt = "2026-08-01T00:00:01.000Z";
  const observedAt = "2026-08-01T00:10:01.000Z";
  const histories = new Map([[PRIMARY, history({ id: PRIMARY, startedAt, lifecycleState: "running", endedAt: null,
    records: [{ kind: "think", text: "still working", timestamp: "2026-08-01T00:09:00.000Z", sequence: 1 }] })]]);
  const model = buildActivityModel({ project: { key: "key", root: "/project" }, histories, ledger: currentLedger,
    forest, signals: [], snapshotChains: new Map(), diagnostics: [], partial: false, observedAt });
  const detail = model.detail(PRIMARY);
  assert.equal(detail.agents[0].startedAt, startedAt);
  assert.equal(detail.agents[0].endedAt, null);
  assert.equal(detail.agents[0].timelineEndedAt, observedAt);
  assert.equal(detail.agents[0].lifecycleState, "running");
  assert.equal(detail.timeline.endedAt, observedAt);
  assert.equal(detail.timeline.elapsedMs, 600_000);
});

test("model projects one interval per retained Turn", () => {
  const currentLedger = ledger();
  const forest = buildActivityAssignmentForest(currentLedger);
  const currentHistory = history({ id: PRIMARY, startedAt: "2026-08-01T00:00:01.000Z", endedAt: "2026-08-01T00:02:04.000Z" });
  currentHistory.taskEvents = [
    { type: "task_started", turnId: "one", timestamp: "2026-08-01T00:00:01.000Z", sequence: 1 },
    { type: "task_complete", turnId: "one", timestamp: "2026-08-01T00:00:04.000Z", sequence: 2 },
    { type: "task_started", turnId: "two", timestamp: "2026-08-01T00:02:01.000Z", sequence: 3 },
    { type: "turn_aborted", turnId: "two", timestamp: "2026-08-01T00:02:04.000Z", sequence: 4 },
  ];
  const detail = buildActivityModel({ project: { key: "key", root: "/project" },
    histories: new Map([[PRIMARY, currentHistory]]), ledger: currentLedger, forest,
    signals: [], snapshotChains: new Map(), diagnostics: [], partial: false }).detail(PRIMARY);
  assert.deepEqual(detail.agents[0].turns, [
    { id: "one", turnId: "one", startedAt: "2026-08-01T00:00:01.000Z", endedAt: "2026-08-01T00:00:04.000Z", state: "complete", startSequence: 1, endSequence: 2 },
    { id: "two", turnId: "two", startedAt: "2026-08-01T00:02:01.000Z", endedAt: "2026-08-01T00:02:04.000Z", state: "aborted", startSequence: 3, endSequence: 4 },
  ]);
});

test("authorized Tasks remain listed when their retained history is omitted", () => {
  const repliedAt = "2026-08-01T00:01:05.000Z";
  const conversations = [
    conversation("p", ROOT, "controller", PRIMARY, "primary"),
    { ...conversation("r", PRIMARY, "primary", REVIEW_ONE, "review", "2026-08-01T00:01:00.000Z"), repliedAt },
  ];
  const currentLedger = ledger(undefined, {
    managedTasks: [
      { taskId: PRIMARY, name: "Primary", role: "primary", createdAt: AT },
      { taskId: REVIEW_ONE, name: "Missing Review", role: "review", createdAt: AT },
    ],
    conversations,
    links: [link(ROOT, PRIMARY, "primary"), link(PRIMARY, REVIEW_ONE, "review")],
  });
  const forest = buildActivityAssignmentForest(currentLedger);
  const detail = buildActivityModel({ project: { key: "key", root: "/project" },
    histories: new Map([[PRIMARY, history({ id: PRIMARY })]]), ledger: currentLedger, forest,
    signals: [], snapshotChains: new Map(), diagnostics: [{ code: "ACTIVITY_SESSION_SOURCE_BOUNDED", taskId: REVIEW_ONE }], partial: true }).detail(PRIMARY);
  assert.deepEqual(detail.agents.map(({ name, available, lifecycleState }) => ({ name, available, lifecycleState })), [
    { name: "Primary", available: true, lifecycleState: "complete" },
    { name: "Missing Review", available: false, lifecycleState: "unavailable" },
  ]);
  assert.equal(detail.metrics.shownAgentCount, 2);
  assert.equal(detail.agents[1].records.length, 0);
  assert.deepEqual(detail.agents[1].turns, [{
    id: "conversation-r",
    turnId: null,
    startedAt: "2026-08-01T00:01:00.000Z",
    endedAt: repliedAt,
    state: "complete",
    evidence: "conversation",
    startSequence: 0,
    endSequence: 1,
  }]);
  assert.equal(detail.timeline.endedAt, repliedAt);
});

test("Timeline and Agents share first-invocation order", () => {
  const earlyCreatedAt = "2026-08-01T00:01:00.000Z";
  const lateCreatedAt = "2026-08-01T00:02:00.000Z";
  const conversations = [
    conversation("p", ROOT, "controller", PRIMARY, "primary"),
    { ...conversation("late", PRIMARY, "primary", REVIEW_ONE, "review", lateCreatedAt), repliedAt: "2026-08-01T00:02:05.000Z" },
    { ...conversation("early", PRIMARY, "primary", REVIEW_TWO, "review", earlyCreatedAt), repliedAt: "2026-08-01T00:01:05.000Z" },
  ];
  const currentLedger = ledger(undefined, {
    managedTasks: [
      { taskId: PRIMARY, name: "Primary", role: "primary", createdAt: AT },
      { taskId: REVIEW_ONE, name: "Later Review", role: "review", createdAt: AT },
      { taskId: REVIEW_TWO, name: "Earlier Review", role: "review", createdAt: AT },
    ],
    conversations,
    links: [link(ROOT, PRIMARY, "primary"), link(PRIMARY, REVIEW_ONE, "review"), link(PRIMARY, REVIEW_TWO, "review")],
  });
  const forest = buildActivityAssignmentForest(currentLedger);
  const primaryHistory = history({ id: PRIMARY });
  primaryHistory.taskEvents = [
    { type: "task_started", turnId: "primary", timestamp: AT, sequence: 1 },
    { type: "task_complete", turnId: "primary", timestamp: "2026-08-01T00:00:05.000Z", sequence: 2 },
  ];
  const detail = buildActivityModel({ project: { key: "key", root: "/project" },
    histories: new Map([[PRIMARY, primaryHistory]]), ledger: currentLedger, forest,
    signals: [], snapshotChains: new Map(), diagnostics: [], partial: true }).detail(PRIMARY);
  assert.deepEqual(detail.agents.map((agent) => agent.name), ["Primary", "Earlier Review", "Later Review"]);
});

test("model never borrows aggregate bounds for evidenced lifecycle endpoints", () => {
  const currentLedger = ledger();
  const forest = buildActivityAssignmentForest(currentLedger);
  const aggregateStart = "2026-08-01T00:00:00.000Z";
  const unrelatedEnd = "2026-08-01T00:20:00.000Z";
  const terminalUnknown = history({ id: PRIMARY, startedAt: aggregateStart, endedAt: unrelatedEnd });
  terminalUnknown.lifecycleStartedAt = null;
  terminalUnknown.lifecycleEndedAt = null;
  terminalUnknown.lifecycleState = "complete";
  terminalUnknown.taskEvents = [
    { type: "task_started", turnId: "turn-1", timestamp: null, sequence: 1 },
    { type: "task_complete", turnId: "turn-1", timestamp: null, sequence: 2 },
  ];
  terminalUnknown.records = [
    { kind: "think", text: "later retained message", timestamp: unrelatedEnd, sequence: 3 },
  ];
  const model = buildActivityModel({ project: { key: "key", root: "/project" }, histories: new Map([[PRIMARY, terminalUnknown]]),
    ledger: currentLedger, forest, signals: [], snapshotChains: new Map(), diagnostics: [], partial: false });
  const agent = model.detail(PRIMARY).agents[0];
  assert.equal(agent.startedAt, null);
  assert.equal(agent.endedAt, null);
  assert.equal(agent.timelineEndedAt, null);
});

test("model keeps Review Cycles inside one Primary Activity", () => {
  const primaryTwo = "77777777-7777-4777-8777-777777777777";
  const conversations = [
    conversation("p1", ROOT, "controller", PRIMARY, "primary"),
    conversation("r1", PRIMARY, "primary", REVIEW_ONE, "review", "2026-08-01T00:01:00.000Z"),
    conversation("r2", PRIMARY, "primary", REVIEW_TWO, "review", "2026-08-01T00:01:00.000Z"),
    conversation("p2", ROOT, "controller", primaryTwo, "primary", "2026-08-01T00:02:00.000Z"),
  ];
  const currentLedger = ledger(undefined, { conversations, links: [link(ROOT, PRIMARY, "primary"), link(PRIMARY, REVIEW_ONE, "review"), link(PRIMARY, REVIEW_TWO, "review"), link(ROOT, primaryTwo, "primary")] });
  const forest = buildActivityAssignmentForest(currentLedger);
  const histories = new Map([
    [ROOT, history({ id: ROOT, records: [{ kind: "input", text: "Root A", timestamp: AT, sequence: 1 }] })],
    [PRIMARY, history({ id: PRIMARY, tokens: 100, retained: 40, compactions: 1 })],
    [primaryTwo, history({ id: primaryTwo })],
    [REVIEW_ONE, history({ id: REVIEW_ONE })],
    [REVIEW_TWO, history({ id: REVIEW_TWO })],
  ]);
  const sameSnapshot = "a".repeat(40);
  const signalSnapshot = "b".repeat(40);
  const snapshotChains = new Map([
    [PRIMARY, { snapshots: [
      { primaryTaskId: PRIMARY, snapshot: signalSnapshot, previousSnapshot: "0".repeat(40), createdAt: "2026-08-01T00:05:00.000Z", sequence: 0 },
      { primaryTaskId: PRIMARY, snapshot: sameSnapshot, previousSnapshot: signalSnapshot, createdAt: "2026-08-01T00:05:00.000Z", sequence: 1 },
    ] }],
    [primaryTwo, { snapshots: [{ primaryTaskId: primaryTwo, snapshot: sameSnapshot, previousSnapshot: "0".repeat(40), createdAt: "2026-08-01T00:05:00.000Z", sequence: 0 }] }],
  ]);
  const raw = "---\ntemplate: review-signal\nseverity: required\nsummary: Full finding\n---\n\n## Explanation\n\nFULL SIGNAL BODY\n\n## Implementation Approach\n";
  const unmatchedSnapshot = "c".repeat(40);
  const model = buildActivityModel({ project: { key: "key", root: "/project" }, histories, ledger: currentLedger, forest, snapshotChains, signals: [
    { id: `${PRIMARY}:${signalSnapshot}:one`, name: "one", snapshot: signalSnapshot, primaryTaskId: PRIMARY, severity: "required", raw, timestamp: "2026-09-01T00:00:00.000Z" },
    { id: `${PRIMARY}:${unmatchedSnapshot}:unresolved`, name: "unresolved", snapshot: unmatchedSnapshot, primaryTaskId: PRIMARY, severity: "consider", raw: "UNRESOLVED RAW", timestamp: "2026-09-02T00:00:00.000Z" },
  ], diagnostics: [], partial: false });
  const detail = model.detail(PRIMARY);
  assert.equal(detail.cycles.length, 2);
  assert.equal(detail.cycles[0].startedAt, "2026-08-01T00:05:00.000Z");
  assert.equal(new Set(detail.cycles.map((item) => item.id)).size, 2);
  assert.equal(detail.cycles.filter((item) => item.signalIds.length === 0).length, 1);
  assert.equal(detail.signals[0].raw, raw);
  assert.deepEqual(detail.unresolvedSignals, [`${PRIMARY}:${unmatchedSnapshot}:unresolved`]);
  assert.equal(detail.metrics.agentCount, 3);
  assert.equal(detail.metrics.compactions, 1);
});

test("partial projection exposes shown counts and nulls completeness-dependent totals", () => {
  const currentLedger = ledger();
  const forest = buildActivityAssignmentForest(currentLedger);
  const histories = new Map([[ROOT, history({ id: ROOT, partial: true })], [PRIMARY, history({ id: PRIMARY, tokens: 50, compactions: 1 })]]);
  const detail = buildActivityModel({ project: { key: "key", root: "/project" }, histories, ledger: currentLedger, forest, signals: [], snapshotChains: new Map(), diagnostics: [], partial: true }).detail(PRIMARY);
  assert.equal(detail.partial, true);
  assert.equal(detail.metrics.shownAgentCount, 1);
  assert.equal(detail.metrics.agentCount, null);
  assert.equal(detail.metrics.signalCount, null);
  assert.equal(detail.metrics.cumulativeTokens, null);
  assert.equal(detail.metrics.compactions, null);
});

test("Activity title is display-only and applies only to the authorized Primary root Agent", () => {
  const currentLedger = ledger(); const forest = buildActivityAssignmentForest(currentLedger);
  const histories = new Map([
    [ROOT, history({ id: ROOT, records: [{ kind: "input", text: "fallback root", timestamp: AT, sequence: 1 }] })],
    [PRIMARY, history({ id: PRIMARY, records: [{ kind: "input", text: "fallback primary", timestamp: AT, sequence: 1 }] })],
  ]);
  const titles = new Map([[ROOT, "Must not expose Controller"], [PRIMARY, "Desktop Primary Title"]]);
  const detail = buildActivityModel({ project: { key: "key", root: "/project" }, histories, ledger: currentLedger, forest,
    signals: [], snapshotChains: new Map(), threadTitles: titles, diagnostics: [], partial: false }).detail(PRIMARY);
  assert.equal(detail.activity.name, "Desktop Primary Title");
  assert.equal(detail.agents.find((agent) => agent.id === PRIMARY).name, "Desktop Primary Title");
  assert.equal(detail.agents.some((agent) => agent.id === ROOT), false);
});

test("Agent activity chronologically combines raw records with bounded durable in-Activity Conversation directions", () => {
  const exchange = conversation("review", PRIMARY, "primary", REVIEW_ONE, "review", "2026-08-01T00:00:02.000Z");
  exchange.repliedAt = "2026-08-01T00:00:04.000Z";
  const currentLedger = ledger(undefined, {
    conversations: [conversation("assign-primary", ROOT, "controller", PRIMARY, "primary"), exchange],
    links: [link(ROOT, PRIMARY, "primary"), link(PRIMARY, REVIEW_ONE, "review")],
  });
  const forest = buildActivityAssignmentForest(currentLedger);
  const histories = new Map([
    [PRIMARY, history({ id: PRIMARY, records: [{ kind: "output", text: "raw output", timestamp: "2026-08-01T00:00:03.000Z", sequence: 2 }] })],
    [REVIEW_ONE, history({ id: REVIEW_ONE })],
  ]);
  const detail = buildActivityModel({ project: { key: "key", root: "/project" }, histories, ledger: currentLedger, forest,
    signals: [], snapshotChains: new Map(), diagnostics: [], partial: false }).detail(PRIMARY);
  const primaryActivity = detail.agents.find((agent) => agent.id === PRIMARY).activity;
  const reviewActivity = detail.agents.find((agent) => agent.id === REVIEW_ONE).activity;
  assert.deepEqual(primaryActivity.map((item) => item.type ?? item.direction), ["SENT", "OUTPUT", "RECEIVED"]);
  assert.deepEqual(reviewActivity.map((item) => item.type ?? item.direction), ["RECEIVED", "SENT"]);
  assert.equal(primaryActivity[0].counterpartyTaskId, REVIEW_ONE); assert.equal(primaryActivity[0].counterpartyAvailable, true);
  assert.equal(Object.hasOwn(primaryActivity[0], "body"), false); assert.equal(Object.hasOwn(primaryActivity[0], "text"), false);

  const many = [conversation("assign-primary", ROOT, "controller", PRIMARY, "primary")];
  for (let index = 0; index < 1_025; index += 1) {
    const item = conversation(`extra-${String(index).padStart(4, "0")}`, PRIMARY, "primary", REVIEW_ONE, "review",
      `2026-08-02T00:${String(index % 60).padStart(2, "0")}:00.000Z`);
    item.repliedAt = item.createdAt; many.push(item);
  }
  const boundedLedger = ledger(undefined, { conversations: many, links: [link(ROOT, PRIMARY, "primary"), link(PRIMARY, REVIEW_ONE, "review")] });
  const boundedForest = buildActivityAssignmentForest(boundedLedger);
  const bounded = buildActivityModel({ project: { key: "key", root: "/project" }, histories, ledger: boundedLedger, forest: boundedForest,
    signals: [], snapshotChains: new Map(), diagnostics: [], partial: false }).detail(PRIMARY);
  assert.equal(bounded.partial, true); assert.ok(bounded.diagnostics.some((item) => item.code === "ACTIVITY_CONVERSATION_ACTIVITY_BOUNDED"));
  assert.equal(bounded.agents.reduce((sum, agent) => sum + agent.activity.filter((item) => item.kind === "conversation").length, 0), 4_096);
  for (const agent of bounded.agents) for (const event of agent.activity.filter((item) => item.kind === "conversation")) {
    if (!event.counterpartyAvailable) continue;
    const peer = bounded.agents.find((item) => item.id === event.counterpartyTaskId);
    assert.ok(peer?.activity.some((candidate) => candidate.kind === "conversation"
      && candidate.conversationId === event.conversationId && candidate.transition === event.transition
      && candidate.counterpartyTaskId === agent.id && candidate.direction !== event.direction));
  }
});

test("Conversation counterparties omitted from projected histories are never navigable", () => {
  const currentLedger = ledger(undefined, { conversations: [
    conversation("assign-primary", ROOT, "controller", PRIMARY, "primary"),
    conversation("missing-review", PRIMARY, "primary", REVIEW_ONE, "review", "2026-08-01T00:01:00.000Z"),
  ], links: [link(ROOT, PRIMARY, "primary"), link(PRIMARY, REVIEW_ONE, "review")] });
  const forest = buildActivityAssignmentForest(currentLedger);
  const histories = new Map([[ROOT, history({ id: ROOT })], [PRIMARY, history({ id: PRIMARY })]]);
  const detail = buildActivityModel({ project: { key: "key", root: "/project" }, histories, ledger: currentLedger, forest,
    signals: [], snapshotChains: new Map(), diagnostics: [], partial: true }).detail(PRIMARY);
  const event = detail.agents.find((agent) => agent.id === PRIMARY).activity
    .find((item) => item.conversationId === "missing-review");
  assert.equal(event.counterpartyTaskId, REVIEW_ONE); assert.equal(event.counterpartyAvailable, false);
  assert.equal(detail.agents.find((agent) => agent.id === REVIEW_ONE)?.available, false);
});

test("loader exposes only ledger-authorized sessions and authorized Primary Signals", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-auth-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, "project");
  const sessions = path.join(temporary, "codex", "sessions");
  await Promise.all([mkdir(projectRoot), mkdir(sessions, { recursive: true })]);
  const project = await resolveProject(projectRoot);
  const unrelated = "99999999-9999-4999-8999-999999999999";
  const currentLedger = ledger(project);
  await mkdir(project.directory, { recursive: true });
  await writeFile(project.stateFile, JSON.stringify(currentLedger));
  await Promise.all([
    writeFile(path.join(sessions, `rollout-${ROOT}.jsonl`), session(ROOT, project.root, null, "AUTHORIZED ROOT")),
    writeFile(path.join(sessions, `rollout-${PRIMARY}.jsonl`), session(PRIMARY, project.root, ROOT, "AUTHORIZED PRIMARY")),
    writeFile(path.join(sessions, `rollout-${unrelated}.jsonl`), session(unrelated, project.root, null, "UNRELATED SENTINEL")),
  ]);
  const snapshot = "a".repeat(40);
  const authorizedDirectory = path.join(project.directory, "signals", PRIMARY, snapshot);
  const unauthorizedDirectory = path.join(project.directory, "signals", unrelated, snapshot);
  await Promise.all([mkdir(authorizedDirectory, { recursive: true }), mkdir(unauthorizedDirectory, { recursive: true })]);
  await writeFile(path.join(authorizedDirectory, "authorized.md"), "---\ntemplate: review-signal\nseverity: required\nsummary: Authorized finding\n---\n\n## Explanation\n\nAUTHORIZED SIGNAL\n\n## Implementation Approach\n");
  await writeFile(path.join(unauthorizedDirectory, "sentinel.md"), "UNAUTHORIZED SIGNAL SENTINEL");
  const activity = await loadActivity(project.root, { sessionRoots: [sessions],
    readActivityThreadTitles: async () => { throw new Error("optional Desktop source unavailable"); },
    listReviewSnapshots: async ({ primaryTaskId }) => ({ snapshots: [{ primaryTaskId, snapshot, previousSnapshot: "0".repeat(40), createdAt: AT, sequence: 0 }], diagnostics: [], partial: false }) });
  const serialized = JSON.stringify({ activities: activity.activities, detail: activity.detail(PRIMARY) });
  assert.deepEqual(activity.activities.map((item) => item.id), [PRIMARY]);
  assert.deepEqual(activity.detail(PRIMARY).agents.map((item) => item.id), [PRIMARY]);
  assert.equal(serialized.includes("UNRELATED SENTINEL"), false);
  assert.equal(serialized.includes("UNAUTHORIZED SIGNAL SENTINEL"), false);
  assert.equal(serialized.includes("AUTHORIZED SIGNAL"), true);
  assert.equal(activity.detail(PRIMARY).agents[0].startedAt, "2026-08-01T00:00:01.000Z");
  assert.equal(activity.detail(PRIMARY).agents[0].timelineEndedAt, "2026-08-01T00:00:05.000Z");
  assert.equal(activity.partial, false); assert.equal(activity.activities[0].name, "Primary");
});

test("missing, malformed, unsupported, and wrong-project ledgers fail before discovery", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-ledger-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = await resolveProject(temporary);
  let discoveryCalls = 0;
  const options = { discoverSessionFiles: async () => { discoveryCalls += 1; return { candidates: [], truncated: false }; } };
  await assert.rejects(loadActivity(project.root, options), (error) => error instanceof ActivityDataError && error.code === "ACTIVITY_LEDGER_UNAVAILABLE");
  await mkdir(project.directory, { recursive: true });
  for (const raw of ["{", JSON.stringify({ ...ledger(project), version: 11 }), JSON.stringify({ ...ledger(project), projectRoot: "/wrong" })]) {
    await writeFile(project.stateFile, raw);
    await assert.rejects(loadActivity(project.root, options), (error) => error.code === "ACTIVITY_LEDGER_UNAVAILABLE");
  }
  assert.equal(discoveryCalls, 0);
});

test("selected Activity continuation reads only append bytes and promotes Output transactionally", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-live-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, "project");
  const sessions = path.join(temporary, "codex", "sessions");
  await Promise.all([mkdir(projectRoot), mkdir(sessions, { recursive: true })]);
  const project = await resolveProject(projectRoot);
  await mkdir(project.directory, { recursive: true });
  await writeFile(project.stateFile, JSON.stringify(ledger(project)));
  const file = path.join(sessions, `rollout-${PRIMARY}.jsonl`);
  await writeFile(file, session(PRIMARY, project.root, ROOT, "initial"));
  const model = await loadActivity(project.root, {
    sessionRoots: [sessions],
    readActivityThreadTitles: async () => new Map(),
    readAllSignals: async () => ({ signals: [], diagnostics: [] }),
    listReviewSnapshots: async () => ({ snapshots: [], diagnostics: [], partial: false }),
  });
  const live = createActivityLiveSession(model, PRIMARY);
  assert.ok(live);
  assert.deepEqual([...live.context.histories.keys()], [PRIMARY]);
  assert.deepEqual([...live.context.liveSources.keys()], [PRIMARY]);
  assert.deepEqual([...live.context.snapshotChains.keys()], [PRIMARY]);
  assert.deepEqual(Object.keys(live.context.ledger).sort(), ["conversations", "links", "managedTasks"]);
  assert.deepEqual(buildActivityModel(live.context).detail(PRIMARY), model.detail(PRIMARY));
  const unchanged = await updateActivityLiveSession(live, { revision: 1 });
  assert.deepEqual(unchanged, { status: "unchanged", revision: 1, appendedBytes: 0 });

  const start = JSON.stringify({ type: "event_msg", timestamp: "2026-08-01T00:01:00.000Z", payload: { type: "task_started", turn_id: "next", started_at: "2026-08-01T00:01:00.000Z" } });
  const message = JSON.stringify({ type: "event_msg", timestamp: "2026-08-01T00:01:01.000Z", payload: { type: "agent_message", message: "追記 output" } });
  const messageBytes = Buffer.from(message);
  const split = messageBytes.indexOf(Buffer.from("追")) + 1;
  await appendFile(file, `${start}\n`);
  await appendFile(file, messageBytes.subarray(0, split));
  const partial = await updateActivityLiveSession(live, { revision: 1 });
  assert.equal(partial.status, "changed");
  assert.equal(partial.revision, 2);
  assert.equal(partial.appendedBytes, Buffer.byteLength(`${start}\n`) + split);
  assert.equal(JSON.stringify(partial.detail).includes("追記 output"), false);

  const complete = JSON.stringify({ type: "event_msg", timestamp: "2026-08-01T00:01:02.000Z", payload: { type: "task_complete", turn_id: "next", completed_at: "2026-08-01T00:01:02.000Z" } });
  await appendFile(file, Buffer.concat([messageBytes.subarray(split), Buffer.from(`\n${complete}\n`)]));
  const updated = await updateActivityLiveSession(live, { revision: 2 });
  assert.equal(updated.status, "changed");
  const visible = updated.detail.agents[0].records.filter((record) => record.kind === "output");
  assert.deepEqual(visible.map((record) => record.text), ["追記 output"]);
  assert.equal(updated.detail.agents[0].lifecycleState, "complete");

  await assert.rejects(updateActivityLiveSession(live, { revision: 2 }), (error) =>
    error.code === "ACTIVITY_LIVE_REFRESH_REQUIRED" && error.reason === "stale_revision");
  await truncate(file, 1);
  await assert.rejects(updateActivityLiveSession(live, { revision: 3 }), (error) =>
    error.code === "ACTIVITY_LIVE_REFRESH_REQUIRED" && error.reason === "source_shrunk");
});

test("selected Activity continuation owns only its detached selected projection", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-live-owned-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, "project");
  const sessions = path.join(temporary, "codex", "sessions");
  await Promise.all([mkdir(projectRoot), mkdir(sessions, { recursive: true })]);
  const project = await resolveProject(projectRoot);
  await mkdir(project.directory, { recursive: true });
  const currentLedger = ledger(project, {
    managedTasks: [
      { taskId: PRIMARY, name: "Selected Primary", role: "primary", createdAt: AT },
      { taskId: PRIMARY_TWO, name: "Outside sentinel", role: "primary", createdAt: AT },
    ],
    links: [link(ROOT, PRIMARY, "primary"), link(ROOT_TWO, PRIMARY_TWO, "primary")],
    conversations: [
      conversation("assign-selected", ROOT, "controller", PRIMARY, "primary"),
      conversation("assign-outside", ROOT_TWO, "controller", PRIMARY_TWO, "primary", "2026-08-01T00:01:00.000Z"),
      conversation("selected-to-outside", PRIMARY, "primary", PRIMARY_TWO, "primary", "2026-08-01T00:02:00.000Z"),
    ],
  });
  await writeFile(project.stateFile, JSON.stringify(currentLedger));
  await Promise.all([
    writeFile(path.join(sessions, `rollout-${PRIMARY}.jsonl`), session(PRIMARY, project.root, ROOT, "SELECTED HISTORY")),
    writeFile(path.join(sessions, `rollout-${PRIMARY_TWO}.jsonl`), session(PRIMARY_TWO, project.root, ROOT_TWO, "OUTSIDE HISTORY SENTINEL")),
  ]);
  const model = await loadActivity(project.root, { sessionRoots: [sessions],
    readActivityThreadTitles: async () => new Map([[PRIMARY, "Selected title"], [PRIMARY_TWO, "Outside title sentinel"]]),
    readAllSignals: async () => ({ signals: [
      { id: "selected-signal", primaryTaskId: PRIMARY, raw: "SELECTED SIGNAL", timestamp: AT },
      { id: "outside-signal", primaryTaskId: PRIMARY_TWO, raw: "OUTSIDE SIGNAL SENTINEL", timestamp: AT },
    ], diagnostics: [] }),
    listReviewSnapshots: async ({ primaryTaskId }) => ({ snapshots: [{ primaryTaskId, snapshot: primaryTaskId === PRIMARY ? "a".repeat(40) : "b".repeat(40), previousSnapshot: "0".repeat(40), createdAt: AT, sequence: 0 }], diagnostics: [], partial: false }) });
  const first = createActivityLiveSession(model, PRIMARY);
  const second = createActivityLiveSession(model, PRIMARY);
  assert.ok(first); assert.ok(second);
  assert.notEqual(first.context, second.context);
  assert.notEqual(first.context.histories, second.context.histories);
  assert.notEqual(first.context.liveSources, second.context.liveSources);
  assert.notEqual(first.context.budget, second.context.budget);
  assert.notEqual(first.context.liveSources.get(PRIMARY).continuation, second.context.liveSources.get(PRIMARY).continuation);
  assert.equal(first.context.liveSources.get(PRIMARY).continuation.budget, first.context.budget);
  assert.deepEqual([...first.authorizedSelectedTaskIds], [PRIMARY]);
  assert.deepEqual([...first.visibleTaskIds], [PRIMARY]);
  assert.deepEqual([...first.context.histories.keys()], [PRIMARY]);
  assert.deepEqual([...first.context.liveSources.keys()], [PRIMARY]);
  assert.deepEqual([...first.context.signals.map((item) => item.primaryTaskId)], [PRIMARY]);
  assert.deepEqual([...first.context.snapshotChains.keys()], [PRIMARY]);
  assert.deepEqual([...first.context.threadTitles.keys()], [PRIMARY]);
  assert.equal(JSON.stringify([...first.context.histories]).includes("OUTSIDE HISTORY SENTINEL"), false);
  assert.equal(JSON.stringify(first.context.signals).includes("OUTSIDE SIGNAL SENTINEL"), false);
  assert.deepEqual(buildActivityModel(first.context).detail(PRIMARY), model.detail(PRIMARY));
  assert.ok(first.context.ledger.conversations.some((item) => item.id === "selected-to-outside"));
  assert.equal(first.context.histories.has(PRIMARY_TWO), false);
});

test("selected Activity continuation rejects source and authorization changes without committing", async (t) => {
  async function fixture(name) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), `codex-small-loop-activity-live-${name}-`));
    const projectRoot = path.join(temporary, "project");
    const sessions = path.join(temporary, "codex", "sessions");
    await Promise.all([mkdir(projectRoot), mkdir(sessions, { recursive: true })]);
    const project = await resolveProject(projectRoot);
    await mkdir(project.directory, { recursive: true });
    await writeFile(project.stateFile, JSON.stringify(ledger(project)));
    const file = path.join(sessions, `rollout-${PRIMARY}.jsonl`);
    await writeFile(file, session(PRIMARY, project.root, ROOT, "initial"));
    const initialSize = Buffer.byteLength(await readFile(file));
    const model = await loadActivity(project.root, { sessionRoots: [sessions],
      readActivityThreadTitles: async () => new Map(),
      readAllSignals: async () => ({ signals: [], diagnostics: [] }),
      listReviewSnapshots: async () => ({ snapshots: [], diagnostics: [], partial: false }) });
    return { temporary, project, file, initialSize, live: createActivityLiveSession(model, PRIMARY) };
  }

  await t.test("malformed and over-bound append", async (t) => {
    const current = await fixture("invalid");
    t.after(() => rm(current.temporary, { recursive: true, force: true }));
    await appendFile(current.file, "{bad}\n");
    await assert.rejects(updateActivityLiveSession(current.live, { revision: 1 }), (error) => error.reason === "append_invalid");
    await truncate(current.file, current.initialSize);
    assert.equal((await updateActivityLiveSession(current.live, { revision: 1 })).status, "unchanged");
    await appendFile(current.file, "{}\n");
    await assert.rejects(updateActivityLiveSession(current.live, { revision: 1, maxAppendBytes: 1 }), (error) => error.reason === "append_bounded");
  });

  await t.test("identity replacement and delete/recreate", async (t) => {
    const current = await fixture("replace");
    t.after(() => rm(current.temporary, { recursive: true, force: true }));
    const old = `${current.file}.old`;
    await rename(current.file, old);
    await writeFile(current.file, await readFile(old));
    await assert.rejects(updateActivityLiveSession(current.live, { revision: 1 }), (error) => error.reason === "source_replaced");
    await rm(current.file);
    await assert.rejects(updateActivityLiveSession(current.live, { revision: 1 }), (error) => error.reason === "source_missing");
  });

  await t.test("new authorized Task", async (t) => {
    const current = await fixture("ledger");
    t.after(() => rm(current.temporary, { recursive: true, force: true }));
    const child = REVIEW_ONE;
    const changedLedger = ledger(current.project, {
      managedTasks: [
        { taskId: PRIMARY, name: "Primary", role: "primary", createdAt: AT },
        { taskId: child, name: "Execute", role: "execute", createdAt: AT },
      ],
      links: [link(ROOT, PRIMARY, "primary"), link(PRIMARY, child, "execute")],
      conversations: [
        conversation("assign-primary", ROOT, "controller", PRIMARY, "primary"),
        conversation("assign-child", PRIMARY, "primary", child, "execute"),
      ],
    });
    await writeFile(current.project.stateFile, JSON.stringify(changedLedger));
    await assert.rejects(updateActivityLiveSession(current.live, { revision: 1 }), (error) => error.reason === "source_set_changed");
  });

  await t.test("selected ledger projection and irrelevant bookkeeping", async (t) => {
    const current = await fixture("ledger-projection");
    t.after(() => rm(current.temporary, { recursive: true, force: true }));
    const harmless = ledger(current.project, { revision: 99, updatedAt: "2026-08-02T00:00:00.000Z",
      conversations: [
        { ...conversation("assign-primary", ROOT, "controller", PRIMARY, "primary"),
          state: "accepted", updatedAt: "2026-08-02T00:00:00.000Z", acceptedAt: "2026-08-02T00:00:00.000Z" },
      ] });
    await writeFile(current.project.stateFile, JSON.stringify(harmless));
    assert.equal((await updateActivityLiveSession(current.live, { revision: 1 })).status, "unchanged");
    harmless.managedTasks[0].name = "Renamed selected Primary";
    await writeFile(current.project.stateFile, JSON.stringify(harmless));
    await assert.rejects(updateActivityLiveSession(current.live, { revision: 1 }), (error) => error.reason === "source_set_changed");
  });
});

test("selected ledger projection binds visible authorization facts only", () => {
  const base = ledger(undefined, {
    managedTasks: [
      { taskId: PRIMARY, name: "Selected", role: "primary", createdAt: AT },
      { taskId: REVIEW_ONE, name: "Child", role: "review", createdAt: AT },
      { taskId: PRIMARY_TWO, name: "Outside", role: "primary", createdAt: AT },
    ],
    links: [
      link(ROOT, PRIMARY, "primary"),
      link(PRIMARY, REVIEW_ONE, "review"),
      link(ROOT_TWO, PRIMARY_TWO, "primary"),
    ],
    conversations: [
      conversation("assign-selected", ROOT, "controller", PRIMARY, "primary"),
      conversation("assign-child", PRIMARY, "primary", REVIEW_ONE, "review", "2026-08-01T00:01:00.000Z"),
      conversation("assign-outside", ROOT_TWO, "controller", PRIMARY_TWO, "primary", "2026-08-01T00:02:00.000Z"),
      conversation("selected-outside", PRIMARY, "primary", PRIMARY_TWO, "primary", "2026-08-01T00:03:00.000Z"),
    ],
  });
  const project = (current) => selectedLedgerProjection(current, buildActivityAssignmentForest(current), PRIMARY);
  const expected = project(base);
  const mutate = (change) => {
    const current = structuredClone(base);
    change(current);
    return project(current);
  };
  const relevant = [
    (current) => { current.managedTasks.find((item) => item.taskId === PRIMARY).name = "Renamed"; },
    (current) => { current.conversations.find((item) => item.id === "assign-child").responderRole = "execute"; },
    (current) => { current.conversations.find((item) => item.id === "assign-child").id = "different-assignment"; },
    (current) => { current.conversations.find((item) => item.id === "assign-child").createdAt = "2026-08-01T00:01:01.000Z"; },
    (current) => { current.links.find((item) => item.childTaskId === REVIEW_ONE).parentTaskId = ROOT; },
    (current) => { current.links.find((item) => item.childTaskId === REVIEW_ONE).role = "execute"; },
    (current) => { current.links.find((item) => item.childTaskId === REVIEW_ONE).sourceTaskId = ROOT; },
    (current) => { current.conversations.find((item) => item.id === "assign-child").repliedAt = "2026-08-01T00:04:00.000Z"; },
    (current) => { current.conversations.find((item) => item.id === "selected-outside").repliedAt = "2026-08-01T00:05:00.000Z"; },
  ];
  for (const change of relevant) assert.notEqual(mutate(change), expected);

  assert.equal(mutate((current) => {
    current.revision = 99; current.updatedAt = "2026-08-02T00:00:00.000Z";
    for (const item of current.conversations) {
      item.state = "accepted"; item.acceptedAt = "2026-08-02T00:00:00.000Z"; item.updatedAt = "2026-08-02T00:00:00.000Z";
    }
  }), expected);
  assert.equal(mutate((current) => {
    current.managedTasks.reverse(); current.links.reverse(); current.conversations.reverse();
  }), expected);
  assert.equal(mutate((current) => {
    current.managedTasks.find((item) => item.taskId === PRIMARY_TWO).name = "Outside renamed";
    current.conversations.find((item) => item.id === "assign-outside").repliedAt = "2026-08-03T00:00:00.000Z";
    current.links.find((item) => item.childTaskId === PRIMARY_TWO).updatedAt = "2026-08-03T00:00:00.000Z";
  }), expected);
});

test("selected Activity live budgets commit all visible sources or none", async (t) => {
  async function fixture(name, withChild = false) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), `codex-small-loop-activity-live-budget-${name}-`));
    const projectRoot = path.join(temporary, "project");
    const sessions = path.join(temporary, "codex", "sessions");
    await Promise.all([mkdir(projectRoot), mkdir(sessions, { recursive: true })]);
    const project = await resolveProject(projectRoot);
    await mkdir(project.directory, { recursive: true });
    const selectedLedger = withChild ? ledger(project, {
      managedTasks: [
        { taskId: PRIMARY, name: "Primary", role: "primary", createdAt: AT },
        { taskId: REVIEW_ONE, name: "Review", role: "review", createdAt: AT },
      ],
      links: [link(ROOT, PRIMARY, "primary"), link(PRIMARY, REVIEW_ONE, "review")],
      conversations: [
        conversation("assign-primary", ROOT, "controller", PRIMARY, "primary"),
        conversation("assign-review", PRIMARY, "primary", REVIEW_ONE, "review", "2026-08-01T00:01:00.000Z"),
      ],
    }) : ledger(project);
    await writeFile(project.stateFile, JSON.stringify(selectedLedger));
    const files = new Map([[PRIMARY, path.join(sessions, `rollout-${PRIMARY}.jsonl`)]]);
    await writeFile(files.get(PRIMARY), session(PRIMARY, project.root, ROOT, "primary"));
    if (withChild) {
      files.set(REVIEW_ONE, path.join(sessions, `rollout-${REVIEW_ONE}.jsonl`));
      await writeFile(files.get(REVIEW_ONE), session(REVIEW_ONE, project.root, PRIMARY, "review"));
    }
    const model = await loadActivity(project.root, { sessionRoots: [sessions],
      readActivityThreadTitles: async () => new Map(),
      readAllSignals: async () => ({ signals: [], diagnostics: [] }),
      listReviewSnapshots: async () => ({ snapshots: [], diagnostics: [], partial: false }) });
    return { temporary, files, live: createActivityLiveSession(model, PRIMARY) };
  }

  await t.test("aggregate source bytes accept exact and reject plus one", async (t) => {
    const exact = await fixture("exact");
    t.after(() => rm(exact.temporary, { recursive: true, force: true }));
    const append = "{}\n";
    exact.live.context.budget.maxSessionSourceBytes = exact.live.context.budget.sessionSourceBytes + Buffer.byteLength(append);
    await appendFile(exact.files.get(PRIMARY), append);
    const accepted = await updateActivityLiveSession(exact.live, { revision: 1 });
    assert.equal(accepted.status, "changed");
    assert.equal(exact.live.context.budget.sessionSourceBytes, exact.live.context.budget.maxSessionSourceBytes);

    const over = await fixture("over");
    t.after(() => rm(over.temporary, { recursive: true, force: true }));
    over.live.context.budget.maxSessionSourceBytes = over.live.context.budget.sessionSourceBytes + Buffer.byteLength(append) - 1;
    const before = {
      revision: over.live.revision,
      offset: over.live.context.liveSources.get(PRIMARY).offset,
      budget: structuredClone(over.live.context.budget),
      history: structuredClone(over.live.context.histories.get(PRIMARY)),
    };
    await appendFile(over.files.get(PRIMARY), append);
    await assert.rejects(updateActivityLiveSession(over.live, { revision: 1 }), (error) => error.reason === "append_bounded");
    assert.equal(over.live.revision, before.revision);
    assert.equal(over.live.context.liveSources.get(PRIMARY).offset, before.offset);
    assert.deepEqual(over.live.context.budget, before.budget);
    assert.deepEqual(over.live.context.histories.get(PRIMARY), before.history);
  });

  await t.test("late source failure rolls back every source and retries the same revision", async (t) => {
    const current = await fixture("transaction", true);
    t.after(() => rm(current.temporary, { recursive: true, force: true }));
    const primaryAppend = `${JSON.stringify({ type: "event_msg", timestamp: "2026-08-01T00:02:00.000Z", payload: { type: "agent_message", message: "PRIMARY APPEND" } })}\n`;
    const oversized = `${JSON.stringify({ type: "event_msg", timestamp: "2026-08-01T00:02:01.000Z", payload: { type: "agent_message", message: "x".repeat(512 * 1024 + 1) } })}\n`;
    const childOffset = current.live.context.liveSources.get(REVIEW_ONE).offset;
    current.live.context.budget.partial = true;
    current.live.context.budget.omittedHistoryEntries = 1;
    current.live.context.budget.omissionKeys.add("pre-existing-partial");
    const before = {
      revision: current.live.revision,
      offsets: new Map([...current.live.context.liveSources].map(([taskId, source]) => [taskId, source.offset])),
      histories: structuredClone([...current.live.context.histories]),
      budget: structuredClone(current.live.context.budget),
    };
    await appendFile(current.files.get(PRIMARY), primaryAppend);
    await appendFile(current.files.get(REVIEW_ONE), oversized);
    await assert.rejects(updateActivityLiveSession(current.live, { revision: 1 }), (error) => error.reason === "append_bounded");
    assert.equal(current.live.revision, before.revision);
    assert.deepEqual(new Map([...current.live.context.liveSources].map(([taskId, source]) => [taskId, source.offset])), before.offsets);
    assert.deepEqual([...current.live.context.histories], before.histories);
    assert.deepEqual(current.live.context.budget, before.budget);

    await truncate(current.files.get(REVIEW_ONE), childOffset);
    const childAppend = `${JSON.stringify({ type: "event_msg", timestamp: "2026-08-01T00:02:01.000Z", payload: { type: "agent_message", message: "CHILD APPEND" } })}\n`;
    await appendFile(current.files.get(REVIEW_ONE), childAppend);
    const retried = await updateActivityLiveSession(current.live, { revision: 1 });
    assert.equal(retried.status, "changed");
    assert.equal(retried.revision, 2);
    assert.match(JSON.stringify(retried.detail), /PRIMARY APPEND/);
    assert.match(JSON.stringify(retried.detail), /CHILD APPEND/);
    assert.equal(current.live.context.budget.partial, true);
    assert.equal(current.live.context.budget.omittedHistoryEntries, 1);
    assert.deepEqual([...current.live.context.budget.omissionKeys], ["pre-existing-partial"]);
  });
});

test("accepted-link compaction retains Primary Activity authorization", () => {
  const project = { root: "/project", key: "key" };
  const accepted = ledger(project, { links: [link(ROOT, PRIMARY, "primary", ROOT, "accepted")] });
  const compacted = compactTaskLedger(accepted);
  assert.equal(compacted.links.length, 0);
  assert.equal(compacted.managedTasks.length, 0);
  const forest = buildActivityAssignmentForest(compacted);
  assert.equal(forest.authorizedTaskIds.has(ROOT), false);
  assert.equal(forest.authorizedTaskIds.has(PRIMARY), true);
  assert.equal(forest.parentByTask.has(PRIMARY), false);
});

test("Task/source budgets enforce exact and over limits without admitting excess", () => {
  const manyConversations = [conversation("root-primary", ROOT, "controller", PRIMARY, "primary")];
  for (let index = 0; index < 255; index += 1) {
    manyConversations.push(conversation(`child-${index}`, PRIMARY, "primary", `task-${index}`, "execute", `2026-08-01T00:${String(index % 60).padStart(2, "0")}:00.000Z`));
  }
  assert.equal(buildActivityAssignmentForest(ledger(undefined, { conversations: manyConversations, links: [] })).authorizedTaskIds.size, 256);
  const taskBudget = createLoadBudget({ maxAuthorizedTasks: 256, maxSessionSourceBytes: 1_000_000 });
  for (let index = 0; index < 256; index += 1) assert.equal(chargeSession(taskBudget, 1), true);
  assert.equal(chargeSession(taskBudget, 1), false);
  assert.equal(taskBudget.authorizedTasks, 256);
  assert.equal(taskBudget.partial, true);

  const sourceBudget = createLoadBudget({ maxAuthorizedTasks: 10, maxSessionSourceBytes: 10 });
  assert.equal(chargeSession(sourceBudget, 10), true);
  assert.equal(chargeSession(sourceBudget, 1), false);
  assert.equal(sourceBudget.sessionSourceBytes, 10);
});

test("one invalid Primary snapshot ref degrades independently and keeps unmatched raw Signals", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-invalid-cycle-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = await resolveProject(temporary);
  const primaryTwo = "77777777-7777-4777-8777-777777777777";
  const currentLedger = ledger(project, {
    conversations: [conversation("p1", ROOT, "controller", PRIMARY, "primary"), conversation("p2", ROOT, "controller", primaryTwo, "primary", "2026-08-01T00:01:00.000Z")],
    links: [link(ROOT, PRIMARY, "primary"), link(ROOT, primaryTwo, "primary")],
  });
  const ids = [ROOT, PRIMARY, primaryTwo];
  const snapshot = "d".repeat(40);
  const signal = { id: `${primaryTwo}:${snapshot}:raw`, name: "raw", snapshot, primaryTaskId: primaryTwo, severity: "required", raw: "INVALID REF RAW SIGNAL", timestamp: AT };
  const activity = await loadActivity(project.root, {
    readLedger: async () => currentLedger,
    discoverSessionFiles: async () => ({ candidates: ids.map((taskId) => ({ taskId, file: taskId })), truncated: false }),
    readVerifiedHistory: async (candidate, _project, budget) => {
      chargeSession(budget, 1);
      return { taskId: candidate.taskId, history: history({ id: candidate.taskId }), metadata: { parentTaskId: candidate.taskId === ROOT ? null : ROOT } };
    },
    readAllSignals: async () => ({ signals: [signal], diagnostics: [] }),
    listReviewSnapshots: async ({ primaryTaskId }) => {
      if (primaryTaskId === primaryTwo) { const error = new Error("invalid ref"); error.code = "REVIEW_SNAPSHOT_HISTORY_INVALID"; throw error; }
      return { snapshots: [{ primaryTaskId, snapshot: "e".repeat(40), previousSnapshot: "0".repeat(40), createdAt: AT, sequence: 0 }], diagnostics: [], partial: false };
    },
  });
  const detail = activity.detail(primaryTwo);
  assert.equal(detail.cycles.length, 0);
  assert.deepEqual(detail.unresolvedSignals, [signal.id]);
  assert.equal(detail.signals[0].raw, "INVALID REF RAW SIGNAL");
  assert.equal(detail.partial, true);
  assert.ok(detail.diagnostics.some((item) => item.code === "REVIEW_SNAPSHOT_HISTORY_INVALID"));
});

test("aggregate admission selects newest Primary Activities first and never admits a child without its parent", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-order-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = await resolveProject(temporary);
  const rootB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const primaryB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const currentLedger = ledger(project, {
    conversations: [
      conversation("old-root", ROOT, "controller", PRIMARY, "primary", "2026-08-01T00:00:00.000Z"),
      conversation("old-child", PRIMARY, "primary", REVIEW_ONE, "review", "2026-08-01T00:01:00.000Z"),
      conversation("new-root", rootB, "controller", primaryB, "primary", "2026-08-02T00:00:00.000Z"),
    ],
    links: [link(ROOT, PRIMARY, "primary"), link(PRIMARY, REVIEW_ONE, "review"), link(rootB, primaryB, "primary")],
  });
  const ids = [ROOT, PRIMARY, REVIEW_ONE, rootB, primaryB];
  const parseOrder = [];
  const activity = await loadActivity(project.root, {
    readLedger: async () => currentLedger,
    budgetLimits: { maxAuthorizedTasks: 2, maxSessionSourceBytes: 100 },
    discoverSessionFiles: async () => ({ candidates: ids.map((taskId) => ({ taskId, file: taskId })), truncated: false }),
    readVerifiedHistory: async (candidate, _project, budget) => {
      parseOrder.push(candidate.taskId);
      if (!chargeSession(budget, 1)) return { taskId: candidate.taskId, omitted: true };
      return {
        taskId: candidate.taskId,
        history: history({ id: candidate.taskId }),
        metadata: { parentTaskId: currentLedger.links.find((item) => item.childTaskId === candidate.taskId)?.sourceTaskId ?? null },
      };
    },
    readAllSignals: async () => ({ signals: [], diagnostics: [] }),
    listReviewSnapshots: async () => ({ snapshots: [], diagnostics: [], partial: false }),
  });
  assert.deepEqual(parseOrder, [primaryB, PRIMARY]);
  assert.deepEqual(activity.activities.map((item) => item.id), [primaryB, PRIMARY]);
  assert.deepEqual(activity.detail(primaryB).agents.map((item) => item.id), [primaryB]);
  assert.equal(activity.partial, true);
  assert.equal(activity.detail(primaryB).metrics.agentCount, null);
});

test("Signal aggregate boundary retains exact raw text and filters unauthorized Primary directories", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-signals-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = await resolveProject(temporary);
  const snapshot = "a".repeat(40);
  const authorized = path.join(project.directory, "signals", PRIMARY, snapshot);
  const unauthorized = path.join(project.directory, "signals", ROOT, snapshot);
  await Promise.all([mkdir(authorized, { recursive: true }), mkdir(unauthorized, { recursive: true })]);
  const raw = "---\ntemplate: review-signal\nseverity: required\nsummary: Test finding\n---\n\n## Explanation\n\nRAW SIGNAL\n\n## Implementation Approach\n";
  await writeFile(path.join(authorized, "signal.md"), raw);
  await writeFile(path.join(unauthorized, "sentinel.md"), "UNAUTHORIZED");
  const generous = createLoadBudget({ maxSignalJsonBytes: 10_000 });
  const first = await readAllSignals(project, new Set([PRIMARY]), generous);
  assert.equal(first.signals[0].raw, raw);
  assert.equal(first.signals[0].severity, "required");
  assert.equal(Object.hasOwn(first.signals[0], "disposition"), false);
  assert.equal(JSON.stringify(first).includes("UNAUTHORIZED"), false);
  const exact = createLoadBudget({ maxSignalJsonBytes: generous.signalJsonBytes });
  assert.equal((await readAllSignals(project, new Set([PRIMARY]), exact)).signals.length, 1);
  const over = createLoadBudget({ maxSignalJsonBytes: generous.signalJsonBytes - 1 });
  const partial = await readAllSignals(project, new Set([PRIMARY]), over);
  assert.equal(partial.signals.length, 0);
  assert.equal(over.partial, true);
  assert.equal(partial.diagnostics[0].code, "ACTIVITY_SIGNAL_AGGREGATE_BOUNDED");
});

test("reserved one-handle read ignores pathname replacement and rejects changed canonical cwd", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-reopen-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, "project");
  const otherRoot = path.join(temporary, "other");
  await Promise.all([mkdir(projectRoot), mkdir(otherRoot)]);
  const project = await resolveProject(projectRoot);
  const file = path.join(temporary, `rollout-${ROOT}.jsonl`);
  await writeFile(file, session(ROOT, project.root));
  const candidate = { taskId: ROOT, file };
  const inodeResult = await readVerifiedHistory(candidate, project, createLoadBudget(), {
    afterOpenBeforeScan: async () => {
      const replacement = `${file}.replacement`;
      await writeFile(replacement, session(ROOT, project.root, null, "REPLACEMENT SENTINEL"));
      try {
        await rename(replacement, file);
      } catch (error) {
        if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
        await rm(replacement, { force: true });
      }
    },
  });
  assert.equal(inodeResult.history.records.some((item) => item.text.includes("REPLACEMENT SENTINEL")), false);

  await writeFile(file, session(ROOT, otherRoot));
  const cwdResult = await readVerifiedHistory(candidate, project, createLoadBudget(), {
  });
  assert.equal(cwdResult.rejected, "ACTIVITY_SESSION_CWD_MISMATCH");
});

test("loader reads zero-Signal and forced snapshot Cycles from the real attested ref chain", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-cycles-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  git(temporary, "init", "-q");
  git(temporary, "config", "user.name", "Test");
  git(temporary, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(temporary, "tracked.txt"), "baseline\n");
  git(temporary, "add", "tracked.txt"); git(temporary, "commit", "-qm", "baseline");
  const project = await resolveProject(temporary);
  await mkdir(project.directory, { recursive: true });
  await writeFile(project.stateFile, JSON.stringify(ledger(project)));
  const sessions = path.join(temporary, "sessions"); await mkdir(sessions);
  await writeFile(path.join(sessions, `rollout-${ROOT}.jsonl`), session(ROOT, project.root));
  await writeFile(path.join(sessions, `rollout-${PRIMARY}.jsonl`), session(PRIMARY, project.root, ROOT));
  await createReviewSnapshot({ primaryTaskId: PRIMARY, projectRoot: project.root });
  await createReviewSnapshot({ primaryTaskId: PRIMARY, projectRoot: project.root, forceNew: true });
  const activity = await loadActivity(project.root, { sessionRoots: [sessions] });
  assert.equal(activity.detail(PRIMARY).signals.length, 0);
  assert.equal(activity.detail(PRIMARY).cycles.length, 2);
  assert.deepEqual(activity.detail(PRIMARY).cycles.map((item) => item.sequence), [0, 1]);
});

test("authorized descendant omission makes the available Primary Activity globally partial", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-missing-authorized-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = await resolveProject(temporary);
  const currentLedger = ledger(project, {
    conversations: [
      conversation("primary", ROOT, "controller", PRIMARY, "primary"),
      conversation("review", PRIMARY, "primary", REVIEW_ONE, "review", "2026-08-01T00:01:00.000Z"),
    ],
    links: [link(ROOT, PRIMARY, "primary"), link(PRIMARY, REVIEW_ONE, "review")],
  });
  const activity = await loadActivity(project.root, {
    readLedger: async () => currentLedger,
    discoverSessionFiles: async () => ({ candidates: [{ taskId: PRIMARY, file: PRIMARY, size: 1 }], omissions: [], truncated: false }),
    readVerifiedHistory: async (candidate, _project, budget) => {
      chargeSession(budget, 1);
      return { taskId: candidate.taskId, history: history({ id: candidate.taskId, tokens: 10, compactions: 1 }), metadata: { parentTaskId: ROOT }, reservedBytes: 1 };
    },
    readAllSignals: async () => ({ signals: [], diagnostics: [] }),
    listReviewSnapshots: async () => ({ snapshots: [], diagnostics: [], partial: false }),
  });
  const detail = activity.detail(PRIMARY);
  assert.equal(activity.partial, true);
  assert.equal(detail.partial, true);
  assert.equal(detail.metrics.shownAgentCount, 2);
  for (const value of [detail.metrics.agentCount, detail.metrics.signalCount, detail.timeline.responseCount, detail.metrics.cumulativeTokens, detail.metrics.retainedContextTokens, detail.metrics.compactions]) {
    assert.equal(value, null);
  }
  assert.ok(detail.diagnostics.some((item) => item.code === "ACTIVITY_AUTHORIZED_SESSION_MISSING" && item.taskId === REVIEW_ONE));
});

test("authorized discovery omissions, ambiguity, cutoff, and lineage loss remain explicit", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-discovery-omissions-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = await resolveProject(temporary);
  const currentLedger = ledger(project, {
    conversations: [
      conversation("primary", ROOT, "controller", PRIMARY, "primary"),
      conversation("review", PRIMARY, "primary", REVIEW_ONE, "review", "2026-08-01T00:01:00.000Z"),
    ],
    links: [link(ROOT, PRIMARY, "primary"), link(PRIMARY, REVIEW_ONE, "review")],
  });
  const cases = [
    { name: "oversized", candidates: [], omissions: [{ taskId: REVIEW_ONE, code: "ACTIVITY_AUTHORIZED_SESSION_OVERSIZED", sourceBytes: 65 }], truncated: false, expected: "ACTIVITY_AUTHORIZED_SESSION_OVERSIZED" },
    { name: "ambiguous", candidates: [{ taskId: REVIEW_ONE, file: "p1", size: 1 }, { taskId: REVIEW_ONE, file: "p2", size: 1 }], omissions: [], truncated: false, expected: "ACTIVITY_SESSION_AMBIGUOUS" },
    { name: "cutoff", candidates: [], omissions: [], truncated: true, expected: "ACTIVITY_AUTHORIZED_SESSION_DISCOVERY_UNCERTAIN" },
    { name: "candidate-cutoff", candidates: [{ taskId: REVIEW_ONE, file: REVIEW_ONE, size: 1 }], omissions: [{ taskId: REVIEW_ONE, code: "ACTIVITY_SESSION_CANDIDATE_BOUNDED", sourceBytes: 1 }], truncated: true, expected: "ACTIVITY_SESSION_CANDIDATE_BOUNDED" },
    { name: "non-regular", candidates: [], omissions: [{ taskId: REVIEW_ONE, code: "ACTIVITY_AUTHORIZED_SESSION_NON_REGULAR", sourceBytes: 0 }], truncated: false, expected: "ACTIVITY_AUTHORIZED_SESSION_NON_REGULAR" },
    { name: "stat-failed", candidates: [], omissions: [{ taskId: REVIEW_ONE, code: "ACTIVITY_AUTHORIZED_SESSION_STAT_FAILED", sourceBytes: 0 }], truncated: false, expected: "ACTIVITY_AUTHORIZED_SESSION_STAT_FAILED" },
  ];
  for (const current of cases) {
    const activity = await loadActivity(project.root, {
      readLedger: async () => currentLedger,
      discoverSessionFiles: async () => ({ ...current,
        candidates: [{ taskId: PRIMARY, file: PRIMARY, size: 1 }, ...current.candidates] }),
      readVerifiedHistory: async (candidate, _project, budget) => {
        chargeSession(budget, 1);
        return { taskId: candidate.taskId, history: history({ id: candidate.taskId }),
          metadata: { parentTaskId: candidate.taskId === PRIMARY ? ROOT : PRIMARY }, reservedBytes: 1 };
      },
      readAllSignals: async () => ({ signals: [], diagnostics: [] }),
      listReviewSnapshots: async () => ({ snapshots: [], diagnostics: [], partial: false }),
    });
    assert.equal(activity.partial, true, current.name);
    assert.ok(activity.detail(PRIMARY).diagnostics.some((item) => item.code === current.expected), current.name);
  }

  const mismatchLedger = ledger(project, {
    conversations: [conversation("primary", ROOT, "controller", PRIMARY, "primary"), conversation("review", PRIMARY, "primary", REVIEW_ONE, "review")],
    links: [link(ROOT, PRIMARY, "primary"), link(ROOT, REVIEW_ONE, "review")],
  });
  const forest = buildActivityAssignmentForest(mismatchLedger);
  assert.equal(forest.partial, true);
  assert.deepEqual([...forest.excludedAuthorizedTaskIds], [REVIEW_ONE]);
});

test("session source is reserved before one bounded read and never refunded", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-reserve-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, "project");
  await mkdir(projectRoot);
  const project = await resolveProject(projectRoot);
  const file = path.join(temporary, `rollout-${ROOT}.jsonl`);
  const valid = `${`${JSON.stringify({ type: "ignored" })}\n`.repeat(100)}${session(ROOT, project.root)}`;
  await writeFile(file, valid);
  const bytes = Buffer.byteLength(valid);
  let scans = 0;
  const exactBudget = createLoadBudget({ maxAuthorizedTasks: 1, maxSessionSourceBytes: bytes });
  const exact = await readVerifiedHistory({ taskId: ROOT, file }, project, exactBudget, {
    scanActivityHistory: async (stream, options) => { scans += 1; const { scanActivityHistory } = await import("../source/activity-history.mjs"); return scanActivityHistory(stream, options); },
  });
  assert.equal(exact.history.metadata.taskId, ROOT);
  assert.equal(scans, 1);
  assert.equal(exactBudget.authorizedTasks, 1);
  assert.equal(exactBudget.sessionSourceBytes, bytes);
  assert.equal(exactBudget.partial, false);

  scans = 0;
  const overBudget = createLoadBudget({ maxAuthorizedTasks: 1, maxSessionSourceBytes: bytes - 1 });
  const over = await readVerifiedHistory({ taskId: ROOT, file }, project, overBudget, { scanActivityHistory: async () => { scans += 1; throw new Error("must not scan"); } });
  assert.equal(over.code, "ACTIVITY_SESSION_SOURCE_BOUNDED");
  assert.equal(scans, 0);
  assert.equal(overBudget.authorizedTasks, 0);
  assert.equal(overBudget.sessionSourceBytes, 0);
  assert.equal(overBudget.omittedTasks, 1);
  assert.equal(overBudget.omittedSourceBytes, bytes);

  const missingMetaFile = path.join(temporary, `missing-${ROOT}.jsonl`);
  await writeFile(missingMetaFile, `${JSON.stringify({ type: "ignored" })}\n`);
  const missingBytes = Buffer.byteLength(await import("node:fs/promises").then(({ readFile }) => readFile(missingMetaFile)));
  const noRefund = createLoadBudget({ maxAuthorizedTasks: 2, maxSessionSourceBytes: missingBytes });
  const missing = await readVerifiedHistory({ taskId: ROOT, file: missingMetaFile }, project, noRefund);
  assert.equal(missing.rejected, "ACTIVITY_SESSION_META_MISSING");
  assert.equal(noRefund.sessionSourceBytes, missingBytes);
  assert.equal(noRefund.rejectedTasks, 1);
  assert.equal(noRefund.rejectedSourceBytes, missingBytes);
  const refusedLater = await readVerifiedHistory({ taskId: ROOT, file }, project, noRefund);
  assert.equal(refusedLater.code, "ACTIVITY_SESSION_SOURCE_BOUNDED");
  assert.equal(noRefund.sessionSourceBytes, missingBytes);
});

test("reserved session rejects malformed ownership and bounded-file races without refund", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-reserved-errors-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, "project");
  const outside = path.join(temporary, "outside");
  await Promise.all([mkdir(projectRoot), mkdir(outside)]);
  const project = await resolveProject(projectRoot);
  const cases = [
    { name: "malformed", body: `${JSON.stringify({ type: "session_meta", payload: { id: ROOT, cwd: project.root } })}\n{broken}\n`, code: "ACTIVITY_JSONL_MALFORMED" },
    { name: "task", body: session(PRIMARY, project.root), code: "ACTIVITY_SESSION_TASK_MISMATCH" },
    { name: "cwd", body: session(ROOT, outside), code: "ACTIVITY_SESSION_CWD_MISMATCH" },
  ];
  for (const current of cases) {
    const file = path.join(temporary, `${current.name}-${ROOT}.jsonl`);
    await writeFile(file, current.body);
    const size = Buffer.byteLength(current.body);
    const budget = createLoadBudget({ maxAuthorizedTasks: 1, maxSessionSourceBytes: size });
    const result = await readVerifiedHistory({ taskId: ROOT, file }, project, budget);
    assert.equal(result.rejected, current.code, current.name);
    assert.equal(budget.authorizedTasks, 1, current.name);
    assert.equal(budget.sessionSourceBytes, size, current.name);
    assert.equal(budget.rejectedTasks, 1, current.name);
    assert.equal(budget.omittedTasks, 1, current.name);
  }

  const boundedFile = path.join(temporary, `bounded-${ROOT}.jsonl`);
  const original = session(ROOT, project.root, null, "ORIGINAL");
  await writeFile(boundedFile, original);
  const appendBudget = createLoadBudget();
  const appended = await readVerifiedHistory({ taskId: ROOT, file: boundedFile }, project, appendBudget, {
    afterOpenBeforeScan: async () => appendFile(boundedFile, `${JSON.stringify({ type: "event_msg", timestamp: AT, payload: { type: "agent_message", message: "APPENDED SENTINEL" } })}\n`),
  });
  assert.equal(appended.history.records.some((item) => item.text.includes("APPENDED SENTINEL")), false);
  assert.equal(appendBudget.sessionSourceBytes, Buffer.byteLength(original));

  await writeFile(boundedFile, original);
  const truncateBudget = createLoadBudget();
  const truncated = await readVerifiedHistory({ taskId: ROOT, file: boundedFile }, project, truncateBudget, {
    afterOpenBeforeScan: async () => truncate(boundedFile, 1),
  });
  assert.equal(truncated.rejected, "ACTIVITY_SESSION_META_MISSING");
  assert.equal(truncateBudget.rejectedTasks, 1);
  assert.equal(truncateBudget.sessionSourceBytes, Buffer.byteLength(original));
});

test("authorized Signal omissions are exact, partial, and suppress complete metrics", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-signal-omissions-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = await resolveProject(temporary);
  const snapshot = "f".repeat(40);
  const prefix = "---\ntemplate: review-signal\nseverity: required\nsummary: Exact finding\n---\n\n## Explanation\n\n";
  const suffix = "\n\n## Implementation Approach\n";
  const exactRaw = prefix + "x".repeat((256 * 1024) - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
  const budget = createLoadBudget({ maxSignalJsonBytes: 2 * 1024 * 1024 });
  const result = await readAllSignals(project, new Set([PRIMARY]), budget, {
    signalReader: async () => ({
      entries: [{ primaryTaskId: PRIMARY, snapshot, name: "exact.md", raw: exactRaw, timestamp: AT, sourceBytes: Buffer.byteLength(exactRaw) }],
      omissions: ["ACTIVITY_SIGNAL_OVERSIZED", "ACTIVITY_SIGNAL_UNREADABLE", "ACTIVITY_SIGNAL_CHANGED", "ACTIVITY_SIGNAL_NON_REGULAR", "ACTIVITY_SIGNAL_DISCOVERY_BOUNDED"]
        .map((code) => ({ code, primaryTaskId: PRIMARY })),
    }),
  });
  assert.deepEqual(result.signals.map((item) => item.name), ["exact"]);
  assert.equal(result.signals[0].raw.length, 256 * 1024);
  assert.equal(budget.partial, true);
  assert.equal(budget.omittedSignals, 5);
  for (const code of ["ACTIVITY_SIGNAL_OVERSIZED", "ACTIVITY_SIGNAL_UNREADABLE", "ACTIVITY_SIGNAL_CHANGED", "ACTIVITY_SIGNAL_NON_REGULAR", "ACTIVITY_SIGNAL_DISCOVERY_BOUNDED"]) {
    assert.ok(result.diagnostics.some((item) => item.code === code), code);
  }
  const currentLedger = ledger();
  const forest = buildActivityAssignmentForest(currentLedger);
  const detail = buildActivityModel({
    project: { key: "key", root: "/project" },
    histories: new Map([[ROOT, history({ id: ROOT })], [PRIMARY, history({ id: PRIMARY })]]),
    ledger: currentLedger,
    forest,
    signals: result.signals,
    snapshotChains: new Map(),
    diagnostics: result.diagnostics,
    partial: budget.partial,
  }).detail(PRIMARY);
  assert.equal(detail.metrics.shownSignalCount, 1);
  assert.equal(detail.metrics.signalCount, null);
  assert.equal(detail.metrics.signalRatePerHour, null);
  assert.equal(detail.metrics.agentCount, null);
});

test("healthy raw Signal survives beside an unsafe authorized container with global null totals", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-mixed-signals-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = await resolveProject(temporary);
  const primaryTwo = "77777777-7777-4777-8777-777777777777";
  const snapshot = "e".repeat(40);
  const healthy = path.join(project.directory, "signals", PRIMARY, snapshot);
  const external = path.join(temporary, "external-primary", snapshot);
  await Promise.all([mkdir(healthy, { recursive: true }), mkdir(external, { recursive: true })]);
  await writeFile(path.join(healthy, "healthy.md"), "---\ntemplate: review-signal\nseverity: required\nsummary: Healthy finding\n---\n\n## Explanation\n\nHEALTHY RAW SIGNAL\n\n## Implementation Approach\n");
  await writeFile(path.join(external, "outside.md"), "OUTSIDE RAW SIGNAL SENTINEL");
  await symlink(
    path.dirname(external),
    path.join(project.directory, "signals", primaryTwo),
    process.platform === "win32" ? "junction" : "dir",
  );
  const currentLedger = ledger(project, {
    conversations: [
      conversation("p1", ROOT, "controller", PRIMARY, "primary"),
      conversation("p2", ROOT, "controller", primaryTwo, "primary", "2026-08-01T00:01:00.000Z"),
    ],
    links: [link(ROOT, PRIMARY, "primary"), link(ROOT, primaryTwo, "primary")],
  });
  const ids = [ROOT, PRIMARY, primaryTwo];
  const activity = await loadActivity(project.root, {
    readLedger: async () => currentLedger,
    discoverSessionFiles: async () => ({ candidates: ids.map((taskId) => ({ taskId, file: taskId, size: 1 })), omissions: [], truncated: false }),
    readVerifiedHistory: async (candidate, _project, budget) => {
      chargeSession(budget, 1);
      return { taskId: candidate.taskId, history: history({ id: candidate.taskId }), metadata: { parentTaskId: candidate.taskId === ROOT ? null : ROOT }, reservedBytes: 1 };
    },
    listReviewSnapshots: async () => ({ snapshots: [], diagnostics: [], partial: false }),
  });
  const detail = activity.detail(PRIMARY);
  assert.equal(detail.signals.length, 1);
  assert.equal(detail.signals[0].raw.includes("HEALTHY RAW SIGNAL"), true);
  assert.equal(JSON.stringify(detail).includes("OUTSIDE RAW SIGNAL SENTINEL"), false);
  assert.equal(detail.partial, true);
  assert.equal(detail.metrics.shownSignalCount, 1);
  assert.equal(detail.metrics.signalCount, null);
  assert.equal(detail.metrics.agentCount, null);
  assert.ok(detail.diagnostics.some((item) => item.code === "ACTIVITY_SIGNAL_DIRECTORY_UNSAFE"));
});

test("unavailable Signal reader fails closed and suppresses global complete metrics", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-reader-unavailable-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = await resolveProject(temporary);
  const ids = [ROOT, PRIMARY];
  const activity = await loadActivity(project.root, {
    readLedger: async () => ledger(project),
    discoverSessionFiles: async () => ({ candidates: ids.map((taskId) => ({ taskId, file: taskId, size: 1 })), omissions: [], truncated: false }),
    readVerifiedHistory: async (candidate, _project, budget) => {
      chargeSession(budget, 1);
      return { taskId: candidate.taskId, history: history({ id: candidate.taskId }), metadata: { parentTaskId: candidate.taskId === PRIMARY ? ROOT : null }, reservedBytes: 1 };
    },
    signalReader: async () => ({
      entries: [],
      omissions: [{ code: "ACTIVITY_SIGNAL_READER_UNAVAILABLE", primaryTaskId: null }],
      diagnostics: [],
      partial: true,
    }),
    listReviewSnapshots: async () => ({ snapshots: [], diagnostics: [], partial: false }),
  });
  const detail = activity.detail(PRIMARY);
  assert.equal(detail.signals.length, 0);
  assert.equal(detail.partial, true);
  assert.equal(detail.metrics.shownSignalCount, 0);
  assert.equal(detail.metrics.signalCount, null);
  assert.equal(detail.metrics.agentCount, null);
  assert.ok(detail.diagnostics.some((item) => item.code === "ACTIVITY_SIGNAL_READER_UNAVAILABLE"));
});

test("post-discovery session failures and sourced lineage mismatch are counted once", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-post-discovery-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, "project");
  await mkdir(projectRoot);
  const project = await resolveProject(projectRoot);
  const missing = path.join(temporary, `missing-${ROOT}.jsonl`);
  const missingBudget = createLoadBudget();
  const missingResult = await readVerifiedHistory({ taskId: ROOT, file: missing }, project, missingBudget);
  assert.equal(missingResult.code, "ACTIVITY_AUTHORIZED_SESSION_MISSING");
  assert.equal(missingBudget.authorizedTasks, 0);

  const sessions = path.join(temporary, "sessions");
  await mkdir(sessions);
  await writeFile(path.join(sessions, `rollout-${ROOT}.jsonl`), session(ROOT, project.root));
  const primaryRaw = session(PRIMARY, project.root, "wrong-source", "PRIVATE SENTINEL");
  await writeFile(path.join(sessions, `rollout-${PRIMARY}.jsonl`), primaryRaw);
  const activity = await loadActivity(project.root, {
    readLedger: async () => ledger(project),
    sessionRoots: [sessions],
    readAllSignals: async () => ({ signals: [], diagnostics: [] }),
    listReviewSnapshots: async () => ({ snapshots: [], diagnostics: [], partial: false }),
  });
  assert.equal(activity.partial, true);
  assert.deepEqual(activity.activities, []);
  assert.equal(activity.detail(PRIMARY), null);
  assert.equal(JSON.stringify(activity).includes("PRIVATE SENTINEL"), false);
});

test("ancestor omission prevents descendant reads and one damaged Primary makes healthy Activities partial", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-global-partial-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = await resolveProject(temporary);
  const rootB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const primaryB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const currentLedger = ledger(project, {
    conversations: [
      conversation("a-primary", ROOT, "controller", PRIMARY, "primary", "2026-08-01T00:00:00.000Z"),
      conversation("a-review", PRIMARY, "primary", REVIEW_ONE, "review", "2026-08-01T00:01:00.000Z"),
      conversation("b-primary", rootB, "controller", primaryB, "primary", "2026-08-02T00:00:00.000Z"),
    ],
    links: [link(ROOT, PRIMARY, "primary"), link(PRIMARY, REVIEW_ONE, "review"), link(rootB, primaryB, "primary")],
  });
  const available = [ROOT, REVIEW_ONE, rootB, primaryB];
  const reads = [];
  const activity = await loadActivity(project.root, {
    readLedger: async () => currentLedger,
    discoverSessionFiles: async () => ({ candidates: available.map((taskId) => ({ taskId, file: taskId, size: 1 })), omissions: [], truncated: false }),
    readVerifiedHistory: async (candidate, _project, budget) => {
      reads.push(candidate.taskId);
      chargeSession(budget, 1);
      return { taskId: candidate.taskId, history: history({ id: candidate.taskId, records: [{ kind: "input", text: `RAW ${candidate.taskId}`, timestamp: AT, sequence: 1 }] }), metadata: { parentTaskId: currentLedger.links.find((item) => item.childTaskId === candidate.taskId)?.sourceTaskId ?? null }, reservedBytes: 1 };
    },
    readAllSignals: async () => ({ signals: [], diagnostics: [] }),
    listReviewSnapshots: async () => ({ snapshots: [], diagnostics: [], partial: false }),
  });
  assert.equal(reads.includes(REVIEW_ONE), false);
  assert.deepEqual(activity.activities.map((item) => item.id), [primaryB]);
  assert.equal(activity.partial, true);
  assert.equal(activity.detail(PRIMARY), null);
  assert.equal(activity.detail(primaryB).metrics.agentCount, null);
  assert.ok(JSON.stringify(activity.detail(primaryB)).includes(`RAW ${primaryB}`));
});

test("loaded parser partial propagates global partial while exact complete control remains complete", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-parser-partial-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = await resolveProject(temporary);
  const run = async (partial) => loadActivity(project.root, {
    readLedger: async () => ledger(project),
    discoverSessionFiles: async () => ({ candidates: [ROOT, PRIMARY].map((taskId) => ({ taskId, file: taskId, size: 1 })), omissions: [], truncated: false }),
    readVerifiedHistory: async (candidate, _project, budget) => {
      chargeSession(budget, 1);
      return { taskId: candidate.taskId, history: history({ id: candidate.taskId, partial: partial && candidate.taskId === PRIMARY }), metadata: { parentTaskId: candidate.taskId === PRIMARY ? ROOT : null }, reservedBytes: 1 };
    },
    readAllSignals: async () => ({ signals: [], diagnostics: [] }),
    listReviewSnapshots: async () => ({ snapshots: [], diagnostics: [], partial: false }),
  });
  const partialActivity = await run(true);
  assert.equal(partialActivity.partial, true);
  assert.equal(partialActivity.detail(PRIMARY).metrics.agentCount, null);
  const completeActivity = await run(false);
  assert.equal(completeActivity.partial, false);
  assert.equal(completeActivity.detail(PRIMARY).metrics.agentCount, 1);
  assert.equal(completeActivity.detail(PRIMARY).metrics.signalCount, 0);
});
