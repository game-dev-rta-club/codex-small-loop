import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AtomicJsonStore } from "../source/atomic-json-store.mjs";
import { resolveProject } from "../source/project.mjs";
import {
  initializeTaskLedger,
  readTaskLedger,
} from "../source/task-ledger.mjs";
import {
  advancePendingLaunch,
  continueDeferredFork,
  continuePendingRoleLaunch,
  forkTask,
  launchTask,
  preparePendingLaunch,
  promotePendingLaunch,
  recordPendingLaunchError,
  TaskLaunchError,
} from "../source/task-launch.mjs";

function link(parentTaskId, childTaskId, lifecycle = "open") {
  return {
    parentTaskId,
    childTaskId,
    role: "primary",
    lifecycle,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    historyFile: null,
    acceptedAt: lifecycle === "accepted"
      ? "2026-07-25T00:01:00.000Z"
      : null,
    acceptanceReason: lifecycle === "accepted" ? "accepted" : null,
  };
}

function state(overrides = {}) {
  return structuredClone({
    managedTasks: [],
    pendingLaunches: [],
    links: [],
    conversations: [],
    ...overrides,
  });
}

function prepare(current = state(), overrides = {}) {
  return preparePendingLaunch(current, {
    assignment: "Inspect the project.",
    launchId: "launch-1",
    name: "Curie",
    parentTaskId: "parent-1",
    role: "primary",
    now: "2026-07-25T00:02:00.000Z",
    ...overrides,
  });
}

function toCreating(current) {
  return advancePendingLaunch(current, {
    launchId: "launch-1",
    expectedPhase: "prepared",
    phase: "creating",
    now: "2026-07-25T00:03:00.000Z",
  });
}

function toChildCreated(current, childTaskId = "child-1") {
  return advancePendingLaunch(current, {
    launchId: "launch-1",
    expectedPhase: "creating",
    phase: "child_created",
    childTaskId,
    now: "2026-07-25T00:04:00.000Z",
  });
}

function toAssignmentStarted(current, assignmentTurnId = "turn-1") {
  const starting = advancePendingLaunch(current, {
    launchId: "launch-1",
    expectedPhase: "role_started",
    phase: "assignment_starting",
    now: "2026-07-25T00:05:30.000Z",
  });
  return advancePendingLaunch(starting.state, {
    launchId: "launch-1",
    expectedPhase: "assignment_starting",
    phase: "assignment_started",
    assignmentTurnId,
    now: "2026-07-25T00:06:00.000Z",
  });
}

function toRoleStarted(current, roleTurnId = "role-turn") {
  return advancePendingLaunch(current, {
    launchId: "launch-1",
    expectedPhase: "child_created",
    phase: "role_started",
    roleTurnId,
    now: "2026-07-25T00:05:00.000Z",
  });
}

test("prepares one immutable launch for an unregistered Root Task", () => {
  const original = Object.freeze(state());
  const result = prepare(original);

  assert.deepEqual(original, {
    managedTasks: [],
    pendingLaunches: [],
    links: [],
    conversations: [],
  });
  assert.deepEqual(result.result, {
    launchId: "launch-1",
    name: "Curie",
    role: "primary",
    phase: "prepared",
  });
  assert.deepEqual(result.state.pendingLaunches, [{
    assignment: "Inspect the project.",
    id: "launch-1",
    model: null,
    name: "Curie",
    parentTaskId: "parent-1",
    reasoningEffort: null,
    role: "primary",
    serviceTier: null,
    childTaskId: null,
    phase: "prepared",
    assignmentTurnId: null,
    roleTurnId: null,
    createdAt: "2026-07-25T00:02:00.000Z",
    updatedAt: "2026-07-25T00:02:00.000Z",
    lastError: null,
  }]);
});

test("allows only an open managed parent to prepare more work", () => {
  assert.equal(
    prepare(state({ links: [link("root", "parent-1")] }))
      .state.pendingLaunches.length,
    1,
  );

  for (const lifecycle of ["stopped", "accepted"]) {
    assert.throws(
      () => prepare(state({
        links: [link("root", "parent-1", lifecycle)],
      })),
      (error) => error instanceof TaskLaunchError
        && error.code === "PARENT_TASK_NOT_OPEN",
    );
  }
});

test("rejects duplicate launch IDs and malformed identifiers", () => {
  const prepared = prepare().state;
  assert.throws(
    () => prepare(prepared),
    (error) => error.code === "LAUNCH_CONFLICT",
  );
  assert.throws(
    () => prepare(state(), { launchId: "" }),
    /launchId/,
  );
  assert.throws(
    () => prepare(state(), { parentTaskId: " " }),
    /parentTaskId/,
  );
  assert.throws(
    () => prepare(state(), { role: "Bad Role" }),
    /role/,
  );
  assert.throws(
    () => prepare(state(), { name: "" }),
    /name/,
  );
});

test("requires names to be unique among one parent's direct children", () => {
  const existing = state({
    managedTasks: [{
      taskId: "existing-child",
      name: "Curie",
      role: "primary",
      createdAt: "2026-07-25T00:00:00.000Z",
    }],
    links: [link("parent-1", "existing-child", "accepted")],
  });

  assert.throws(
    () => prepare(existing),
    (error) => error.code === "TASK_NAME_CONFLICT",
  );

  assert.doesNotThrow(() => prepare(state({
    managedTasks: [{
      taskId: "other-child",
      name: "Curie",
      role: "primary",
      createdAt: "2026-07-25T00:00:00.000Z",
    }],
    links: [link("other-parent", "other-child")],
  })));
});

test("advances only the exact durable launch phase", () => {
  const prepared = prepare().state;
  const creating = toCreating(prepared);
  const childCreated = toChildCreated(creating.state);
  const roleSent = toRoleStarted(childCreated.state);
  const assignmentSent = toAssignmentStarted(roleSent.state);

  assert.equal(creating.result.phase, "creating");
  assert.deepEqual(childCreated.state.pendingLaunches[0], {
    ...prepared.pendingLaunches[0],
    childTaskId: "child-1",
    phase: "child_created",
    updatedAt: "2026-07-25T00:04:00.000Z",
  });
  assert.deepEqual(assignmentSent.state.pendingLaunches[0], {
    ...roleSent.state.pendingLaunches[0],
    assignmentTurnId: "turn-1",
    phase: "assignment_started",
    updatedAt: "2026-07-25T00:06:00.000Z",
  });

  assert.throws(
    () => advancePendingLaunch(creating.state, {
      launchId: "launch-1",
      expectedPhase: "prepared",
      phase: "creating",
      now: "2026-07-25T00:06:00.000Z",
    }),
    (error) => error.code === "LAUNCH_PHASE_CONFLICT",
  );
  assert.throws(
    () => advancePendingLaunch(prepared, {
      launchId: "launch-1",
      expectedPhase: "prepared",
      phase: "assignment_started",
      assignmentTurnId: "turn-1",
      now: "2026-07-25T00:06:00.000Z",
    }),
    (error) => error.code === "LAUNCH_PHASE_INVALID",
  );
});

