import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyArchiveTerminations,
  applyPendingLaunchReconciliation,
  buildHeartbeatReport,
  buildHeartbeatObservationRequests,
  leaseHeartbeatAppMessages,
  observeHeartbeatTasks,
  planArchiveTerminations,
  planPendingLaunchReconciliation,
  reconcileArchiveTerminations,
  reconcilePendingLaunches,
  reconcileAppMessageSchedules,
  runDeferredForks,
  runHeartbeatRecovery,
  runHeartbeat,
  runLifecycleDeliveries,
} from "../source/heartbeat.mjs";
import { AtomicJsonStore } from "../source/atomic-json-store.mjs";
import { buildTaskForest } from "../source/task-forest.mjs";
import {
  acknowledgeScheduledAppMessage,
  enqueueAppMessage,
  initializeTaskLedger,
  leaseAppMessages,
  markAppMessageScheduled,
  readTaskLedger,
  transactTaskLedger,
  validateTaskLedger,
} from "../source/task-ledger.mjs";
import { runHeartbeatCli } from "../internal/heartbeat.mjs";

function pendingLaunch(
  id,
  phase,
  overrides = {},
) {
  const hasChild = phase === "child_created"
    || phase === "role_started"
    || phase === "assignment_starting"
    || phase === "assignment_started"
    || phase === "fork_child_created"
    || phase === "fork_role_started"
    || phase === "fork_assignment_starting"
    || phase === "fork_assignment_started";
  return {
    assignment: `Assignment for ${id}`,
    id,
    model: null,
    name: `Agent ${id}`,
    parentTaskId: `parent-${id}`,
    reasoningEffort: null,
    role: "primary",
    serviceTier: null,
    childTaskId: hasChild ? `child-${id}` : null,
    phase,
    assignmentTurnId: phase === "assignment_started"
      || phase === "fork_assignment_started"
      ? `assignment-${id}`
      : null,
    roleTurnId: phase === "role_started"
      || phase === "assignment_starting"
      || phase === "assignment_started"
      || phase === "fork_role_started"
      || phase === "fork_assignment_starting"
      || phase === "fork_assignment_started"
      ? `role-${id}`
      : null,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:01:00.000Z",
    lastError: null,
    ...overrides,
  };
}

function exactSnapshot(
  launch,
  turnState,
  location = "active",
) {
  const rolePhase = launch.phase === "role_started"
    || launch.phase === "fork_role_started";
  return {
    taskId: launch.childTaskId,
    location,
    historyFile: location === "missing"
      ? null
      : `/history/${launch.childTaskId}.jsonl`,
    turnId: rolePhase ? launch.roleTurnId : launch.assignmentTurnId,
    turnState,
    diagnostics: [],
  };
}

test("classifies every durable pending-launch phase deterministically", () => {
  const prepared = pendingLaunch("prepared", "prepared");
  const creating = pendingLaunch("creating", "creating");
  const childCreated = pendingLaunch("child", "child_created");
  const assignmentStarting = pendingLaunch(
    "assignment-starting",
    "assignment_starting",
  );
  const ended = pendingLaunch("ended", "assignment_started");
  const running = pendingLaunch("running", "assignment_started");

  const plan = planPendingLaunchReconciliation([
    running,
    childCreated,
    assignmentStarting,
    ended,
    creating,
    prepared,
  ], [
    exactSnapshot(running, "in_progress"),
    exactSnapshot(ended, "ended"),
  ]);

  assert.deepEqual(plan, {
    deferredForks: [],
    roleContinuations: [],
    waitingForkLaunchIds: [],
    promotions: [
      {
        launchId: "ended",
        childTaskId: "child-ended",
        assignmentTurnId: "assignment-ended",
        historyFile: "/history/child-ended.jsonl",
      },
      {
        launchId: "running",
        childTaskId: "child-running",
        assignmentTurnId: "assignment-running",
        historyFile: "/history/child-running.jsonl",
      },
    ],
    runningLaunchIds: [],
    repairRequired: [
      {
        launchId: "assignment-starting",
        reason: "assignment_start_ambiguous",
      },
      {
        launchId: "child",
        reason: "assignment_turn_unrecorded",
      },
      {
        launchId: "creating",
        reason: "child_creation_ambiguous",
      },
      {
        launchId: "prepared",
        reason: "launch_not_started",
      },
    ],
    degraded: [],
  });
});

test("fails closed when a migrated pending launch has no assignment", () => {
  const legacy = pendingLaunch("legacy", "fork_queued", {
    assignment: null,
  });

  const plan = planPendingLaunchReconciliation([legacy], []);

  assert.deepEqual(plan.repairRequired, [{
    launchId: "legacy",
    reason: "assignment_missing",
  }]);
  assert.deepEqual(plan.deferredForks, []);
});

test("waits for a queued fork until its Parent turn completes", () => {
  const queued = pendingLaunch("fork", "fork_queued");
  const active = {
    taskId: queued.parentTaskId,
    location: "active",
    historyFile: "/history/parent-fork.jsonl",
    turnId: "parent-turn",
    turnState: "in_progress",
    diagnostics: [],
  };
  const complete = { ...active, turnState: "ended" };

  assert.deepEqual(
    planPendingLaunchReconciliation([queued], [active]),
    {
      deferredForks: [],
      roleContinuations: [],
      waitingForkLaunchIds: ["fork"],
      promotions: [],
      runningLaunchIds: [],
      repairRequired: [],
      degraded: [],
    },
  );
  assert.deepEqual(
    planPendingLaunchReconciliation([queued], [complete]).deferredForks,
    [{ launchId: "fork" }],
  );
});

test("waits for both the managing Parent and distinct fork source", () => {
  const queued = pendingLaunch("fork", "fork_queued", {
    sourceTaskId: "execute-1",
  });
  const parent = {
    taskId: queued.parentTaskId,
    location: "active",
    historyFile: "/history/parent-fork.jsonl",
    turnId: "parent-turn",
    turnState: "ended",
    diagnostics: [],
  };
  const source = {
    taskId: queued.sourceTaskId,
    location: "active",
    historyFile: "/history/execute-1.jsonl",
    turnId: "execute-turn",
    turnState: "in_progress",
    diagnostics: [],
  };

  assert.deepEqual(
    planPendingLaunchReconciliation([queued], [parent, source]),
    {
      deferredForks: [],
      roleContinuations: [],
      waitingForkLaunchIds: ["fork"],
      promotions: [],
      runningLaunchIds: [],
      repairRequired: [],
      degraded: [],
    },
  );
  assert.deepEqual(
    planPendingLaunchReconciliation(
      [queued],
      [parent, { ...source, turnState: "ended" }],
    ).deferredForks,
    [{ launchId: "fork" }],
  );
});

test("continues only a completed Role Turn and leaves an active one running", () => {
  const ended = pendingLaunch("role-ended", "role_started");
  const running = pendingLaunch("role-running", "fork_role_started");

  const plan = planPendingLaunchReconciliation([
    running,
    ended,
  ], [
    exactSnapshot(running, "in_progress"),
    exactSnapshot(ended, "ended"),
  ]);

  assert.deepEqual(plan.roleContinuations, [{
    launchId: "role-ended",
  }]);
  assert.deepEqual(plan.runningLaunchIds, ["role-running"]);
  assert.deepEqual(plan.promotions, []);
  assert.deepEqual(plan.repairRequired, []);
});

