import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AtomicJsonStore } from "../source/atomic-json-store.mjs";
import { buildTaskForest } from "../source/task-forest.mjs";
import {
  applyLifecyclePlan,
  commitLifecycleOperation,
  planArchiveTermination,
  planResume,
  planStop,
  runLifecycleOperation,
} from "../source/task-lifecycle.mjs";
import {
  initializeTaskLedger,
  readTaskLedger,
  transactTaskLedger,
  validateTaskLedger,
} from "../source/task-ledger.mjs";

const NOW = "2026-07-25T01:00:00.000Z";

function link(
  parentTaskId,
  childTaskId,
  lifecycle = "open",
  overrides = {},
) {
  return {
    parentTaskId,
    childTaskId,
    role: "primary",
    lifecycle,
    acceptanceReason: lifecycle === "accepted" ? "direct" : null,
    historyFile: null,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: lifecycle === "accepted"
      ? "2026-07-25T00:30:00.000Z"
      : "2026-07-25T00:00:00.000Z",
    acceptedAt: lifecycle === "accepted"
      ? "2026-07-25T00:30:00.000Z"
      : null,
    ...overrides,
  };
}

function options(operationId) {
  return {
    now: NOW,
    operationId,
  };
}

function action(
  kind,
  operationId,
  parentTaskId,
  targetTaskId,
  conversationId,
) {
  const digest = createHash("sha256")
    .update(kind)
    .update("\0")
    .update(operationId)
    .update("\0")
    .update(targetTaskId)
    .digest("hex");

  return {
    id: `action:${digest}`,
    kind,
    targetTaskId,
    parentTaskId,
    operationId,
    observedTurnId: null,
    ...(conversationId === undefined ? {} : { conversationId }),
  };
}

function conversations(links) {
  return links
    .filter(({ lifecycle }) => lifecycle !== "accepted")
    .map((currentLink, index) => ({
      id: `conversation-${index + 1}`,
      initiatorTaskId: currentLink.parentTaskId,
      initiatorRole: "primary",
      responderTaskId: currentLink.childTaskId,
      responderRole: currentLink.role,
      state: "awaiting_reply",
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      repliedAt: null,
      acceptedAt: null,
    }));
}

function lifecycleState(links) {
  return {
    links,
    conversations: conversations(links),
  };
}

function ledger(links, deliveries = []) {
  return validateTaskLedger({
    version: 10,
    revision: 0,
    projectRoot: "/project",
    projectKey: "project-key",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    managedTasks: [],
    pendingLaunches: [],
    links,
    conversations: conversations(links),
    deliveries,
    appMessages: [],
  }, {
    root: "/project",
    key: "project-key",
    stateFile: "/project/.codex-small-loop/state.json",
  });
}

test("stops only Tasks in the selected Conversation branch", () => {
  const state = lifecycleState([
    link("root", "selected"),
    link("selected", "open-a"),
    link("selected", "open-b"),
    link("selected", "accepted", "accepted"),
    link("root", "sibling"),
  ]);
  const plan = planStop(
    state,
    "selected",
    options("stop-1"),
  );

  assert.deepEqual(plan.changes, [
    { childTaskId: "open-a", from: "open", to: "stopped" },
    { childTaskId: "open-b", from: "open", to: "stopped" },
    { childTaskId: "selected", from: "open", to: "stopped" },
  ]);
  assert.deepEqual(plan.actions, [
    action("interrupt", "stop-1", "selected", "open-a"),
    action("interrupt", "stop-1", "selected", "open-b"),
    action("interrupt", "stop-1", "root", "selected"),
  ]);
});

test("follows a Conversation branch even when launch lineage differs", () => {
  const interviewerLink = link("root", "interviewer");
  const reviewerLink = link("root", "reviewer");
  const [upstream] = conversations([interviewerLink]);
  const downstream = {
    ...conversations([reviewerLink])[0],
    id: "interview-conversation",
    initiatorTaskId: "interviewer",
  };
  const state = {
    links: [interviewerLink, reviewerLink],
    conversations: [upstream, downstream],
  };

  const plan = planStop(
    state,
    "interviewer",
    options("stop-interview"),
  );

  assert.deepEqual(plan.changes, [
    { childTaskId: "interviewer", from: "open", to: "stopped" },
    { childTaskId: "reviewer", from: "open", to: "stopped" },
  ]);
  assert.deepEqual(plan.actions, [
    action("interrupt", "stop-interview", "root", "interviewer"),
    action("interrupt", "stop-interview", "interviewer", "reviewer"),
  ]);
});

