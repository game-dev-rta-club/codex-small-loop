import assert from "node:assert/strict";
import test from "node:test";

import {
  planRecoveryCandidates,
  queueRecoveryCandidates,
  runRecoveryDeliveries,
} from "../source/abnormal-recovery.mjs";
import {
  acknowledgeDelivery,
  enqueueAppMessage,
  validateTaskLedger,
} from "../source/task-ledger.mjs";

const NOW = "2026-07-25T02:00:00.000Z";

function link(parentTaskId, childTaskId, lifecycle = "open") {
  return {
    parentTaskId,
    childTaskId,
    role: "primary",
    lifecycle,
  };
}

function conversationsFromLinks(links) {
  return links
    .filter(({ lifecycle }) => lifecycle === "open")
    .map(({ parentTaskId, childTaskId }) => ({
      id: `conversation:${parentTaskId}:${childTaskId}`,
      initiatorTaskId: parentTaskId,
      initiatorRole: "primary",
      responderTaskId: childTaskId,
      responderRole: "primary",
      state: "awaiting_reply",
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      repliedAt: null,
      acceptedAt: null,
    }));
}

function buildTaskForest(links) {
  return conversationsFromLinks(links);
}

function snapshot(
  taskId,
  turnState,
  latestTurnId = `turn-${taskId}`,
  location = "active",
) {
  return {
    taskId,
    location,
    historyFile: location === "missing" ? null : `/history/${taskId}.jsonl`,
    latestTurnId,
    turnState,
    diagnostics: [],
  };
}

function ledgerState(links, deliveries = []) {
  return validateTaskLedger({
    version: 10,
    revision: 0,
    projectRoot: "/project",
    projectKey: "project-key",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    managedTasks: [],
    pendingLaunches: [],
    links: links.map((currentLink) => ({
      ...currentLink,
      acceptanceReason: null,
      historyFile: null,
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      acceptedAt: null,
    })),
    conversations: conversationsFromLinks(links),
    deliveries,
    appMessages: [],
  }, {
    root: "/project",
    key: "project-key",
    stateFile: "/project/.codex-small-loop/state.json",
  });
}

function transactionFrom(initialState, events) {
  return async (store, project, transform) => {
    events.push("transaction");
    return transform(initialState);
  };
}

function mutableTransactions(initialState, events = []) {
  let currentState = initialState;

  return {
    async transact(store, project, transform) {
      events.push("transaction");
      const outcome = transform(currentState);
      currentState = outcome.state;
      return outcome;
    },
    state() {
      return currentState;
    },
  };
}

function recoveryDelivery(taskId, parentTaskId = "root", overrides = {}) {
  return {
    id: `delivery-${taskId}`,
    kind: "recovery",
    targetTaskId: taskId,
    parentTaskId,
    conversationId: `conversation:${parentTaskId}:${taskId}`,
    dedupeKey: `recovery:${taskId}:turn-${taskId}`,
    operationId: null,
    observedTurnId: `turn-${taskId}`,
    resultTurnId: null,
    status: "ready",
    attemptCount: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: "2026-07-25T01:00:00.000Z",
    updatedAt: "2026-07-25T01:00:00.000Z",
    deliveredAt: null,
    lastError: null,
    ...overrides,
  };
}

test("classifies every open leaf across parallel roots", () => {
  const forest = buildTaskForest([
    link("root-b", "child-running"),
    link("root-a", "child-complete"),
    link("root-a", "child-aborted"),
  ]);

  assert.deepEqual(
    planRecoveryCandidates(forest, [
      snapshot("child-running", "in_progress"),
      snapshot("child-aborted", "aborted"),
      snapshot("child-complete", "ended"),
    ], []),
    {
      candidates: [
        {
          targetTaskId: "child-aborted",
          parentTaskId: "root-a",
          conversationId: "conversation:root-a:child-aborted",
          observedTurnId: "turn-child-aborted",
          observedTurnState: "aborted",
          dedupeKey: "recovery:child-aborted:turn-child-aborted",
        },
        {
          targetTaskId: "child-complete",
          parentTaskId: "root-a",
          conversationId: "conversation:root-a:child-complete",
          observedTurnId: "turn-child-complete",
          observedTurnState: "ended",
          dedupeKey: "recovery:child-complete:turn-child-complete",
        },
      ],
      healthyTaskIds: ["child-running"],
      waitingTaskIds: [],
      unresolvedRecoveryTaskIds: [],
      degraded: [],
    },
  );
});