test("rejects a Child Task already pending or linked elsewhere", () => {
  const first = toCreating(prepare().state).state;
  const withSibling = preparePendingLaunch(first, {
    assignment: "Inspect a sibling.",
    launchId: "launch-2",
    name: "Ada",
    parentTaskId: "parent-1",
    role: "primary",
    now: "2026-07-25T00:03:30.000Z",
  }).state;
  const siblingCreating = advancePendingLaunch(withSibling, {
    launchId: "launch-2",
    expectedPhase: "prepared",
    phase: "creating",
    now: "2026-07-25T00:03:31.000Z",
  }).state;
  const firstCreated = toChildCreated(siblingCreating).state;

  assert.throws(
    () => advancePendingLaunch(firstCreated, {
      launchId: "launch-2",
      expectedPhase: "creating",
      phase: "child_created",
      childTaskId: "child-1",
      now: "2026-07-25T00:04:30.000Z",
    }),
    (error) => error.code === "CHILD_TASK_CONFLICT",
  );
  assert.throws(
    () => toChildCreated(state({
      pendingLaunches: first.pendingLaunches,
      links: [link("other", "child-1")],
    })),
    (error) => error.code === "CHILD_TASK_CONFLICT",
  );
});

test("records one bounded error without advancing the launch", () => {
  const creating = toCreating(prepare().state).state;
  const failed = recordPendingLaunchError(creating, {
    launchId: "launch-1",
    expectedPhase: "creating",
    code: "LAUNCH_CHILD_ID_UNKNOWN",
    message: "x".repeat(2_000),
    now: "2026-07-25T00:04:00.000Z",
  });

  assert.equal(failed.state.pendingLaunches[0].phase, "creating");
  assert.deepEqual(failed.state.pendingLaunches[0].lastError, {
    code: "LAUNCH_CHILD_ID_UNKNOWN",
    message: `${"x".repeat(1_023)}…`,
    at: "2026-07-25T00:04:00.000Z",
  });
  assert.throws(
    () => recordPendingLaunchError(creating, {
      launchId: "launch-1",
      expectedPhase: "child_created",
      code: "FAILED",
      message: "failed",
      now: "2026-07-25T00:04:00.000Z",
    }),
    (error) => error.code === "LAUNCH_PHASE_CONFLICT",
  );
});

test("promotes one accepted assignment into an open relationship", () => {
  const pending = toAssignmentStarted(
    toRoleStarted(
      toChildCreated(
        toCreating(prepare().state).state,
      ).state,
    ).state,
  ).state;
  const promoted = promotePendingLaunch(pending, {
    launchId: "launch-1",
    now: "2026-07-25T00:06:00.000Z",
    historyFile: "/codex/sessions/child-1.jsonl",
  });

  assert.deepEqual(promoted.result, {
    launchId: "launch-1",
    name: "Curie",
    parentTaskId: "parent-1",
    childTaskId: "child-1",
    role: "primary",
    phase: "ready",
  });
  assert.deepEqual(promoted.state.pendingLaunches, []);
  assert.deepEqual(promoted.state.managedTasks, [{
    taskId: "child-1",
    name: "Curie",
    role: "primary",
    createdAt: "2026-07-25T00:06:00.000Z",
  }]);
  assert.deepEqual(promoted.state.links, [{
    parentTaskId: "parent-1",
    childTaskId: "child-1",
    role: "primary",
    lifecycle: "open",
    createdAt: "2026-07-25T00:06:00.000Z",
    updatedAt: "2026-07-25T00:06:00.000Z",
    historyFile: "/codex/sessions/child-1.jsonl",
    acceptedAt: null,
    acceptanceReason: null,
  }]);
  assert.deepEqual(promoted.state.conversations, [{
    id: "launch-1",
    initiatorTaskId: "parent-1",
    initiatorRole: "controller",
    responderTaskId: "child-1",
    responderRole: "primary",
    state: "awaiting_reply",
    createdAt: "2026-07-25T00:06:00.000Z",
    updatedAt: "2026-07-25T00:06:00.000Z",
    repliedAt: null,
    acceptedAt: null,
  }]);
});

test("promotion preserves parallel siblings and rejects stale parent state", () => {
  const base = state({
    links: [
      link("root", "parent-1"),
      link("parent-1", "existing-child"),
      link("root", "unrelated"),
    ],
  });
  const pending = toAssignmentStarted(
    toRoleStarted(
      toChildCreated(
        toCreating(prepare(base).state,
        ).state,
        "child-2",
      ).state,
      "role-turn-2",
    ).state,
    "turn-2",
  ).state;
  const promoted = promotePendingLaunch(pending, {
    launchId: "launch-1",
    now: "2026-07-25T00:06:00.000Z",
  });

  assert.deepEqual(
    promoted.state.links.map(({ childTaskId }) => childTaskId),
    ["parent-1", "existing-child", "unrelated", "child-2"],
  );

  const stopped = structuredClone(pending);
  stopped.links[0] = link("root", "parent-1", "stopped");
  assert.throws(
    () => promotePendingLaunch(stopped, {
      launchId: "launch-1",
      now: "2026-07-25T00:06:00.000Z",
    }),
    (error) => error.code === "PARENT_TASK_NOT_OPEN",
  );
});

test("promotion fails closed on duplicate ownership, self-links, and cycles", () => {
  function pendingFor(parentTaskId, childTaskId, links = []) {
    return state({
      links,
      pendingLaunches: [{
        id: "launch-1",
        parentTaskId,
        role: "primary",
        childTaskId,
        phase: "assignment_started",
        assignmentTurnId: "turn-1",
        createdAt: "2026-07-25T00:02:00.000Z",
        updatedAt: "2026-07-25T00:05:00.000Z",
        lastError: null,
      }],
    });
  }

  assert.throws(
    () => promotePendingLaunch(
      pendingFor("parent-1", "child-1", [link("other", "child-1")]),
      {
        launchId: "launch-1",
        now: "2026-07-25T00:06:00.000Z",
      },
    ),
    (error) => error.code === "CHILD_TASK_CONFLICT",
  );

  for (const current of [
    pendingFor("same", "same"),
    pendingFor("child-1", "root", [link("root", "child-1")]),
  ]) {
    assert.throws(
      () => promotePendingLaunch(current, {
        launchId: "launch-1",
        now: "2026-07-25T00:06:00.000Z",
      }),
      (error) => error.code === "TASK_RELATIONSHIP_INVALID",
    );
  }
});