test("resumes every reopened open leaf without waking its parent", () => {
  const state = lifecycleState([
    link("root", "branch-a", "stopped"),
    link("branch-a", "leaf-a", "stopped"),
    link("branch-a", "accepted-a", "accepted"),
    link("root", "branch-b", "stopped"),
  ]);
  const plan = planResume(
    state,
    "root",
    options("resume-1"),
  );

  assert.deepEqual(plan.changes, [
    { childTaskId: "branch-a", from: "stopped", to: "open" },
    { childTaskId: "branch-b", from: "stopped", to: "open" },
    { childTaskId: "leaf-a", from: "stopped", to: "open" },
  ]);
  assert.deepEqual(plan.actions, [
    action(
      "resume",
      "resume-1",
      "root",
      "branch-b",
      "conversation-3",
    ),
    action(
      "resume",
      "resume-1",
      "branch-a",
      "leaf-a",
      "conversation-2",
    ),
  ]);
});

test("rejects resuming a Child beneath a stopped ancestor", () => {
  const state = lifecycleState([
    link("root", "stopped-parent", "stopped"),
    link("stopped-parent", "selected", "stopped"),
  ]);

  assert.throws(
    () => planResume(
      state,
      "selected",
      options("resume-hidden"),
    ),
    (error) => error.code === "TASK_ANCESTOR_STOPPED",
  );
});

test("stop and resume are idempotent no-ops", () => {
  const stoppedState = lifecycleState([
    link("root", "paused", "stopped"),
  ]);
  const openState = lifecycleState([
    link("root", "active"),
  ]);

  for (const plan of [
    planStop(stoppedState, "paused", options("stop-noop")),
    planResume(openState, "active", options("resume-noop")),
  ]) {
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(plan.actions, []);
  }
});

test("archive acceptance preserves history and skips the archived task action", () => {
  const forest = buildTaskForest([
    link("root", "archived-child"),
    link("archived-child", "active-a"),
    link("archived-child", "active-b", "stopped"),
    link("archived-child", "already-done", "accepted"),
    link("root", "sibling"),
  ]);
  const plan = planArchiveTermination(
    forest,
    "archived-child",
    options("archive-1"),
  );

  assert.deepEqual(plan.changes, [
    {
      childTaskId: "active-a",
      from: "open",
      to: "accepted",
      acceptanceReason: "archive",
    },
    {
      childTaskId: "active-b",
      from: "stopped",
      to: "accepted",
      acceptanceReason: "archive",
    },
    {
      childTaskId: "archived-child",
      from: "open",
      to: "accepted",
      acceptanceReason: "archive",
    },
  ]);
  assert.deepEqual(plan.actions, [
    action("interrupt", "archive-1", "archived-child", "active-a"),
    action("interrupt", "archive-1", "archived-child", "active-b"),
  ]);
});

test("archive acceptance is idempotent and unmanaged tasks fail closed", () => {
  const forest = buildTaskForest([
    link("root", "done", "accepted", {
      acceptanceReason: "archive",
    }),
  ]);
  const plan = planArchiveTermination(
    forest,
    "done",
    options("archive-noop"),
  );

  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.actions, []);
  assert.throws(
    () => planStop(
      lifecycleState(forest.links),
      "unknown",
      options("stop-unknown"),
    ),
    (error) => error.code === "TASK_NOT_MANAGED",
  );
});

test("applies resume changes and queues only reopened leaves", () => {
  const current = ledger([
    link("root", "parent", "stopped"),
    link("parent", "leaf", "stopped"),
  ]);
  const plan = planResume(
    current,
    "root",
    options("resume-atomic"),
  );
  const applied = applyLifecyclePlan(current, plan);

  assert.deepEqual(
    applied.state.links.map(({ childTaskId, lifecycle }) => ({
      childTaskId,
      lifecycle,
    })),
    [
      { childTaskId: "parent", lifecycle: "open" },
      { childTaskId: "leaf", lifecycle: "open" },
    ],
  );
  assert.deepEqual(
    applied.state.deliveries.map(({ kind, targetTaskId }) => ({
      kind,
      targetTaskId,
    })),
    [{ kind: "resume", targetTaskId: "leaf" }],
  );
});