test("observes the Parent of a queued fork without requiring a managed link", () => {
  assert.deepEqual(
    buildHeartbeatObservationRequests({
      links: [],
      conversations: [],
      pendingLaunches: [pendingLaunch("fork", "fork_queued")],
    }),
    [{
      taskId: "parent-fork",
      mode: "latest",
    }],
  );
});

test("observes a distinct fork source alongside the managing Parent", () => {
  assert.deepEqual(
    buildHeartbeatObservationRequests({
      links: [],
      conversations: [],
      pendingLaunches: [
        pendingLaunch("fork", "fork_queued", {
          sourceTaskId: "execute-1",
        }),
      ],
    }),
    [
      {
        taskId: "execute-1",
        mode: "latest",
      },
      {
        taskId: "parent-fork",
        mode: "latest",
      },
    ],
  );
});

test("runs only the deferred forks selected from accepted Parent turns", async () => {
  const calls = [];
  const finalState = ledgerState([]);
  const result = await runDeferredForks({
    project: { root: "/project", key: "project-key" },
    store: "store",
  }, {
    deferredForks: [
      { launchId: "launch-b" },
      { launchId: "launch-a" },
    ],
  }, {
    state: ledgerState([]),
    async continueDeferredFork(input) {
      calls.push(input);
    },
    async readTaskLedger(store, project) {
      assert.equal(store, "store");
      assert.equal(project.root, "/project");
      return finalState;
    },
  });

  assert.deepEqual(calls, [
    { projectRoot: "/project", launchId: "launch-a" },
    { projectRoot: "/project", launchId: "launch-b" },
  ]);
  assert.deepEqual(result, {
    state: finalState,
    completedLaunchIds: ["launch-a", "launch-b"],
    failed: [],
  });
});

test("starts independent deferred forks concurrently while Role Turns run", {
  timeout: 1_000,
}, async () => {
  const calls = [];
  let release;
  const bothStarted = new Promise((resolve) => {
    release = resolve;
  });

  await runDeferredForks({
    project: { root: "/project", key: "project-key" },
    store: "store",
  }, {
    deferredForks: [
      { launchId: "launch-a" },
      { launchId: "launch-b" },
    ],
  }, {
    state: ledgerState([]),
    async continueDeferredFork({ launchId }) {
      calls.push(launchId);
      if (calls.length === 2) release();
      await bothStarted;
    },
    async readTaskLedger() {
      return ledgerState([]);
    },
  });

  assert.deepEqual(calls.sort(), ["launch-a", "launch-b"]);
});

test("observes only unfinished relationships instead of historical tasks", () => {
  const open = {
    parentTaskId: "root",
    childTaskId: "open-child",
    role: "primary",
    lifecycle: "open",
  };
  const stopped = {
    parentTaskId: "root",
    childTaskId: "stopped-child",
    role: "primary",
    lifecycle: "stopped",
  };
  const accepted = {
    parentTaskId: "root",
    childTaskId: "accepted-child",
    role: "primary",
    lifecycle: "accepted",
  };

  assert.deepEqual(buildHeartbeatObservationRequests({
    links: [accepted, stopped, open],
    conversations: [],
    pendingLaunches: [],
  }), [
    { taskId: "open-child", mode: "latest" },
    { taskId: "root", mode: "latest" },
    { taskId: "stopped-child", mode: "latest" },
  ]);
});

test("promotes an accepted aborted assignment and separates unavailable evidence", () => {
  const aborted = pendingLaunch("aborted", "assignment_started");
  const archived = pendingLaunch("archived", "assignment_started");
  const missing = pendingLaunch("missing", "assignment_started");
  const notStarted = pendingLaunch("not-started", "assignment_started");
  const unknown = pendingLaunch("unknown", "assignment_started");

  const plan = planPendingLaunchReconciliation([
    unknown,
    missing,
    archived,
    aborted,
    notStarted,
  ], [
    exactSnapshot(aborted, "aborted"),
    exactSnapshot(archived, "ended", "archived"),
    exactSnapshot(missing, "unknown", "missing"),
    exactSnapshot(notStarted, "not_started"),
    exactSnapshot(unknown, "unknown"),
  ]);

  assert.deepEqual(plan.promotions, [{
    launchId: "aborted",
    childTaskId: "child-aborted",
    assignmentTurnId: "assignment-aborted",
    historyFile: "/history/child-aborted.jsonl",
  }]);
  assert.deepEqual(plan.runningLaunchIds, []);
  assert.deepEqual(plan.repairRequired, [
    {
      launchId: "archived",
      reason: "child_archived",
    },
  ]);
  assert.deepEqual(plan.degraded, [
    {
      launchId: "missing",
      reason: "observation_missing",
    },
    {
      launchId: "not-started",
      reason: "assignment_not_started",
    },
    {
      launchId: "unknown",
      reason: "observation_unknown",
    },
  ]);
});

test("requires the exact stored child and assignment turn boundary", () => {
  const absent = pendingLaunch("absent", "assignment_started");
  const wrongTask = pendingLaunch("wrong-task", "assignment_started");
  const wrongTurn = pendingLaunch("wrong-turn", "assignment_started");

  const plan = planPendingLaunchReconciliation([
    absent,
    wrongTask,
    wrongTurn,
  ], [
    {
      ...exactSnapshot(wrongTask, "ended"),
      taskId: "another-child",
    },
    {
      ...exactSnapshot(wrongTurn, "ended"),
      turnId: "another-turn",
    },
  ]);

  assert.deepEqual(plan.promotions, []);
  assert.deepEqual(plan.degraded, [
    {
      launchId: "absent",
      reason: "observation_missing",
    },
    {
      launchId: "wrong-task",
      reason: "observation_missing",
    },
    {
      launchId: "wrong-turn",
      reason: "turn_boundary_changed",
    },
  ]);
});

test("does not mutate pending launches or exact observations", () => {
  const launch = pendingLaunch("ended", "assignment_started");
  const launches = [launch];
  const snapshots = [exactSnapshot(launch, "ended")];
  const originalLaunches = structuredClone(launches);
  const originalSnapshots = structuredClone(snapshots);

  planPendingLaunchReconciliation(launches, snapshots);

  assert.deepEqual(launches, originalLaunches);
  assert.deepEqual(snapshots, originalSnapshots);
});

function readyLink(parentTaskId, childTaskId, lifecycle = "open") {
  return {
    parentTaskId,
    childTaskId,
    role: "primary",
    lifecycle,
    acceptanceReason: null,
    historyFile: null,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    acceptedAt: null,
  };
}

function awaitingConversation(initiatorTaskId, responderTaskId) {
  return {
    id: `conversation:${initiatorTaskId}:${responderTaskId}`,
    initiatorTaskId,
    initiatorRole: "primary",
    responderTaskId,
    responderRole: "primary",
    state: "awaiting_reply",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    repliedAt: null,
    acceptedAt: null,
  };
}

