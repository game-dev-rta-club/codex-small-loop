import assert from "node:assert/strict";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  createTaskEventReducer,
  MAX_JSONL_LINE_LENGTH,
  readCodexSessionMetadata,
  readCodexTaskRunSettings,
  MAX_TURN_ID_LENGTH,
  reduceTaskEvents,
  scanCodexTaskEvents,
} from "../source/codex-jsonl.mjs";

function envelope(type, turnId, extra = {}, timestamp) {
  return {
    type: "event_msg",
    ...(timestamp ? { timestamp } : {}),
    payload: {
      type,
      turn_id: turnId,
      ...extra,
    },
    conversation: "must not escape",
  };
}

test("drops event timestamps that are not needed for task-state observation", async () => {
  const { events } = await scan([
    line(envelope(
      "task_started",
      "turn-a",
      {},
      "2026-07-25T01:00:00.000Z",
    )),
    line(envelope(
      "task_complete",
      "turn-a",
      {},
      "2026-07-25T01:01:00.000Z",
    )),
  ]);

  assert.deepEqual(events, [
    {
      type: "task_started",
      turnId: "turn-a",
    },
    {
      type: "task_complete",
      turnId: "turn-a",
    },
  ]);
  assert.equal("turnEndedAt" in reduceTaskEvents(events), false);
});

function line(value, ending = "\n") {
  return `${JSON.stringify(value)}${ending}`;
}

async function scan(chunks) {
  const events = [];
  const readable = Readable.from(chunks);
  const summary = await scanCodexTaskEvents(readable, (event) => {
    events.push(event);
  });

  return { events, readable, summary };
}

function expectDiagnostic(result, code) {
  assert.equal(result.turnState, "unknown");
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, code);
  assert.ok(result.diagnostics[0].message.length <= 512);
}

test("reads bounded Task identity, cwd, and threadSource from session metadata", async () => {
  const source = Buffer.from([
    line({ type: "response_item", payload: { text: "ignore me" } }),
    line({
      type: "session_meta",
      payload: {
        id: "task-a",
        cwd: "/project",
        thread_source: "codex-small-loop",
        base_instructions: "must not escape",
      },
    }),
    line(envelope("task_started", "turn-a")),
  ].join(""));
  const chunks = [];
  for (let index = 0; index < source.length; index += 3) {
    chunks.push(source.subarray(index, index + 3));
  }
  const readable = Readable.from(chunks);

  assert.deepEqual(
    await readCodexSessionMetadata(readable, "task-a"),
    {
      taskId: "task-a",
      cwd: path.normalize("/project"),
      threadSource: "codex-small-loop",
    },
  );
  assert.equal(readable.destroyed, true);
});

test("rejects missing, mismatched, and malformed session metadata", async () => {
  await assert.rejects(
    readCodexSessionMetadata(
      Readable.from([line({
        type: "session_meta",
        payload: { id: "other-task", cwd: "/project" },
      })]),
      "task-a",
    ),
    (error) => error.code === "TASK_SESSION_META_INVALID",
  );
  await assert.rejects(
    readCodexSessionMetadata(
      Readable.from([line(envelope("task_started", "turn-a"))]),
      "task-a",
    ),
    (error) => error.code === "TASK_SESSION_META_MISSING",
  );
  await assert.rejects(
    readCodexSessionMetadata(
      Readable.from(["{broken}\n"]),
      "task-a",
    ),
    (error) => error.code === "TASK_JSONL_MALFORMED",
  );
});