test("keeps open non-leaves waiting and classifies only the leaf frontier", () => {
  const forest = buildTaskForest([
    link("root", "parent"),
    link("parent", "leaf-running"),
    link("parent", "leaf-ended"),
  ]);

  const plan = planRecoveryCandidates(forest, [
    snapshot("parent", "ended"),
    snapshot("leaf-running", "in_progress"),
    snapshot("leaf-ended", "ended"),
  ], []);

  assert.deepEqual(plan.waitingTaskIds, ["parent"]);
  assert.deepEqual(plan.healthyTaskIds, ["leaf-running"]);
  assert.deepEqual(
    plan.candidates.map(({ targetTaskId }) => targetTaskId),
    ["leaf-ended"],
  );
});

test("recovers a terminal leaf without waiting for elapsed time", () => {
  const forest = buildTaskForest([
    link("root", "child"),
  ]);
  const ended = snapshot("child", "ended");

  const plan = planRecoveryCandidates(forest, [ended], [], {
    appMessages: [],
  });

  assert.deepEqual(
    plan.candidates.map(({ targetTaskId }) => targetTaskId),
    ["child"],
  );
  assert.deepEqual(plan.waitingTaskIds, []);
});

test("defers only the leaf whose outbound App message schedule is pending", () => {
  const forest = buildTaskForest([
    link("root", "child-a"),
    link("root", "child-b"),
  ]);
  const plan = planRecoveryCandidates(forest, [
    snapshot("root", "ended"),
    snapshot("child-a", "ended"),
    snapshot("child-b", "ended"),
  ], [], {
    appMessages: [{
      sourceTaskId: "child-a",
      targetTaskId: "root",
      status: "scheduled",
      createdAt: "2026-07-25T01:59:00.000Z",
      updatedAt: "2026-07-25T01:59:30.000Z",
      terminalAt: null,
    }],
  });

  assert.deepEqual(
    plan.candidates.map(({ targetTaskId }) => targetTaskId),
    ["child-b"],
  );
  assert.deepEqual(plan.waitingTaskIds, ["child-a"]);
});

test("defers a deep leaf while its direct parent is processing the report", () => {
  const forest = buildTaskForest([
    link("root", "parent"),
    link("parent", "grandchild"),
    link("root", "parallel-child"),
  ]);
  const plan = planRecoveryCandidates(forest, [
    snapshot("parent", "in_progress"),
    snapshot("grandchild", "ended"),
    snapshot("parallel-child", "ended"),
  ], [], {
    appMessages: [{
      sourceTaskId: "grandchild",
      targetTaskId: "parent",
      status: "delivered",
      createdAt: "2026-07-25T01:30:00.000Z",
      updatedAt: "2026-07-25T01:31:00.000Z",
      terminalAt: "2026-07-25T01:31:00.000Z",
    }],
  });

  assert.deepEqual(
    plan.candidates.map(({ targetTaskId }) => targetTaskId),
    ["parallel-child"],
  );
  assert.deepEqual(plan.waitingTaskIds, ["grandchild", "parent"]);
});

test("does not defer a delivered report after the App parent turn ended", () => {
  const forest = buildTaskForest([
    link("root", "child"),
  ]);
  const plan = planRecoveryCandidates(forest, [
    snapshot("root", "ended"),
    snapshot("child", "ended"),
  ], [], {
    appMessages: [{
      sourceTaskId: "child",
      targetTaskId: "root",
      status: "delivered",
      createdAt: "2026-07-25T01:58:00.000Z",
      updatedAt: "2026-07-25T01:59:00.000Z",
      terminalAt: "2026-07-25T01:59:00.000Z",
    }],
  });

  assert.deepEqual(
    plan.candidates.map(({ targetTaskId }) => targetTaskId),
    ["child"],
  );
  assert.deepEqual(plan.waitingTaskIds, []);
});