function ledgerState(
  pendingLaunches,
  links = [],
  deliveries = [],
  conversations = null,
) {
  return validateTaskLedger({
    version: 10,
    revision: 0,
    projectRoot: "/project",
    projectKey: "project-key",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    managedTasks: [],
    pendingLaunches,
    links,
    conversations: conversations ?? links
      .filter(({ lifecycle }) => lifecycle !== "accepted")
      .map((currentLink) => awaitingConversation(
        currentLink.parentTaskId,
        currentLink.childTaskId,
      )),
    deliveries,
    appMessages: [],
  }, {
    root: "/project",
    key: "project-key",
    stateFile: "/project/.codex-small-loop/state.json",
  });
}

function mutableTransactions(initialState) {
  let currentState = initialState;

  return {
    async transact(store, project, transform) {
      const outcome = transform(currentState);
      currentState = outcome.state;
      return outcome;
    },
    state() {
      return currentState;
    },
    replaceState(nextState) {
      currentState = nextState;
    },
  };
}

test("leases a bounded App batch for local mechanical delivery", async () => {
  let current = ledgerState([], [], []);
  current = enqueueAppMessage(current, {
    id: "message-1",
    targetTaskId: "app-task",
    text: "Exact envelope",
  }, { now: "2026-07-25T00:02:00.000Z" }).state;
  const transactions = mutableTransactions(current);
  const result = await leaseHeartbeatAppMessages({
    store: {},
    project: {
      root: "/project",
      key: "project-key",
    },
  }, {
    now: "2026-07-25T00:03:00.000Z",
    leaseOwner: "runtime-turn",
    limit: 1,
    transactTaskLedger: transactions.transact,
  });

  assert.equal(result.messages[0].text, "Exact envelope");
  assert.equal(result.messages[0].targetTaskId, "app-task");
  assert.deepEqual(Object.keys(result.messages[0]).sort(), [
    "id",
    "targetTaskId",
    "text",
  ]);
  assert.equal(result.state.appMessages[0].status, "leased");
});

test("materializes and reconciles an App message schedule", async () => {
  let current = enqueueAppMessage(ledgerState([]), {
    id: "message-1",
    sourceTaskId: "child",
    targetTaskId: "app-parent",
    text: "done",
  }, { now: "2026-07-25T01:00:00.000Z" }).state;
  const transaction = async (
    _store,
    _project,
    transform,
  ) => {
    const transformed = transform(current);
    current = transformed.state;
    return { state: current, result: transformed.result };
  };
  const created = [];
  let schedulePresent = false;
  const options = {
    now: "2026-07-25T01:01:00.000Z",
    leaseOwner: "supervisor",
    automationRoot: "/codex/automations",
    transactTaskLedger: transaction,
    async createAppMessageSchedule(input) {
      created.push(input);
      schedulePresent = true;
      return {
        automationId: "codex-small-loop-message-id",
        file: "/codex/automations/message/automation.toml",
        created: true,
      };
    },
    async inspectAppMessageSchedule({ messageId, automationRoot }) {
      assert.equal(messageId, "message-1");
      assert.equal(automationRoot, "/codex/automations");
      return {
        automationId: "codex-small-loop-message-id",
        file: "/codex/automations/message/automation.toml",
        present: schedulePresent,
      };
    },
  };

  const scheduled = await reconcileAppMessageSchedules({
    store: {},
    project: { root: "/project" },
  }, options);

  assert.deepEqual(scheduled.deliveredMessageIds, []);
  assert.deepEqual(scheduled.pendingMessageIds, ["message-1"]);
  assert.equal(scheduled.state.appMessages[0].status, "scheduled");
  assert.deepEqual(created, [{
    messageId: "message-1",
    targetTaskId: "app-parent",
    text: "done",
    nowMs: Date.parse(options.now),
    automationRoot: "/codex/automations",
  }]);

  const waiting = await reconcileAppMessageSchedules({
    store: {},
    project: { root: "/project" },
  }, options);
  assert.deepEqual(waiting.deliveredMessageIds, []);
  assert.deepEqual(waiting.pendingMessageIds, ["message-1"]);
  assert.equal(created.length, 1);

  schedulePresent = false;
  const delivered = await reconcileAppMessageSchedules({
    store: {},
    project: { root: "/project" },
  }, options);
  assert.deepEqual(delivered.deliveredMessageIds, ["message-1"]);
  assert.deepEqual(delivered.pendingMessageIds, []);
  assert.equal(delivered.state.appMessages[0].status, "delivered");
});

test("releases an App message when schedule creation fails", async () => {
  let current = enqueueAppMessage(ledgerState([]), {
    id: "message-1",
    targetTaskId: "app-parent",
    text: "retry me",
  }, { now: "2026-07-25T01:00:00.000Z" }).state;
  const transaction = async (
    _store,
    _project,
    transform,
  ) => {
    const transformed = transform(current);
    current = transformed.state;
    return { state: current, result: transformed.result };
  };

  const result = await reconcileAppMessageSchedules({
    store: {},
    project: { root: "/project" },
  }, {
    now: "2026-07-25T01:01:00.000Z",
    leaseOwner: "supervisor",
    automationRoot: "/codex/automations",
    transactTaskLedger: transaction,
    async createAppMessageSchedule() {
      throw new Error("schedule unavailable");
    },
    async inspectAppMessageSchedule() {
      throw new Error("no scheduled messages expected");
    },
  });

  assert.deepEqual(result.deliveredMessageIds, []);
  assert.deepEqual(result.failedMessageIds, ["message-1"]);
  assert.deepEqual(result.pendingMessageIds, ["message-1"]);
  assert.equal(result.state.appMessages[0].status, "ready");
  assert.equal(
    result.state.appMessages[0].lastError.message,
    "schedule unavailable",
  );
});

test("accepts a concurrent schedule acknowledgement as an idempotent result", async () => {
  let current = enqueueAppMessage(ledgerState([]), {
    id: "message-1",
    targetTaskId: "app-parent",
    text: "already received",
  }, { now: "2026-07-25T01:00:00.000Z" }).state;
  current = leaseAppMessages(current, {
    now: "2026-07-25T01:01:00.000Z",
    leaseExpiresAt: "2026-07-25T01:06:00.000Z",
    leaseOwner: "earlier-worker",
  }).state;
  current = markAppMessageScheduled(
    current,
    "message-1",
    "earlier-worker",
    "2026-07-25T01:01:01.000Z",
  );
  let transactionCount = 0;
  const transaction = async (
    _store,
    _project,
    transform,
  ) => {
    transactionCount += 1;
    if (transactionCount === 2) {
      current = acknowledgeScheduledAppMessage(
        current,
        "message-1",
        "2026-07-25T01:01:30.000Z",
      );
    }
    const transformed = transform(current);
    current = transformed.state;
    return { state: current, result: transformed.result };
  };

  const result = await reconcileAppMessageSchedules({
    store: {},
    project: { root: "/project" },
  }, {
    now: "2026-07-25T01:02:00.000Z",
    leaseOwner: "supervisor",
    automationRoot: "/codex/automations",
    transactTaskLedger: transaction,
    async inspectAppMessageSchedule() {
      return {
        automationId: "codex-small-loop-message-id",
        file: "/codex/automations/message/automation.toml",
        present: false,
      };
    },
    async createAppMessageSchedule() {
      throw new Error("no ready messages expected");
    },
  });

  assert.deepEqual(result.deliveredMessageIds, ["message-1"]);
  assert.deepEqual(result.pendingMessageIds, []);
  assert.equal(result.state.appMessages[0].status, "delivered");
});