test("reads the latest complete Task run settings without acquiring a writer", async () => {
  const readable = Readable.from([
    line({
      type: "session_meta",
      payload: {
        id: "task-a",
        cwd: "/project",
      },
    }),
    line({
      type: "turn_context",
      payload: {
        cwd: "/old-project",
        model: "gpt-5.5",
        effort: "high",
        approval_policy: "on-request",
        sandbox_policy: { type: "read-only" },
        permission_profile: { type: "disabled" },
      },
    }),
    line({
      type: "session_meta",
      payload: {
        id: "inherited-parent-task",
        cwd: "/project",
      },
    }),
    line({ type: "response_item", payload: { text: "must not escape" } }),
    line({
      type: "turn_context",
      payload: {
        cwd: "/project",
        model: "gpt-5.6-sol",
        effort: "medium",
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" },
        permission_profile: { type: "disabled" },
      },
    }),
    '{"type":"response_item","payload":',
  ]);

  assert.deepEqual(
    await readCodexTaskRunSettings(readable, "task-a"),
    {
      taskId: "task-a",
      cwd: path.normalize("/project"),
      settings: {
        activePermissionProfile: null,
        approvalPolicy: "never",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        sandboxPolicy: { type: "dangerFullAccess" },
        serviceTier: null,
      },
    },
  );
  assert.equal(readable.destroyed, true);
});

test("reads the applied service tier when turn context omits it", async () => {
  const readable = Readable.from([
    line({
      type: "session_meta",
      payload: {
        id: "task-a",
        cwd: "/project",
      },
    }),
    line({
      type: "turn_context",
      payload: {
        cwd: "/project",
        model: "gpt-5.6-sol",
        effort: "medium",
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" },
        permission_profile: { type: "disabled" },
      },
    }),
    line({
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: {
          service_tier: "priority",
        },
      },
    }),
    line({
      type: "turn_context",
      payload: {
        cwd: "/project",
        model: "gpt-5.6-sol",
        effort: "medium",
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" },
        permission_profile: { type: "disabled" },
      },
    }),
  ]);

  assert.equal(
    (await readCodexTaskRunSettings(readable, "task-a"))
      .settings.serviceTier,
    "priority",
  );
});

test("fails closed when persisted Task run settings cannot preserve authority", async () => {
  await assert.rejects(
    readCodexTaskRunSettings(Readable.from([
      line({
        type: "session_meta",
        payload: { id: "task-a", cwd: "/project" },
      }),
      line({
        type: "turn_context",
        payload: {
          cwd: "/project",
          model: "gpt-5.6-sol",
          effort: "medium",
          approval_policy: "never",
          sandbox_policy: { type: "workspace-write" },
          permission_profile: { type: "managed" },
        },
      }),
    ]), "task-a"),
    (error) => error.code === "TASK_TURN_CONTEXT_INVALID",
  );
});

test("streams LF, CRLF, UTF-8, and arbitrary byte boundaries", async () => {
  const source = Buffer.from([
    line(envelope("task_started", "시작-turn"), "\r\n"),
    line(envelope("task_complete", "시작-turn")),
  ].join(""));
  const chunks = [];

  for (let index = 0; index < source.length; index += 2) {
    chunks.push(source.subarray(index, index + 2));
  }

  const { events, readable, summary } = await scan(chunks);

  assert.deepEqual(events, [
    { type: "task_started", turnId: "시작-turn" },
    { type: "task_complete", turnId: "시작-turn" },
  ]);
  assert.deepEqual(summary, {
    eventCount: 2,
    ignoredIncompleteTail: false,
    lineCount: 2,
  });
  assert.equal(readable.destroyed, true);
});

test("ignores blank and unrelated records and strips conversation fields", async () => {
  const { events, summary } = await scan([
    "\n",
    line({ type: "response_item", payload: { text: "private conversation" } }),
    line({
      type: "event_msg",
      payload: {
        type: "token_count",
        turn_id: "ignored",
        last_agent_message: "private",
      },
    }),
    line(envelope("task_started", "turn-a", {
      tool_arguments: { secret: true },
      last_agent_message: "private",
      usage: { total_tokens: 100 },
    })),
  ]);

  assert.deepEqual(events, [{ type: "task_started", turnId: "turn-a" }]);
  assert.deepEqual(Object.keys(events[0]), ["type", "turnId"]);
  assert.equal(JSON.stringify(events).includes("private"), false);
  assert.equal(summary.lineCount, 4);
});