function coordinatorState(overrides = {}) {
  return {
    version: 10,
    revision: 0,
    projectRoot: "/project",
    projectKey: "project-key",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    managedTasks: [],
    pendingLaunches: [],
    links: [],
    conversations: [],
    deliveries: [],
    appMessages: [],
    ...overrides,
  };
}

function coordinatorHarness({
  state: initialState = coordinatorState(),
  parentSnapshot = {
    taskId: "parent-1",
    location: "active",
    historyFile: "/codex/parent-1.jsonl",
    latestTurnId: "parent-turn",
    turnState: "ended",
    diagnostics: [],
  },
  taskSnapshots = null,
  parentCwd = "/project",
  parentModel = "gpt-5.6-sol",
  parentReasoningEffort = "high",
  parentServiceTier = "priority",
  parentApprovalPolicy = "never",
  parentPermission = {
    type: "sandbox",
    policy: { type: "dangerFullAccess" },
  },
  profileError = null,
  createError = null,
  assignmentError = null,
  roleError = null,
  taskNameError = null,
  waitError = null,
  waitStatus = "completed",
  assignmentTurnStates = ["ended"],
  runtimeError = null,
  commitErrorPhase = null,
} = {}) {
  let current = structuredClone(initialState);
  let assignmentObservationIndex = 0;
  let monotonicNow = 0;
  const events = [];
  const timestamps = [
    "2026-07-25T00:01:00.000Z",
    "2026-07-25T00:02:00.000Z",
    "2026-07-25T00:03:00.000Z",
    "2026-07-25T00:04:00.000Z",
    "2026-07-25T00:05:00.000Z",
    "2026-07-25T00:06:00.000Z",
    "2026-07-25T00:07:00.000Z",
    "2026-07-25T00:08:00.000Z",
  ];

  const appServer = {
    async createTask({ cwd, runContext }) {
      events.push([
        "createTask",
        cwd,
        runContext.model,
        runContext.reasoningEffort,
        current.pendingLaunches[0]?.phase,
        runContext.serviceTier,
        runContext.approvalPolicy,
        structuredClone(runContext.permission),
      ]);
      if (createError) throw createError;
      return {
        taskId: "child-1",
        runContext: structuredClone(runContext),
      };
    },
    async forkTask({
      taskId,
      cwd,
      runContext,
    }) {
      events.push([
        "forkTask",
        taskId,
        cwd,
        runContext.model,
        runContext.reasoningEffort,
        current.pendingLaunches[0]?.phase,
        runContext.serviceTier,
        runContext.approvalPolicy,
        structuredClone(runContext.permission),
      ]);
      if (createError) throw createError;
      return {
        taskId: "child-1",
        runContext: structuredClone(runContext),
      };
    },
    async readTaskProfile({ taskId }) {
      events.push(["readTaskProfile", taskId]);
      if (profileError) throw profileError;
      return {
        taskId,
        cwd: parentCwd,
        runContext: {
          approvalPolicy: structuredClone(parentApprovalPolicy),
          permission: structuredClone(parentPermission),
          model: parentModel,
          reasoningEffort: parentReasoningEffort,
          serviceTier: parentServiceTier,
        },
      };
    },
    async resumeTask({ taskId }) {
      events.push(["resumeTask", taskId]);
      return {
        taskId,
        cwd: parentCwd,
        runContext: {
          approvalPolicy: structuredClone(parentApprovalPolicy),
          permission: structuredClone(parentPermission),
          model: parentModel,
          reasoningEffort: parentReasoningEffort,
          serviceTier: parentServiceTier,
        },
      };
    },
    async setTaskName({ taskId, name }) {
      events.push([
        "setTaskName",
        taskId,
        name,
        current.pendingLaunches[0]?.phase,
      ]);
      if (taskNameError) throw taskNameError;
      return { taskId, name };
    },
    async startTurn({
      taskId,
      text,
      cwd,
      runContext,
    }) {
      events.push([
        "startTurn",
        taskId,
        text,
        cwd,
        runContext.approvalPolicy,
        runContext.permission.type === "sandbox"
          ? runContext.permission.policy
          : null,
        current.pendingLaunches[0]?.phase,
        runContext.model,
        runContext.reasoningEffort,
        runContext.serviceTier,
        structuredClone(runContext.permission),
      ]);
      const roleTurn = (
        text.includes("Role System (System)")
        || text.includes("Fork Notification (System)")
      );
      if (roleTurn && roleError) throw roleError;
      if (!roleTurn && assignmentError) throw assignmentError;
      return { turnId: roleTurn ? "role-turn" : "assignment-turn" };
    },
    async waitForTurn({ taskId, turnId }) {
      events.push([
        "waitForTurn",
        taskId,
        turnId,
        current.pendingLaunches[0]?.phase,
      ]);
      if (waitError) throw waitError;
      return { taskId, turnId, status: waitStatus };
    },
    async close() {
      events.push(["close"]);
    },
  };

  return {
    appServer,
    events,
    get state() {
      return current;
    },
    options: {
      createLaunchId: () => "launch-1",
      now: () => timestamps.shift(),
      store: {},
      appServer,
      async resolveProject(projectRoot) {
        events.push(["resolveProject", projectRoot]);
        return projectRoot === "/project" || projectRoot === parentCwd
          ? {
            root: projectRoot,
            key: projectRoot === "/project" ? "project-key" : "other-key",
            stateFile: `${projectRoot}/.codex-small-loop/state.json`,
          }
          : {
            root: projectRoot,
            key: "other-key",
            stateFile: `${projectRoot}/.codex-small-loop/state.json`,
          };
      },
      async assertRuntimeAvailable() {
        events.push(["assertRuntimeAvailable"]);
        if (runtimeError) throw runtimeError;
        return {
          ledger: structuredClone(current),
          configuration: { status: "PAUSED" },
        };
      },
      async observeLatestTask(taskId) {
        events.push(["observeLatestTask", taskId]);
        return taskSnapshots?.[taskId] ?? {
          ...parentSnapshot,
          taskId,
          historyFile: `/codex/${taskId}.jsonl`,
        };
      },
      async observeExactTurn(taskId, turnId) {
        const turnState = assignmentTurnStates[
          Math.min(
            assignmentObservationIndex,
            assignmentTurnStates.length - 1,
          )
        ];
        assignmentObservationIndex += 1;
        events.push(["observeExactTurn", taskId, turnId, turnState]);
        return {
          taskId,
          location: "active",
          historyFile: `/codex/${taskId}.jsonl`,
          turnId,
          turnState,
          diagnostics: [],
        };
      },
      nowMs: () => monotonicNow,
      async sleep(milliseconds) {
        monotonicNow += milliseconds;
      },
      async openHistory(historyFile) {
        events.push(["openHistory", historyFile]);
        return { historyFile };
      },
      async readSessionMetadata(_readable, taskId) {
        events.push(["readSessionMetadata", taskId]);
        return { taskId, cwd: parentCwd };
      },
      async transactTaskLedger(
        _store,
        _project,
        transform,
      ) {
        const transformed = transform(structuredClone(current));
        const nextPhase = transformed.state.pendingLaunches[0]?.phase
          ?? "ready";
        if (commitErrorPhase === nextPhase) {
          throw new Error(`commit failed at ${nextPhase}`);
        }
        current = structuredClone(transformed.state);
        current.revision += 1;
        events.push([
          "commit",
          nextPhase,
        ]);
        return {
          state: structuredClone(current),
          result: transformed.result,
        };
      },
    },
  };
}

