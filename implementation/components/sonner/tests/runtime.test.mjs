import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeProjection } from "../source/runtime.mjs";

const project = Object.freeze({ root: "/project", stateFile: "/project/.codex-small-loop/state.json" });
const at = "2026-08-10T00:00:00.000Z";

function link(parentTaskId, childTaskId, lifecycle = "open", createdAt = at) {
  return {
    parentTaskId,
    childTaskId,
    role: childTaskId.includes("primary") ? "primary" : "execute",
    lifecycle,
    historyFile: null,
    createdAt,
    updatedAt: createdAt,
    acceptedAt: lifecycle === "accepted" ? createdAt : null,
    acceptanceReason: lifecycle === "accepted" ? "direct" : null,
  };
}

function ledger(overrides = {}) {
  return {
    links: [
      link("root-old", "old-primary", "accepted"),
      link("root-new", "new-primary"),
      link("new-primary", "new-execute"),
      link("new-primary", "new-review"),
    ],
    managedTasks: [
      { taskId: "old-primary", name: "old-primary-name", role: "primary", createdAt: at },
      { taskId: "new-primary", name: "new-primary-name", role: "primary", createdAt: at },
      { taskId: "new-execute", name: "new-execute-name", role: "execute", createdAt: at },
      { taskId: "new-review", name: "new-review-name", role: "review", createdAt: at },
    ],
    conversations: [],
    pendingLaunches: [],
    deliveries: [],
    appMessages: [],
    ...overrides,
  };
}

function observer(states, seen = null) {
  return async (requests) => {
    seen?.push(...requests.map(({ taskId }) => taskId));
    return requests.map(({ taskId }) => ({
      taskId,
      location: "active",
      latestTurnId: `turn-${taskId}`,
      turnState: states[taskId] ?? "ended",
      diagnostics: [],
    }));
  };
}

function projectOperation() {
  const controller = new AbortController();
  let reason = null;
  return {
    signal: controller.signal,
    deadline: Date.now() + 5_000,
    remainingMs: () => 5_000,
    abort(error = Object.assign(new Error("expired"), { code: "SONNER_OPERATION_ABORTED" })) {
      if (controller.signal.aborted) return false;
      reason = error;
      controller.abort(error);
      return true;
    },
    throwIfAborted() { if (controller.signal.aborted) throw reason; },
  };
}

test("publishes only non-ended Tasks from open execution relationships", async () => {
  const seen = [];
  const result = await buildRuntimeProjection(project, {
    readLedger: async () => ledger(),
    observeTasks: observer({
      "root-new": "in_progress",
      "new-review": "aborted",
      "old-primary": "in_progress",
    }, seen),
    readDiagnostic: async () => null,
  });

  assert.deepEqual(Object.keys(result), ["status", "health", "reasons", "tasks"]);
  assert.equal(result.status, "available");
  assert.equal(result.health, "attention");
  assert.deepEqual(result.reasons, ["task_aborted"]);
  assert.equal(seen.includes("root-old"), false);
  assert.equal(seen.includes("old-primary"), false);
  assert.deepEqual(result.tasks, [
    { id: "new-review", name: "new-review-name", role: "review", turnState: "aborted" },
    { id: "root-new", name: null, role: "controller", turnState: "running" },
  ]);
  assert.equal(JSON.stringify(result).includes("ended"), false);
});

test("a healthy runtime with no active relationships returns an empty Task list", async () => {
  let observed = false;
  const result = await buildRuntimeProjection(project, {
    readLedger: async () => ledger({ links: [link("root-old", "old-primary", "accepted")] }),
    observeTasks: async () => { observed = true; return []; },
    readDiagnostic: async () => null,
  });
  assert.deepEqual(result, { status: "available", health: "ok", reasons: [], tasks: [] });
  assert.equal(observed, false);
});

test("pending launch Tasks remain visible without publishing coordination payloads", async () => {
  const result = await buildRuntimeProjection(project, {
    readLedger: async () => ledger({
      pendingLaunches: [{
        id: "launch-private",
        parentTaskId: "new-primary",
        childTaskId: "new-child",
        sourceTaskId: null,
        name: "new-child-name",
        role: "execute",
        assignment: "DO_NOT_PUBLISH",
        createdAt: at,
      }],
      conversations: [{ id: "private", initiatorTaskId: "new-primary", responderTaskId: "new-child", state: "replied", body: "DO_NOT_PUBLISH" }],
    }),
    observeTasks: observer({ "new-child": "not_started" }),
    readDiagnostic: async () => null,
  });
  assert.deepEqual(result.tasks.find(({ id }) => id === "new-child"), {
    id: "new-child", name: "new-child-name", role: "execute", turnState: "not_started",
  });
  assert.equal(JSON.stringify(result).includes("DO_NOT_PUBLISH"), false);
  assert.equal(Object.hasOwn(result, "coordination"), false);
});

test("unknown observations and runtime diagnostics fail health closed", async () => {
  const unknown = await buildRuntimeProjection(project, {
    readLedger: async () => ledger(),
    observeTasks: async (requests) => requests.map(({ taskId }) => ({
      taskId, turnState: "unknown", diagnostics: [{ code: "TASK_HISTORY_MISSING" }],
    })),
    readDiagnostic: async () => null,
  });
  assert.equal(unknown.health, "unknown");
  assert.deepEqual(unknown.reasons, ["history_unavailable"]);
  assert.ok(unknown.tasks.every(({ turnState }) => turnState === "unknown"));

  const attention = await buildRuntimeProjection(project, {
    readLedger: async () => ledger(),
    observeTasks: observer({}),
    readDiagnostic: async () => ({ code: "RECOVERY_SUPERVISOR_FAILED" }),
  });
  assert.deepEqual(attention, {
    status: "available", health: "attention", reasons: ["runtime_diagnostic"], tasks: [],
  });
});