function interruptDelivery(taskId, parentTaskId = "root") {
  return {
    id: `interrupt-${taskId}`,
    kind: "interrupt",
    conversationId: null,
    targetTaskId: taskId,
    parentTaskId,
    dedupeKey: `interrupt:operation:${taskId}`,
    operationId: "operation",
    observedTurnId: null,
    resultTurnId: null,
    status: "ready",
    attemptCount: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: "2026-07-25T01:00:00.000Z",
    updatedAt: "2026-07-25T01:00:00.000Z",
    deliveredAt: null,
    lastError: null,
  };
}

function resumeDelivery(taskId, parentTaskId = "root") {
  return {
    ...interruptDelivery(taskId, parentTaskId),
    id: `resume-${taskId}`,
    kind: "resume",
    conversationId: `conversation:${parentTaskId}:${taskId}`,
    dedupeKey: `resume:operation:${taskId}`,
  };
}

test("promotes valid siblings while retaining independently stale launches", () => {
  const accepted = pendingLaunch("accepted", "assignment_started");
  const stopped = pendingLaunch("stopped", "assignment_started");
  const changed = pendingLaunch("changed", "assignment_started");
  const state = ledgerState(
    [accepted, stopped, {
      ...changed,
      assignmentTurnId: "newer-assignment",
    }],
    [readyLink("root", stopped.parentTaskId, "stopped")],
  );
  const plan = planPendingLaunchReconciliation(
    [accepted, stopped, changed],
    [
      exactSnapshot(accepted, "ended"),
      exactSnapshot(stopped, "ended"),
      exactSnapshot(changed, "ended"),
    ],
  );

  const result = applyPendingLaunchReconciliation(state, plan, {
    now: "2026-07-25T02:00:00.000Z",
  });

  assert.deepEqual(result.result.promotedLaunchIds, ["accepted"]);
  assert.deepEqual(result.result.discarded, [
    {
      launchId: "changed",
      reason: "launch_changed",
    },
    {
      launchId: "stopped",
      reason: "parent_not_open",
    },
  ]);
  assert.deepEqual(
    result.state.pendingLaunches.map(({ id }) => id),
    ["stopped", "changed"],
  );
  assert.deepEqual(
    result.state.links.map(
      ({ parentTaskId, childTaskId, lifecycle }) => ({
        parentTaskId,
        childTaskId,
        lifecycle,
      }),
    ),
    [
      {
        parentTaskId: "root",
        childTaskId: "parent-stopped",
        lifecycle: "stopped",
      },
      {
        parentTaskId: "parent-accepted",
        childTaskId: "child-accepted",
        lifecycle: "open",
      },
    ],
  );
});

test("commits all pending-launch promotions through one ledger transaction", async () => {
  const launch = pendingLaunch("accepted", "assignment_started");
  const initialState = ledgerState([launch]);
  const plan = planPendingLaunchReconciliation(
    [launch],
    [exactSnapshot(launch, "ended")],
  );
  const calls = [];

  const result = await reconcilePendingLaunches({
    store: "store",
    project: "project",
  }, plan, {
    now: "2026-07-25T02:00:00.000Z",
    async transactTaskLedger(
      store,
      project,
      transform,
    ) {
      calls.push([store, project]);
      return transform(initialState);
    },
  });

  assert.deepEqual(calls, [["store", "project"]]);
  assert.deepEqual(result.promotedLaunchIds, ["accepted"]);
  assert.equal(result.state.pendingLaunches.length, 0);
  assert.equal(result.state.links[0].childTaskId, "child-accepted");
});

test("builds one deterministic observation batch for the whole project", () => {
  const pending = pendingLaunch("pending", "assignment_started");
  const state = ledgerState([pending], [
    readyLink("root-b", "child-b"),
    readyLink("root-a", "child-a"),
    readyLink("child-a", "grandchild-a"),
  ]);

  assert.deepEqual(buildHeartbeatObservationRequests(state), [
    { taskId: "child-a", mode: "latest" },
    { taskId: "child-b", mode: "latest" },
    { taskId: "grandchild-a", mode: "latest" },
    { taskId: "root-a", mode: "latest" },
    { taskId: "root-b", mode: "latest" },
    {
      taskId: "child-pending",
      mode: "exact",
      turnId: "assignment-pending",
    },
  ]);
});

test("observes the batch once and preserves latest and launch identities", async () => {
  const pending = pendingLaunch("pending", "assignment_started");
  const state = ledgerState(
    [pending],
    [readyLink("root", "child")],
  );
  const calls = [];

  const result = await observeHeartbeatTasks(state, {
    async observeTasks(requests, observationOptions) {
      calls.push([requests, observationOptions]);
      return requests.map((request) =>
        request.mode === "latest"
          ? {
              taskId: request.taskId,
              location: "active",
              latestTurnId: `turn-${request.taskId}`,
              turnState: "in_progress",
            }
          : {
              taskId: request.taskId,
              location: "active",
              turnId: request.turnId,
              turnState: "ended",
            }
      );
    },
    roots: ["roots"],
    cachedPaths: new Map([["child", "/history/child.jsonl"]]),
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], {
    roots: ["roots"],
    cachedPaths: new Map([["child", "/history/child.jsonl"]]),
    fileSystem: undefined,
    openHistory: undefined,
  });
  assert.deepEqual(
    result.latestSnapshots.map(({ taskId }) => taskId),
    ["child", "root"],
  );
  assert.deepEqual(result.pendingLaunchSnapshots, [{
    launchId: "pending",
    snapshot: {
      taskId: "child-pending",
      location: "active",
      turnId: "assignment-pending",
      turnState: "ended",
    },
  }]);
});

test("plans only top-most archived anchors across independent trees", () => {
  const links = [
    readyLink("root-a", "child-a"),
    readyLink("child-a", "grandchild-a"),
    readyLink("root-b", "child-b"),
    readyLink("child-b", "grandchild-b"),
  ];
  const forest = buildTaskForest(links);

  const plans = planArchiveTerminations(forest, [
    {
      taskId: "root-a",
      location: "archived",
      latestTurnId: "turn-root-a",
      turnState: "ended",
    },
    {
      taskId: "child-a",
      location: "archived",
      latestTurnId: "turn-child-a",
      turnState: "ended",
    },
    {
      taskId: "child-b",
      location: "archived",
      latestTurnId: "turn-child-b",
      turnState: "ended",
    },
  ], {
    now: "2026-07-25T02:00:00.000Z",
  });

  assert.deepEqual(
    plans.map(({ taskId }) => taskId),
    ["child-b", "root-a"],
  );
});