test("coordinates durable launch phases before each external operation", async () => {
  const harness = coordinatorHarness();
  const result = await launchTask({
        assignment: "Inspect the project and report the result.",
    name: "Curie",
    projectRoot: "/project",
    parentTaskId: "parent-1",
    role: "primary",
  }, harness.options);

  assert.deepEqual(result, {
    run: "ok",
    operation: "launch",
    launchId: "launch-1",
    parentTaskId: "parent-1",
    childTaskId: "child-1",
    name: "Curie",
    role: "primary",
    phase: "ready",
    nextAction: {
      type: "end_turn",
      required: true,
      reason: "The Child assignment started; end this turn so its callback can resume the parent cleanly.",
    },
  });
  assert.equal(harness.state.pendingLaunches.length, 0);
  assert.equal(harness.state.links[0].childTaskId, "child-1");
  assert.deepEqual(
    harness.events.find(([event]) => event === "createTask").slice(2, 4),
    ["gpt-5.6-sol", "high"],
  );
  assert.deepEqual(
    harness.events.find(([event]) => event === "startTurn").slice(4, 6),
    [
      "never",
      { type: "dangerFullAccess" },
    ],
  );
  assert.deepEqual(
    harness.events
      .filter(([event]) => [
        "commit",
        "createTask",
        "setTaskName",
        "startTurn",
      ].includes(event))
      .map((entry) => {
        if (entry[0] === "commit") return `commit:${entry[1]}`;
        if (entry[0] === "createTask") return `createTask:${entry[4]}`;
        if (entry[0] === "startTurn") return `startTurn:${entry[6]}`;
        return `${entry[0]}:${entry.at(-1)}`;
      }),
    [
      "commit:prepared",
      "commit:creating",
      "createTask:creating",
      "commit:child_created",
      "setTaskName:child_created",
      "startTurn:child_created",
      "commit:role_started",
      "commit:assignment_starting",
      "startTurn:assignment_starting",
      "commit:assignment_started",
      "commit:ready",
    ],
  );
  const turns = harness.events.filter(([event]) => event === "startTurn");
  assert.equal(turns.length, 2);
  for (const turn of turns) {
    assert.deepEqual(turn.slice(7, 10), [
      "gpt-5.6-sol",
      "high",
      "priority",
    ]);
  }
  const roleText = turns[0][2];
  const assignmentText = turns[1][2];
  assert.match(roleText, /Current role: primary/);
  assert.match(roleText, /components\/commands\/role\.mjs primary/);
  assert.doesNotMatch(roleText, /Inspect the project and report the result\./);
  assert.match(assignmentText, /Inspect the project and report the result\./);
  assert.match(assignmentText, /Conversation ID: launch-/);
  assert.match(assignmentText, /Initiator Task ID: parent-1/);
  assert.match(assignmentText, /Responder Task ID: child-1/);
  assert.match(
    assignmentText,
    /conversation reply --conversation launch-/,
  );
  assert.match(
    assignmentText,
    /=== Codex Small Loop · Controller → Primary ===[\s\S]*=== Message ===[\s\S]*Inspect the project and report the result\./,
  );
  assert.doesNotMatch(assignmentText, /^Task:/m);
  assert.equal(
    harness.events.some(([event]) => event === "readTask"),
    false,
  );
  assert.doesNotMatch(assignmentText, /=== System Instructions ===/);
  assert.doesNotMatch(
    assignmentText,
    /will send the actual assignment next/,
  );
  assert.equal(harness.events.at(-1)[0], "close");
});

test("merges explicit launch overrides into the Parent profile", async () => {
  const harness = coordinatorHarness({
    parentModel: "gpt-5.6-sol",
    parentReasoningEffort: "high",
  });

  await launchTask({
    assignment: "Inspect the project and report the result.",
    name: "Curie",
    projectRoot: "/project",
    parentTaskId: "parent-1",
    role: "primary",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
  }, harness.options);

  assert.deepEqual(
    harness.events.find(([event]) => event === "createTask").slice(2, 6),
    ["gpt-5.6-sol", "medium", "creating", "priority"],
  );
  assert.equal(
    harness.events.some(([event]) => event === "readTaskProfile"),
    true,
  );
  assert.equal(
    harness.events.some(([event]) => event === "resumeTask"),
    false,
  );
});

test("overrides only the service tier while inheriting Parent model settings", async () => {
  const harness = coordinatorHarness({
    parentModel: "gpt-5.6-sol",
    parentReasoningEffort: "high",
    parentServiceTier: null,
  });

  await launchTask({
    assignment: "Inspect the project and report the result.",
    name: "Curie",
    projectRoot: "/project",
    parentTaskId: "parent-1",
    role: "primary",
    serviceTier: "priority",
  }, harness.options);

  assert.deepEqual(
    harness.events.find(([event]) => event === "createTask").slice(2, 6),
    ["gpt-5.6-sol", "high", "creating", "priority"],
  );
});

test("inherits a Parent profile with a confirmed null reasoning effort", async () => {
  const harness = coordinatorHarness({
    parentModel: "gpt-5.6-sol",
    parentReasoningEffort: null,
    parentServiceTier: null,
  });

  await launchTask({
    assignment: "Inspect the project and report the result.",
    name: "Curie",
    projectRoot: "/project",
    parentTaskId: "parent-1",
    role: "primary",
  }, harness.options);

  assert.deepEqual(
    harness.events.find(([event]) => event === "createTask").slice(2, 6),
    ["gpt-5.6-sol", null, "creating", null],
  );
});

test("preserves Parent authority through Child creation and both Child turns", async () => {
  const permission = {
    type: "profile",
    id: "project-maintainer",
  };
  const harness = coordinatorHarness({
    parentApprovalPolicy: "on-request",
    parentPermission: permission,
  });

  await launchTask({
    assignment: "Inspect the project and report the result.",
    name: "Curie",
    projectRoot: "/project",
    parentTaskId: "parent-1",
    role: "primary",
    reasoningEffort: "medium",
    model: "gpt-5.6-terra",
  }, harness.options);

  const creation = harness.events.find(([event]) => event === "createTask");
  assert.equal(creation[6], "on-request");
  assert.deepEqual(creation[7], permission);
  for (const turn of harness.events.filter(([event]) => event === "startTurn")) {
    assert.equal(turn[4], "on-request");
    assert.equal(turn[5], null);
    assert.deepEqual(turn[10], permission);
    assert.deepEqual(turn.slice(7, 10), [
      "gpt-5.6-terra",
      "medium",
      "priority",
    ]);
  }
});