test("rejects a stale plan without changing the current ledger", () => {
  const current = ledger([
    link("root", "child", "stopped", {
      updatedAt: NOW,
    }),
  ]);
  const stalePlan = {
    operation: "stop",
    operationId: "stale-operation",
    taskId: "child",
    at: NOW,
    changes: [
      { childTaskId: "child", from: "open", to: "stopped" },
    ],
    actions: [
      action("interrupt", "stale-operation", "root", "child"),
    ],
  };

  assert.throws(
    () => applyLifecyclePlan(current, stalePlan),
    (error) => error.code === "TASK_LIFECYCLE_INVALID",
  );
  assert.equal(current.links[0].lifecycle, "stopped");
  assert.equal(current.deliveries.length, 0);
});

test("applying an idempotent no-op preserves the same ledger object", () => {
  const current = ledger([
    link("root", "paused", "stopped"),
  ]);
  const plan = planStop(
    current,
    "paused",
    options("stop-noop-atomic"),
  );
  const applied = applyLifecyclePlan(current, plan);

  assert.equal(applied.state, current);
  assert.deepEqual(applied.result, {
    operation: "stop",
    operationId: "stop-noop-atomic",
    taskId: "paused",
    changedLinks: 0,
    queuedActions: 0,
    affectedTaskIds: [],
  });
});

test("coordinates one lifecycle commit from the latest locked ledger", async () => {
  const runtimeSnapshot = ledger([
    link("root", "child"),
  ]);
  const latestLockedState = ledger([
    link("root", "child", "stopped"),
  ]);
  const calls = [];
  const result = await commitLifecycleOperation({
    operation: "resume",
    projectRoot: "/project",
    taskId: "root",
  }, {
    store: { name: "store" },
    createOperationId: () => "coordinator-operation",
    now: () => NOW,
    async resolveProject(projectRoot) {
      calls.push(["resolve", projectRoot]);
      return {
        root: "/project",
        key: "project-key",
        stateFile: "/project/.codex-small-loop/state.json",
      };
    },
    async assertRuntimeAvailable(project, options) {
      calls.push(["runtime", project.root, options.store.name]);
      return { ledger: runtimeSnapshot };
    },
    async transactTaskLedger(
      store,
      project,
      transform,
      options,
    ) {
      calls.push([
        "transact",
        store.name,
        project.root,
        options.now,
      ]);
      const transformed = transform(latestLockedState);
      return {
        state: transformed.state,
        result: transformed.result,
      };
    },
  });

  assert.deepEqual(calls, [
    ["resolve", path.normalize("/project")],
    ["runtime", "/project", "store"],
    ["transact", "store", "/project", NOW],
  ]);
  assert.deepEqual(result, {
    run: "ok",
    operation: "resume",
    operationId: "coordinator-operation",
    taskId: "root",
    changedLinks: 1,
    queuedActions: 1,
    affectedTaskIds: ["child"],
  });
});

test("coordinator replans instead of applying the runtime snapshot", async () => {
  const runtimeSnapshot = ledger([
    link("root", "child"),
  ]);
  const latestLockedState = ledger([
    link("root", "child", "stopped"),
  ]);

  const result = await commitLifecycleOperation({
    operation: "stop",
    projectRoot: "/project",
    taskId: "root",
  }, {
    store: {},
    createOperationId: () => "replanned-operation",
    now: () => NOW,
    async resolveProject() {
      return {
        root: "/project",
        key: "project-key",
        stateFile: "/project/.codex-small-loop/state.json",
      };
    },
    async assertRuntimeAvailable() {
      return { ledger: runtimeSnapshot };
    },
    async transactTaskLedger(
      store,
      project,
      transform,
    ) {
      const transformed = transform(latestLockedState);
      return {
        state: transformed.state,
        result: transformed.result,
      };
    },
  });

  assert.equal(result.changedLinks, 0);
  assert.equal(result.queuedActions, 0);
});