test("applies archive acceptance before recovery without crossing siblings", () => {
  const links = [
    readyLink("root-a", "child-a"),
    readyLink("child-a", "grandchild-a"),
    readyLink("root-b", "child-b"),
    readyLink("root-b", "sibling-b"),
    readyLink("child-b", "grandchild-b"),
  ];
  const state = ledgerState([], links);
  const plans = planArchiveTerminations(buildTaskForest(links), [
    {
      taskId: "child-b",
      location: "archived",
      latestTurnId: "turn-child-b",
      turnState: "ended",
    },
  ], {
    now: "2026-07-25T02:00:00.000Z",
  });

  const result = applyArchiveTerminations(state, plans);
  const lifecycleByTaskId = new Map(
    result.state.links.map(({ childTaskId, lifecycle }) => [
      childTaskId,
      lifecycle,
    ]),
  );

  assert.deepEqual(result.result.archivedTaskIds, ["child-b"]);
  assert.equal(lifecycleByTaskId.get("child-b"), "accepted");
  assert.equal(lifecycleByTaskId.get("grandchild-b"), "accepted");
  assert.equal(lifecycleByTaskId.get("sibling-b"), "open");
  assert.equal(lifecycleByTaskId.get("child-a"), "open");
  assert.equal(
    result.state.links.find(
      ({ childTaskId }) => childTaskId === "child-b",
    ).acceptanceReason,
    "archive",
  );
});

test("replans and commits archive termination from the newest ledger", async () => {
  const initialState = ledgerState([], [
    readyLink("root", "archived-child"),
    readyLink("root", "open-sibling"),
  ]);
  const calls = [];

  const result = await reconcileArchiveTerminations({
    store: "store",
    project: "project",
  }, [{
    taskId: "archived-child",
    location: "archived",
    latestTurnId: "turn-archived",
    turnState: "ended",
  }], {
    now: "2026-07-25T02:00:00.000Z",
    async transactTaskLedger(
      store,
      project,
      transform,
    ) {
      calls.push([store, project]);
      return transform(initialState);
    },
  });

  assert.deepEqual(calls, [["store", "project"]]);
  assert.deepEqual(result.archivedTaskIds, ["archived-child"]);
  assert.equal(
    result.state.links.find(
      ({ childTaskId }) => childTaskId === "archived-child",
    ).lifecycle,
    "accepted",
  );
  assert.equal(
    result.state.links.find(
      ({ childTaskId }) => childTaskId === "open-sibling",
    ).lifecycle,
    "open",
  );
});

test("composes post-archive recovery without consuming lifecycle actions", async () => {
  const links = [
    readyLink("root", "ended"),
    readyLink("root", "running"),
  ];
  const initialState = ledgerState(
    [],
    links,
    [interruptDelivery("running")],
  );
  const transactions = mutableTransactions(initialState);
  const snapshots = [
    {
      taskId: "ended",
      location: "active",
      latestTurnId: "turn-ended",
      turnState: "ended",
    },
    {
      taskId: "running",
      location: "active",
      latestTurnId: "turn-running",
      turnState: "in_progress",
    },
    {
      taskId: "root",
      location: "active",
      latestTurnId: "turn-root",
      turnState: "ended",
    },
  ];

  const result = await runHeartbeatRecovery({
    store: {},
    project: { root: "/project" },
  }, initialState, snapshots, {
    now: "2026-07-25T02:00:00.000Z",
    leaseOwner: "heartbeat-run",
    leaseDurationMs: 60_000,
    transactTaskLedger: transactions.transact,
    async observeTasks(requests) {
      return requests.map(({ taskId }) =>
        snapshots.find((snapshot) => snapshot.taskId === taskId)
      );
    },
    async deliverMechanicalActions(actions) {
      assert.deepEqual(
        actions.map(({ kind, targetTaskId }) => ({
          kind,
          targetTaskId,
        })),
        [{
          kind: "recovery",
          targetTaskId: "ended",
        }],
      );
      return actions.map(({ id }) => ({
        deliveryId: id,
        status: "delivered",
        effect: "sent",
        turnId: "recovery-turn-ended",
      }));
    },
  });

  assert.deepEqual(result.recoveryCandidates, ["ended"]);
  assert.deepEqual(result.healthyTaskIds, ["running"]);
  assert.deepEqual(result.queuedTaskIds, ["ended"]);
  assert.deepEqual(result.deliveredTaskIds, ["ended"]);
  assert.deepEqual(result.pendingTaskIds, []);
  assert.deepEqual(
    result.state.deliveries.map(({ kind, targetTaskId, status }) => ({
      kind,
      targetTaskId,
      status,
    })),
    [
      {
        kind: "interrupt",
        targetTaskId: "running",
        status: "ready",
      },
      {
        kind: "recovery",
        targetTaskId: "ended",
        status: "delivered",
      },
    ],
  );
});

test("retries valid interrupt and resume deliveries in one bounded batch", async () => {
  const links = [
    readyLink("root", "stopped", "stopped"),
    readyLink("root", "resumed"),
  ];
  const transactions = mutableTransactions(ledgerState(
    [],
    links,
    [
      interruptDelivery("stopped"),
      resumeDelivery("resumed"),
    ],
  ));

  const result = await runLifecycleDeliveries({
    store: {},
    project: { root: "/project" },
  }, {
    now: "2026-07-25T02:00:00.000Z",
    leaseOwner: "heartbeat-run",
    leaseDurationMs: 60_000,
    transactTaskLedger: transactions.transact,
    async deliverMechanicalActions(actions) {
      assert.deepEqual(
        actions.map(({ kind, targetTaskId }) => ({
          kind,
          targetTaskId,
        })),
        [
          {
            kind: "interrupt",
            targetTaskId: "stopped",
          },
          {
            kind: "resume",
            targetTaskId: "resumed",
          },
        ],
      );
      return actions.map(({ id }) => ({
        deliveryId: id,
        status: "delivered",
        effect: "sent",
      }));
    },
  });

  assert.deepEqual(result.deliveredTaskIds, ["resumed", "stopped"]);
  assert.deepEqual(result.pendingTaskIds, []);
  assert.deepEqual(result.discarded, []);
  assert.equal(
    result.state.deliveries.every(
      ({ status }) => status === "delivered",
    ),
    true,
  );
});

test("discards lifecycle actions invalidated before heartbeat delivery", async () => {
  const links = [
    readyLink("root", "opened"),
    readyLink("root", "stopped", "stopped"),
    readyLink("root", "waiting"),
    readyLink("waiting", "leaf"),
  ];
  const transactions = mutableTransactions(ledgerState(
    [],
    links,
    [
      interruptDelivery("opened"),
      resumeDelivery("stopped"),
      resumeDelivery("waiting"),
    ],
  ));
  let delivered = false;

  const result = await runLifecycleDeliveries({
    store: {},
    project: { root: "/project" },
  }, {
    now: "2026-07-25T02:00:00.000Z",
    leaseOwner: "heartbeat-run",
    leaseDurationMs: 60_000,
    transactTaskLedger: transactions.transact,
    async deliverMechanicalActions() {
      delivered = true;
      return [];
    },
  });

  assert.equal(delivered, false);
  assert.deepEqual(result.discarded, [
    {
      taskId: "opened",
      reason: "lifecycle_changed",
    },
    {
      taskId: "stopped",
      reason: "lifecycle_changed",
    },
    {
      taskId: "waiting",
      reason: "position_changed",
    },
  ]);
  assert.deepEqual(result.state.deliveries, []);
});