test("rejects an incomplete internal execution override", async () => {
  const harness = coordinatorHarness();

  await assert.rejects(
    launchTask({
      assignment: "Inspect the project and report the result.",
      name: "Curie",
      projectRoot: "/project",
      parentTaskId: "parent-1",
      role: "primary",
      model: "gpt-5.6-sol",
    }, harness.options),
    /model and reasoningEffort must be provided together/,
  );
  assert.deepEqual(harness.events, []);
});

test("uses the managed Parent role when a nested Parent launches a Child", async () => {
  const harness = coordinatorHarness({
    state: coordinatorState({
      managedTasks: [{
        taskId: "parent-1",
        name: "Harbor",
        role: "execute",
        createdAt: "2026-07-25T00:00:00.000Z",
      }],
      links: [link("root-1", "parent-1")],
    }),
  });

  await launchTask({
    assignment: "Check the arithmetic.",
    name: "Euclid",
    projectRoot: "/project",
    parentTaskId: "parent-1",
    role: "review",
  }, harness.options);

  const assignmentText = harness.events.filter(
    ([event]) => event === "startTurn",
  )[1][2];
  assert.match(
    assignmentText,
    /=== Codex Small Loop · Execute → Review ===/,
  );
  assert.doesNotMatch(
    assignmentText,
    /Harbor|Implement the calculator|^Task:/m,
  );
});

test("forks the latest Parent context through the durable launch lifecycle", async () => {
  const harness = coordinatorHarness();
  const result = await forkTask({
        assignment: "Inspect the project and report the result.",
    name: "Builder-1",
    projectRoot: "/project",
    parentTaskId: "parent-1",
    role: "execute",
  }, harness.options);

  assert.deepEqual(result, {
    run: "ok",
    operation: "fork",
    launchId: "launch-1",
    name: "Builder-1",
    parentTaskId: "parent-1",
    sourceTaskId: "parent-1",
    role: "execute",
    phase: "fork_queued",
    nextAction: {
      type: "end_turn",
      required: true,
      reason: "The fork starts after this Parent turn completes.",
    },
  });
  assert.equal(
    harness.events.some(([event]) =>
      event === "createTask" || event === "forkTask"
    ),
    false,
  );
  assert.equal(harness.state.pendingLaunches[0].phase, "fork_queued");
  assert.equal(harness.state.pendingLaunches[0].parentTaskId, "parent-1");
});

test("continues one queued fork with its stored assignment and no callback", async () => {
  const harness = coordinatorHarness();
  await forkTask({
        assignment: "Inspect the project and report the result.",
    name: "Builder-1",
    projectRoot: "/project",
    parentTaskId: "parent-1",
    role: "execute",
  }, harness.options);

  const result = await continueDeferredFork({
    launchId: "launch-1",
    projectRoot: "/project",
  }, harness.options);

  assert.equal(result.phase, "ready");
  assert.equal(result.childTaskId, "child-1");
  assert.deepEqual(
    harness.events.find(([event]) => event === "forkTask").slice(0, 7),
    [
      "forkTask",
      "parent-1",
      "/project",
      "gpt-5.6-sol",
      "high",
      "fork_creating",
      "priority",
    ],
  );
  assert.equal(harness.state.pendingLaunches.length, 0);
  assert.equal(harness.state.links[0].role, "execute");
  assert.deepEqual(harness.state.appMessages, []);
  const turns = harness.events.filter(([event]) => event === "startTurn");
  assert.match(
    turns[0][2],
    /^=== Codex Small Loop · Fork Notification \(System\) ===/,
  );
  assert.match(turns[0][2], /Previous role: controller/);
  assert.match(turns[0][2], /Current role: execute/);
  assert.match(turns[0][2], /Parent Task ID: parent-1/);
  assert.match(turns[0][2], /Current Task ID: child-1/);
  assert.match(
    turns[1][2],
    /Inspect the project and report the result\./,
  );
});

test("forks Execute context while keeping Primary as the managing Parent", async () => {
  const harness = coordinatorHarness({
    state: coordinatorState({
      managedTasks: [{
        taskId: "parent-1",
        name: "Primary-1",
        role: "primary",
        createdAt: "2026-07-25T00:00:00.000Z",
      }, {
        taskId: "execute-1",
        name: "Builder-1",
        role: "execute",
        createdAt: "2026-07-25T00:00:00.000Z",
      }],
      links: [{
        ...link("parent-1", "execute-1"),
        role: "execute",
      }],
    }),
  });

  const queued = await forkTask({
    assignment: "Refine the required Signal with its Reviewer.",
    name: "Interviewer-1",
    projectRoot: "/project",
    parentTaskId: "parent-1",
    sourceTaskId: "execute-1",
    role: "interviewer",
  }, harness.options);

  assert.equal(queued.parentTaskId, "parent-1");
  assert.equal(queued.sourceTaskId, "execute-1");
  assert.equal(harness.state.pendingLaunches[0].parentTaskId, "parent-1");
  assert.equal(harness.state.pendingLaunches[0].sourceTaskId, "execute-1");

  const result = await continueDeferredFork({
    launchId: "launch-1",
    projectRoot: "/project",
  }, harness.options);

  assert.equal(result.parentTaskId, "parent-1");
  assert.equal(result.sourceTaskId, "execute-1");
  assert.deepEqual(
    harness.events.find(([event]) => event === "forkTask").slice(0, 2),
    ["forkTask", "execute-1"],
  );
  assert.equal(
    harness.events.some(([event, taskId]) =>
      event === "readTaskProfile" && taskId === "execute-1"
    ),
    true,
  );
  assert.equal(harness.state.links[1].parentTaskId, "parent-1");
  assert.equal(harness.state.links[1].sourceTaskId, "execute-1");

  const turns = harness.events.filter(([event]) => event === "startTurn");
  assert.match(turns[0][2], /Previous role: execute/);
  assert.match(turns[0][2], /Parent Task ID: parent-1/);
  assert.match(turns[0][2], /Fork Source Task ID: execute-1/);
  assert.match(
    turns[1][2],
    /=== Codex Small Loop · Primary → Interviewer ===/,
  );
});

