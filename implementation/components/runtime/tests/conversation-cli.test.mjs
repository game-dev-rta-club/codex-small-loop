import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runConversationCli } from "../../commands/conversation.mjs";
import { runMessageCli } from "../../commands/message.mjs";

function input(text = "") {
  const stream = new PassThrough();
  stream.end(text);
  return stream;
}

function output() {
  let source = "";
  return {
    stream: { write(chunk) { source += chunk; } },
    json() { return JSON.parse(source); },
    text() { return source; },
  };
}

function ledger() {
  return {
    version: 10,
    revision: 0,
    projectRoot: "/project",
    projectKey: "key:/project",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    managedTasks: [{
      taskId: "review-task",
      name: "Reviewer",
      role: "review",
      createdAt: "2026-08-07T00:00:00.000Z",
    }],
    pendingLaunches: [],
    links: [{
      parentTaskId: "primary-task",
      childTaskId: "review-task",
      lifecycle: "open",
      role: "review",
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
      historyFile: null,
      acceptanceReason: null,
      acceptedAt: null,
    }],
    conversations: [],
    deliveries: [],
    appMessages: [],
  };
}

function harness(threadSource = "codex-small-loop") {
  let state = ledger();
  const sent = [];
  let ids = 0;
  return {
    sent,
    state: () => state,
    options: {
      cwd: "/project",
      env: { CODEX_THREAD_ID: "primary-task" },
      now: () => "2026-08-07T00:01:00.000Z",
      createMessageId: () => `message-${++ids}`,
      async resolveProject(projectRoot) {
        return {
          root: projectRoot,
          key: `key:${projectRoot}`,
          stateFile: `${projectRoot}/.codex-small-loop/state.json`,
        };
      },
      async readLedger() { return state; },
      async transactTaskLedger(store, project, transform) {
        const outcome = transform(state);
        state = outcome.state;
        return { state, result: outcome.result };
      },
      createAppServer() {
        return {
          async readTask({ taskId }) {
            return { taskId, threadSource };
          },
          async close() {},
        };
      },
      async send(message) {
        sent.push(message);
        return {
          taskId: message.taskId,
          turnId: `turn-${sent.length}`,
          delivery: "started",
        };
      },
      async startSupervisor() {},
    },
  };
}

test("conversation help owns the managed Conversation lifecycle", async () => {
  const stdout = output();
  const exitCode = await runConversationCli(["--help"], {
    stdout: stdout.stream,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.text(), /conversation start --task/);
  assert.match(stdout.text(), /conversation reply\|continue --conversation/);
  assert.match(stdout.text(), /conversation accept --conversation/);
  assert.doesNotMatch(stdout.text(), /message notify/);
});

test("message rejects Conversation lifecycle commands", async () => {
  const stdout = output();
  const exitCode = await runMessageCli(["start", "--task", "review-task"], {
    cwd: "/project",
    env: { CODEX_THREAD_ID: "primary-task" },
    stdin: input("Review this."),
    stdout: stdout.stream,
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.json().code, "MESSAGE_COMMAND_INVALID");
});

test("start reloads the Task's canonical Role in the assignment turn", async () => {
  const current = harness();
  const stdout = output();
  const exitCode = await runConversationCli([
    "start",
    "--task",
    "review-task",
    "--reload-role",
  ], {
    ...current.options,
    stdin: input("Review this correction."),
    stdout: stdout.stream,
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.json().operation, "start");
  assert.equal(current.state().conversations[0].responderRole, "review");
  assert.match(
    current.sent[0].text,
    /node <plugin-root>\/components\/commands\/role\.mjs review/,
  );
  assert.match(current.sent[0].text, /continue in this same turn/i);
  assert.match(current.sent[0].text, /Review this correction\./);
});

test("reload-role is valid only when starting a Conversation", async () => {
  const current = harness();
  const stdout = output();
  const exitCode = await runConversationCli([
    "reply",
    "--conversation",
    "conversation-1",
    "--reload-role",
  ], {
    ...current.options,
    stdin: input("Done."),
    stdout: stdout.stream,
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.json().code, "CONVERSATION_CLI_USAGE");
});

test("a committed Conversation delivery failure returns partial and queues recovery", async () => {
  const current = harness();
  current.options.send = async () => {
    throw Object.assign(new Error("direct delivery failed"), {
      code: "DELIVERY_FAILED",
    });
  };
  const stdout = output();
  const exitCode = await runConversationCli([
    "start",
    "--task",
    "review-task",
  ], {
    ...current.options,
    stdin: input("Review this."),
    stdout: stdout.stream,
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.json().run, "partial");
  assert.equal(stdout.json().code, "DELIVERY_FAILED");
  assert.equal(stdout.json().conversationId, "message-1");
  assert.equal(stdout.json().delivery, "queued");
  assert.equal(current.state().conversations[0].state, "awaiting_reply");
  assert.equal(current.state().appMessages.length, 1);
});

test("a queued Conversation stays partial when supervision cannot start", async () => {
  const current = harness("user");
  current.options.startSupervisor = async () => {
    throw Object.assign(new Error("supervisor unavailable"), {
      code: "RECOVERY_SUPERVISOR_START_FAILED",
    });
  };
  const stdout = output();
  const exitCode = await runConversationCli([
    "start",
    "--task",
    "review-task",
  ], {
    ...current.options,
    stdin: input("Review this."),
    stdout: stdout.stream,
  });

  assert.equal(exitCode, 2);
  assert.deepEqual(stdout.json(), {
    run: "partial",
    operation: "start",
    code: "RECOVERY_SUPERVISOR_START_FAILED",
    message: "supervisor unavailable",
    conversationId: "message-1",
    taskId: "review-task",
    messageId: "message-2",
    delivery: "queued",
    recommendedAction: "start_supervisor",
  });
  assert.equal(current.state().appMessages.length, 1);
});

test("a delivered Conversation reports delivery when only supervision fails", async () => {
  const current = harness();
  current.options.startSupervisor = async () => {
    throw Object.assign(new Error("supervisor unavailable"), {
      code: "RECOVERY_SUPERVISOR_START_FAILED",
    });
  };
  const stdout = output();
  const exitCode = await runConversationCli([
    "start",
    "--task",
    "review-task",
  ], {
    ...current.options,
    stdin: input("Review this."),
    stdout: stdout.stream,
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.json().run, "partial");
  assert.equal(stdout.json().delivery, "started");
  assert.equal(stdout.json().turnId, "turn-1");
  assert.equal(stdout.json().recommendedAction, "start_supervisor");
});