test("incomplete, duplicate, and failed observations become bounded unknown Tasks", async () => {
  const incomplete = await buildRuntimeProjection(project, {
    readLedger: async () => ledger(),
    observeTasks: async () => [
      { taskId: "root-new", turnState: "ended", diagnostics: [] },
      { taskId: "root-new", turnState: "in_progress", diagnostics: [] },
      { taskId: "not-requested", turnState: "in_progress", diagnostics: [] },
    ],
    readDiagnostic: async () => null,
  });
  assert.equal(incomplete.health, "unknown");
  assert.equal(incomplete.tasks.some(({ id }) => id === "not-requested"), false);
  assert.ok(incomplete.tasks.some(({ turnState }) => turnState === "unknown"));

  const failed = await buildRuntimeProjection(project, {
    readLedger: async () => ledger(),
    observeTasks: async () => { throw new Error("private observer failure"); },
    readDiagnostic: async () => null,
  });
  assert.equal(failed.health, "unknown");
  assert.deepEqual(failed.reasons, ["observation_failed"]);
  assert.equal(JSON.stringify(failed).includes("private observer failure"), false);
});

test("history and diagnostic share one operation and abort rejects outward", async () => {
  const session = projectOperation();
  const started = [];
  const waitForAbort = () => new Promise((resolve, reject) => {
    session.signal.addEventListener("abort", () => reject(session.signal.reason), { once: true });
  });
  const projection = buildRuntimeProjection(project, {
    projectSession: session,
    readLedger: async () => ledger(),
    observeTasks: async (_requests, options) => {
      started.push("history"); assert.equal(options.session, session); return waitForAbort();
    },
    readDiagnostic: async () => { started.push("diagnostic"); return waitForAbort(); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["diagnostic", "history"]);
  session.abort();
  await assert.rejects(projection, { code: "SONNER_OPERATION_ABORTED" });
});

test("an expired operation admits neither observation phase", async () => {
  const session = projectOperation(); session.abort();
  let observations = 0; let diagnostics = 0;
  await assert.rejects(buildRuntimeProjection(project, {
    projectSession: session,
    readLedger: async () => ledger(),
    observeTasks: async () => { observations += 1; return []; },
    readDiagnostic: async () => { diagnostics += 1; return null; },
  }), { code: "SONNER_OPERATION_ABORTED" });
  assert.equal(observations, 0); assert.equal(diagnostics, 0);
});

test("enforces the 512 Task forest bound before observation", async () => {
  const over = Array.from({ length: 512 }, (_, index) =>
    link(index === 0 ? "root-bound" : `task-${index - 1}`, `task-${index}`));
  let observed = false;
  assert.deepEqual(await buildRuntimeProjection(project, {
    readLedger: async () => ledger({ links: over, managedTasks: [] }),
    observeTasks: async () => { observed = true; return []; },
  }), { status: "invalid" });
  assert.equal(observed, false);

  const exact = Array.from({ length: 511 }, (_, index) =>
    link(index === 0 ? "root-exact" : `exact-${index - 1}`, `exact-${index}`));
  const result = await buildRuntimeProjection(project, {
    readLedger: async () => ledger({ links: exact, managedTasks: [] }),
    observeTasks: observer({}),
    readDiagnostic: async () => null,
  });
  assert.deepEqual(result.tasks, []);
});

test("rejects combined retained and pending structural anomalies", async () => {
  const anomalies = [
    ledger({ links: [link("root", "child")], pendingLaunches: [{ parentTaskId: "child", childTaskId: "root", createdAt: at }], managedTasks: [] }),
    ledger({ links: [link("root", "child")], pendingLaunches: [{ parentTaskId: "other", childTaskId: "child", createdAt: at }], managedTasks: [] }),
    ledger({ links: [], pendingLaunches: [{ parentTaskId: "A", childTaskId: "B", createdAt: at }, { parentTaskId: "B", childTaskId: "A", createdAt: at }], managedTasks: [] }),
  ];
  for (const candidate of anomalies) {
    assert.deepEqual(await buildRuntimeProjection(project, { readLedger: async () => candidate }), { status: "invalid" });
  }
});

test("is deterministic and keeps missing or invalid ledgers bounded", async () => {
  const options = {
    readLedger: async () => ledger(),
    observeTasks: observer({ "root-new": "in_progress" }),
    readDiagnostic: async () => null,
  };
  assert.equal(JSON.stringify(await buildRuntimeProjection(project, options)), JSON.stringify(await buildRuntimeProjection(project, options)));
  assert.deepEqual(await buildRuntimeProjection(project, {
    readLedger: async () => { const error = new Error("missing"); error.code = "LEDGER_NOT_FOUND"; throw error; },
  }), { status: "missing" });
  assert.deepEqual(await buildRuntimeProjection(project, {
    readLedger: async () => { throw new Error("do not expose me"); },
  }), { status: "invalid" });
});