test("returns a fork source error without falling back to Primary context", async () => {
  const harness = coordinatorHarness({
    taskSnapshots: {
      "parent-1": {
        taskId: "parent-1",
        location: "active",
        historyFile: "/codex/parent-1.jsonl",
        latestTurnId: "parent-turn",
        turnState: "ended",
        diagnostics: [],
      },
      "execute-1": {
        taskId: "execute-1",
        location: "archived",
        historyFile: "/codex/execute-1.jsonl",
        latestTurnId: "execute-turn",
        turnState: "ended",
        diagnostics: [],
      },
    },
  });

  await assert.rejects(
    forkTask({
      assignment: "Refine the required Signal.",
      name: "Interviewer-1",
      projectRoot: "/project",
      parentTaskId: "parent-1",
      sourceTaskId: "execute-1",
      role: "interviewer",
    }, harness.options),
    (error) => error.code === "FORK_SOURCE_TASK_ARCHIVED"
      && error.sourceTaskId === "execute-1",
  );

  assert.equal(harness.state.pendingLaunches.length, 0);
  assert.equal(
    harness.events.some(([event]) => event === "forkTask"),
    false,
  );
});

test("continues a persisted completed Role Turn after a process restart", async () => {
  const roleStarted = toRoleStarted(
    toChildCreated(
      toCreating(prepare().state).state,
    ).state,
  ).state.pendingLaunches[0];
  roleStarted.createdAt = "2026-07-25T00:00:00.000Z";
  roleStarted.updatedAt = "2026-07-25T00:00:00.000Z";
  const harness = coordinatorHarness({
    state: coordinatorState({
      pendingLaunches: [roleStarted],
    }),
    parentApprovalPolicy: "on-request",
    parentPermission: {
      type: "profile",
      id: "project-maintainer",
    },
  });

  const result = await continuePendingRoleLaunch({
    launchId: "launch-1",
    projectRoot: "/project",
  }, harness.options);

  assert.equal(result.phase, "ready");
  assert.equal(harness.state.pendingLaunches.length, 0);
  assert.equal(harness.state.links[0].childTaskId, "child-1");
  assert.equal(
    harness.events.filter(([event]) => event === "startTurn").length,
    1,
  );
  assert.equal(
    harness.events.some(([event]) => event === "waitForTurn"),
    false,
  );
  assert.match(
    harness.events.find(([event]) => event === "startTurn")[2],
    /Inspect the project\./,
  );
  const assignment = harness.events.find(([event]) => event === "startTurn");
  assert.equal(assignment[4], "on-request");
  assert.deepEqual(assignment[10], {
    type: "profile",
    id: "project-maintainer",
  });
});

test("allows only one concurrent continuation to claim the Parent assignment", async () => {
  const roleStarted = toRoleStarted(
    toChildCreated(
      toCreating(prepare().state).state,
    ).state,
  ).state.pendingLaunches[0];
  roleStarted.createdAt = "2026-07-25T00:00:00.000Z";
  roleStarted.updatedAt = "2026-07-25T00:00:00.000Z";
  const harness = coordinatorHarness({
    state: coordinatorState({
      pendingLaunches: [roleStarted],
    }),
  });
  const input = {
    launchId: "launch-1",
    projectRoot: "/project",
  };

  const outcomes = await Promise.allSettled([
    continuePendingRoleLaunch(input, harness.options),
    continuePendingRoleLaunch(input, harness.options),
  ]);

  assert.equal(
    outcomes.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.filter(({ status }) => status === "rejected").length,
    1,
  );
  assert.equal(
    outcomes.find(({ status }) => status === "rejected").reason.code,
    "LAUNCH_ASSIGNMENT_CLAIM_FAILED",
  );
  assert.equal(
    harness.events.filter(([event]) => event === "startTurn").length,
    1,
  );
});

test("uses an explicit fork profile instead of the Parent profile", async () => {
  const harness = coordinatorHarness({
    parentModel: "gpt-5.6-sol",
    parentReasoningEffort: "high",
  });
  await forkTask({
    assignment: "Inspect the project and report the result.",
    name: "Builder-1",
    projectRoot: "/project",
    parentTaskId: "parent-1",
    role: "execute",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
  }, harness.options);

  await continueDeferredFork({
    launchId: "launch-1",
    projectRoot: "/project",
  }, harness.options);

  assert.deepEqual(
    harness.events.find(([event]) => event === "forkTask").slice(3, 5),
    ["gpt-5.6-sol", "medium"],
  );
});

test("does not continue a queued fork while the Parent still has an active turn", async () => {
  const harness = coordinatorHarness({
    parentSnapshot: {
      taskId: "parent-1",
      location: "active",
      historyFile: "/codex/parent-1.jsonl",
      latestTurnId: "parent-turn",
      turnState: "in_progress",
      diagnostics: [],
    },
  });
  await forkTask({
        assignment: "Inspect the project and report the result.",
    name: "Builder-1",
    projectRoot: "/project",
    parentTaskId: "parent-1",
    role: "execute",
  }, harness.options);

  await assert.rejects(
    continueDeferredFork({
      launchId: "launch-1",
      projectRoot: "/project",
    }, harness.options),
    (error) => error.code === "DEFERRED_FORK_PARENT_ACTIVE",
  );
  assert.equal(harness.state.pendingLaunches[0].phase, "fork_queued");
  assert.equal(
    harness.events.some(([event]) => event === "forkTask"),
    false,
  );
});

test("rejects missing, archived, and wrong-project parents before creating work", async () => {
  const cases = [
    {
      snapshot: {
        taskId: "parent-1",
        location: "missing",
        historyFile: null,
        latestTurnId: null,
        turnState: "unknown",
        diagnostics: [],
      },
      code: "PARENT_TASK_NOT_FOUND",
    },
    {
      snapshot: {
        taskId: "parent-1",
        location: "archived",
        historyFile: "/codex/parent-1.jsonl",
        latestTurnId: "turn",
        turnState: "ended",
        diagnostics: [],
      },
      code: "PARENT_TASK_ARCHIVED",
    },
  ];

  for (const current of cases) {
    const harness = coordinatorHarness({ parentSnapshot: current.snapshot });
    await assert.rejects(
      launchTask({
        assignment: "Inspect the project and report the result.",
        name: "Curie",
        projectRoot: "/project",
        parentTaskId: "parent-1",
        role: "primary",
      }, harness.options),
      (error) => error.code === current.code && error.run === "failed",
    );
    assert.equal(
      harness.events.some(([event]) => event === "createTask"),
      false,
    );
    assert.equal(harness.state.pendingLaunches.length, 0);
  }

  const wrongProject = coordinatorHarness({ parentCwd: "/other" });
  await assert.rejects(
    launchTask({
        assignment: "Inspect the project and report the result.",
      name: "Curie",
      projectRoot: "/project",
      parentTaskId: "parent-1",
      role: "primary",
    }, wrongProject.options),
    (error) => error.code === "PROJECT_ROOT_MISMATCH"
      && error.run === "failed",
  );
  assert.equal(
    wrongProject.events.some(([event]) => event === "createTask"),
    false,
  );
});

