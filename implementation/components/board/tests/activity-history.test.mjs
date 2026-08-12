import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { appendActivityHistoryContinuation, cloneActivityHistoryContinuation,
  createActivityHistoryContinuation, scanActivityHistory, snapshotActivityHistoryContinuation } from "../source/activity-history.mjs";

function record(type, payload, timestamp) {
  return JSON.stringify({ type, payload, timestamp });
}

test("history parser preserves allowed text, excludes tool payloads, and derives metrics", async () => {
  const lines = [
    record("session_meta", { id: "task-1", cwd: "/project", forked_from_id: null }, "2026-08-01T00:00:00.000Z"),
    record("event_msg", { type: "task_started", turn_id: "turn-1", started_at: "2026-08-01T00:00:00.500Z" }, "2026-08-01T00:00:00.500Z"),
    record("event_msg", { type: "user_message", message: "raw input" }, "2026-08-01T00:00:01.000Z"),
    record("event_msg", { type: "agent_reasoning", text: "visible think" }, "2026-08-01T00:00:02.000Z"),
    record("event_msg", { type: "exec_command_end", stdout: "SECRET COMMAND OUTPUT" }, "2026-08-01T00:00:03.000Z"),
    record("event_msg", { type: "mcp_tool_call_end", result: "SECRET TOOL OUTPUT" }, "2026-08-01T00:00:04.000Z"),
    record("event_msg", { type: "agent_message", message: "visible progress" }, "2026-08-01T00:00:04.500Z"),
    record("event_msg", { type: "agent_message", message: "raw output" }, "2026-08-01T00:00:05.000Z"),
    record("event_msg", { type: "task_complete", turn_id: "turn-1", completed_at: "2026-08-01T00:00:05.500Z" }, "2026-08-01T00:00:05.500Z"),
    record("event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 1200 }, last_token_usage: { input_tokens: 300, total_tokens: 500 }, model_context_window: 4000 } }, "2026-08-01T00:00:06.000Z"),
    record("event_msg", { type: "context_compacted" }, "2026-08-01T00:00:07.000Z"),
  ].join("\n") + "\n";
  const bytes = Buffer.from(lines);
  const chunks = [];
  for (let index = 0; index < bytes.length; index += (index % 7) + 1) {
    const size = (index % 7) + 1;
    chunks.push(bytes.subarray(index, index + size));
  }
  const history = await scanActivityHistory(Readable.from(chunks));
  assert.deepEqual(history.records.map(({ kind, text }) => ({ kind, text })), [
    { kind: "input", text: "raw input" },
    { kind: "think", text: "visible progress" },
    { kind: "output", text: "raw output" },
  ]);
  assert.equal(JSON.stringify(history).includes("SECRET"), false);
  assert.equal(JSON.stringify(history).includes("visible think"), false);
  assert.equal(history.records.filter((item) => item.kind === "output").length, 1);
  assert.equal(history.lifecycleState, "complete");
  assert.equal(history.lifecycleStartedAt, "2026-08-01T00:00:00.500Z");
  assert.equal(history.lifecycleEndedAt, "2026-08-01T00:00:05.500Z");
  assert.equal(history.cumulativeTokens, 500);
  assert.equal(history.hasTokenUsage, true);
  assert.equal(history.retainedContextTokens, 300);
  assert.equal(history.contextWindow, 4000);
  assert.equal(history.compactions, 1);
});

test("history parser ignores an incomplete final JSON record", async () => {
  const source = `${record("session_meta", { id: "task-1", cwd: "/project" }, "2026-08-01T00:00:00.000Z")}\n${record("event_msg", { type: "task_started", started_at: "2026-08-01T00:00:01.000Z" }, "2026-08-01T00:00:01.000Z")}\n{"type":`;
  const history = await scanActivityHistory(Readable.from([source]));
  assert.equal(history.diagnostics[0].code, "ACTIVITY_JSONL_INCOMPLETE_TAIL");
  assert.equal(history.partial, true);
});

test("history parser rejects a malformed complete record", async () => {
  const source = `${record("session_meta", { id: "task-1", cwd: "/project" })}\n{"bad":\n`;
  await assert.rejects(
    scanActivityHistory(Readable.from([source])),
    (error) => error.code === "ACTIVITY_JSONL_MALFORMED",
  );
});

test("projection budget admits the exact boundary and omits whole over-budget entries", async () => {
  const source = [
    record("session_meta", { id: "task-1", cwd: "/project" }, "2026-08-01T00:00:00.000Z"),
    record("event_msg", { type: "task_started", started_at: "2026-08-01T00:00:01.000Z" }, "2026-08-01T00:00:01.000Z"),
    record("event_msg", { type: "user_message", message: "exact raw input" }, "2026-08-01T00:00:02.000Z"),
    record("event_msg", { type: "agent_message", message: "exact raw output" }, "2026-08-01T00:00:03.000Z"),
    record("event_msg", { type: "task_complete", completed_at: "2026-08-01T00:00:04.000Z" }, "2026-08-01T00:00:04.000Z"),
  ].join("\n") + "\n";
  const generous = { historyJsonBytes: 0, timelineEvents: 0, maxHistoryJsonBytes: 10_000, maxTimelineEvents: 10, omittedHistoryEntries: 0, partial: false };
  const complete = await scanActivityHistory(Readable.from([source]), { budget: generous });
  const exact = { historyJsonBytes: 0, timelineEvents: 0, maxHistoryJsonBytes: generous.historyJsonBytes, maxTimelineEvents: generous.timelineEvents, omittedHistoryEntries: 0, partial: false };
  const exactHistory = await scanActivityHistory(Readable.from([source]), { budget: exact });
  assert.equal(exactHistory.partial, false);
  assert.deepEqual(exactHistory.records, complete.records);

  const over = { historyJsonBytes: 0, timelineEvents: 0, maxHistoryJsonBytes: generous.historyJsonBytes - 1, maxTimelineEvents: generous.timelineEvents, omittedHistoryEntries: 0, partial: false };
  const partial = await scanActivityHistory(Readable.from([source]), { budget: over });
  assert.equal(partial.partial, true);
  assert.ok(partial.diagnostics.some((item) => item.code === "ACTIVITY_HISTORY_AGGREGATE_BOUNDED"));
  assert.equal(partial.records.some((item) => item.text.includes("…")), false);

  const eventOver = { historyJsonBytes: 0, timelineEvents: 0, maxHistoryJsonBytes: 10_000, maxTimelineEvents: generous.timelineEvents - 1, omittedHistoryEntries: 0, partial: false };
  const eventPartial = await scanActivityHistory(Readable.from([source]), { budget: eventOver });
  assert.equal(eventPartial.partial, true);
  assert.equal(eventPartial.records.some((item) => item.kind === "output"), false);
});

test("live continuation reject mode keeps exact projection bounds transactional", () => {
  const prefix = [
    record("session_meta", { id: "task-1", cwd: "/project" }, "2026-08-01T00:00:00.000Z"),
    record("event_msg", { type: "task_started", turn_id: "t", started_at: "2026-08-01T00:00:01.000Z" }, "2026-08-01T00:00:01.000Z"),
  ].join("\n") + "\n";
  const generous = { historyJsonBytes: 0, timelineEvents: 0, maxHistoryJsonBytes: 10_000, maxTimelineEvents: 10,
    omittedHistoryEntries: 0, partial: false };
  const base = createActivityHistoryContinuation({ budget: generous });
  appendActivityHistoryContinuation(base, prefix);
  const before = structuredClone({ history: base.history, fragment: base.fragment.toString("hex"), sequence: base.sequence, budget: generous });
  const line = `${record("event_msg", { type: "agent_message", message: "exact" }, "2026-08-01T00:00:02.000Z")}\n`;
  const sizing = cloneActivityHistoryContinuation(base, { budget: structuredClone(generous), omissionMode: "reject" });
  appendActivityHistoryContinuation(sizing, line);
  const charge = sizing.budget.historyJsonBytes - generous.historyJsonBytes;
  const exactBudget = { ...structuredClone(generous), maxHistoryJsonBytes: generous.historyJsonBytes + charge };
  const exact = cloneActivityHistoryContinuation(base, { budget: exactBudget, omissionMode: "reject" });
  appendActivityHistoryContinuation(exact, line);
  assert.equal(snapshotActivityHistoryContinuation(exact).records.at(-1).text, "exact");
  const over = cloneActivityHistoryContinuation(base, { budget: { ...structuredClone(generous), maxHistoryJsonBytes: generous.historyJsonBytes + charge - 1 }, omissionMode: "reject" });
  assert.throws(() => appendActivityHistoryContinuation(over, line), (error) => error.code === "ACTIVITY_LIVE_PROJECTION_BOUNDED");
  assert.deepEqual({ history: base.history, fragment: base.fragment.toString("hex"), sequence: base.sequence, budget: generous }, before);
  const textOver = cloneActivityHistoryContinuation(base, { budget: structuredClone(generous), omissionMode: "reject" });
  for (const [type, field] of [["agent_message", "message"], ["user_message", "message"]]) {
    const oversized = cloneActivityHistoryContinuation(textOver, { budget: structuredClone(generous), omissionMode: "reject" });
    assert.throws(() => appendActivityHistoryContinuation(oversized,
      `${record("event_msg", { type, [field]: "x".repeat(512 * 1024 + 1) }, "2026-08-01T00:00:02.000Z")}\n`),
    (error) => error.code === "ACTIVITY_LIVE_PROJECTION_BOUNDED");
    assert.deepEqual({ history: base.history, fragment: base.fragment.toString("hex"), sequence: base.sequence, budget: generous }, before);
  }

  const terminal = `${record("event_msg", { type: "task_complete", turn_id: "t", completed_at: "2026-08-01T00:00:03.000Z" }, "2026-08-01T00:00:03.000Z")}\n`;
  const eventExact = cloneActivityHistoryContinuation(base, { budget: {
    ...structuredClone(generous), maxTimelineEvents: generous.timelineEvents + 1,
  }, omissionMode: "reject" });
  appendActivityHistoryContinuation(eventExact, terminal);
  assert.equal(eventExact.budget.timelineEvents, generous.timelineEvents + 1);
  const eventOver = cloneActivityHistoryContinuation(base, { budget: {
    ...structuredClone(generous), maxTimelineEvents: generous.timelineEvents,
  }, omissionMode: "reject" });
  assert.throws(() => appendActivityHistoryContinuation(eventOver, terminal),
    (error) => error.code === "ACTIVITY_LIVE_PROJECTION_BOUNDED");
  assert.deepEqual({ history: base.history, fragment: base.fragment.toString("hex"), sequence: base.sequence, budget: generous }, before);
});

test("multiple turns expose only the Task-wide latest confirmed response", async () => {
  const source = [
    record("session_meta", { id: "task-1", cwd: "/project" }, "2026-08-01T00:00:00.000Z"),
    record("event_msg", { type: "task_started", turn_id: "turn-1", started_at: "2026-08-01T00:00:01.000Z" }, "2026-08-01T00:00:01.000Z"),
    record("event_msg", { type: "agent_message", message: "first final" }, "2026-08-01T00:00:02.000Z"),
    record("event_msg", { type: "task_complete", turn_id: "turn-1", completed_at: "2026-08-01T00:00:03.000Z" }, "2026-08-01T00:00:03.000Z"),
    record("event_msg", { type: "task_started", turn_id: "turn-2", started_at: "2026-08-01T00:01:00.000Z" }, "2026-08-01T00:01:00.000Z"),
    record("event_msg", { type: "agent_message", message: "second progress" }, "2026-08-01T00:01:01.000Z"),
    record("event_msg", { type: "agent_message", message: "second final" }, "2026-08-01T00:01:02.000Z"),
    record("event_msg", { type: "task_complete", turn_id: "turn-2", completed_at: "2026-08-01T00:01:03.000Z" }, "2026-08-01T00:01:03.000Z"),
  ].join("\n") + "\n";
  const history = await scanActivityHistory(Readable.from([source]));
  assert.deepEqual(history.records.map(({ kind, text }) => ({ kind, text })), [
    { kind: "think", text: "first final" },
    { kind: "think", text: "second progress" },
    { kind: "output", text: "second final" },
  ]);
  assert.equal(history.lifecycleState, "complete");
  assert.equal(history.lifecycleEndedAt, "2026-08-01T00:01:03.000Z");
});

test("running and aborted turns never promote their visible messages to Output", async () => {
  const base = [
    record("session_meta", { id: "task-1", cwd: "/project" }, "2026-08-01T00:00:00.000Z"),
    record("event_msg", { type: "task_started", turn_id: "turn-1", started_at: "2026-08-01T00:00:01.000Z" }, "2026-08-01T00:00:01.000Z"),
    record("event_msg", { type: "agent_message", message: "progress" }, "2026-08-01T00:00:02.000Z"),
  ];
  const running = await scanActivityHistory(Readable.from([base.join("\n") + "\n"]));
  assert.equal(running.lifecycleState, "running");
  assert.equal(running.lifecycleEndedAt, null);
  assert.deepEqual(running.records.map((item) => item.kind), ["think"]);

  const aborted = await scanActivityHistory(Readable.from([[...base,
    record("event_msg", { type: "turn_aborted", turn_id: "turn-1", completed_at: "2026-08-01T00:00:03.000Z" }, "2026-08-01T00:00:03.000Z"),
  ].join("\n") + "\n"]));
  assert.equal(aborted.lifecycleState, "aborted");
  assert.equal(aborted.lifecycleEndedAt, "2026-08-01T00:00:03.000Z");
  assert.deepEqual(aborted.records.map((item) => item.kind), ["think"]);
});

test("lifecycle events select only their event-specific semantic timestamp or record timestamp", async () => {
  const common = await scanActivityHistory(Readable.from([[
    record("session_meta", { id: "task-1", cwd: "/project" }, "2026-08-01T00:00:00.000Z"),
    record("event_msg", { type: "task_started", turn_id: "turn-1", started_at: "2026-08-01T00:00:01.000Z", completed_at: "2026-08-01T00:00:02.000Z" }, "2026-08-01T00:00:00.500Z"),
    record("event_msg", { type: "task_complete", turn_id: "turn-1", started_at: "2026-08-01T00:00:01.000Z", completed_at: "2026-08-01T00:00:05.000Z" }, "2026-08-01T00:00:06.000Z"),
  ].join("\n") + "\n"]));
  assert.equal(common.lifecycleStartedAt, "2026-08-01T00:00:01.000Z");
  assert.equal(common.lifecycleEndedAt, "2026-08-01T00:00:05.000Z");
  assert.deepEqual(common.taskEvents.map((event) => event.timestamp), [
    "2026-08-01T00:00:01.000Z",
    "2026-08-01T00:00:05.000Z",
  ]);

  const aborted = await scanActivityHistory(Readable.from([[
    record("session_meta", { id: "task-2", cwd: "/project" }, "2026-08-01T00:00:00.000Z"),
    record("event_msg", { type: "task_started", turn_id: "turn-2", started_at: "2026-08-01T00:00:01.000Z" }, "2026-08-01T00:00:01.000Z"),
    record("event_msg", { type: "turn_aborted", turn_id: "turn-2", started_at: "2026-08-01T00:00:01.000Z", completed_at: "2026-08-01T00:00:04.000Z" }, "2026-08-01T00:00:05.000Z"),
  ].join("\n") + "\n"]));
  assert.equal(aborted.lifecycleEndedAt, "2026-08-01T00:00:04.000Z");

  const recordFallbacks = await scanActivityHistory(Readable.from([[
    record("session_meta", { id: "task-3", cwd: "/project" }, "2026-08-01T00:00:00.000Z"),
    record("event_msg", { type: "task_started", turn_id: "turn-3", started_at: "invalid" }, "2026-08-01T00:00:01.000Z"),
    record("event_msg", { type: "task_complete", turn_id: "turn-3", completed_at: {} }, "2026-08-01T00:00:03.000Z"),
  ].join("\n") + "\n"]));
  assert.equal(recordFallbacks.lifecycleStartedAt, "2026-08-01T00:00:01.000Z");
  assert.equal(recordFallbacks.lifecycleEndedAt, "2026-08-01T00:00:03.000Z");

  const abortedRecordFallback = await scanActivityHistory(Readable.from([[
    record("session_meta", { id: "task-3b", cwd: "/project" }, "2026-08-01T00:00:00.000Z"),
    record("event_msg", { type: "task_started", turn_id: "turn-3b", started_at: 1_786_000_001 }, "invalid"),
    record("event_msg", { type: "turn_aborted", turn_id: "turn-3b", completed_at: "invalid" }, 1_786_000_003),
  ].join("\n") + "\n"]));
  assert.equal(abortedRecordFallback.lifecycleStartedAt, new Date(1_786_000_001_000).toISOString());
  assert.equal(abortedRecordFallback.lifecycleEndedAt, new Date(1_786_000_003_000).toISOString());

  const oppositeFields = await scanActivityHistory(Readable.from([[
    record("session_meta", { id: "task-4", cwd: "/project" }, "2026-08-01T00:00:00.000Z"),
    record("event_msg", { type: "task_started", turn_id: "turn-4", started_at: "2026-08-01T00:00:01.000Z" }, "2026-08-01T00:00:01.000Z"),
    record("event_msg", { type: "task_started", turn_id: "turn-4b", completed_at: "2026-08-01T00:00:02.000Z" }),
    record("event_msg", { type: "task_complete", turn_id: "turn-4b", started_at: "2026-08-01T00:00:03.000Z" }),
  ].join("\n") + "\n"]));
  assert.deepEqual(oppositeFields.taskEvents.slice(-2).map((event) => event.timestamp), [null, null]);
  assert.equal(oppositeFields.lifecycleEndedAt, null);
  assert.equal(oppositeFields.lifecycleState, "complete");

  const abortedOppositeField = await scanActivityHistory(Readable.from([[
    record("session_meta", { id: "task-5", cwd: "/project" }, "2026-08-01T00:00:00.000Z"),
    record("event_msg", { type: "task_started", turn_id: "turn-5", started_at: "2026-08-01T00:00:01.000Z" }, "2026-08-01T00:00:01.000Z"),
    record("event_msg", { type: "turn_aborted", turn_id: "turn-5", started_at: "2026-08-01T00:00:03.000Z" }),
  ].join("\n") + "\n"]));
  assert.equal(abortedOppositeField.lifecycleEndedAt, null);
  assert.equal(abortedOppositeField.taskEvents.at(-1).timestamp, null);
});

test("one compacted plus context_compacted envelope pair counts as one compaction", async () => {
  const source = [
    record("session_meta", { id: "task-1", cwd: "/project" }, "2026-08-01T00:00:00.000Z"),
    record("event_msg", { type: "task_started", started_at: "2026-08-01T00:00:01.000Z" }, "2026-08-01T00:00:01.000Z"),
    record("compacted", { replacement_history: [] }, "2026-08-01T00:01:00.000Z"),
    record("event_msg", { type: "context_compacted" }, "2026-08-01T00:01:00.010Z"),
  ].join("\n") + "\n";
  const history = await scanActivityHistory(Readable.from([source]));
  assert.equal(history.compactions, 1);
});
