import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  deliverMechanicalActions,
  renderConversationMessage,
  renderForkNotification,
  renderLaunchRoleInstructions,
  renderNextActions,
  renderNotificationMessage,
  renderRecoveryMessage,
  renderResumeMessage,
  renderSystemInstructions,
  sendTaskMessage,
} from "../source/task-messaging.mjs";

function fullAccessSettings(taskId, cwd = "/project") {
  return {
    taskId,
    cwd,
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
}

test("renders Conversation direction and exact follow-up commands", () => {
  assert.equal(
    renderConversationMessage({
      conversationId: "conversation-1",
      initiatorTaskId: "task-interviewer",
      initiatorRole: "interviewer",
      operation: "start",
      responderTaskId: "task-review",
      responderRole: "review",
      scheduleId: null,
      text: "Please explain the Signal boundary.",
    }),
    `=== Codex Small Loop · Interviewer → Review ===

=== Conversation ===
Initiator Task ID: task-interviewer
Responder Task ID: task-review
Conversation ID: conversation-1

=== Message ===
Please explain the Signal boundary.

=== Next Actions ===
1. Reply to this Conversation after completing the requested work.
   Conversation ID: conversation-1
   Use Codex Small Loop \`conversation reply --conversation conversation-1\`.

After completing the protocol actions above, resume the currently loaded Role and perform its next applicable Action for the resulting state.`,
  );

  assert.equal(
    renderConversationMessage({
      conversationId: "conversation-1",
      initiatorTaskId: "task-interviewer",
      initiatorRole: "interviewer",
      operation: "reply",
      responderTaskId: "task-review",
      responderRole: "review",
      scheduleId: null,
      text: "The boundary is the current snapshot.",
    }),
    `=== Codex Small Loop · Interviewer ← Review ===

=== Conversation ===
Initiator Task ID: task-interviewer
Responder Task ID: task-review
Conversation ID: conversation-1

=== Message ===
The boundary is the current snapshot.

=== Next Actions ===
1. Continue or accept this replied Conversation.
   Conversation ID: conversation-1
   Use Codex Small Loop \`conversation continue --conversation conversation-1\` to ask for another reply.
   Use Codex Small Loop \`conversation accept --conversation conversation-1\` to close only this Conversation.

After completing the protocol actions above, resume the currently loaded Role and perform its next applicable Action for the resulting state.`,
  );
});

test("appends the Role-continuation reminder to every Conversation operation", () => {
  for (const operation of ["start", "reply", "continue"]) {
    const message = renderConversationMessage({
      conversationId: `conversation-${operation}`,
      initiatorTaskId: "task-primary",
      initiatorRole: "primary",
      operation,
      responderTaskId: "task-execute",
      responderRole: "execute",
      scheduleId: null,
      text: "Continue the current work.",
    });
    assert.equal(
      message.match(/resume the currently loaded Role/g)?.length,
      1,
    );
    assert.match(
      message,
      /resulting state\.$/,
    );
  }
});

test("renders a one-way notification without a reply instruction", () => {
  assert.equal(
    renderNotificationMessage({
      scheduleId: null,
      targetTaskId: "task-controller",
      text: "The E2E run completed.",
    }),
    `=== Codex Small Loop · Notification ===

No reply or acknowledgement is required.

=== Message ===
The E2E run completed.`,
  );
});

test("renders all supported actions through one Next Actions contract", () => {
  assert.equal(
    renderNextActions([
      {
        type: "delete_schedule",
        scheduleId: "codex-small-loop-message-notification",
        targetTaskId: "task-controller",
      },
      {
        type: "reply_to_conversation",
        conversationId: "conversation-1",
      },
      {
        type: "continue_or_accept_conversation",
        conversationId: "conversation-2",
      },
    ]),
    `=== Next Actions ===
1. Delete this delivery schedule before continuing.
   First run Codex Small Loop \`schedule read --schedule codex-small-loop-message-notification --task task-controller\`.
   Then run \`schedule delete --schedule codex-small-loop-message-notification --task task-controller --if-match <returned-etag>\`.

2. Reply to this Conversation after completing the requested work.
   Conversation ID: conversation-1
   Use Codex Small Loop \`conversation reply --conversation conversation-1\`.

3. Continue or accept this replied Conversation.
   Conversation ID: conversation-2
   Use Codex Small Loop \`conversation continue --conversation conversation-2\` to ask for another reply.
   Use Codex Small Loop \`conversation accept --conversation conversation-2\` to close only this Conversation.`,
  );
});

test("renders scheduled messages with schedule deletion in the same action list", () => {
  const conversation = renderConversationMessage({
    conversationId: "conversation-1",
    initiatorTaskId: "task-interviewer",
    initiatorRole: "interviewer",
    operation: "start",
    responderTaskId: "task-review",
    responderRole: "review",
    scheduleId: "codex-small-loop-message-conversation",
    text: "Please explain the Signal boundary.",
  });
  assert.equal(conversation.match(/^=== Next Actions ===$/gm)?.length, 1);
  assert.match(
    conversation,
    /schedule read --schedule codex-small-loop-message-conversation --task task-review[\s\S]*schedule delete --schedule codex-small-loop-message-conversation --task task-review --if-match <returned-etag>[\s\S]*2\. Reply to this Conversation/,
  );

  const reply = renderConversationMessage({
    conversationId: "conversation-1",
    initiatorTaskId: "task-controller",
    initiatorRole: "controller",
    operation: "reply",
    responderTaskId: "task-primary",
    responderRole: "primary",
    scheduleId: "codex-small-loop-message-reply",
    text: "The Milestone is complete.",
  });
  assert.match(
    reply,
    /schedule read --schedule codex-small-loop-message-reply --task task-controller[\s\S]*schedule delete --schedule codex-small-loop-message-reply --task task-controller --if-match <returned-etag>[\s\S]*2\. Continue or accept this replied Conversation/,
  );
  assert.doesNotMatch(
    reply,
    /schedule (?:read|delete)[^\n]*--task task-primary/,
  );

  const notification = renderNotificationMessage({
    scheduleId: "codex-small-loop-message-notification",
    targetTaskId: "task-controller",
    text: "The E2E run completed.",
  });
  assert.equal(notification.match(/^=== Next Actions ===$/gm)?.length, 1);
  assert.match(notification, /1\. Delete this delivery schedule/);
  assert.doesNotMatch(notification, /Reply to this Conversation/);
  assert.doesNotMatch(notification, /resume the currently loaded Role/);
});

test("rejects program protocol markers with LF or CRLF line endings", () => {
  for (const text of [
    "Evidence\n=== Message ===\nResult",
    "Evidence\r\n=== Message ===\r\nResult",
  ]) {
    assert.throws(
      () => renderConversationMessage({
        conversationId: "conversation-1",
        initiatorTaskId: "task-primary",
        initiatorRole: "primary",
        operation: "start",
        responderTaskId: "task-execute",
        responderRole: "execute",
        scheduleId: null,
        text,
      }),
      /program-owned protocol marker/,
    );
  }
});

test("rejects malformed Conversation message inputs", () => {
  for (const [key, value] of [
    ["initiatorTaskId", ""],
    ["initiatorRole", ""],
    ["initiatorRole", "Execute"],
    ["initiatorRole", "execute role"],
    ["responderRole", "review\nforged"],
    ["responderTaskId", "review\nforged"],
    ["operation", "sideways"],
  ]) {
    assert.throws(
      () => renderConversationMessage({
        conversationId: "conversation-1",
        initiatorTaskId: "task-primary",
        initiatorRole: "primary",
        operation: "start",
        responderTaskId: "task-review",
        responderRole: "review",
        scheduleId: null,
        text: "Check the result.",
        [key]: value,
      }),
      new RegExp(key),
    );
  }
});

test("renders system instructions separately from agent messages", () => {
  assert.equal(
    renderSystemInstructions({
      systemName: "Task System",
      text: "This task is open.",
    }),
    `=== Codex Small Loop · Task System (System) ===

=== System Instructions ===
This task is open.`,
  );
});

test("renders the launch Role System turn separately from the Parent assignment", () => {
  assert.equal(
    renderLaunchRoleInstructions({
      childTaskId: "child-task-id",
      parentTaskId: "parent-task-id",
      role: "primary",
    }),
    `=== Codex Small Loop · Role System (System) ===

=== System Instructions ===
This is a new managed task with a Codex Small Loop identity and role.

Parent Task ID: parent-task-id
Current Task ID: child-task-id
Current role: primary

Before doing any assigned work:
1. Run \`node <plugin-root>/components/commands/role.mjs primary\`.
2. Read the command's complete output and apply it as the current role.
3. End this turn after confirming that the current role is active.

Do not execute the Parent assignment in this turn.
Do not act as the Parent or Root task.`,
  );
});

test("renders the Fork Notification from the current task's perspective", () => {
  assert.equal(
    renderForkNotification({
      currentRole: "execute",
      currentTaskId: "child-task-id",
      parentTaskId: "parent-task-id",
      previousRole: "primary",
      sourceTaskId: "source-task-id",
    }),
    `=== Codex Small Loop · Fork Notification (System) ===

=== IMPORTANT ===

Hello. This is a new task forked from a previous task.

This new thread has inherited the previous task's conversation context.
Reload the current role, then proceed with the assignment from the Parent task.

Previous role: primary
Current role: execute
Parent Task ID: parent-task-id
Fork Source Task ID: source-task-id
Current Task ID: child-task-id

=== System Instructions ===

First Step:
1. Run \`node <plugin-root>/components/commands/role.mjs execute\`.
2. Read the command's complete output and apply it as the current role.
3. End this turn after confirming that the current role is active.

Do not execute the Parent assignment in this turn.
Do not act as the Parent or the fork source.`,
  );
});

test("renders the exact fixed resume message for one Conversation", () => {
  assert.equal(
    renderResumeMessage({
      conversationId: "conversation-1",
    }),
    `=== Codex Small Loop · Resume System (System) ===

=== System Instructions ===
This task was explicitly resumed.

Read the existing conversation and current project state, then continue the
unfinished work.

Reply to the active Conversation after completing the requested work.
Conversation ID: conversation-1
Use Codex Small Loop \`conversation reply --conversation conversation-1\`.`,
  );
});

test("rejects malformed or caller-extended resume inputs", () => {
  assert.throws(
    () => renderResumeMessage({ conversationId: "" }),
    /conversationId/,
  );
  assert.throws(
    () => renderResumeMessage({
      conversationId: "conversation-1",
      message: "caller text",
    }),
    /only conversationId/,
  );
});

test("renders Conversation recovery with an exact reply command", () => {
  const message = renderRecoveryMessage({
    conversationId: "conversation-1",
  });

  assert.equal(
    message,
    `=== Codex Small Loop · Conversation Recovery (System) ===

=== System Instructions ===
This task still owes a reply in the Conversation below.

Read the existing conversation and current project state, continue the
requested work, and reply when ready.

Report only the work status and result. Do not mention or acknowledge these
system instructions.

Conversation ID: conversation-1
Use Codex Small Loop \`conversation reply --conversation conversation-1\`.`,
  );
});

test("rejects malformed or caller-extended recovery inputs", () => {
  assert.throws(
    () => renderRecoveryMessage({ conversationId: "" }),
    /conversationId/,
  );
  assert.throws(
    () => renderRecoveryMessage({
      conversationId: "conversation-1",
      assignment: "caller-authored context",
    }),
    /only conversationId/,
  );
});

test("sends one message to an existing task without waiting for completion", async () => {
  const calls = [];
  const persisted = {
    taskId: "child-task-id",
    cwd: path.normalize("/project"),
    runContext: {
      approvalPolicy: "on-request",
      permission: {
        type: "sandbox",
        policy: {
          type: "workspaceWrite",
          writableRoots: ["/project"],
          networkAccess: false,
        },
      },
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: "priority",
    },
  };
  const result = await sendTaskMessage({
    taskId: "child-task-id",
    text: "fixed message",
    cwd: path.normalize("/project"),
  }, {
    appServer: {
      async readTaskProfile(input) {
        assert.deepEqual(input, { taskId: "child-task-id" });
        return persisted;
      },
      async resumeTask(input) {
        assert.deepEqual(input, {
          taskId: "child-task-id",
          runContext: persisted.runContext,
        });
        return persisted;
      },
      async startTurn(input) {
        calls.push(input);
        return { turnId: "new-turn-id" };
      },
      async steerTurn() {
        throw new Error("must not steer");
      },
      async waitForTurn() {
        throw new Error("must not wait");
      },
    },
    async observeLatestTask() {
      return {
        taskId: "child-task-id",
        location: "active",
        historyFile: "/codex/child.jsonl",
        latestTurnId: "previous-turn",
        turnState: "ended",
        diagnostics: [],
      };
    },
  });

  assert.deepEqual(calls, [{
    taskId: "child-task-id",
    text: "fixed message",
    cwd: path.normalize("/project"),
    runContext: {
      approvalPolicy: "on-request",
      permission: {
        type: "sandbox",
        policy: {
          type: "workspaceWrite",
          writableRoots: ["/project"],
          networkAccess: false,
        },
      },
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: "priority",
    },
  }]);
  assert.deepEqual(result, {
    taskId: "child-task-id",
    turnId: "new-turn-id",
    delivery: "started",
  });
});

test("uses the active named permission profile instead of a sandbox override", async () => {
  const starts = [];
  await sendTaskMessage({
    taskId: "child-task-id",
    text: "fixed message",
    cwd: "/project",
  }, {
    appServer: {
      async resumeTask() {
        return {
          taskId: "child-task-id",
          cwd: "/project",
          runContext: {
            approvalPolicy: "never",
            permission: {
              type: "profile",
              id: "project-maintainer",
            },
            model: "gpt-5.6-sol",
            reasoningEffort: "medium",
            serviceTier: "priority",
          },
        };
      },
      async startTurn(input) {
        starts.push(input);
        return { turnId: "new-turn-id" };
      },
      async steerTurn() {
        throw new Error("must not steer");
      },
    },
    async observeLatestTask() {
      return {
        taskId: "child-task-id",
        location: "active",
        historyFile: "/codex/child.jsonl",
        latestTurnId: "previous-turn",
        turnState: "ended",
        diagnostics: [],
      };
    },
  });

  assert.deepEqual(starts, [{
    taskId: "child-task-id",
    text: "fixed message",
    cwd: path.normalize("/project"),
    runContext: {
      approvalPolicy: "never",
      permission: {
        type: "profile",
        id: "project-maintainer",
      },
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: "priority",
    },
  }]);
});

test("refuses to start when resume permissions are unknown or cwd differs", async () => {
  for (const [snapshot, code] of [
    [{
      taskId: "child-task-id",
      cwd: path.normalize("/project"),
    }, "TASK_PERMISSION_UNKNOWN"],
    [{
      taskId: "child-task-id",
      cwd: "/other-project",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: "priority",
      activePermissionProfile: null,
    }, "TASK_MESSAGE_CWD_MISMATCH"],
  ]) {
    await assert.rejects(
      sendTaskMessage({
        taskId: "child-task-id",
        text: "fixed message",
        cwd: "/project",
      }, {
        appServer: {
          async resumeTask() {
            return snapshot;
          },
          async startTurn() {
            throw new Error("must not start");
          },
          async steerTurn() {
            throw new Error("must not steer");
          },
        },
        async observeLatestTask() {
          return {
            taskId: "child-task-id",
            location: "active",
            historyFile: "/codex/child.jsonl",
            latestTurnId: "previous-turn",
            turnState: "ended",
            diagnostics: [],
          };
        },
      }),
      (error) => error.code === code,
    );
  }
});

test("steers an active daemon turn instead of starting another turn", async () => {
  const calls = [];
  const result = await sendTaskMessage({
    taskId: "child-task-id",
    text: "updated direction",
    cwd: path.normalize("/project"),
  }, {
    appServer: {
      async startTurn() {
        throw new Error("must not start");
      },
      async steerTurn(input) {
        calls.push(input);
        return { turnId: input.turnId };
      },
    },
    async observeLatestTask() {
      return {
        taskId: "child-task-id",
        location: "active",
        historyFile: "/codex/child.jsonl",
        latestTurnId: "active-turn",
        turnState: "in_progress",
        diagnostics: [],
      };
    },
  });

  assert.deepEqual(calls, [{
    taskId: "child-task-id",
    turnId: "active-turn",
    text: "updated direction",
    cwd: path.normalize("/project"),
  }]);
  assert.deepEqual(result, {
    taskId: "child-task-id",
    turnId: "active-turn",
    delivery: "steered",
  });
});

test("waits for an externally owned active turn before starting", async () => {
  const events = [];
  const latest = [
    {
      taskId: "child-task-id",
      location: "active",
      historyFile: "/codex/child.jsonl",
      latestTurnId: "external-turn",
      turnState: "in_progress",
      diagnostics: [],
    },
    {
      taskId: "child-task-id",
      location: "active",
      historyFile: "/codex/child.jsonl",
      latestTurnId: "external-turn",
      turnState: "in_progress",
      diagnostics: [],
    },
    {
      taskId: "child-task-id",
      location: "active",
      historyFile: "/codex/child.jsonl",
      latestTurnId: "external-turn",
      turnState: "ended",
      diagnostics: [],
    },
  ];
  const exact = ["in_progress", "ended"];
  const result = await sendTaskMessage({
    taskId: "child-task-id",
    text: "follow-up",
    cwd: "/project",
  }, {
    appServer: {
      async steerTurn() {
        events.push("steer");
        throw Object.assign(new Error("no active turn to steer"), {
          code: "APP_SERVER_STEER_NO_ACTIVE_TURN",
        });
      },
      async startTurn() {
        events.push("start");
        return { turnId: "new-turn" };
      },
      async resumeTask({ taskId }) {
        events.push("resume");
        return fullAccessSettings(taskId);
      },
    },
    async observeLatestTask() {
      events.push("latest");
      return latest.shift();
    },
    async observeExactTurn(_taskId, turnId) {
      events.push("exact");
      return {
        taskId: "child-task-id",
        location: "active",
        historyFile: "/codex/child.jsonl",
        turnId,
        turnState: exact.shift(),
        diagnostics: [],
      };
    },
    async sleep() {
      events.push("sleep");
    },
    nowMs: () => 0,
    timeoutMs: 100,
  });

  assert.deepEqual(events, [
    "latest",
    "steer",
    "latest",
    "exact",
    "sleep",
    "exact",
    "latest",
    "resume",
    "start",
  ]);
  assert.equal(result.delivery, "started");
  assert.equal(result.turnId, "new-turn");
});

test("waits for a non-steerable review turn before starting", async () => {
  const snapshots = [
    {
      taskId: "child-task-id",
      location: "active",
      historyFile: "/codex/child.jsonl",
      latestTurnId: "review-turn",
      turnState: "in_progress",
      diagnostics: [],
    },
    {
      taskId: "child-task-id",
      location: "active",
      historyFile: "/codex/child.jsonl",
      latestTurnId: "review-turn",
      turnState: "ended",
      diagnostics: [],
    },
  ];
  const result = await sendTaskMessage({
    taskId: "child-task-id",
    text: "after review",
    cwd: "/project",
  }, {
    appServer: {
      async steerTurn() {
        throw Object.assign(new Error("cannot steer a review turn"), {
          code: "APP_SERVER_STEER_NOT_STEERABLE",
          turnKind: "review",
        });
      },
      async startTurn() {
        return { turnId: "after-review-turn" };
      },
      async resumeTask({ taskId }) {
        return fullAccessSettings(taskId);
      },
    },
    async observeLatestTask() {
      return snapshots.shift();
    },
    async observeExactTurn(_taskId, turnId) {
      return {
        taskId: "child-task-id",
        location: "active",
        historyFile: "/codex/child.jsonl",
        turnId,
        turnState: "ended",
        diagnostics: [],
      };
    },
  });

  assert.deepEqual(result, {
    taskId: "child-task-id",
    turnId: "after-review-turn",
    delivery: "started",
  });
});

test("reobserves a turn mismatch and fails closed on unknown state", async () => {
  const turnIds = [];
  const snapshots = [
    {
      taskId: "child-task-id",
      location: "active",
      historyFile: "/codex/child.jsonl",
      latestTurnId: "old-turn",
      turnState: "in_progress",
      diagnostics: [],
    },
    {
      taskId: "child-task-id",
      location: "active",
      historyFile: "/codex/child.jsonl",
      latestTurnId: "new-turn",
      turnState: "in_progress",
      diagnostics: [],
    },
  ];
  const routed = await sendTaskMessage({
    taskId: "child-task-id",
    text: "new input",
    cwd: "/project",
  }, {
    appServer: {
      async startTurn() {
        throw new Error("must not start");
      },
      async steerTurn({ turnId }) {
        turnIds.push(turnId);
        if (turnId === "old-turn") {
          throw Object.assign(new Error("mismatch"), {
            code: "APP_SERVER_STEER_TURN_MISMATCH",
          });
        }
        return { turnId };
      },
    },
    async observeLatestTask() {
      return snapshots.shift();
    },
  });
  assert.deepEqual(turnIds, ["old-turn", "new-turn"]);
  assert.equal(routed.delivery, "steered");

  await assert.rejects(
    sendTaskMessage({
      taskId: "child-task-id",
      text: "new input",
      cwd: "/project",
    }, {
      appServer: {
        async startTurn() {
          throw new Error("must not start");
        },
        async steerTurn() {
          throw new Error("must not steer");
        },
      },
      async observeLatestTask() {
        return {
          taskId: "child-task-id",
          location: "active",
          historyFile: "/codex/child.jsonl",
          latestTurnId: null,
          turnState: "unknown",
          diagnostics: [{ code: "TASK_HISTORY_UNREADABLE" }],
        };
      },
    }),
    (error) => error.code === "TASK_MESSAGE_STATE_UNKNOWN",
  );
});

test("rejects malformed message inputs and ambiguous turn-start responses", async () => {
  await assert.rejects(
    sendTaskMessage({
      taskId: "child-task-id",
      text: "fixed message",
      cwd: "/project",
    }, {
      appServer: {
        async resumeTask({ taskId }) {
          return fullAccessSettings(taskId);
        },
        async startTurn() {
          return {};
        },
        async steerTurn() {
          throw new Error("must not steer");
        },
      },
      async observeLatestTask() {
        return {
          taskId: "child-task-id",
          location: "active",
          historyFile: "/codex/child.jsonl",
          latestTurnId: "previous-turn",
          turnState: "ended",
          diagnostics: [],
        };
      },
    }),
    (error) => error.code === "APP_SERVER_RESPONSE_INVALID",
  );
  await assert.rejects(
    sendTaskMessage({
      taskId: "child-task-id",
      text: "",
      cwd: "/project",
    }, {
      appServer: {
        async startTurn() {
          throw new Error("must not be called");
        },
        async steerTurn() {
          throw new Error("must not be called");
        },
      },
    }),
    /text/,
  );
});

function delivery(kind, targetTaskId, overrides = {}) {
  return {
    id: `delivery-${targetTaskId}`,
    kind,
    targetTaskId,
    parentTaskId: "parent-task-id",
    conversationId: kind === "interrupt"
      ? null
      : `conversation-${targetTaskId}`,
    ...overrides,
  };
}

test("delivers resume text and interrupts only exact active turns", async () => {
  const calls = [];
  const actions = [
    delivery("resume", "resume-child"),
    delivery("interrupt", "running-child"),
    delivery("interrupt", "finished-child"),
    delivery("interrupt", "archived-child"),
  ];
  const outcomes = await deliverMechanicalActions(actions, {
    projectRoot: "/project",
    appServer: {
      async resumeTask({ taskId }) {
        return fullAccessSettings(taskId);
      },
      async startTurn(input) {
        calls.push(["start", input]);
        return { turnId: "resume-turn" };
      },
      async steerTurn() {
        throw new Error("must not steer");
      },
      async interruptTurn(input) {
        calls.push(["interrupt", input]);
        return { interrupted: true };
      },
    },
    async observeTasks(requests) {
      calls.push(["observe", requests]);
      if (
        requests.length === 1
        && requests[0].taskId === "resume-child"
      ) {
        return [{
          taskId: "resume-child",
          location: "active",
          historyFile: "/codex/resume-child.jsonl",
          latestTurnId: "previous-resume-turn",
          turnState: "ended",
          diagnostics: [],
        }];
      }
      return [
        {
          taskId: "running-child",
          location: "active",
          historyFile: "/codex/running-child.jsonl",
          latestTurnId: "running-turn",
          turnState: "in_progress",
        },
        {
          taskId: "finished-child",
          location: "active",
          historyFile: "/codex/finished-child.jsonl",
          latestTurnId: "finished-turn",
          turnState: "ended",
        },
        {
          taskId: "archived-child",
          location: "archived",
          historyFile: "/codex/archived-child.jsonl",
          latestTurnId: "archived-turn",
          turnState: "ended",
        },
      ];
    },
  });

  assert.deepEqual(calls[0], ["observe", [
      { taskId: "running-child", mode: "latest" },
      { taskId: "finished-child", mode: "latest" },
      { taskId: "archived-child", mode: "latest" },
    ]]);
  assert.ok(calls.some((call) => (
    call[0] === "observe"
    && call[1]?.[0]?.taskId === "resume-child"
  )));
  assert.deepEqual(calls.find(([kind]) => kind === "start"), ["start", {
      taskId: "resume-child",
      text: renderResumeMessage({
        conversationId: "conversation-resume-child",
      }),
      cwd: path.normalize("/project"),
      runContext: fullAccessSettings("resume-child").runContext,
    }]);
  assert.deepEqual(calls.find(([kind]) => kind === "interrupt"), ["interrupt", {
      taskId: "running-child",
      turnId: "running-turn",
    }]);
  assert.deepEqual(outcomes, [
    {
      deliveryId: "delivery-resume-child",
      status: "delivered",
      effect: "sent",
      turnId: "resume-turn",
      route: "started",
    },
    {
      deliveryId: "delivery-running-child",
      status: "delivered",
      effect: "interrupted",
    },
    {
      deliveryId: "delivery-finished-child",
      status: "delivered",
      effect: "no_op",
    },
    {
      deliveryId: "delivery-archived-child",
      status: "delivered",
      effect: "no_op",
    },
  ]);
});

test("delivers only the fixed recovery message to its target task", async () => {
  const calls = [];
  const outcomes = await deliverMechanicalActions([
    delivery("recovery", "recovery-child"),
  ], {
    projectRoot: "/project",
    appServer: {
      async resumeTask({ taskId }) {
        return fullAccessSettings(taskId);
      },
      async startTurn(input) {
        calls.push(input);
        return { turnId: "recovery-turn" };
      },
      async steerTurn() {
        throw new Error("must not steer");
      },
      async interruptTurn() {
        throw new Error("must not interrupt recovery");
      },
    },
    async observeTasks() {
      return [{
        taskId: "recovery-child",
        location: "active",
        historyFile: "/codex/recovery-child.jsonl",
        latestTurnId: "previous-recovery-turn",
        turnState: "ended",
        diagnostics: [],
      }];
    },
  });

  assert.deepEqual(calls, [{
    taskId: "recovery-child",
    text: renderRecoveryMessage({
      conversationId: "conversation-recovery-child",
    }),
    cwd: path.normalize("/project"),
    runContext: fullAccessSettings("recovery-child").runContext,
  }]);
  assert.deepEqual(outcomes, [{
    deliveryId: "delivery-recovery-child",
    status: "delivered",
    effect: "sent",
    turnId: "recovery-turn",
    route: "started",
  }]);
});

test("returns bounded per-action failures without hiding healthy siblings", async () => {
  const outcomes = await deliverMechanicalActions([
    delivery("interrupt", "unknown-child"),
    delivery("resume", "failed-resume"),
    delivery("resume", "healthy-resume"),
  ], {
    projectRoot: "/project",
    appServer: {
      async resumeTask({ taskId }) {
        return fullAccessSettings(taskId);
      },
      async startTurn({ taskId }) {
        if (taskId === "failed-resume") {
          throw Object.assign(new Error("x".repeat(2_000)), {
            code: "APP_SERVER_REQUEST_FAILED",
          });
        }
        return { turnId: "healthy-turn" };
      },
      async steerTurn() {
        throw new Error("must not steer");
      },
      async interruptTurn() {
        throw new Error("must not be called");
      },
    },
    async observeTasks(requests) {
      return requests.map(({ taskId }) => (
        taskId === "unknown-child"
          ? {
            taskId,
            location: "active",
            historyFile: "/codex/unknown-child.jsonl",
            latestTurnId: null,
            turnState: "unknown",
          }
          : {
            taskId,
            location: "active",
            historyFile: `/codex/${taskId}.jsonl`,
            latestTurnId: "previous-turn",
            turnState: "ended",
          }
      ));
    },
  });

  assert.deepEqual(outcomes[0], {
    deliveryId: "delivery-unknown-child",
    status: "failed",
    error: {
      code: "TASK_STATE_UNKNOWN",
      message: "Current in-progress Turn could not be proven.",
    },
  });
  assert.equal(outcomes[1].status, "failed");
  assert.equal(outcomes[1].error.code, "APP_SERVER_REQUEST_FAILED");
  assert.equal(outcomes[1].error.message.length <= 512, true);
  assert.deepEqual(outcomes[2], {
    deliveryId: "delivery-healthy-resume",
    status: "delivered",
    effect: "sent",
    turnId: "healthy-turn",
    route: "started",
  });
});