test("parses a valid final line and ignores only a malformed incomplete tail", async () => {
  const valid = await scan([line(envelope("task_started", "turn-a"), "")]);
  assert.deepEqual(valid.events, [{ type: "task_started", turnId: "turn-a" }]);
  assert.equal(valid.summary.ignoredIncompleteTail, false);

  const partial = await scan([
    line(envelope("task_started", "turn-a")),
    '{"type":"event_msg","payload":',
  ]);
  assert.deepEqual(partial.events, [{ type: "task_started", turnId: "turn-a" }]);
  assert.equal(partial.summary.ignoredIncompleteTail, true);
  assert.equal(partial.summary.lineCount, 2);
});

test("rejects a malformed complete line with bounded diagnostics", async () => {
  const readable = Readable.from([
    line(envelope("task_started", "turn-a")),
    "{broken-json}\n",
  ]);

  await assert.rejects(
    scanCodexTaskEvents(readable, () => {}),
    (error) => {
      assert.equal(error.code, "TASK_JSONL_MALFORMED");
      assert.equal(error.lineNumber, 2);
      assert.ok(error.message.length <= 512);
      return true;
    },
  );
  assert.equal(readable.destroyed, true);
});

test("rejects oversized complete lines and retained fragments", async () => {
  const complete = Readable.from([`${"x".repeat(MAX_JSONL_LINE_LENGTH + 1)}\n`]);
  await assert.rejects(
    scanCodexTaskEvents(complete, () => {}),
    (error) => error.code === "TASK_JSONL_LINE_TOO_LARGE",
  );

  const fragment = Readable.from([
    "x".repeat(Math.floor(MAX_JSONL_LINE_LENGTH / 2)),
    "x".repeat(Math.ceil(MAX_JSONL_LINE_LENGTH / 2) + 1),
  ]);
  await assert.rejects(
    scanCodexTaskEvents(fragment, () => {}),
    (error) => error.code === "TASK_JSONL_LINE_TOO_LARGE",
  );
  assert.equal(fragment.destroyed, true);
});

test("accepts only the three supported event envelopes", async () => {
  const { events } = await scan([
    line(envelope("task_started", "turn-a")),
    line(envelope("task_complete", "turn-a")),
    line(envelope("turn_aborted", "turn-b")),
    line(envelope("agent_message", "turn-a")),
    line({ type: "other", payload: { type: "task_started", turn_id: "turn-c" } }),
  ]);

  assert.deepEqual(events, [
    { type: "task_started", turnId: "turn-a" },
    { type: "task_complete", turnId: "turn-a" },
    { type: "turn_aborted", turnId: "turn-b" },
  ]);
});

test("rejects invalid Turn IDs in otherwise supported envelopes", async () => {
  const invalidTurnIds = [
    "",
    "   ",
    42,
    "x".repeat(MAX_TURN_ID_LENGTH + 1),
  ];

  for (const turnId of invalidTurnIds) {
    const readable = Readable.from([line(envelope("task_started", turnId))]);
    await assert.rejects(
      scanCodexTaskEvents(readable, () => {}),
      (error) => {
        assert.equal(error.code, "TASK_EVENT_INVALID");
        assert.equal(error.lineNumber, 1);
        assert.ok(error.message.length <= 512);
        return true;
      },
    );
  }
});

test("reduces the latest turn across multiple turns", () => {
  const events = [
    { type: "task_started", turnId: "turn-old" },
    { type: "task_complete", turnId: "turn-old" },
    { type: "task_started", turnId: "turn-new" },
  ];

  assert.deepEqual(reduceTaskEvents([], { mode: "latest" }), {
    mode: "latest",
    turnId: null,
    turnState: "not_started",
    diagnostics: [],
  });
  assert.deepEqual(reduceTaskEvents(events, { mode: "latest" }), {
    mode: "latest",
    turnId: "turn-new",
    turnState: "in_progress",
    diagnostics: [],
  });
  assert.equal(
    reduceTaskEvents([
      ...events,
      { type: "task_complete", turnId: "turn-new" },
    ], { mode: "latest" }).turnState,
    "ended",
  );
  assert.equal(
    reduceTaskEvents([
      ...events,
      { type: "turn_aborted", turnId: "turn-new" },
    ], { mode: "latest" }).turnState,
    "aborted",
  );
});