test("rejects an unavailable runtime before creating pending or external work", async () => {
  const harness = coordinatorHarness({
    runtimeError: Object.assign(new Error("Runtime state unavailable"), {
      code: "RUNTIME_NOT_CONFIGURED",
    }),
  });
  await assert.rejects(
    launchTask({
        assignment: "Inspect the project and report the result.",
      name: "Curie",
      projectRoot: "/project",
      parentTaskId: "parent-1",
      role: "primary",
    }, harness.options),
    (error) => error.code === "RUNTIME_NOT_AVAILABLE"
      && error.run === "failed"
      && !/codex-small-loop-doctor/i.test(error.message)
      && /runtime\.mjs"? status/.test(error.message)
      && /could not be read safely/i.test(error.message)
      && /diagnos/i.test(error.message)
      && /retry.*create/i.test(error.message)
      && !error.message.includes("<plugin-root>"),
  );
  assert.equal(harness.state.pendingLaunches.length, 0);
  assert.equal(
    harness.events.some(([event]) => event === "createTask"),
    false,
  );
});

test("retains creating evidence when Child Task creation is ambiguous", async () => {
  const failure = Object.assign(new Error("connection ended"), {
    code: "APP_SERVER_EXITED",
  });
  const harness = coordinatorHarness({ createError: failure });

  await assert.rejects(
    launchTask({
        assignment: "Inspect the project and report the result.",
      name: "Curie",
      projectRoot: "/project",
      parentTaskId: "parent-1",
      role: "primary",
    }, harness.options),
    (error) => error.code === "LAUNCH_CHILD_ID_UNKNOWN"
      && error.run === "partial"
      && error.phase === "creating",
  );
  assert.equal(harness.state.pendingLaunches[0].phase, "creating");
  assert.equal(
    harness.state.pendingLaunches[0].lastError.code,
    "LAUNCH_CHILD_ID_UNKNOWN",
  );
});

test("persists app-server diagnostics when Parent profile loading fails", async () => {
  const failure = Object.assign(
    new Error("Codex app-server exited unexpectedly (1)"),
    {
      code: "APP_SERVER_EXITED",
      operation: "readTaskProfile",
      stderr: "APP_SERVER_HOST_NOT_READY: host socket was not ready in time",
      exitCode: 1,
      signal: null,
    },
  );
  const harness = coordinatorHarness({ profileError: failure });

  await assert.rejects(
    launchTask({
      assignment: "Inspect the project and report the result.",
      name: "Curie",
      projectRoot: "/project",
      parentTaskId: "parent-1",
      role: "primary",
    }, harness.options),
    (error) => error.code === "LAUNCH_PARENT_PROFILE_FAILED"
      && error.run === "partial"
      && error.phase === "prepared",
  );

  assert.equal(harness.state.pendingLaunches[0].phase, "prepared");
  const stored = harness.state.pendingLaunches[0].lastError;
  assert.equal(stored.code, "LAUNCH_PARENT_PROFILE_FAILED");
  assert.match(stored.message, /Codex app-server exited unexpectedly \(1\)/);
  assert.match(stored.message, /code=APP_SERVER_EXITED/);
  assert.match(stored.message, /operation=readTaskProfile/);
  assert.match(stored.message, /exitCode=1/);
  assert.match(
    stored.message,
    /stderr=APP_SERVER_HOST_NOT_READY: host socket was not ready in time/,
  );
});

test("keeps a deferred fork retryable when the persisted source profile is temporarily unavailable", async () => {
  const failure = Object.assign(
    new Error("source session is temporarily unavailable"),
    {
      code: "APP_SERVER_REQUEST_FAILED",
      operation: "readTaskProfile",
    },
  );
  const harness = coordinatorHarness({ profileError: failure });
  await forkTask({
    assignment: "Inspect the project and report the result.",
    name: "Builder-1",
    projectRoot: "/project",
    parentTaskId: "parent-1",
    role: "execute",
  }, harness.options);

  await assert.rejects(
    continueDeferredFork({
      launchId: "launch-1",
      projectRoot: "/project",
    }, harness.options),
    (error) => error.code === "LAUNCH_PARENT_PROFILE_FAILED"
      && error.run === "partial"
      && error.phase === "fork_queued",
  );

  assert.equal(harness.state.pendingLaunches[0].phase, "fork_queued");
  assert.equal(
    harness.state.pendingLaunches[0].lastError.code,
    "LAUNCH_PARENT_PROFILE_FAILED",
  );
  assert.equal(
    harness.events.some(([event]) => event === "forkTask"),
    false,
  );
});

test("retains the last proven Child phase when assignment start fails", async () => {
  const nameHarness = coordinatorHarness({
    taskNameError: Object.assign(new Error("name rejected"), {
      code: "APP_SERVER_REQUEST_FAILED",
    }),
  });
  await assert.rejects(
    launchTask({
      assignment: "Inspect the project and report the result.",
      name: "Curie",
      projectRoot: "/project",
      parentTaskId: "parent-1",
      role: "primary",
    }, nameHarness.options),
    (error) => error.code === "LAUNCH_TASK_NAME_FAILED"
      && error.phase === "child_created",
  );
  assert.equal(
    nameHarness.state.pendingLaunches[0].phase,
    "child_created",
  );
  assert.equal(
    nameHarness.events.some(([event]) => event === "startTurn"),
    false,
  );

  const assignmentHarness = coordinatorHarness({
    assignmentError: Object.assign(new Error("turn rejected"), {
      code: "APP_SERVER_REQUEST_FAILED",
    }),
  });
  await assert.rejects(
    launchTask({
        assignment: "Inspect the project and report the result.",
      name: "Curie",
      projectRoot: "/project",
      parentTaskId: "parent-1",
      role: "primary",
    }, assignmentHarness.options),
    (error) => error.code === "LAUNCH_ASSIGNMENT_FAILED"
      && error.phase === "assignment_starting",
  );
  assert.equal(
    assignmentHarness.state.pendingLaunches[0].phase,
    "assignment_starting",
  );
});

test("does not send the Parent assignment when the Role Turn fails", async () => {
  for (const waitStatus of ["interrupted", "failed"]) {
    const harness = coordinatorHarness({ waitStatus });

    await assert.rejects(
      launchTask({
        assignment: "Inspect the project and report the result.",
        name: "Curie",
        projectRoot: "/project",
        parentTaskId: "parent-1",
        role: "primary",
      }, harness.options),
      (error) => error.code === "LAUNCH_ROLE_INCOMPLETE"
        && error.phase === "role_started",
    );
    assert.equal(
      harness.events.filter(([event]) => event === "startTurn").length,
      1,
    );
    assert.equal(
      harness.state.pendingLaunches[0].lastError.code,
      "LAUNCH_ROLE_INCOMPLETE",
    );
  }
});

