import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runConversationCli } from "../../commands/conversation.mjs";
import { runMessageCli } from "../../commands/message.mjs";

const PROJECT_ROOT = path.resolve("/project");

function input(text) {
  const stream = new PassThrough();
  stream.end(text);
  return stream;
}

function output() {
  let source = "";
  return {
    stream: {
      write(chunk) {
        source += chunk;
      },
    },
    json() {
      return JSON.parse(source);
    },
    text() {
      return source;
    },
  };
}

function link(parentTaskId, childTaskId) {
  return {
    parentTaskId,
    childTaskId,
    lifecycle: "open",
    role: "primary",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    historyFile: null,
    acceptanceReason: null,
    acceptedAt: null,
  };
}

function ledger(overrides = {}) {
  return {
    version: 10,
    revision: 0,
    projectRoot: PROJECT_ROOT,
    projectKey: `key:${PROJECT_ROOT}`,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    managedTasks: [
      {
        taskId: "review-task",
        name: "Reviewer",
        role: "review",
        createdAt: "2026-07-30T00:00:00.000Z",
      },
      {
        taskId: "interviewer-task",
        name: "Interviewer",
        role: "interviewer",
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    ],
    pendingLaunches: [],
    links: [
      link("primary-task", "review-task"),
      link("primary-task", "interviewer-task"),
    ],
    conversations: [],
    deliveries: [],
    appMessages: [],
    ...overrides,
  };
}

function harness(
  initialState = ledger(),
  threadSource = "codex-small-loop",
  targetCwd = PROJECT_ROOT,
) {
  let state = initialState;
  const sent = [];
  let appServerCreates = 0;
  let supervisorStarts = 0;

  return {
    options: {
      cwd: "/project",
      env: { CODEX_THREAD_ID: "interviewer-task" },
      now: () => "2026-07-30T00:01:00.000Z",
      createMessageId: (() => {
        let index = 0;
        return () => `generated-${++index}`;
      })(),
      async resolveProject(projectRoot) {
        return {
          root: projectRoot,
          key: `key:${projectRoot}`,
          stateFile: `${projectRoot}/.codex-small-loop/state.json`,
        };
      },
      async readLedger() {
        return state;
      },
      async transactTaskLedger(store, project, transform) {
        const outcome = transform(state);
        state = outcome.state;
        return { state, result: outcome.result };
      },
      createAppServer({ cwd }) {
        assert.equal(cwd, PROJECT_ROOT);
        appServerCreates += 1;
        return {
          async readTask({ taskId }) {
            return {
              taskId,
              name: "Target",
              threadSource,
            };
          },
          async resumeTask() {
            assert.fail("notification metadata must not resume the target");
          },
          async readTaskProfile({ taskId }) {
            return {
              taskId,
              cwd: targetCwd,
            };
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
      async startSupervisor(projectRoot) {
        assert.equal(projectRoot, PROJECT_ROOT);
        supervisorStarts += 1;
      },
    },
    state() {
      return state;
    },
    sent,
    appServerCreates() {
      return appServerCreates;
    },
    supervisorStarts() {
      return supervisorStarts;
    },
  };
}

async function run(argv, currentHarness, {
  body = "",
  senderTaskId,
} = {}) {
  if (senderTaskId) {
    currentHarness.options.env = { CODEX_THREAD_ID: senderTaskId };
  }
  const stdout = output();
  const runner = argv[0] === "notify"
    ? runMessageCli
    : runConversationCli;
  const exitCode = await runner(argv, {
    ...currentHarness.options,
    stdin: input(body),
    stdout: stdout.stream,
  });
  return {
    exitCode,
    result: stdout.json(),
  };
}

test("shows separate Notification and Conversation help without a Task context", async () => {
  const current = harness();
  current.options.env = {};
  const messageStdout = output();
  const messageExit = await runMessageCli(["--help"], {
    ...current.options,
    stdin: input(""),
    stdout: messageStdout.stream,
  });
  const conversationStdout = output();
  const conversationExit = await runConversationCli(["--help"], {
    ...current.options,
    stdin: input(""),
    stdout: conversationStdout.stream,
  });

  assert.equal(messageExit, 0);
  assert.equal(conversationExit, 0);
  assert.match(messageStdout.text(), /Information only.*message notify/is);
  assert.match(conversationStdout.text(), /conversation start/is);
  assert.match(conversationStdout.text(), /reply\|continue/);
  assert.match(conversationStdout.text(), /conversation accept/);
});

test("starts, replies to, continues, and accepts one Conversation", async () => {
  const current = harness();
  const started = await run([
    "start",
    "--task",
    "review-task",
  ], current, {
    body: "Explain the required Signal.",
  });

  assert.equal(started.exitCode, 0);
  assert.equal(started.result.conversationId, "generated-1");
  assert.equal(current.state().conversations[0].state, "awaiting_reply");
  assert.match(current.sent[0].text, /Interviewer → Review/);
  assert.match(current.sent[0].text, /Initiator Task ID: interviewer-task/);
  assert.match(current.sent[0].text, /Responder Task ID: review-task/);
  assert.match(current.sent[0].text, /Conversation ID: generated-1/);

  const replied = await run([
    "reply",
    "--conversation",
    "generated-1",
  ], current, {
    body: "The Signal applies to the current snapshot.",
    senderTaskId: "review-task",
  });
  assert.equal(replied.exitCode, 0);
  assert.equal(current.state().conversations[0].state, "replied");
  assert.equal(current.sent[1].taskId, "interviewer-task");
  assert.match(current.sent[1].text, /Interviewer ← Review/);
  assert.match(current.sent[1].text, /Initiator Task ID: interviewer-task/);
  assert.match(current.sent[1].text, /Responder Task ID: review-task/);

  const continued = await run([
    "continue",
    "--conversation",
    "generated-1",
  ], current, {
    body: "Clarify the implementation boundary.",
    senderTaskId: "interviewer-task",
  });
  assert.equal(continued.exitCode, 0);
  assert.equal(current.state().conversations[0].state, "awaiting_reply");

  await run([
    "reply",
    "--conversation",
    "generated-1",
  ], current, {
    body: "Only the total calculation changes.",
    senderTaskId: "review-task",
  });

  const appServerCreates = current.appServerCreates();
  const accepted = await run([
    "accept",
    "--conversation",
    "generated-1",
  ], current, {
    senderTaskId: "interviewer-task",
  });
  assert.equal(accepted.exitCode, 0);
  assert.equal(accepted.result.state, "accepted");
  assert.equal(current.state().conversations[0].state, "accepted");
  assert.equal(current.appServerCreates(), appServerCreates);
});

test("an accepted Conversation cannot continue and points to a new start", async () => {
  const current = harness();
  const started = await run([
    "start",
    "--task",
    "review-task",
  ], current, {
    body: "Review this cycle.",
  });
  await run([
    "reply",
    "--conversation",
    started.result.conversationId,
  ], current, {
    body: "This cycle is complete.",
    senderTaskId: "review-task",
  });
  await run([
    "accept",
    "--conversation",
    started.result.conversationId,
  ], current, {
    senderTaskId: "interviewer-task",
  });

  const continued = await run([
    "continue",
    "--conversation",
    started.result.conversationId,
  ], current, {
    body: "Review the next cycle.",
    senderTaskId: "interviewer-task",
  });
  assert.equal(continued.exitCode, 1);
  assert.equal(continued.result.code, "CONVERSATION_ACCEPTED");
  assert.match(
    continued.result.message,
    /conversation\.mjs start --task review-task/i,
  );

  const next = await run([
    "start",
    "--task",
    "review-task",
  ], current, {
    body: "Review the next cycle.",
    senderTaskId: "interviewer-task",
  });
  assert.equal(next.exitCode, 0);
  assert.notEqual(
    next.result.conversationId,
    started.result.conversationId,
  );
});

test("managed Tasks remain on direct delivery even if threadSource reports user", async () => {
  const current = harness(ledger(), "user");
  const started = await run(["start", "--task", "review-task"], current, { body: "Review this." });
  assert.equal(started.exitCode, 0);
  assert.equal(started.result.delivery, "started");
  assert.equal(current.state().appMessages.length, 0);
  assert.equal(current.state().conversations[0].state, "awaiting_reply");
  assert.match(current.sent[0].text, /Interviewer → Review/);
  assert.doesNotMatch(current.sent[0].text, /schedule delete/);
});

test("an unmanaged App Controller starts a Controller to Primary Conversation", async () => {
  const primaryTask = {
    taskId: "primary-task",
    name: "Primary",
    role: "primary",
    createdAt: "2026-07-30T00:00:00.000Z",
  };
  const primaryLink = {
    ...link("controller-task", "primary-task"),
    role: "primary",
  };
  const current = harness(ledger({
    managedTasks: [primaryTask],
    links: [primaryLink],
  }), "user");

  const started = await run([
    "start",
    "--task",
    "primary-task",
  ], current, {
    body: "Begin the approved Milestone.",
    senderTaskId: "controller-task",
  });

  assert.equal(started.exitCode, 0);
  assert.equal(current.state().conversations[0].initiatorRole, "controller");
  assert.equal(current.state().conversations[0].responderRole, "primary");
  assert.match(current.sent[0].text, /Controller → Primary/);
});

test("replies to an App Controller without reading its locked session", async () => {
  const primaryTask = {
    taskId: "primary-task",
    name: "Primary",
    role: "primary",
    createdAt: "2026-07-30T00:00:00.000Z",
  };
  const primaryLink = {
    ...link("controller-task", "primary-task"),
    role: "primary",
  };
  const current = harness(ledger({
    managedTasks: [primaryTask],
    links: [primaryLink],
    conversations: [{
      id: "controller-primary",
      initiatorTaskId: "controller-task",
      initiatorRole: "controller",
      responderTaskId: "primary-task",
      responderRole: "primary",
      state: "awaiting_reply",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      repliedAt: null,
      acceptedAt: null,
    }],
  }));

  const replied = await run([
    "reply",
    "--conversation",
    "controller-primary",
  ], current, {
    body: "Implementation complete.",
    senderTaskId: "primary-task",
  });

  assert.equal(replied.exitCode, 0);
  assert.equal(replied.result.delivery, "queued");
  assert.equal(current.appServerCreates(), 0);
  assert.equal(current.sent.length, 0);
  assert.equal(current.state().conversations[0].state, "replied");
  assert.equal(current.state().appMessages[0].targetTaskId, "controller-task");
  assert.match(
    current.state().appMessages[0].text,
    /schedule read --schedule codex-small-loop-message-[a-f0-9]{32} --task controller-task[\s\S]*schedule delete --schedule codex-small-loop-message-[a-f0-9]{32} --task controller-task --if-match <returned-etag>/,
  );
  assert.doesNotMatch(
    current.state().appMessages[0].text,
    /schedule (?:read|delete)[^\n]*--task primary-task/,
  );
});

test("notifies an unmanaged Codex Small Loop Task without a Conversation", async () => {
  const current = harness(ledger(), "codex-small-loop", "/other-project");
  const notified = await run([
    "notify",
    "--task",
    "external-task",
  ], current, {
    body: "The E2E run completed.",
  });

  assert.equal(notified.exitCode, 0);
  assert.deepEqual(notified.result, {
    run: "ok",
    operation: "notify",
    taskId: "external-task",
    turnId: "turn-1",
    delivery: "started",
    replyExpected: false,
  });
  assert.equal(current.state().conversations.length, 0);
  assert.equal(current.state().appMessages.length, 0);
  assert.deepEqual(current.sent[0], {
    taskId: "external-task",
    text: `=== Codex Small Loop · Notification ===

No reply or acknowledgement is required.

=== Message ===
The E2E run completed.`,
    cwd: path.normalize("/other-project"),
  });
  assert.equal(current.supervisorStarts(), 0);
});

test("uses a Unicode --message argument without reading piped stdin", async () => {
  const current = harness(ledger(), "codex-small-loop", "/other-project");
  const notified = await run([
    "notify",
    "--task",
    "external-task",
    "--message",
    "Hello, world",
  ], current, {
    body: "This piped body must not be used.",
  });

  assert.equal(notified.exitCode, 0);
  assert.match(current.sent[0].text, /=== Message ===\nHello, world$/);
  assert.doesNotMatch(current.sent[0].text, /piped body/);
});

test("reports an unverified direct Notification result as partial", async () => {
  const current = harness(ledger(), "codex-small-loop", "/other-project");
  current.options.send = async () => ({
    taskId: "external-task",
    turnId: null,
    delivery: "started",
  });
  const notified = await run([
    "notify",
    "--task",
    "external-task",
  ], current, {
    body: "The E2E run completed.",
  });

  assert.equal(notified.exitCode, 2);
  assert.equal(notified.result.run, "partial");
  assert.equal(notified.result.code, "MESSAGE_RESPONSE_INVALID");
  assert.equal(notified.result.delivery, "unknown");
  assert.equal(notified.result.recommendedAction, "inspect_delivery");
});

test("queues repeated notifications to an unmanaged App-owned Task", async () => {
  const current = harness(ledger(), "user");
  const first = await run([
    "notify",
    "--task",
    "controller-task",
  ], current, {
    body: "Run complete.",
  });
  const second = await run([
    "notify",
    "--task",
    "controller-task",
  ], current, {
    body: "Run complete.",
  });

  assert.equal(first.exitCode, 0);
  assert.deepEqual(first.result, {
    run: "ok",
    operation: "notify",
    taskId: "controller-task",
    messageId: "generated-1",
    delivery: "queued",
    replyExpected: false,
  });
  assert.equal(second.exitCode, 0);
  assert.equal(second.result.messageId, "generated-2");
  assert.equal(current.state().conversations.length, 0);
  assert.equal(current.state().appMessages.length, 2);
  assert.equal(
    current.state().appMessages[0].sourceTaskId,
    "interviewer-task",
  );
  assert.match(
    current.state().appMessages[0].text,
    /Codex Small Loop · Notification/,
  );
  assert.match(
    current.state().appMessages[0].text,
    /=== Next Actions ===[\s\S]*schedule read --schedule codex-small-loop-message-[a-f0-9]{32} --task controller-task[\s\S]*schedule delete --schedule codex-small-loop-message-[a-f0-9]{32} --task controller-task --if-match <returned-etag>/,
  );
  assert.doesNotMatch(
    current.state().appMessages[0].text,
    /Conversation ID|conversation reply|conversation accept/,
  );
  assert.notEqual(
    current.state().appMessages[0].text,
    current.state().appMessages[1].text,
  );
  assert.equal(current.sent.length, 0);
  assert.equal(current.supervisorStarts(), 2);
});

test("fails before delivery when the target already owes a reply", async () => {
  const existing = {
    id: "existing-conversation",
    initiatorTaskId: "primary-task",
    initiatorRole: "primary",
    responderTaskId: "review-task",
    responderRole: "review",
    state: "awaiting_reply",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    repliedAt: null,
    acceptedAt: null,
  };
  const current = harness(ledger({ conversations: [existing] }));
  const result = await run([
    "start",
    "--task",
    "review-task",
  ], current, {
    body: "Competing request.",
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.result.code, "MESSAGE_TARGET_BUSY");
  assert.match(result.result.message, /currently owes a reply/i);
  assert.equal(current.sent.length, 0);
});

test("enforces Conversation authorization and lifecycle", async () => {
  const existing = {
    id: "conversation-1",
    initiatorTaskId: "interviewer-task",
    initiatorRole: "interviewer",
    responderTaskId: "review-task",
    responderRole: "review",
    state: "awaiting_reply",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    repliedAt: null,
    acceptedAt: null,
  };
  const current = harness(ledger({ conversations: [existing] }));

  const wrongSender = await run([
    "reply",
    "--conversation",
    "conversation-1",
  ], current, {
    body: "Forged reply.",
    senderTaskId: "interviewer-task",
  });
  assert.equal(wrongSender.exitCode, 1);
  assert.equal(
    wrongSender.result.code,
    "CONVERSATION_RESPONDER_REQUIRED",
  );

  const earlyAccept = await run([
    "accept",
    "--conversation",
    "conversation-1",
  ], current, {
    senderTaskId: "interviewer-task",
  });
  assert.equal(earlyAccept.exitCode, 1);
  assert.equal(
    earlyAccept.result.code,
    "CONVERSATION_ACCEPT_NOT_ALLOWED",
  );
});

test("rejects unmanaged targets, unsupported sources, and legacy syntax", async () => {
  const current = harness();
  let result = await run([
    "start",
    "--task",
    "unknown-task",
  ], current, {
    body: "Hello.",
  });
  assert.equal(result.result.code, "MESSAGE_TARGET_UNMANAGED");

  result = await run([
    "--task",
    "review-task",
  ], current, {
    body: "Legacy.",
  });
  assert.equal(result.result.code, "CONVERSATION_COMMAND_INVALID");

  const unsupported = harness(ledger(), "automation");
  result = await run([
    "start",
    "--task",
    "review-task",
  ], unsupported, {
    body: "Hello.",
  });
  assert.equal(result.result.code, "MESSAGE_TASK_SOURCE_UNSUPPORTED");
});

test("validates exact arguments, source identity, and message bodies", async () => {
  const cases = [
    {
      argv: ["start"],
      body: "text",
      code: "CONVERSATION_TASK_REQUIRED",
    },
    {
      argv: ["reply", "--task", "review-task"],
      body: "text",
      code: "CONVERSATION_ID_REQUIRED",
    },
    {
      argv: ["accept", "--conversation", "conversation-1", "--extra", "x"],
      code: "CONVERSATION_CLI_USAGE",
    },
    {
      argv: ["start", "--task", "review-task"],
      body: "",
      code: "MESSAGE_TEXT_REQUIRED",
    },
    {
      argv: ["start", "--task", "review-task"],
      body: "=== Message ===",
      code: "MESSAGE_PROTOCOL_MARKER_RESERVED",
    },
    {
      argv: ["start", "--task", "review-task", "--message", ""],
      body: "ignored",
      code: "MESSAGE_TEXT_REQUIRED",
    },
    {
      argv: [
        "start",
        "--task",
        "review-task",
        "--message",
        "=== Message ===",
      ],
      body: "ignored",
      code: "MESSAGE_PROTOCOL_MARKER_RESERVED",
    },
    {
      argv: [
        "accept",
        "--conversation",
        "conversation-1",
        "--message",
        "unexpected",
      ],
      code: "CONVERSATION_CLI_USAGE",
    },
  ];
  for (const currentCase of cases) {
    const current = harness();
    const result = await run(currentCase.argv, current, {
      body: currentCase.body,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.result.code, currentCase.code);
  }

  const missingSource = harness();
  missingSource.options.env = {};
  const result = await run([
    "start",
    "--task",
    "review-task",
  ], missingSource, {
    body: "text",
  });
  assert.equal(result.result.code, "MESSAGE_SOURCE_TASK_REQUIRED");
});

test("rejects a body whose complete rendered message exceeds the limit", async () => {
  const current = harness();
  const result = await run([
    "start",
    "--task",
    "review-task",
  ], current, {
    body: "x".repeat(65_500),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.result.code, "MESSAGE_TEXT_TOO_LARGE");
  assert.match(result.result.message, /rendered message exceeds/i);
  assert.equal(current.state().conversations.length, 0);
  assert.equal(current.sent.length, 0);
});

test("closes App control and bounds direct delivery failures", async () => {
  const current = harness();
  let closed = 0;
  current.options.createAppServer = () => ({
    async readTask({ taskId }) {
      return { taskId, threadSource: "codex-small-loop" };
    },
    async close() {
      closed += 1;
    },
  });
  current.options.send = async () => {
    const error = new Error("x".repeat(2_000));
    error.code = "DELIVERY_FAILED";
    throw error;
  };

  const result = await run([
    "start",
    "--task",
    "review-task",
  ], current, {
    body: "Hello.",
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.result.run, "partial");
  assert.equal(result.result.code, "DELIVERY_FAILED");
  assert.equal(result.result.delivery, "not_queued");
  assert.equal(current.state().appMessages.length, 0);
  assert.ok(result.result.message.length <= 512);
  assert.equal(closed, 1);
});

test("notification authority mismatch is reported without heartbeat fallback", async () => {
  const current = harness();
  const expectedContext = { permission: { type: "sandbox", policy: { type: "dangerFullAccess" } } };
  const actualContext = { permission: { type: "sandbox", policy: { type: "readOnly" } } };
  current.options.send = async () => {
    throw Object.assign(new Error("authority changed"), {
      code: "TASK_RUN_CONTEXT_MISMATCH", expectedContext, actualContext,
    });
  };
  const result = await run(["notify", "--task", "review-task"], current, { body: "Interview." });
  assert.equal(result.exitCode, 1);
  assert.equal(result.result.code, "TASK_RUN_CONTEXT_MISMATCH");
  assert.deepEqual(result.result.expectedContext, expectedContext);
  assert.deepEqual(result.result.actualContext, actualContext);
  assert.equal(current.state().appMessages.length, 0);
  assert.equal(current.supervisorStarts(), 0);
});