test("releases one failed lifecycle delivery without hiding its sibling", async () => {
  const links = [
    readyLink("root", "failed"),
    readyLink("root", "sent"),
  ];
  const transactions = mutableTransactions(ledgerState(
    [],
    links,
    [
      resumeDelivery("failed"),
      resumeDelivery("sent"),
    ],
  ));

  const result = await runLifecycleDeliveries({
    store: {},
    project: { root: "/project" },
  }, {
    now: "2026-07-25T02:00:00.000Z",
    leaseOwner: "heartbeat-run",
    leaseDurationMs: 60_000,
    transactTaskLedger: transactions.transact,
    async deliverMechanicalActions() {
      return [
        {
          deliveryId: "resume-failed",
          status: "failed",
          error: {
            code: "APP_SEND_FAILED",
            message: "send failed",
          },
        },
        {
          deliveryId: "resume-sent",
          status: "delivered",
          effect: "sent",
        },
      ];
    },
  });

  assert.deepEqual(result.deliveredTaskIds, ["sent"]);
  assert.deepEqual(result.pendingTaskIds, ["failed"]);
  assert.equal(
    result.state.deliveries.find(
      ({ targetTaskId }) => targetTaskId === "failed",
    ).status,
    "ready",
  );
});

test("reclaims an expired lifecycle lease after process interruption", async () => {
  const delivery = {
    ...interruptDelivery("stopped"),
    status: "leased",
    attemptCount: 1,
    leaseOwner: "ended-process",
    leaseExpiresAt: "2026-07-25T01:30:00.000Z",
  };
  const transactions = mutableTransactions(ledgerState(
    [],
    [readyLink("root", "stopped", "stopped")],
    [delivery],
  ));

  const result = await runLifecycleDeliveries({
    store: {},
    project: { root: "/project" },
  }, {
    now: "2026-07-25T02:00:00.000Z",
    leaseOwner: "heartbeat-run",
    leaseDurationMs: 60_000,
    transactTaskLedger: transactions.transact,
    async deliverMechanicalActions(actions) {
      assert.equal(actions[0].attemptCount, 2);
      assert.equal(actions[0].leaseOwner, "heartbeat-run");
      return [{
        deliveryId: actions[0].id,
        status: "delivered",
        effect: "interrupted",
      }];
    },
  });

  assert.deepEqual(result.deliveredTaskIds, ["stopped"]);
  assert.equal(result.state.deliveries[0].status, "delivered");
});

test("a concurrent resume invalidates an already leased stop interrupt", async () => {
  const stoppedLink = readyLink("root", "child", "stopped");
  const initialState = ledgerState(
    [],
    [stoppedLink],
    [interruptDelivery("child")],
  );
  let currentState = initialState;
  let transactionCount = 0;
  let delivered = false;

  const result = await runLifecycleDeliveries({
    store: {},
    project: { root: "/project" },
  }, {
    now: "2026-07-25T02:00:00.000Z",
    leaseOwner: "heartbeat-run",
    leaseDurationMs: 60_000,
    async transactTaskLedger(
      store,
      project,
      transform,
    ) {
      transactionCount += 1;
      const outcome = transform(currentState);
      currentState = outcome.state;

      if (transactionCount === 1) {
        currentState = validateTaskLedger({
          ...currentState,
          links: [{
            ...currentState.links[0],
            lifecycle: "open",
          }],
        }, {
          root: "/project",
          key: "project-key",
          stateFile: "/project/.codex-small-loop/state.json",
        });
      }
      return {
        ...outcome,
        state: currentState,
      };
    },
    async deliverMechanicalActions() {
      delivered = true;
      return [];
    },
  });

  assert.equal(delivered, false);
  assert.deepEqual(result.discarded, [{
    taskId: "child",
    reason: "lifecycle_changed",
  }]);
  assert.equal(result.state.links[0].lifecycle, "open");
  assert.deepEqual(result.state.deliveries, []);
});

function emptyHeartbeatPhases(overrides = {}) {
  return {
    pendingLaunchPlan: {
      promotions: [],
      runningLaunchIds: [],
      repairRequired: [],
      degraded: [],
    },
    pendingLaunchResult: {
      promotedLaunchIds: [],
      discarded: [],
    },
    archiveResult: {
      archivedTaskIds: [],
    },
    recoveryResult: {
      recoveryCandidates: [],
      healthyTaskIds: [],
      waitingTaskIds: [],
      unresolvedRecoveryTaskIds: [],
      degraded: [],
      queuedTaskIds: [],
      protectedTaskIds: [],
      deliveredTaskIds: [],
      pendingTaskIds: [],
      discarded: [],
    },
    lifecycleResult: {
      deliveredTaskIds: [],
      pendingTaskIds: [],
      discarded: [],
    },
    ...overrides,
  };
}

test("builds the minimal unchanged idle heartbeat report", () => {
  const report = buildHeartbeatReport({
    state: ledgerState([]),
    ...emptyHeartbeatPhases(),
  });

  assert.deepEqual(report, {
    run: "ok",
    project: "idle",
    summary: {
      pendingLaunches: 0,
      activeConversations: 0,
      openLinks: 0,
      stoppedLinks: 0,
      runningTasks: 0,
      waitingTasks: 0,
      recoveryCandidates: 0,
      unresolvedRecoveries: 0,
      pendingDeliveries: 0,
      pendingAppMessages: 0,
    },
    events: [],
  });
});

test("reports App message schedule failures as degraded heartbeat events", () => {
  const report = buildHeartbeatReport({
    state: ledgerState([]),
    ...emptyHeartbeatPhases(),
    appMessageResult: {
      failedMessageIds: ["message-2", "message-1"],
    },
  });

  assert.equal(report.run, "partial");
  assert.equal(report.project, "degraded");
  assert.deepEqual(report.events, [{
    type: "app_message_failed",
    messageIds: ["message-1", "message-2"],
  }]);
});