test("reports repair-required crash windows when returned IDs cannot persist", async () => {
  const childPersistence = coordinatorHarness({
    commitErrorPhase: "child_created",
  });
  await assert.rejects(
    launchTask({
        assignment: "Inspect the project and report the result.",
      name: "Curie",
      projectRoot: "/project",
      parentTaskId: "parent-1",
      role: "primary",
    }, childPersistence.options),
    (error) => error.code === "LAUNCH_REPAIR_REQUIRED"
      && error.childTaskId === "child-1"
      && error.phase === "creating",
  );
  assert.equal(
    childPersistence.state.pendingLaunches[0].phase,
    "creating",
  );

  const rolePersistence = coordinatorHarness({
    commitErrorPhase: "role_started",
  });
  await assert.rejects(
    launchTask({
      assignment: "Inspect the project and report the result.",
      name: "Curie",
      projectRoot: "/project",
      parentTaskId: "parent-1",
      role: "primary",
    }, rolePersistence.options),
    (error) => error.code === "LAUNCH_REPAIR_REQUIRED"
      && error.roleTurnId === "role-turn"
      && error.phase === "child_created",
  );
  assert.equal(
    rolePersistence.state.pendingLaunches[0].phase,
    "child_created",
  );

  const turnPersistence = coordinatorHarness({
    commitErrorPhase: "assignment_started",
  });
  await assert.rejects(
    launchTask({
        assignment: "Inspect the project and report the result.",
      name: "Curie",
      projectRoot: "/project",
      parentTaskId: "parent-1",
      role: "primary",
    }, turnPersistence.options),
    (error) => error.code === "LAUNCH_REPAIR_REQUIRED"
      && error.assignmentTurnId === "assignment-turn"
      && error.phase === "assignment_starting",
  );
  assert.equal(
    turnPersistence.state.pendingLaunches[0].phase,
    "assignment_starting",
  );
});

test("waits for the Role Turn but not for the Child assignment turn", async () => {
  const harness = coordinatorHarness({
    waitStatus: "completed",
    assignmentTurnStates: ["in_progress", "ended"],
  });

  const result = await launchTask({
        assignment: "Inspect the project and report the result.",
    name: "Curie",
    projectRoot: "/project",
    parentTaskId: "parent-1",
    role: "primary",
  }, harness.options);

  assert.equal(result.phase, "ready");
  assert.deepEqual(
    harness.events
      .filter(([event]) =>
        event === "startTurn" || event === "waitForTurn"
      )
      .map(([event, _taskId, value]) => [event, value]),
    [
      ["startTurn", harness.events.find(
        ([event]) => event === "startTurn",
      )[2]],
      ["waitForTurn", "role-turn"],
      ["startTurn", harness.events.filter(
        ([event]) => event === "startTurn",
      )[1][2]],
    ],
  );
  assert.equal(
    harness.events.some(([event]) => event === "observeExactTurn"),
    false,
  );
});

test("real ledger transactions preserve parallel sibling launches", async () => {
  const projectRoot = await mkdtemp(
    path.join(os.tmpdir(), "whole-job-launch-"),
  );
  try {
    const project = await resolveProject(projectRoot);
    await mkdir(project.directory, { recursive: true });
    const store = new AtomicJsonStore(project.stateFile);
    await initializeTaskLedger(
      store,
      project,
      "2026-07-25T00:00:00.000Z",
    );

    let tick = 0;
    const now = () => {
      tick += 1;
      return new Date(
        Date.parse("2026-07-25T00:00:00.000Z") + tick * 1_000,
      ).toISOString();
    };
    const shared = {
      store,
      now,
      resolveProject,
      async assertRuntimeAvailable() {
        return { ledger: await readTaskLedger(store, project) };
      },
      async observeLatestTask(taskId) {
        return {
          taskId,
          location: "active",
          historyFile: `/codex/${taskId}.jsonl`,
          latestTurnId: "turn",
          turnState: "ended",
          diagnostics: [],
        };
      },
      async observeExactTurn(taskId, turnId) {
        return {
          taskId,
          location: "active",
          historyFile: `/codex/${taskId}.jsonl`,
          turnId,
          turnState: "ended",
          diagnostics: [],
        };
      },
      async openHistory() {
        return {};
      },
      async readSessionMetadata(_readable, taskId) {
        return { taskId, cwd: projectRoot };
      },
    };
    function appServer(childTaskId, turnId) {
      return {
        async readTask({ taskId }) {
          return {
            taskId,
            name: "Parent coordination task",
            threadSource: "user",
          };
        },
        async readTaskProfile({ taskId }) {
          return {
            taskId,
            cwd: projectRoot,
            runContext: {
              approvalPolicy: "never",
              permission: {
                type: "sandbox",
                policy: { type: "dangerFullAccess" },
              },
              model: "gpt-5.6-sol",
              reasoningEffort: "high",
              serviceTier: "priority",
            },
          };
        },
        async resumeTask({ taskId }) {
          return {
            taskId,
            cwd: projectRoot,
            runContext: {
              approvalPolicy: "never",
              permission: {
                type: "sandbox",
                policy: { type: "dangerFullAccess" },
              },
              model: "gpt-5.6-sol",
              reasoningEffort: "high",
              serviceTier: "priority",
            },
          };
        },
        async createTask({ runContext }) {
          await new Promise((resolve) => setImmediate(resolve));
          return {
            taskId: childTaskId,
            runContext,
          };
        },
        async setTaskName({ taskId, name }) {
          return { taskId, name };
        },
        async startTurn() {
          return { turnId };
        },
        async waitForTurn() {
          return {
            taskId: childTaskId,
            turnId,
            status: "completed",
          };
        },
        async close() {},
      };
    }

    const results = await Promise.all([
      launchTask({
        assignment: "Inspect the project and report the result.",
        name: "Curie",
        projectRoot,
        parentTaskId: "parent-1",
        role: "primary",
      }, {
        ...shared,
        createLaunchId: () => "launch-1",
        appServer: appServer("child-1", "turn-1"),
      }),
      launchTask({
        assignment: "Inspect the project and report the result.",
        name: "Ada",
        projectRoot,
        parentTaskId: "parent-1",
        role: "primary",
      }, {
        ...shared,
        createLaunchId: () => "launch-2",
        appServer: appServer("child-2", "turn-2"),
      }),
    ]);

    const ledger = await readTaskLedger(store, project);
    assert.deepEqual(
      results.map(({ childTaskId }) => childTaskId).sort(),
      ["child-1", "child-2"],
    );
    assert.deepEqual(
      ledger.links.map(({ childTaskId }) => childTaskId).sort(),
      ["child-1", "child-2"],
    );
    assert.equal(ledger.pendingLaunches.length, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