test("coordinator fails before mutation when the runtime is unavailable", async () => {
  let transacted = false;

  await assert.rejects(
    commitLifecycleOperation({
      operation: "stop",
      projectRoot: "/project",
      taskId: "child",
    }, {
      store: {},
      async resolveProject() {
        return {
          root: "/project",
          key: "project-key",
          stateFile: "/project/.codex-small-loop/state.json",
        };
      },
      async assertRuntimeAvailable() {
        throw Object.assign(new Error("not configured"), {
          code: "RUNTIME_NOT_CONFIGURED",
        });
      },
      async transactTaskLedger() {
        transacted = true;
      },
    }),
    (error) => error.code === "RUNTIME_NOT_AVAILABLE"
      && !/codex-small-loop-doctor/i.test(error.message)
      && /runtime\.mjs"? status/.test(error.message)
      && /could not be read safely/i.test(error.message)
      && /diagnos/i.test(error.message)
      && /retry.*stop/i.test(error.message)
      && !error.message.includes("<plugin-root>"),
  );
  assert.equal(transacted, false);
});

test("coordinator rejects unsupported operations and implicit Task IDs", async () => {
  for (const input of [
    {
      operation: "archive",
      projectRoot: "/project",
      taskId: "child",
    },
    {
      operation: "stop",
      projectRoot: "/project",
    },
    {
      operation: "stop",
      projectRoot: "relative",
      taskId: "child",
    },
  ]) {
    await assert.rejects(
      commitLifecycleOperation(input),
      (error) => error.code === "TASK_LIFECYCLE_INVALID",
    );
  }
});

function lifecycleHarness(initialState, overrides = {}) {
  let currentState = initialState;
  const calls = [];
  const appServer = {
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
    async startTurn(input) {
      calls.push(["start", input]);
      return { turnId: "started-turn" };
    },
    async steerTurn() {
      throw new Error("must not steer a accepted task");
    },
    async interruptTurn(input) {
      calls.push(["interrupt", input]);
      return { interrupted: true };
    },
    async close() {
      calls.push(["close"]);
    },
    ...overrides.appServer,
  };
  const project = {
    root: "/project",
    key: "project-key",
    stateFile: "/project/.codex-small-loop/state.json",
  };
  const options = {
    store: {},
    appServer,
    createOperationId: () => "run-operation",
    createLeaseOwner: () => "lease-owner",
    now: (() => {
      const values = [
        "2026-07-25T01:00:00.000Z",
        "2026-07-25T01:01:00.000Z",
        "2026-07-25T01:02:00.000Z",
      ];
      return () => values.shift() ?? "2026-07-25T01:03:00.000Z";
    })(),
    async resolveProject() {
      return project;
    },
    async assertRuntimeAvailable() {
      return { ledger: currentState };
    },
    async observeTasks(requests) {
      return requests.map(({ taskId, mode, turnId }) => ({
        taskId,
        location: "active",
        historyFile: `/history/${taskId}.jsonl`,
        ...(mode === "exact"
          ? { turnId }
          : { latestTurnId: `previous-${taskId}` }),
        turnState: "ended",
        diagnostics: [],
      }));
    },
    async transactTaskLedger(
      store,
      currentProject,
      transform,
      transactionOptions,
    ) {
      calls.push(["transaction", transactionOptions.now]);
      const transformed = transform(currentState);
      currentState = transformed.state;
      return {
        state: currentState,
        result: transformed.result,
      };
    },
    ...overrides.options,
  };

  return {
    appServer,
    calls,
    options,
    state() {
      return currentState;
    },
  };
}

test("runs commit, lease, delivery, and acknowledgement as one lifecycle command", async () => {
  const harness = lifecycleHarness(ledger([
    link("root", "child", "stopped"),
  ]));
  const result = await runLifecycleOperation({
    operation: "resume",
    projectRoot: "/project",
    taskId: "root",
  }, harness.options);

  assert.deepEqual(result, {
    run: "ok",
    operation: "resume",
    operationId: "run-operation",
    taskId: "root",
    changedLinks: 1,
    queuedActions: 1,
    deliveredActions: 1,
    pendingActions: 0,
    affectedTaskIds: ["child"],
    omitted: 0,
  });
  assert.equal(harness.state().links[0].lifecycle, "open");
  assert.equal(harness.state().deliveries[0].status, "delivered");
  assert.equal(harness.state().deliveries[0].attemptCount, 1);
  assert.deepEqual(
    harness.calls.filter(([kind]) => kind === "transaction"),
    [
      ["transaction", "2026-07-25T01:00:00.000Z"],
      ["transaction", "2026-07-25T01:01:00.000Z"],
      ["transaction", "2026-07-25T01:02:00.000Z"],
    ],
  );
  assert.equal(
    harness.calls.some(([kind]) => kind === "start"),
    true,
  );
  assert.deepEqual(harness.calls.at(-1), ["close"]);
});