test("defers a terminal leaf while a resume delivery is pending", () => {
  const forest = buildTaskForest([
    link("root", "child"),
  ]);
  const plan = planRecoveryCandidates(
    forest,
    [snapshot("child", "ended")],
    [{
      kind: "resume",
      targetTaskId: "child",
      status: "ready",
      dedupeKey: "resume:operation:child",
    }],
  );

  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.waitingTaskIds, ["child"]);
});

test("reports contradictory or unavailable leaf observations as degraded", () => {
  const forest = buildTaskForest([
    link("root", "missing"),
    link("root", "not-started"),
    link("root", "unknown"),
  ]);

  const plan = planRecoveryCandidates(forest, [
    snapshot("not-started", "not_started", null),
    snapshot("unknown", "unknown", null),
  ], []);

  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.healthyTaskIds, []);
  assert.deepEqual(plan.degraded, [
    {
      taskId: "missing",
      reason: "observation_missing",
    },
    {
      taskId: "not-started",
      reason: "turn_not_started",
    },
    {
      taskId: "unknown",
      reason: "turn_unknown",
    },
  ]);
});

test("leaves archived, stopped, and accepted tasks to their own handlers", () => {
  const forest = buildTaskForest([
    link("root", "archived"),
    link("root", "stopped", "stopped"),
    link("root", "accepted", "accepted"),
  ]);

  const plan = planRecoveryCandidates(forest, [
    snapshot("archived", "ended", "turn-archived", "archived"),
    snapshot("stopped", "ended"),
    snapshot("accepted", "ended"),
  ], []);

  assert.deepEqual(plan, {
    candidates: [],
    healthyTaskIds: [],
    waitingTaskIds: [],
    unresolvedRecoveryTaskIds: [],
    degraded: [],
  });
});

test("distinguishes pending and unresolved recovery turns", () => {
  const forest = buildTaskForest([
    link("root", "child"),
  ]);
  const taskSnapshot = snapshot("child", "ended");

  for (const status of ["ready", "leased"]) {
    const plan = planRecoveryCandidates(forest, [taskSnapshot], [{
      kind: "recovery",
      targetTaskId: "child",
      dedupeKey: "recovery:child:turn-child",
      status,
    }]);

    assert.deepEqual(plan.candidates, [], status);
    assert.deepEqual(plan.waitingTaskIds, ["child"], status);
    assert.deepEqual(plan.unresolvedRecoveryTaskIds, [], status);
  }

  const unresolved = planRecoveryCandidates(forest, [taskSnapshot], [{
    kind: "recovery",
    targetTaskId: "child",
    dedupeKey: "recovery:child:turn-child",
    status: "delivered",
  }]);

  assert.deepEqual(unresolved.candidates, []);
  assert.deepEqual(unresolved.waitingTaskIds, []);
  assert.deepEqual(unresolved.unresolvedRecoveryTaskIds, ["child"]);
});

test("keeps recovering each new terminal result Turn without a total retry limit", () => {
  const forest = buildTaskForest([link("root", "child")]);
  const deliveries = [
    {
      kind: "recovery",
      targetTaskId: "child",
      dedupeKey: "recovery:child:turn-1",
      observedTurnId: "turn-1",
      resultTurnId: "turn-2",
      status: "delivered",
    },
    {
      kind: "recovery",
      targetTaskId: "child",
      dedupeKey: "recovery:child:turn-2",
      observedTurnId: "turn-2",
      resultTurnId: "turn-3",
      status: "delivered",
    },
  ];

  const plan = planRecoveryCandidates(
    forest,
    [snapshot("child", "ended", "turn-3")],
    deliveries,
  );

  assert.deepEqual(
    plan.candidates.map(({ targetTaskId, observedTurnId }) => ({
      targetTaskId,
      observedTurnId,
    })),
    [{
      targetTaskId: "child",
      observedTurnId: "turn-3",
    }],
  );
  assert.deepEqual(plan.unresolvedRecoveryTaskIds, []);
});

