import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AtomicJsonStore } from "../source/atomic-json-store.mjs";
import {
  acknowledgeScheduledAppMessage,
  acknowledgeAppMessage,
  acknowledgeDelivery,
  compactTaskLedger,
  discardAppMessage,
  discardDelivery,
  enqueueDeliveries,
  enqueueAppMessage,
  hasPendingWork,
  initializeTaskLedger,
  leaseDeliveries,
  leaseAppMessages,
  markAppMessageScheduled,
  migrateTaskLedger,
  readTaskLedger,
  releaseDelivery,
  releaseAppMessage,
  transactTaskLedger,
  validateTaskLedger,
} from "../source/task-ledger.mjs";

const CREATED_AT = "2026-07-25T00:00:00.000Z";
const UPDATED_AT = "2026-07-25T00:15:00.000Z";

function project(root = "/absolute/project") {
  return {
    root,
    key: `key:${root}`,
    stateFile: `${root}/.codex-small-loop/state.json`,
  };
}

function pendingLaunch(phase, overrides = {}) {
  const childTaskId = new Set([
    "child_created",
    "role_started",
    "assignment_starting",
    "assignment_started",
    "fork_child_created",
    "fork_role_started",
    "fork_assignment_starting",
    "fork_assignment_started",
  ]).has(phase)
    ? "child-task"
    : null;
  const assignmentTurnId = new Set([
    "assignment_started",
    "fork_assignment_started",
  ]).has(phase)
    ? "assignment-turn"
    : null;
  const roleTurnId = new Set([
    "role_started",
    "assignment_starting",
    "assignment_started",
    "fork_role_started",
    "fork_assignment_starting",
    "fork_assignment_started",
  ]).has(phase)
    ? "role-turn"
    : null;

  return {
    assignment: "Inspect the project.",
    id: "launch-id",
    name: "Curie",
    parentTaskId: "parent-task",
    role: "primary",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    childTaskId,
    phase,
    assignmentTurnId,
    roleTurnId,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    lastError: null,
    ...overrides,
  };
}

function readyLink(overrides = {}) {
  return {
    parentTaskId: "parent-task",
    childTaskId: "child-task",
    role: "primary",
    lifecycle: "open",
    acceptanceReason: null,
    historyFile: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    acceptedAt: null,
    ...overrides,
  };
}

function awaitingConversation(overrides = {}) {
  return {
    id: "conversation-1",
    initiatorTaskId: "parent-task",
    initiatorRole: "primary",
    responderTaskId: "child-task",
    responderRole: "execute",
    state: "awaiting_reply",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    repliedAt: null,
    acceptedAt: null,
    ...overrides,
  };
}

function recoveryDelivery(overrides = {}) {
  return {
    id: "delivery-id",
    kind: "recovery",
    conversationId: "conversation-1",
    targetTaskId: "child-task",
    parentTaskId: "parent-task",
    dedupeKey: "recovery:child-task:observed-turn",
    operationId: null,
    observedTurnId: "observed-turn",
    resultTurnId: null,
    status: "ready",
    attemptCount: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    deliveredAt: null,
    lastError: null,
    ...overrides,
  };
}

function state(overrides = {}) {
  const currentProject = project();
  const snapshot = {
    version: 10,
    revision: 0,
    projectRoot: currentProject.root,
    projectKey: currentProject.key,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    managedTasks: [],
    pendingLaunches: [],
    links: [],
    conversations: [],
    deliveries: [],
    appMessages: [],
    ...overrides,
  };
  if (overrides.managedTasks === undefined) {
    const seen = new Set();
    snapshot.managedTasks = snapshot.links
      .filter(({ childTaskId }) => {
        if (seen.has(childTaskId)) return false;
        seen.add(childTaskId);
        return true;
      })
      .map((link) => ({
        taskId: link.childTaskId,
        name: link.childTaskId,
        role: link.role,
        createdAt: link.createdAt,
      }));
  }
  if (overrides.conversations === undefined) {
    snapshot.conversations = snapshot.links
      .filter(({ lifecycle }) => lifecycle === "open")
      .map((currentLink, index) => awaitingConversation({
        id: `conversation-${index + 1}`,
        initiatorTaskId: currentLink.parentTaskId,
        responderTaskId: currentLink.childTaskId,
        responderRole: currentLink.role,
        createdAt: currentLink.createdAt,
        updatedAt: currentLink.updatedAt,
      }));
  }
  return snapshot;
}