test("returns partial and releases a failed delivery for heartbeat retry", async () => {
  const harness = lifecycleHarness(ledger([
    link("root", "child", "stopped"),
  ]), {
    appServer: {
      async startTurn() {
        throw Object.assign(new Error("send failed"), {
          code: "APP_SERVER_REQUEST_FAILED",
        });
      },
    },
  });
  const result = await runLifecycleOperation({
    operation: "resume",
    projectRoot: "/project",
    taskId: "root",
  }, harness.options);

  assert.equal(result.run, "partial");
  assert.equal(result.deliveredActions, 0);
  assert.equal(result.pendingActions, 1);
  assert.equal(harness.state().links[0].lifecycle, "open");
  assert.equal(harness.state().deliveries[0].status, "ready");
  assert.equal(
    harness.state().deliveries[0].lastError.code,
    "APP_SERVER_REQUEST_FAILED",
  );
  assert.deepEqual(harness.calls.at(-1), ["close"]);
});

test("an idempotent lifecycle no-op does not start App control", async () => {
  const harness = lifecycleHarness(ledger([
    link("root", "child", "stopped"),
  ]));
  const result = await runLifecycleOperation({
    operation: "stop",
    projectRoot: "/project",
    taskId: "root",
  }, harness.options);

  assert.equal(result.run, "ok");
  assert.equal(result.changedLinks, 0);
  assert.equal(result.queuedActions, 0);
  assert.equal(result.deliveredActions, 0);
  assert.equal(result.pendingActions, 0);
  assert.equal(
    harness.calls.some(([kind]) =>
      kind === "start" || kind === "interrupt" || kind === "close"
    ),
    false,
  );
});

test("reports partial when leasing fails after lifecycle state commits", async () => {
  const harness = lifecycleHarness(ledger([
    link("root", "child", "stopped"),
  ]));
  const transact = harness.options.transactTaskLedger;
  let transactionCount = 0;
  harness.options.transactTaskLedger = async (...args) => {
    transactionCount += 1;
    if (transactionCount === 2) {
      throw new Error("lease storage unavailable");
    }
    return transact(...args);
  };

  await assert.rejects(
    runLifecycleOperation({
      operation: "resume",
      projectRoot: "/project",
      taskId: "root",
    }, harness.options),
    (error) => (
      error.code === "TASK_DELIVERY_STATE_FAILED"
      && error.run === "partial"
    ),
  );
  assert.equal(harness.state().links[0].lifecycle, "open");
  assert.equal(harness.state().deliveries[0].status, "ready");
});

async function withRealLedger(initialLinks, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lifecycle-ledger-"));
  const project = {
    root,
    key: `project:${root}`,
    stateFile: path.join(root, ".codex-small-loop", "state.json"),
  };
  const store = new AtomicJsonStore(project.stateFile);
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
          links: initialLinks,
          conversations: conversations(initialLinks),
        },
        result: null,
      }),
      { now: "2026-07-25T00:10:00.000Z" },
    );
    const baseOptions = {
      store,
      async resolveProject() {
        return project;
      },
      async assertRuntimeAvailable() {
        return { ledger: await readTaskLedger(store, project) };
      },
      transactTaskLedger,
    };

    await run({
      baseOptions,
      project,
      store,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("real resume commit exposes open work atomically", async () => {
  await withRealLedger([
    link("root", "child", "stopped"),
  ], async ({
    baseOptions,
    project,
    store,
  }) => {
    const result = await commitLifecycleOperation({
      operation: "resume",
      projectRoot: project.root,
      taskId: "root",
    }, {
      ...baseOptions,
      createOperationId: () => "resume-wakeup",
      now: () => "2026-07-25T01:00:00.000Z",
    });
    const finalState = await readTaskLedger(store, project);

    assert.equal(result.changedLinks, 1);
    assert.equal(finalState.links[0].lifecycle, "open");
    assert.equal(finalState.deliveries[0].status, "ready");
  });
});