test("returns deterministic output without mutating inputs", () => {
  const forest = buildTaskForest([
    link("root-z", "z"),
    link("root-a", "a"),
    link("root-m", "m"),
  ]);
  const snapshots = [
    snapshot("z", "ended"),
    snapshot("m", "in_progress"),
    snapshot("a", "unknown", null),
  ];
  const deliveries = [];
  const originalForestLinks = structuredClone(forest.links);
  const originalSnapshots = structuredClone(snapshots);
  const originalDeliveries = structuredClone(deliveries);

  const plan = planRecoveryCandidates(forest, snapshots, deliveries);

  assert.deepEqual(
    plan.candidates.map(({ targetTaskId }) => targetTaskId),
    ["z"],
  );
  assert.deepEqual(plan.healthyTaskIds, ["m"]);
  assert.deepEqual(plan.degraded.map(({ taskId }) => taskId), ["a"]);
  assert.deepEqual(forest.links, originalForestLinks);
  assert.deepEqual(snapshots, originalSnapshots);
  assert.deepEqual(deliveries, originalDeliveries);
});

test("re-observes candidates before atomically queueing valid siblings", async () => {
  const links = [
    link("root", "child-a"),
    link("root", "child-b"),
  ];
  const state = ledgerState(links);
  const initialPlan = planRecoveryCandidates(
    buildTaskForest(links),
    [
      snapshot("child-a", "ended"),
      snapshot("child-b", "aborted"),
    ],
    [],
  );
  const events = [];

  const result = await queueRecoveryCandidates(
    {
      store: "store",
      project: "project",
    },
    initialPlan,
    async (requests) => {
      events.push("observe");
      assert.deepEqual(requests, [
        { taskId: "child-a", mode: "latest" },
        { taskId: "root", mode: "latest" },
        { taskId: "child-b", mode: "latest" },
      ]);
      return [
        snapshot("child-a", "ended"),
        snapshot("root", "ended"),
        snapshot("child-b", "aborted"),
      ];
    },
    {
      now: NOW,
      transactTaskLedger:
        transactionFrom(state, events),
    },
  );

  assert.deepEqual(events, ["observe", "transaction"]);
  assert.deepEqual(result.queuedTaskIds, ["child-a", "child-b"]);
  assert.deepEqual(result.protectedTaskIds, []);
  assert.deepEqual(result.discarded, []);
  assert.equal(result.state.deliveries.length, 2);
  assert.deepEqual(
    result.state.deliveries.map(({ dedupeKey }) => dedupeKey),
    [
      "recovery:child-a:turn-child-a",
      "recovery:child-b:turn-child-b",
    ],
  );
});

test("discards stale candidates independently before and inside the lock", async () => {
  const initialLinks = [
    link("root", "archived-location"),
    link("root", "changed-lifecycle"),
    link("root", "changed-parent"),
    link("root", "changed-turn"),
    link("root", "changed-position"),
    link("root", "still-valid"),
  ];
  const initialPlan = planRecoveryCandidates(
    buildTaskForest(initialLinks),
    initialLinks.map(({ childTaskId }) =>
      snapshot(childTaskId, "ended")
    ),
    [],
  );
  const newestState = ledgerState([
    link("root", "archived-location"),
    link("root", "changed-lifecycle", "stopped"),
    link("other-root", "changed-parent"),
    link("root", "changed-turn"),
    link("root", "changed-position"),
    link("root", "still-valid"),
    link("changed-position", "new-leaf"),
  ]);

  const result = await queueRecoveryCandidates(
    {
      store: {},
      project: {},
    },
    initialPlan,
    async () => [
      snapshot(
        "archived-location",
        "ended",
        "turn-archived-location",
        "archived",
      ),
      snapshot("changed-lifecycle", "ended"),
      snapshot("changed-parent", "ended"),
      snapshot("changed-turn", "in_progress", "new-turn"),
      snapshot("changed-position", "ended"),
      snapshot("still-valid", "ended"),
    ],
    {
      now: NOW,
      transactTaskLedger:
        transactionFrom(newestState, []),
    },
  );

  assert.deepEqual(result.queuedTaskIds, ["still-valid"]);
  assert.deepEqual(result.discarded, [
    {
      taskId: "archived-location",
      reason: "turn_changed",
    },
    {
      taskId: "changed-lifecycle",
      reason: "relationship_changed",
    },
    {
      taskId: "changed-parent",
      reason: "relationship_changed",
    },
    {
      taskId: "changed-position",
      reason: "position_changed",
    },
    {
      taskId: "changed-turn",
      reason: "turn_changed",
    },
  ]);
});