async function withStore(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-ledger-"));
  const stateFile = path.join(directory, ".codex-small-loop", "state.json");
  const currentProject = {
    root: directory,
    key: `key:${directory}`,
    stateFile,
  };
  const store = new AtomicJsonStore(stateFile);

  try {
    await run({
      project: currentProject,
      stateFile,
      store,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function expectLedgerError(run, code, causeCode) {
  assert.throws(run, (error) => {
    assert.equal(error.code, code);
    assert.equal(typeof error.operation, "string");
    assert.equal(typeof error.stateFile, "string");

    if (causeCode) {
      assert.equal(error.cause?.code, causeCode);
    }

    return true;
  });
}

test("compacts accepted task branches without touching active siblings", () => {
  const completedParent = readyLink({
    childTaskId: "accepted-parent",
    lifecycle: "accepted",
    acceptanceReason: "direct",
    acceptedAt: UPDATED_AT,
  });
  const completedChild = readyLink({
    parentTaskId: "accepted-parent",
    childTaskId: "accepted-child",
    lifecycle: "accepted",
    acceptanceReason: "ancestor",
    acceptedAt: UPDATED_AT,
  });
  const activeSibling = readyLink({
    childTaskId: "active-child",
  });
  const current = state({
    links: [completedParent, completedChild, activeSibling],
    deliveries: [
      recoveryDelivery({
        id: "accepted-delivery",
        targetTaskId: "accepted-child",
        parentTaskId: "accepted-parent",
        dedupeKey: "recovery:accepted-child:observed-turn",
        status: "delivered",
        attemptCount: 1,
        deliveredAt: UPDATED_AT,
      }),
      recoveryDelivery({
        id: "active-delivery",
        targetTaskId: "active-child",
        dedupeKey: "recovery:active-child:observed-turn",
        status: "delivered",
        attemptCount: 1,
        deliveredAt: UPDATED_AT,
      }),
    ],
    appMessages: [{
      id: "terminal-message",
      sourceTaskId: "accepted-child",
      targetTaskId: "root-task",
      text: "done",
      status: "delivered",
      attemptCount: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      terminalAt: UPDATED_AT,
      terminalReason: null,
      lastError: null,
    }],
  });

  const compacted = compactTaskLedger(current);

  assert.deepEqual(
    compacted.links.map(({ childTaskId }) => childTaskId),
    ["active-child"],
  );
  assert.deepEqual(
    compacted.managedTasks.map(({ taskId }) => taskId),
    ["active-child"],
  );
  assert.deepEqual(
    compacted.deliveries.map(({ id }) => id),
    ["active-delivery"],
  );
  assert.deepEqual(compacted.appMessages, []);
});

test("retains a accepted branch while its child report is pending", () => {
  const current = state({
    links: [readyLink({
      lifecycle: "accepted",
      acceptanceReason: "direct",
      acceptedAt: UPDATED_AT,
    })],
    appMessages: [{
      id: "pending-message",
      sourceTaskId: "child-task",
      targetTaskId: "parent-task",
      text: "done",
      status: "ready",
      attemptCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      terminalAt: null,
      terminalReason: null,
      lastError: null,
    }],
  });

  const compacted = compactTaskLedger(current);

  assert.equal(compacted.links.length, 1);
  assert.equal(compacted.managedTasks.length, 1);
  assert.equal(compacted.appMessages.length, 1);
});

test("initializes version 10 idempotently", async () => {
  await withStore(async ({
    project: currentProject,
    store,
  }) => {
    const initialized = await initializeTaskLedger(
      store,
      currentProject,
      CREATED_AT,
    );
    const repeated = await initializeTaskLedger(
      store,
      currentProject,
      UPDATED_AT,
    );

    assert.deepEqual(initialized, {
      version: 10,
      revision: 0,
      projectRoot: currentProject.root,
      projectKey: currentProject.key,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      managedTasks: [],
      pendingLaunches: [],
      links: [],
      conversations: [],
      deliveries: [],
      appMessages: [],
    });
    assert.deepEqual(repeated, initialized);
    assert.ok(Object.isFrozen(initialized));
  });
});

test("initialization rejects an incompatible stored ledger", async () => {
  await withStore(async ({
    store,
    project: currentProject,
  }) => {
    const legacy = {
      version: 9,
      revision: 4,
      projectRoot: currentProject.root,
      projectKey: currentProject.key,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      managedTasks: [],
      pendingLaunches: [],
      links: [],
      conversations: [],
      deliveries: [],
      appMessages: [],
    };
    await store.initialize(legacy);

    await assert.rejects(
      initializeTaskLedger(store, currentProject, UPDATED_AT),
      (error) => error?.code === "LEDGER_VERSION_UNSUPPORTED",
    );
  });
});

test("validates an exact immutable version 10 snapshot", () => {
  const raw = state({
    pendingLaunches: [
      pendingLaunch("assignment_started", {
        lastError: {
          code: "LAUNCH_ASSIGNMENT_FAILED",
          message: "bounded diagnostic",
          at: UPDATED_AT,
        },
      }),
    ],
    links: [
      readyLink({
        childTaskId: "ready-child",
        historyFile: "/absolute/history.jsonl",
      }),
    ],
    deliveries: [
      recoveryDelivery({
        targetTaskId: "ready-child",
        dedupeKey: "recovery:ready-child:observed-turn",
      }),
    ],
  });
  const original = structuredClone(raw);
  const validated = validateTaskLedger(raw, project());

  assert.deepEqual(validated, original);
  assert.deepEqual(raw, original);
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.pendingLaunches));
  assert.ok(Object.isFrozen(validated.pendingLaunches[0]));
  assert.ok(Object.isFrozen(validated.links[0]));
  assert.ok(Object.isFrozen(validated.deliveries[0]));
  assert.throws(() => validated.links.push(readyLink()), TypeError);
});

test("records fork context provenance separately from launch ancestry", () => {
  const raw = state({
    pendingLaunches: [
      pendingLaunch("fork_queued", {
        sourceTaskId: "execute-task",
      }),
    ],
    links: [
      readyLink({
        childTaskId: "interviewer-task",
        role: "interviewer",
        sourceTaskId: "execute-task",
      }),
    ],
  });

  const validated = validateTaskLedger(raw, project());

  assert.equal(
    validated.pendingLaunches[0].parentTaskId,
    "parent-task",
  );
  assert.equal(
    validated.pendingLaunches[0].sourceTaskId,
    "execute-task",
  );
  assert.equal(validated.links[0].parentTaskId, "parent-task");
  assert.equal(validated.links[0].sourceTaskId, "execute-task");
});

test("validates persisted Conversation obligations", () => {
  const raw = state({
    conversations: [awaitingConversation()],
  });

  const validated = validateTaskLedger(raw, project());

  assert.deepEqual(validated.conversations, raw.conversations);
  assert.ok(Object.isFrozen(validated.conversations[0]));

  expectLedgerError(
    () => validateTaskLedger(state({
      conversations: [
        awaitingConversation(),
        awaitingConversation({
          id: "conversation-2",
          initiatorTaskId: "interviewer-task",
        }),
      ],
    }), project()),
    "LEDGER_SCHEMA_INVALID",
    "MESSAGE_TARGET_BUSY",
  );
});

test("rejects unsupported versions, extra fields, and project mismatches", () => {
  const missingVersion = state();
  delete missingVersion.version;

  expectLedgerError(
    () => validateTaskLedger(missingVersion, project()),
    "LEDGER_SCHEMA_INVALID",
  );
  expectLedgerError(
    () => validateTaskLedger(state({ version: 9 }), project()),
    "LEDGER_VERSION_UNSUPPORTED",
  );
  expectLedgerError(
    () => validateTaskLedger(state({ conversation: "must not persist" }), project()),
    "LEDGER_SCHEMA_INVALID",
  );
  expectLedgerError(
    () => validateTaskLedger(state(), project("/different/project")),
    "LEDGER_PROJECT_MISMATCH",
  );
});

test("accepts every pending launch phase and rejects inconsistent phase fields", () => {
  for (
    const phase
    of [
      "prepared",
      "creating",
      "child_created",
      "role_started",
      "assignment_starting",
      "assignment_started",
      "fork_queued",
      "fork_creating",
      "fork_child_created",
      "fork_role_started",
      "fork_assignment_starting",
      "fork_assignment_started",
    ]
  ) {
    const validated = validateTaskLedger(
      state({ pendingLaunches: [pendingLaunch(phase)] }),
      project(),
    );
    assert.equal(validated.pendingLaunches[0].phase, phase);
  }

  for (const invalid of [
    pendingLaunch("prepared", { childTaskId: "unexpected" }),
    pendingLaunch("creating", { assignmentTurnId: "unexpected" }),
    pendingLaunch("child_created", { childTaskId: null }),
    pendingLaunch("child_created", { assignmentTurnId: "unexpected" }),
    pendingLaunch("role_started", { roleTurnId: null }),
    pendingLaunch("assignment_starting", {
      assignmentTurnId: "unexpected",
    }),
    pendingLaunch("assignment_started", { assignmentTurnId: null }),
    pendingLaunch("fork_queued", {
      model: "gpt-5.6-sol",
      reasoningEffort: "bogus",
    }),
    pendingLaunch("fork_queued", {
      model: "gpt-5.6-sol",
      reasoningEffort: null,
    }),
    pendingLaunch("fork_queued", {
      serviceTier: "",
    }),
  ]) {
    expectLedgerError(
      () => validateTaskLedger(state({ pendingLaunches: [invalid] }), project()),
      "LEDGER_SCHEMA_INVALID",
    );
  }
});

test("rejects duplicate launches and a pending child already in ready links", () => {
  expectLedgerError(
    () => validateTaskLedger(state({
      pendingLaunches: [
        pendingLaunch("prepared"),
        pendingLaunch("creating"),
      ],
    }), project()),
    "LEDGER_SCHEMA_INVALID",
  );
  expectLedgerError(
    () => validateTaskLedger(state({
      pendingLaunches: [pendingLaunch("child_created")],
      links: [readyLink()],
    }), project()),
    "LEDGER_SCHEMA_INVALID",
  );
});

test("rejects cycles and reownership across retained and pending Task relationships", () => {
  const cases = [
    {
      links: [readyLink({ parentTaskId: "root", childTaskId: "child" })],
      pendingLaunches: [pendingLaunch("child_created", {
        id: "cycle-launch",
        parentTaskId: "child",
        childTaskId: "root",
      })],
    },
    {
      links: [readyLink({ parentTaskId: "root", childTaskId: "child" })],
      pendingLaunches: [pendingLaunch("child_created", {
        id: "reown-root",
        parentTaskId: "other-root",
        childTaskId: "root",
      })],
    },
    {
      links: [readyLink({ parentTaskId: "root", childTaskId: "child" })],
      pendingLaunches: [pendingLaunch("child_created", {
        id: "reown-child",
        parentTaskId: "other-parent",
        childTaskId: "child",
      })],
    },
    {
      links: [],
      pendingLaunches: [
        pendingLaunch("child_created", {
          id: "pending-a",
          parentTaskId: "pending-a-parent",
          childTaskId: "pending-b-parent",
        }),
        pendingLaunch("child_created", {
          id: "pending-b",
          parentTaskId: "pending-b-parent",
          childTaskId: "pending-a-parent",
        }),
      ],
    },
  ];
  for (const candidate of cases) {
    expectLedgerError(
      () => validateTaskLedger(state(candidate), project()),
      "LEDGER_SCHEMA_INVALID",
    );
  }
});

test("validates lifecycle acceptance metadata through Task Forest", () => {
  const accepted = readyLink({
    lifecycle: "accepted",
    acceptanceReason: "direct",
    acceptedAt: UPDATED_AT,
  });

  assert.equal(
    validateTaskLedger(state({ links: [accepted] }), project())
      .links[0].acceptanceReason,
    "direct",
  );

  for (const invalid of [
    readyLink({ lifecycle: "open", acceptedAt: UPDATED_AT }),
    readyLink({ lifecycle: "stopped", acceptanceReason: "direct" }),
    readyLink({ lifecycle: "accepted", acceptanceReason: null }),
    readyLink({
      lifecycle: "accepted",
      acceptanceReason: "unknown",
      acceptedAt: UPDATED_AT,
    }),
  ]) {
    expectLedgerError(
      () => validateTaskLedger(state({ links: [invalid] }), project()),
      "LEDGER_SCHEMA_INVALID",
    );
  }

  expectLedgerError(
    () => validateTaskLedger(state({
      links: [
        readyLink({
          parentTaskId: "A",
          childTaskId: "B",
        }),
        readyLink({
          parentTaskId: "B",
          childTaskId: "A",
        }),
      ],
    }), project()),
    "LEDGER_SCHEMA_INVALID",
    "TASK_FOREST_CYCLE",
  );
});

test("validates delivery cause, state, dedupe, and direct relationship", () => {
  const linkRecord = readyLink();
  const validStates = [
    recoveryDelivery(),
    recoveryDelivery({
      id: "leased-delivery",
      dedupeKey: "recovery:child-task:second-turn",
      observedTurnId: "second-turn",
      status: "leased",
      attemptCount: 1,
      leaseOwner: "worker-id",
      leaseExpiresAt: "2026-07-25T00:30:00.000Z",
    }),
    recoveryDelivery({
      id: "delivered-delivery",
      dedupeKey: "recovery:child-task:third-turn",
      observedTurnId: "third-turn",
      status: "delivered",
      attemptCount: 1,
      deliveredAt: UPDATED_AT,
    }),
    recoveryDelivery({
      id: "resume-delivery",
      kind: "resume",
      dedupeKey: "resume:operation-id:child-task",
      operationId: "operation-id",
      observedTurnId: null,
    }),
  ];

  validateTaskLedger(state({
    links: [linkRecord],
    deliveries: validStates,
  }), project());

  for (const invalid of [
    recoveryDelivery({ parentTaskId: "wrong-parent" }),
    recoveryDelivery({ operationId: "not-null" }),
    recoveryDelivery({ dedupeKey: "wrong" }),
    recoveryDelivery({ status: "leased", leaseOwner: null }),
    recoveryDelivery({
      status: "leased",
      attemptCount: 1,
      leaseOwner: "worker-id",
      leaseExpiresAt: UPDATED_AT,
    }),
    recoveryDelivery({ status: "delivered", deliveredAt: null }),
    recoveryDelivery({
      status: "delivered",
      deliveredAt: UPDATED_AT,
      attemptCount: 0,
    }),
  ]) {
    expectLedgerError(
      () => validateTaskLedger(state({
        links: [linkRecord],
        deliveries: [invalid],
      }), project()),
      "LEDGER_SCHEMA_INVALID",
    );
  }
});

test("increments revisions only for committed state changes", async () => {
  await withStore(async ({
    project: currentProject,
    store,
  }) => {
    await initializeTaskLedger(
      store,
      currentProject,
      CREATED_AT,
    );

    const changed = await transactTaskLedger(
      store,
      currentProject,
      (current) => ({
        state: {
          ...current,
          managedTasks: [{
            taskId: "child-task",
            name: "child-task",
            role: "primary",
            createdAt: CREATED_AT,
          }],
          links: [readyLink()],
        },
        result: "added",
      }),
      { now: UPDATED_AT },
    );

    assert.equal(changed.result, "added");
    assert.equal(changed.state.revision, 1);
    assert.equal(changed.state.updatedAt, UPDATED_AT);

    let hooksCalled = 0;
    const unchanged = await transactTaskLedger(
      store,
      currentProject,
      (current) => ({ state: current, result: "same" }),
      {
        now: "2026-07-25T01:00:00.000Z",
        beforeCommit() {
          hooksCalled += 1;
        },
        afterCommit() {
          hooksCalled += 1;
        },
      },
    );

    assert.equal(unchanged.result, "same");
    assert.equal(unchanged.state.revision, 1);
    assert.equal(unchanged.state.updatedAt, UPDATED_AT);
    assert.equal(hooksCalled, 0);
    assert.deepEqual(
      await readTaskLedger(store, currentProject),
      unchanged.state,
    );
  });
});

test("rejects asynchronous transforms and preserves the current revision", async () => {
  await withStore(async ({
    project: currentProject,
    store,
  }) => {
    await initializeTaskLedger(
      store,
      currentProject,
      CREATED_AT,
    );

    await assert.rejects(
      transactTaskLedger(
        store,
        currentProject,
        async (current) => ({ state: current, result: null }),
        { now: UPDATED_AT },
      ),
      /synchronous/i,
    );
    assert.equal((await store.read()).revision, 0);
  });
});

test("calculates project activity from launches, Conversations, and deliveries", () => {
  assert.equal(hasPendingWork(state()), false);
  assert.equal(
    hasPendingWork(state({ pendingLaunches: [pendingLaunch("prepared")] })),
    true,
  );
  assert.equal(
    hasPendingWork(state({
      conversations: [awaitingConversation()],
    })),
    true,
  );
  assert.equal(
    hasPendingWork(state({
      links: [readyLink({ lifecycle: "stopped" })],
      conversations: [awaitingConversation()],
    })),
    false,
  );
  assert.equal(
    hasPendingWork(state({
      conversations: [{
        ...awaitingConversation(),
        state: "replied",
        repliedAt: UPDATED_AT,
      }],
    })),
    false,
  );
  assert.equal(
    hasPendingWork(state({
      links: [readyLink()],
      deliveries: [recoveryDelivery({ status: "ready" })],
    })),
    true,
  );
  assert.equal(
    hasPendingWork(state({
      links: [readyLink({ lifecycle: "accepted", acceptanceReason: "direct", acceptedAt: UPDATED_AT })],
      deliveries: [recoveryDelivery({
        status: "delivered",
        deliveredAt: UPDATED_AT,
      })],
    })),
    false,
  );
});

test("promotes a pending launch to one ready link atomically", async () => {
  await withStore(async ({
    project: currentProject,
    store,
  }) => {
    await initializeTaskLedger(
      store,
      currentProject,
      CREATED_AT,
    );
    await transactTaskLedger(
      store,
      currentProject,
      (current) => ({
        state: {
          ...current,
          pendingLaunches: [pendingLaunch("assignment_started")],
        },
        result: null,
      }),
      { now: UPDATED_AT },
    );

    const promoted = await transactTaskLedger(
      store,
      currentProject,
      (current) => ({
        state: {
          ...current,
          pendingLaunches: [],
          managedTasks: [{
            taskId: "child-task",
            name: "Curie",
            role: "primary",
            createdAt: "2026-07-25T00:20:00.000Z",
          }],
          links: [readyLink()],
        },
        result: "ready",
      }),
      { now: "2026-07-25T00:20:00.000Z" },
    );

    assert.equal(promoted.result, "ready");
    assert.deepEqual(promoted.state.pendingLaunches, []);
    assert.deepEqual(promoted.state.links, [readyLink()]);
    assert.equal(promoted.state.revision, 2);
  });
});

test("enqueues fixed deliveries and returns an existing deduplicated action", () => {
  const current = validateTaskLedger(state({
    links: [readyLink()],
  }), project());
  const action = {
    id: "delivery-id",
    kind: "recovery",
    conversationId: "conversation-1",
    targetTaskId: "child-task",
    parentTaskId: "parent-task",
    operationId: null,
    observedTurnId: "observed-turn",
  };
  const first = enqueueDeliveries(current, [action], {
    now: UPDATED_AT,
  });
  const duplicate = enqueueDeliveries(first.state, [{
    ...action,
    id: "unused-duplicate-id",
  }], {
    now: "2026-07-25T00:20:00.000Z",
  });

  assert.equal(first.state.deliveries.length, 1);
  assert.equal(first.added[0].id, "delivery-id");
  assert.deepEqual(duplicate.state, first.state);
  assert.deepEqual(duplicate.added[0], first.state.deliveries[0]);
  assert.equal(duplicate.added[0].id, "delivery-id");
});

test("keeps a delivered recovery dedupe boundary protected", () => {
  const delivered = recoveryDelivery({
    status: "delivered",
    attemptCount: 1,
    deliveredAt: UPDATED_AT,
  });
  const current = validateTaskLedger(state({
    links: [readyLink()],
    deliveries: [delivered],
  }), project());
  const duplicate = enqueueDeliveries(current, [{
    id: "replacement-id",
    kind: "recovery",
    conversationId: "conversation-1",
    targetTaskId: "child-task",
    parentTaskId: "parent-task",
    operationId: null,
    observedTurnId: "observed-turn",
  }], {
    now: "2026-07-25T00:30:00.000Z",
  });

  assert.deepEqual(duplicate.state, current);
  assert.equal(duplicate.added[0].id, "delivery-id");
  assert.equal(duplicate.added[0].status, "delivered");
});

test("leases ready actions, releases failures, and reclaims expired leases", () => {
  const current = validateTaskLedger(state({
    links: [readyLink()],
    deliveries: [recoveryDelivery()],
  }), project());
  const firstLease = leaseDeliveries(current, {
    leaseOwner: "worker-one",
    leaseExpiresAt: "2026-07-25T00:30:00.000Z",
    now: UPDATED_AT,
  });

  assert.equal(firstLease.leased.length, 1);
  assert.equal(firstLease.leased[0].attemptCount, 1);
  assert.equal(firstLease.leased[0].leaseOwner, "worker-one");

  const released = releaseDelivery(
    firstLease.state,
    "delivery-id",
    "worker-one",
    {
      code: "SEND_FAILED",
      message: "x".repeat(2_000),
    },
    "2026-07-25T00:20:00.000Z",
  );

  assert.equal(released.deliveries[0].status, "ready");
  assert.equal(released.deliveries[0].leaseOwner, null);
  assert.equal(released.deliveries[0].lastError.code, "SEND_FAILED");
  assert.equal(released.deliveries[0].lastError.message.length, 1_024);

  const leasedAgain = leaseDeliveries(released, {
    leaseOwner: "worker-one",
    leaseExpiresAt: "2026-07-25T00:30:00.000Z",
    now: "2026-07-25T00:21:00.000Z",
  });
  const reclaimed = leaseDeliveries(leasedAgain.state, {
    leaseOwner: "worker-two",
    leaseExpiresAt: "2026-07-25T00:45:00.000Z",
    now: "2026-07-25T00:31:00.000Z",
  });

  assert.equal(reclaimed.leased[0].leaseOwner, "worker-two");
  assert.equal(reclaimed.leased[0].attemptCount, 3);
  expectLedgerError(
    () => acknowledgeDelivery(
      reclaimed.state,
      "delivery-id",
      "worker-one",
      "2026-07-25T00:32:00.000Z",
    ),
    "DELIVERY_LEASE_CONFLICT",
  );
  expectLedgerError(
    () => releaseDelivery(
      reclaimed.state,
      "delivery-id",
      "worker-one",
      { code: "STALE", message: "stale owner" },
      "2026-07-25T00:32:00.000Z",
    ),
    "DELIVERY_LEASE_CONFLICT",
  );

  const acknowledged = acknowledgeDelivery(
    reclaimed.state,
    "delivery-id",
    "worker-two",
    "2026-07-25T00:32:00.000Z",
    { resultTurnId: "recovery-result-turn" },
  );
  assert.equal(acknowledged.deliveries[0].status, "delivered");
  assert.equal(acknowledged.deliveries[0].deliveredAt, "2026-07-25T00:32:00.000Z");
  assert.equal(acknowledged.deliveries[0].observedTurnId, "observed-turn");
  assert.equal(acknowledged.deliveries[0].resultTurnId, "recovery-result-turn");
  assert.equal(
    acknowledged.deliveries[0].dedupeKey,
    "recovery:child-task:observed-turn",
  );
});

test("discards only an unsent delivery leased by the same owner", () => {
  const current = validateTaskLedger(state({
    links: [readyLink()],
    deliveries: [recoveryDelivery({
      status: "leased",
      attemptCount: 1,
      leaseOwner: "worker-one",
      leaseExpiresAt: "2026-07-25T00:30:00.000Z",
    })],
  }), project());

  expectLedgerError(
    () => discardDelivery(
      current,
      "delivery-id",
      "worker-two",
      UPDATED_AT,
    ),
    "DELIVERY_LEASE_CONFLICT",
  );

  const discarded = discardDelivery(
    current,
    "delivery-id",
    "worker-one",
    UPDATED_AT,
  );
  assert.deepEqual(discarded.deliveries, []);
});

test("returns stable not-found errors for delivery operations", () => {
  const current = validateTaskLedger(state(), project());

  expectLedgerError(
    () => acknowledgeDelivery(
      current,
      "missing",
      "worker",
      UPDATED_AT,
    ),
    "DELIVERY_NOT_FOUND",
  );
});

test("allows an App message to target a managed Parent", () => {
  const current = validateTaskLedger(state({
    managedTasks: [{
      taskId: "managed-parent",
      name: "Ada",
      role: "primary",
      createdAt: CREATED_AT,
    }],
  }), project());

  const queued = enqueueAppMessage(current, {
    id: "fork-ready-message",
    sourceTaskId: "managed-child",
    targetTaskId: "managed-parent",
    text: "=== Codex Small Loop · Primary ← Execute ===\n\n=== Message ===\nDone.",
  }, { now: UPDATED_AT });

  assert.equal(queued.queued.targetTaskId, "managed-parent");
  assert.equal(queued.queued.status, "ready");
});

test("leases App messages and records scheduled, delivered, retry, and archived outcomes", () => {
  let current = validateTaskLedger(state(), project());
  current = enqueueAppMessage(current, {
    id: "message-1",
    targetTaskId: "app-task",
    text: "=== Codex Small Loop · Primary ← Review ===\n\n=== Message ===\nDone.",
  }, { now: CREATED_AT }).state;
  let leased = leaseAppMessages(current, {
    now: UPDATED_AT,
    leaseExpiresAt: "2026-07-25T00:30:00.000Z",
    leaseOwner: "runtime-turn",
    limit: 1,
  });
  assert.equal(leased.leased[0].text, current.appMessages[0].text);

  current = releaseAppMessage(
    leased.state,
    "message-1",
    "runtime-turn",
    new Error("temporary"),
    "2026-07-25T00:16:00.000Z",
  );
  assert.equal(current.appMessages[0].status, "ready");
  assert.equal(current.appMessages[0].lastError.message, "temporary");

  leased = leaseAppMessages(current, {
    now: "2026-07-25T00:17:00.000Z",
    leaseExpiresAt: "2026-07-25T00:30:00.000Z",
    leaseOwner: "runtime-turn-2",
  });
  current = markAppMessageScheduled(
    leased.state,
    "message-1",
    "runtime-turn-2",
    "2026-07-25T00:18:00.000Z",
  );
  assert.equal(current.appMessages[0].status, "scheduled");
  assert.equal(hasPendingWork(current), true);

  current = acknowledgeScheduledAppMessage(
    current,
    "message-1",
    "2026-07-25T00:18:30.000Z",
  );
  assert.equal(current.appMessages[0].status, "delivered");

  current = enqueueAppMessage(current, {
    id: "message-2",
    targetTaskId: "archived-app-task",
    text: "Message",
  }, { now: "2026-07-25T00:19:00.000Z" }).state;
  leased = leaseAppMessages(current, {
    now: "2026-07-25T00:20:00.000Z",
    leaseExpiresAt: "2026-07-25T00:30:00.000Z",
    leaseOwner: "runtime-turn-3",
  });
  current = discardAppMessage(
    leased.state,
    "message-2",
    "runtime-turn-3",
    "2026-07-25T00:21:00.000Z",
  );
  assert.equal(current.appMessages[1].status, "discarded");
  assert.equal(current.appMessages[1].terminalReason, "target_archived");
});

test("accepts only the current ledger version", () => {
  const current = state();
  assert.deepEqual(
    migrateTaskLedger(current, 10, { project: project() }),
    validateTaskLedger(current, project()),
  );
  expectLedgerError(
    () => migrateTaskLedger(current, 9, {
      project: project(),
    }),
    "LEDGER_VERSION_UNSUPPORTED",
  );
  expectLedgerError(
    () => migrateTaskLedger({ ...current, version: 9 }, 10, {
      project: project(),
    }),
    "LEDGER_VERSION_UNSUPPORTED",
  );
});