test("groups and bounds heartbeat changes and problems deterministically", () => {
  const degraded = Array.from({ length: 25 }, (_, index) => ({
    taskId: `task-${String(index).padStart(2, "0")}`,
    reason: "turn_unknown",
  }));
  const state = ledgerState([], [
    readyLink("root", "open-child"),
    readyLink("root", "stopped-child", "stopped"),
  ]);

  const report = buildHeartbeatReport({
    state,
    ...emptyHeartbeatPhases({
      pendingLaunchPlan: {
        promotions: [],
        runningLaunchIds: [],
        repairRequired: [{
          launchId: "launch-b",
          reason: "assignment_aborted",
        }],
        degraded: [{
          launchId: "launch-a",
          reason: "observation_missing",
        }],
      },
      pendingLaunchResult: {
        promotedLaunchIds: ["launch-z"],
        discarded: [],
      },
      archiveResult: {
        archivedTaskIds: ["archived-child"],
      },
      recoveryResult: {
        recoveryCandidates: ["candidate"],
        healthyTaskIds: ["running"],
        waitingTaskIds: ["waiting"],
        unresolvedRecoveryTaskIds: ["unresolved"],
        degraded,
        queuedTaskIds: ["candidate"],
        protectedTaskIds: [],
        deliveredTaskIds: [],
        pendingTaskIds: ["candidate"],
        discarded: [{
          taskId: "stale",
          reason: "turn_changed",
        }],
      },
      lifecycleResult: {
        deliveredTaskIds: ["interrupted"],
        pendingTaskIds: ["resume-failed"],
        discarded: [],
      },
    }),
  });

  assert.equal(report.run, "partial");
  assert.equal(report.project, "degraded");
  assert.deepEqual(report.summary, {
    pendingLaunches: 0,
      activeConversations: 1,
    openLinks: 1,
    stoppedLinks: 1,
    runningTasks: 1,
    waitingTasks: 1,
    recoveryCandidates: 1,
    unresolvedRecoveries: 1,
    pendingDeliveries: 0,
    pendingAppMessages: 0,
  });
  assert.deepEqual(
    report.events.map(({ type, reason }) => [type, reason ?? null]),
    [
      ["archive_accepted", null],
      ["delivery_failed", "task_message_failed"],
      ["launch_promoted", null],
      ["launch_repair_required", "assignment_aborted"],
      ["launch_repair_required", "observation_missing"],
      ["lifecycle_sent", null],
      ["recovery_degraded", "turn_unknown"],
      ["recovery_discarded", "turn_changed"],
      ["recovery_queued", null],
      ["recovery_unresolved", null],
    ],
  );
  const degradedEvent = report.events.find(
    ({ type }) => type === "recovery_degraded",
  );
  assert.equal(degradedEvent.taskIds.length, 20);
  assert.equal(degradedEvent.omitted, 5);
});

test("reports an active healthy project without inventing events", () => {
  const state = ledgerState(
    [],
    [readyLink("root", "running")],
    [],
    [awaitingConversation("root", "running")],
  );
  const report = buildHeartbeatReport({
    state,
    ...emptyHeartbeatPhases({
      recoveryResult: {
        recoveryCandidates: [],
        healthyTaskIds: ["running"],
        waitingTaskIds: [],
        unresolvedRecoveryTaskIds: [],
        degraded: [],
        queuedTaskIds: [],
        protectedTaskIds: [],
        deliveredTaskIds: [],
        pendingTaskIds: [],
        discarded: [],
      },
    }),
  });

  assert.equal(report.run, "ok");
  assert.equal(report.project, "active");
  assert.deepEqual(report.events, []);
});

test("runs the one-shot heartbeat pipeline in its required order", async () => {
  const initialState = enqueueAppMessage(ledgerState([]), {
    id: "app-message",
    targetTaskId: "app-task",
    text: "Pending App message",
  }, { now: "2026-07-25T01:00:00.000Z" }).state;
  const events = [];
  const appServer = {
    async close() {
      events.push("close");
    },
  };
  const report = await runHeartbeat({
    projectRoot: "/project",
  }, {
    store: "store",
    appServer,
    now: () => "2026-07-25T02:00:00.000Z",
    createLeaseOwner: () => "heartbeat-run",
    processAppMessages: false,
    async leaseHeartbeatAppMessages() {
      throw new Error("mechanical heartbeat must not lease App messages");
    },
    async resolveProject(projectRoot) {
      events.push("resolve");
      return {
        root: projectRoot,
        key: "project-key",
        stateFile: "/project/.codex-small-loop/state.json",
      };
    },
    async assertRuntimeAvailable(project, options) {
      events.push("runtime");
      assert.equal(options.store, "store");
      return {
        project,
        ledger: initialState,
      };
    },
    async observeHeartbeatTasks() {
      const observationCount = events.filter(
        (event) => event.startsWith("observe-"),
      ).length;
      events.push([
        "observe-initial",
        "observe-current",
        "observe-after-lifecycle",
      ][observationCount]);
      return {
        latestSnapshots: [],
        pendingLaunchSnapshots: [],
      };
    },
    planPendingLaunchReconciliation() {
      events.push("plan-launch");
      return {
        deferredForks: [],
        waitingForkLaunchIds: [],
        promotions: [],
        runningLaunchIds: [],
        repairRequired: [],
        degraded: [],
      };
    },
    async runDeferredForks(_ledger, _plan, options) {
      events.push("run-deferred-forks");
      return {
        state: options.state,
        completedLaunchIds: [],
        failed: [],
      };
    },
    async reconcilePendingLaunches() {
      events.push("reconcile-launch");
      return {
        state: { ...initialState, revision: 1 },
        promotedLaunchIds: [],
        discarded: [],
      };
    },
    async reconcileArchiveTerminations() {
      events.push("archive");
      return {
        state: { ...initialState, revision: 2 },
        archivedTaskIds: [],
      };
    },
    async runHeartbeatRecovery() {
      events.push("recovery");
      return {
        state: { ...initialState, revision: 4 },
        recoveryCandidates: [],
        healthyTaskIds: [],
        waitingTaskIds: [],
        unresolvedRecoveryTaskIds: [],
        degraded: [],
        queuedTaskIds: [],
        protectedTaskIds: [],
        deliveredTaskIds: [],
        pendingTaskIds: [],
        discarded: [],
      };
    },
    async runLifecycleDeliveries() {
      events.push("lifecycle");
      return {
        state: { ...initialState, revision: 3 },
        deliveredTaskIds: [],
        pendingTaskIds: [],
        discarded: [],
      };
    },
  });

  assert.deepEqual(events, [
    "resolve",
    "runtime",
    "observe-initial",
    "plan-launch",
    "run-deferred-forks",
    "reconcile-launch",
    "observe-current",
    "archive",
    "lifecycle",
    "observe-after-lifecycle",
    "recovery",
    "close",
  ]);
  assert.equal(report.run, "ok");
  assert.equal(report.project, "active");
});