test("discards a candidate when its report is queued before the ledger lock", async () => {
  const links = [link("root", "child")];
  const initialPlan = planRecoveryCandidates(
    buildTaskForest(links),
    [snapshot("child", "ended")],
    [],
    {
      appMessages: [],
    },
  );
  const newestState = enqueueAppMessage(
    ledgerState(links),
    {
      id: "message-child-root",
      sourceTaskId: "child",
      targetTaskId: "root",
      text: "Completed.",
    },
    { now: "2026-07-25T01:59:00.000Z" },
  ).state;

  const result = await queueRecoveryCandidates(
    {
      store: {},
      project: {},
    },
    initialPlan,
    async () => [snapshot("child", "ended")],
    {
      now: NOW,
      transactTaskLedger:
        transactionFrom(newestState, []),
    },
  );

  assert.deepEqual(result.queuedTaskIds, []);
  assert.deepEqual(result.discarded, [{
    taskId: "child",
    reason: "activity_changed",
  }]);
  assert.equal(result.state.deliveries.length, 0);
});

test("treats a concurrently protected recovery turn as a successful no-op", async () => {
  const links = [link("root", "child")];
  const initialPlan = planRecoveryCandidates(
    buildTaskForest(links),
    [snapshot("child", "ended")],
    [],
  );
  const state = ledgerState(links, [{
    id: "existing-delivery",
    kind: "recovery",
    targetTaskId: "child",
    parentTaskId: "root",
    conversationId: "conversation:root:child",
    dedupeKey: "recovery:child:turn-child",
    operationId: null,
    observedTurnId: "turn-child",
    resultTurnId: "recovery-turn-child",
    status: "delivered",
    attemptCount: 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: "2026-07-25T01:00:00.000Z",
    updatedAt: "2026-07-25T01:01:00.000Z",
    deliveredAt: "2026-07-25T01:01:00.000Z",
    lastError: null,
  }]);

  const result = await queueRecoveryCandidates(
    {
      store: {},
      project: {},
    },
    initialPlan,
    async () => [snapshot("child", "ended")],
    {
      now: NOW,
      transactTaskLedger:
        transactionFrom(state, []),
    },
  );

  assert.deepEqual(result.queuedTaskIds, []);
  assert.deepEqual(result.protectedTaskIds, ["child"]);
  assert.deepEqual(result.discarded, []);
  assert.equal(result.state.deliveries.length, 1);
});