test("older terminal events do not finish the latest turn", () => {
  const result = reduceTaskEvents([
    { type: "task_started", turnId: "turn-old" },
    { type: "task_started", turnId: "turn-new" },
    { type: "task_complete", turnId: "turn-old" },
  ], { mode: "latest" });

  assert.deepEqual(result, {
    mode: "latest",
    turnId: "turn-new",
    turnState: "in_progress",
    diagnostics: [],
  });
});

test("exact mode tracks its Turn ID after a newer turn starts", () => {
  const events = [
    { type: "task_started", turnId: "assignment-turn" },
    { type: "task_complete", turnId: "assignment-turn" },
    { type: "task_started", turnId: "later-turn" },
  ];

  assert.deepEqual(
    reduceTaskEvents(events, { mode: "exact", turnId: "assignment-turn" }),
    {
      mode: "exact",
      turnId: "assignment-turn",
      turnState: "ended",
      diagnostics: [],
    },
  );
  expectDiagnostic(
    reduceTaskEvents(events, { mode: "exact", turnId: "missing-turn" }),
    "TASK_TURN_NOT_FOUND",
  );
});

test("contradictory selected-turn sequences become unknown", () => {
  const contradictorySequences = [
    [
      { type: "task_started", turnId: "turn-a" },
      { type: "task_complete", turnId: "turn-a" },
      { type: "turn_aborted", turnId: "turn-a" },
    ],
    [
      { type: "task_started", turnId: "turn-a" },
      { type: "task_complete", turnId: "turn-a" },
      { type: "task_started", turnId: "turn-a" },
    ],
    [
      { type: "task_complete", turnId: "turn-a" },
      { type: "task_started", turnId: "turn-a" },
    ],
  ];

  for (const events of contradictorySequences) {
    expectDiagnostic(
      reduceTaskEvents(events, { mode: "exact", turnId: "turn-a" }),
      "TASK_EVENT_CONTRADICTORY",
    );
  }
});

test("rejects invalid reducer modes, exact IDs, and normalized events", () => {
  assert.throws(
    () => reduceTaskEvents([], { mode: "unsupported" }),
    (error) => error.code === "TASK_EVENT_INVALID",
  );
  assert.throws(
    () => reduceTaskEvents([], { mode: "exact", turnId: "" }),
    (error) => error.code === "TASK_EVENT_INVALID",
  );
  assert.throws(
    () => reduceTaskEvents([{ type: "task_started", turnId: "" }]),
    (error) => error.code === "TASK_EVENT_INVALID",
  );
});

test("processes a large history incrementally without retaining event bodies", async () => {
  const eventCount = 20_000;
  let observed = 0;
  const reducer = createTaskEventReducer({ mode: "latest" });

  async function* history() {
    for (let index = 0; index < eventCount; index += 1) {
      yield line(envelope(
        index % 2 === 0 ? "task_started" : "task_complete",
        `turn-${Math.floor(index / 2)}`,
        { last_agent_message: "x".repeat(2_000) },
      ));
    }
  }

  const summary = await scanCodexTaskEvents(
    Readable.from(history()),
    (event) => {
      observed += 1;
      assert.deepEqual(Object.keys(event), ["type", "turnId"]);
      reducer.accept(event);
    },
  );

  assert.equal(observed, eventCount);
  assert.equal(summary.eventCount, eventCount);
  assert.equal(summary.lineCount, eventCount);
  assert.deepEqual(reducer.result(), {
    mode: "latest",
    turnId: "turn-9999",
    turnState: "ended",
    diagnostics: [],
  });
});