test("runs one complete heartbeat through the real ledger boundaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "heartbeat-"));
  const project = {
    root,
    key: "project-key",
    directory: path.join(root, ".codex-small-loop"),
    stateFile: path.join(root, ".codex-small-loop", "state.json"),
  };
  const store = new AtomicJsonStore(project.stateFile);
  const appCalls = [];

  try {
    await initializeTaskLedger(
      store,
      project,
      "2026-07-25T00:00:00.000Z",
    );
    await transactTaskLedger(
      store,
      project,
      (state) => ({
        state: {
          ...state,
          links: [readyLink("root", "ended")],
          conversations: [awaitingConversation("root", "ended")],
        },
        result: null,
      }),
      { now: "2026-07-25T01:00:00.000Z" },
    );

    const heartbeatOptions = {
      store,
      now: () => "2026-07-25T02:00:00.000Z",
      createLeaseOwner: () => "heartbeat-run",
      async resolveProject() {
        return project;
      },
      async assertRuntimeAvailable() {
        return {
          project,
          ledger: await readTaskLedger(store, project),
        };
      },
      async observeTasks(requests) {
        return requests.map((request) => ({
          taskId: request.taskId,
          location: "active",
          historyFile: `/history/${request.taskId}.jsonl`,
          latestTurnId: request.mode === "latest"
            ? (
                request.taskId === "ended" && appCalls.length > 0
                  ? "recovery-turn"
                  : `turn-${request.taskId}`
              )
            : undefined,
          turnId: request.mode === "exact"
            ? request.turnId
            : undefined,
          turnState: request.taskId === "ended"
            || request.taskId === "root"
            ? "ended"
            : "in_progress",
          diagnostics: [],
        }));
      },
      appServer: {
        async resumeTask({ taskId }) {
          return {
            taskId,
            cwd: root,
            runContext: {
              approvalPolicy: "never",
              permission: {
                type: "sandbox",
                policy: { type: "dangerFullAccess" },
              },
              model: "gpt-5.6-sol",
              reasoningEffort: "medium",
              serviceTier: "priority",
            },
          };
        },
        async startTurn(input) {
          appCalls.push(input);
          return { turnId: "recovery-turn" };
        },
        async steerTurn() {
          throw new Error("must not steer a accepted task");
        },
        async interruptTurn() {
          throw new Error("must not interrupt");
        },
        async close() {},
      },
    };
    const report = await runHeartbeat({
      projectRoot: root,
    }, heartbeatOptions);
    const finalState = await readTaskLedger(store, project);

    assert.equal(report.run, "ok");
    assert.equal(report.project, "active");
    assert.deepEqual(
      report.events.map(({ type }) => type),
      ["recovery_queued", "recovery_sent"],
    );
    assert.equal(appCalls.length, 1);
    assert.equal(appCalls[0].taskId, "ended");
    assert.equal(finalState.deliveries.length, 1);
    assert.equal(finalState.deliveries[0].status, "delivered");

    const repeated = await runHeartbeat({
      projectRoot: root,
    }, {
      ...heartbeatOptions,
      createLeaseOwner: () => "heartbeat-repeat",
    });

    assert.equal(repeated.run, "ok");
    assert.deepEqual(
      repeated.events.map(({ type }) => type),
      ["recovery_queued", "recovery_sent"],
    );
    assert.equal(appCalls.length, 2);
    assert.equal(
      (await readTaskLedger(store, project)).deliveries.length,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overlapping heartbeats serialize one recovery send", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "heartbeat-overlap-"));
  const project = {
    root,
    key: "project-key",
    directory: path.join(root, ".codex-small-loop"),
    stateFile: path.join(root, ".codex-small-loop", "state.json"),
  };
  const store = new AtomicJsonStore(project.stateFile);
  let sendCount = 0;

  try {
    await initializeTaskLedger(
      store,
      project,
      "2026-07-25T00:00:00.000Z",
    );
    await transactTaskLedger(
      store,
      project,
      (state) => ({
        state: {
          ...state,
          links: [readyLink("root", "ended")],
          conversations: [awaitingConversation("root", "ended")],
        },
        result: null,
      }),
      { now: "2026-07-25T01:00:00.000Z" },
    );

    const sharedOptions = {
      store,
      now: () => "2026-07-25T02:00:00.000Z",
      async resolveProject() {
        return project;
      },
      async assertRuntimeAvailable() {
        return {
          project,
          ledger: await readTaskLedger(store, project),
        };
      },
      async observeTasks(requests) {
        return requests.map(({ taskId }) => ({
          taskId,
          location: "active",
          historyFile: `/history/${taskId}.jsonl`,
          latestTurnId: `turn-${taskId}`,
          turnState: taskId === "ended" || taskId === "root"
            ? "ended"
            : "in_progress",
          diagnostics: [],
        }));
      },
      appServer: {
        async resumeTask({ taskId }) {
          return {
            taskId,
            cwd: root,
            runContext: {
              approvalPolicy: "never",
              permission: {
                type: "sandbox",
                policy: { type: "dangerFullAccess" },
              },
              model: "gpt-5.6-sol",
              reasoningEffort: "medium",
              serviceTier: "priority",
            },
          };
        },
        async startTurn() {
          sendCount += 1;
          await new Promise((resolve) => setImmediate(resolve));
          return { turnId: `recovery-${sendCount}` };
        },
        async steerTurn() {
          throw new Error("must not steer a accepted task");
        },
        async interruptTurn() {},
        async close() {},
      },
    };

    await Promise.all([
      runHeartbeat({ projectRoot: root }, {
        ...sharedOptions,
        createLeaseOwner: () => "heartbeat-a",
      }),
      runHeartbeat({ projectRoot: root }, {
        ...sharedOptions,
        createLeaseOwner: () => "heartbeat-b",
      }),
    ]);
    const finalState = await readTaskLedger(store, project);

    assert.equal(sendCount, 1);
    assert.equal(finalState.deliveries.length, 1);
    assert.equal(finalState.deliveries[0].status, "delivered");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("heartbeat CLI emits one JSON result and maps run status to exit code", async () => {
  const projectRoot = path.resolve("/workspace/current", "../project");
  const chunks = [];
  const supervisorRoots = [];
  const code = await runHeartbeatCli([
    "--project-root",
    "../project",
  ], {
    cwd: "/workspace/current",
    stdout: {
      write(chunk) {
        chunks.push(chunk);
      },
    },
    async heartbeat(input) {
      assert.deepEqual(input, {
        projectRoot,
      });
      return {
        run: "partial",
        project: "degraded",
        summary: {
          pendingLaunches: 0,
          activeConversations: 1,
          openLinks: 1,
          pendingDeliveries: 0,
          runningTasks: 1,
        },
        events: [],
      };
    },
    startSupervisor(projectRoot) {
      supervisorRoots.push(projectRoot);
    },
  });

  assert.equal(code, 2);
  assert.deepEqual(JSON.parse(chunks.join("")), {
    run: "partial",
    project: "degraded",
    summary: {
      pendingLaunches: 0,
      activeConversations: 1,
      openLinks: 1,
      pendingDeliveries: 0,
      runningTasks: 1,
    },
    events: [],
  });
  assert.deepEqual(supervisorRoots, [projectRoot]);
});

test("heartbeat CLI rejects missing, repeated, and unknown arguments safely", async () => {
  for (const argv of [
    [],
    ["--unknown", "value"],
    ["--project-root", "/a", "--project-root", "/b"],
  ]) {
    const chunks = [];
    const code = await runHeartbeatCli(argv, {
      cwd: "/workspace",
      stdout: {
        write(chunk) {
          chunks.push(chunk);
        },
      },
      async heartbeat() {
        throw new Error("must not run");
      },
    });
    const result = JSON.parse(chunks.join(""));

    assert.equal(code, 1);
    assert.equal(result.run, "failed");
    assert.equal(result.operation, "heartbeat");
    assert.equal(result.code, "HEARTBEAT_CLI_USAGE");
    assert.equal(result.message.length <= 512, true);
  }
});

test("heartbeat executable emits one bounded JSON error", async () => {
  const script = fileURLToPath(new URL("../internal/heartbeat.mjs", import.meta.url));
  const child = spawn(process.execPath, [script], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  assert.equal(exitCode, 1);
  assert.equal(stderr, "");
  assert.equal(stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(stdout).code, "HEARTBEAT_CLI_USAGE");
});