test("leases, revalidates, delivers, and records recovery outcomes", async () => {
  const links = [
    link("root", "valid"),
    link("root", "stale"),
  ];
  const events = [];
  const transactions = mutableTransactions(
    ledgerState(links, [
      recoveryDelivery("valid"),
      recoveryDelivery("stale"),
    ]),
    events,
  );

  const result = await runRecoveryDeliveries({
    store: {},
    project: { root: "/project" },
  }, {
    now: NOW,
    leaseOwner: "heartbeat-run",
    leaseDurationMs: 60_000,
    transactTaskLedger: transactions.transact,
    async observeTasks(requests) {
      events.push("observe");
      assert.deepEqual(requests, [
        { taskId: "stale", mode: "latest" },
        { taskId: "valid", mode: "latest" },
      ]);
      return [
        snapshot("stale", "in_progress", "new-turn"),
        snapshot("valid", "ended"),
      ];
    },
    async deliverMechanicalActions(actions) {
      events.push("deliver");
      assert.deepEqual(
        actions.map(({ targetTaskId }) => targetTaskId),
        ["valid"],
      );
      return [{
        deliveryId: "delivery-valid",
        status: "delivered",
        effect: "sent",
        turnId: "recovery-turn-valid",
      }];
    },
  });

  assert.deepEqual(events, [
    "transaction",
    "observe",
    "transaction",
    "deliver",
    "transaction",
  ]);
  assert.deepEqual(result.deliveredTaskIds, ["valid"]);
  assert.deepEqual(result.pendingTaskIds, []);
  assert.deepEqual(result.discarded, [{
    taskId: "stale",
    reason: "turn_changed",
  }]);
  assert.deepEqual(
    result.state.deliveries.map(({
      targetTaskId,
      status,
      observedTurnId,
      resultTurnId,
      dedupeKey,
    }) => ({
      targetTaskId,
      status,
      observedTurnId,
      resultTurnId,
      dedupeKey,
    })),
    [{
      targetTaskId: "valid",
      status: "delivered",
      observedTurnId: "turn-valid",
      resultTurnId: "recovery-turn-valid",
      dedupeKey: "recovery:valid:turn-valid",
    }],
  );
  assert.deepEqual(
    planRecoveryCandidates(
      buildTaskForest(links),
      [
        snapshot("stale", "in_progress", "new-turn"),
        snapshot("valid", "ended", "recovery-turn-valid"),
      ],
      result.state.deliveries,
    ).candidates.map(({ targetTaskId, observedTurnId }) => ({
      targetTaskId,
      observedTurnId,
    })),
    [{
      targetTaskId: "valid",
      observedTurnId: "recovery-turn-valid",
    }],
  );
});

test("releases a failed recovery send without hiding successful siblings", async () => {
  const links = [
    link("root", "failed"),
    link("root", "sent"),
  ];
  const transactions = mutableTransactions(ledgerState(links, [
    recoveryDelivery("failed"),
    recoveryDelivery("sent"),
  ]));

  const result = await runRecoveryDeliveries({
    store: {},
    project: { root: "/project" },
  }, {
    now: NOW,
    leaseOwner: "heartbeat-run",
    leaseDurationMs: 60_000,
    transactTaskLedger: transactions.transact,
    async observeTasks() {
      return [
        snapshot("failed", "ended"),
        snapshot("sent", "ended"),
      ];
    },
    async deliverMechanicalActions() {
      return [
        {
          deliveryId: "delivery-failed",
          status: "failed",
          error: {
            code: "APP_SEND_FAILED",
            message: "x".repeat(2_000),
          },
        },
        {
          deliveryId: "delivery-sent",
          status: "delivered",
          effect: "sent",
          turnId: "recovery-turn-sent",
        },
      ];
    },
  });

  assert.deepEqual(result.deliveredTaskIds, ["sent"]);
  assert.deepEqual(result.pendingTaskIds, ["failed"]);
  assert.equal(
    result.state.deliveries[0].lastError.message.length,
    1_024,
  );
  assert.deepEqual(
    result.state.deliveries.map(
      ({ targetTaskId, status, lastError }) => ({
        targetTaskId,
        status,
        errorCode: lastError?.code ?? null,
      }),
    ),
    [
      {
        targetTaskId: "failed",
        status: "ready",
        errorCode: "APP_SEND_FAILED",
      },
      {
        targetTaskId: "sent",
        status: "delivered",
        errorCode: null,
      },
    ],
  );
});

test("discards a leased recovery when its relationship is no longer open", async () => {
  const active = ledgerState(
    [link("root", "child")],
    [recoveryDelivery("child")],
  );
  const transactions = mutableTransactions({
    ...active,
    links: active.links.map((currentLink) => ({
      ...currentLink,
      lifecycle: "stopped",
    })),
    conversations: active.conversations.map((conversation) => ({
      ...conversation,
      state: "replied",
      repliedAt: "2026-07-25T01:30:00.000Z",
      updatedAt: "2026-07-25T01:30:00.000Z",
    })),
  });
  let delivered = false;

  const result = await runRecoveryDeliveries({
    store: {},
    project: { root: "/project" },
  }, {
    now: NOW,
    leaseOwner: "heartbeat-run",
    leaseDurationMs: 60_000,
    transactTaskLedger: transactions.transact,
    async observeTasks() {
      return [snapshot("child", "ended")];
    },
    async deliverMechanicalActions() {
      delivered = true;
      return [];
    },
  });

  assert.equal(delivered, false);
  assert.deepEqual(result.discarded, [{
    taskId: "child",
    reason: "relationship_changed",
  }]);
  assert.deepEqual(result.state.deliveries, []);
  assert.equal(result.state.links[0].lifecycle, "stopped");
});

test("releases an ambiguous App acceptance so the safe message may retry", async () => {
  const links = [link("root", "child")];
  const transactions = mutableTransactions(ledgerState(
    links,
    [recoveryDelivery("child")],
  ));

  const result = await runRecoveryDeliveries({
    store: {},
    project: { root: "/project" },
  }, {
    now: NOW,
    leaseOwner: "heartbeat-run",
    leaseDurationMs: 60_000,
    transactTaskLedger: transactions.transact,
    async observeTasks() {
      return [snapshot("child", "ended")];
    },
    appServer: {
      async resumeTask({ taskId }) {
        return {
          taskId,
          cwd: "/project",
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
        return {};
      },
      async steerTurn() {
        throw new Error("must not steer recovery");
      },
      async interruptTurn() {
        throw new Error("must not interrupt recovery");
      },
    },
  });

  assert.deepEqual(result.deliveredTaskIds, []);
  assert.deepEqual(result.pendingTaskIds, ["child"]);
  assert.equal(result.state.deliveries[0].status, "ready");
  assert.equal(
    result.state.deliveries[0].lastError.code,
    "APP_SERVER_RESPONSE_INVALID",
  );
});

test("bounds one recovery delivery batch and leaves remaining work ready", async () => {
  const links = Array.from({ length: 5 }, (_, index) =>
    link("root", `child-${index}`)
  );
  const transactions = mutableTransactions(ledgerState(
    links,
    links.map(({ childTaskId }) => recoveryDelivery(childTaskId)),
  ));

  const result = await runRecoveryDeliveries({
    store: {},
    project: { root: "/project" },
  }, {
    now: NOW,
    leaseOwner: "heartbeat-run",
    leaseDurationMs: 60_000,
    limit: 2,
    transactTaskLedger: transactions.transact,
    async observeTasks(requests) {
      return requests.map(({ taskId }) => snapshot(taskId, "ended"));
    },
    async deliverMechanicalActions(actions) {
      return actions.map(({ id }) => ({
        deliveryId: id,
        status: "delivered",
        effect: "sent",
        turnId: `recovery-${id}`,
      }));
    },
  });

  assert.deepEqual(result.deliveredTaskIds, ["child-0", "child-1"]);
  assert.equal(
    result.state.deliveries.filter(
      ({ status }) => status === "ready",
    ).length,
    3,
  );
});

test("reclaims an expired recovery lease and rejects its stale owner", async () => {
  const links = [link("root", "child")];
  const expired = recoveryDelivery("child", "root", {
    status: "leased",
    attemptCount: 1,
    leaseOwner: "old-run",
    leaseExpiresAt: "2026-07-25T01:30:00.000Z",
    updatedAt: "2026-07-25T01:00:00.000Z",
  });
  const transactions = mutableTransactions(
    ledgerState(links, [expired]),
  );

  const result = await runRecoveryDeliveries({
    store: {},
    project: { root: "/project" },
  }, {
    now: NOW,
    leaseOwner: "new-run",
    leaseDurationMs: 60_000,
    transactTaskLedger: transactions.transact,
    async observeTasks() {
      return [snapshot("child", "ended")];
    },
    async deliverMechanicalActions(actions) {
      assert.equal(actions[0].attemptCount, 2);
      assert.equal(actions[0].leaseOwner, "new-run");
      return [{
        deliveryId: "delivery-child",
        status: "delivered",
        effect: "sent",
        turnId: "recovery-turn-child",
      }];
    },
  });

  assert.deepEqual(result.deliveredTaskIds, ["child"]);
  assert.throws(
    () => acknowledgeDelivery(
      transactions.state(),
      "delivery-child",
      "old-run",
      NOW,
    ),
    (error) => error.code === "DELIVERY_LEASE_CONFLICT",
  );
});
