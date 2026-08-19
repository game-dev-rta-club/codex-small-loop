import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { resolveCodexSessionRoots } from "../source/codex-session-locator.mjs";
import {
  observeExactTurn,
  observeLatestTask,
  observeTasks,
  sameTurnBoundary,
} from "../source/task-state-observer.mjs";

function event(type, turnId, extra = {}) {
  return {
    type: "event_msg",
    payload: {
      type,
      turn_id: turnId,
      ...extra,
    },
  };
}

function jsonl(records, ending = "\n") {
  return records.map(JSON.stringify).join("\n") + ending;
}

async function withCodexHome(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-observer-"));
  const active = path.join(root, "sessions");
  const archived = path.join(root, "archived_sessions");
  await mkdir(active, { recursive: true });
  await mkdir(archived, { recursive: true });

  try {
    await run({
      active,
      archived,
      root,
      roots: resolveCodexSessionRoots(root),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeHistory(root, taskId, records, directory = "") {
  const parent = path.join(root, directory);
  const historyFile = path.join(parent, `rollout-${taskId}.jsonl`);
  await mkdir(parent, { recursive: true });
  await writeFile(historyFile, jsonl(records));
  return historyFile;
}

function latestShape(taskId, location, historyFile, latestTurnId, turnState) {
  return {
    taskId,
    location,
    historyFile,
    latestTurnId,
    turnState,
    diagnostics: [],
  };
}

function expectDiagnostic(snapshot, code) {
  assert.equal(snapshot.turnState, "unknown");
  assert.equal(snapshot.diagnostics.length, 1);
  assert.equal(snapshot.diagnostics[0].code, code);
  assert.ok(snapshot.diagnostics[0].message.length <= 512);
}

test("uses the standard CODEX_HOME roots when none are injected", async () => {
  await withCodexHome(async ({ active, root }) => {
    const taskId = "default-root-task";
    const historyFile = await writeHistory(active, taskId, [
      event("task_started", "turn-default"),
      event("task_complete", "turn-default"),
    ]);
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;

    try {
      assert.deepEqual(
        await observeLatestTask(taskId),
        latestShape(
          taskId,
          "active",
          historyFile,
          "turn-default",
          "ended",
        ),
      );
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });
});

test("observes active latest turns from not started through terminal states", async () => {
  await withCodexHome(async ({ active, roots }) => {
    const emptyFile = await writeHistory(active, "empty-task", []);
    const runningFile = await writeHistory(active, "running-task", [
      event("task_started", "turn-running"),
    ]);
    const completeFile = await writeHistory(active, "complete-task", [
      event("task_started", "turn-complete"),
      event("task_complete", "turn-complete"),
    ]);
    const abortedFile = await writeHistory(active, "aborted-task", [
      event("task_started", "turn-aborted"),
      event("turn_aborted", "turn-aborted"),
    ]);

    assert.deepEqual(
      await observeLatestTask("empty-task", { roots }),
      latestShape("empty-task", "active", emptyFile, null, "not_started"),
    );
    assert.deepEqual(
      await observeLatestTask("running-task", { roots }),
      latestShape(
        "running-task",
        "active",
        runningFile,
        "turn-running",
        "in_progress",
      ),
    );
    assert.deepEqual(
      await observeLatestTask("complete-task", { roots }),
      latestShape(
        "complete-task",
        "active",
        completeFile,
        "turn-complete",
        "ended",
      ),
    );
    assert.deepEqual(
      await observeLatestTask("aborted-task", { roots }),
      latestShape(
        "aborted-task",
        "active",
        abortedFile,
        "turn-aborted",
        "aborted",
      ),
    );
  });
});

test("observes task state across a large valid unrelated Codex record", async () => {
  await withCodexHome(async ({ active, roots }) => {
    const taskId = "large-record-task";
    const historyFile = await writeHistory(active, taskId, [
      event("task_started", "turn-large-record"),
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          output: "x".repeat(1_500_000),
        },
      },
      event("task_complete", "turn-large-record"),
    ]);

    assert.deepEqual(
      await observeLatestTask(taskId, { roots }),
      latestShape(
        taskId,
        "active",
        historyFile,
        "turn-large-record",
        "ended",
      ),
    );
  });
});

test("preserves archived location and degrades missing history", async () => {
  await withCodexHome(async ({ archived, roots }) => {
    const historyFile = await writeHistory(archived, "archived-task", [
      event("task_started", "archived-turn"),
      event("task_complete", "archived-turn"),
    ]);
    const archivedSnapshot = await observeLatestTask("archived-task", { roots });
    const missingSnapshot = await observeLatestTask("missing-task", { roots });

    assert.deepEqual(
      archivedSnapshot,
      latestShape(
        "archived-task",
        "archived",
        historyFile,
        "archived-turn",
        "ended",
      ),
    );
    assert.equal(missingSnapshot.taskId, "missing-task");
    assert.equal(missingSnapshot.location, "missing");
    assert.equal(missingSnapshot.historyFile, null);
    assert.equal(missingSnapshot.latestTurnId, null);
    expectDiagnostic(missingSnapshot, "TASK_HISTORY_MISSING");
  });
});

test("observes an exact assignment turn after a newer turn exists", async () => {
  await withCodexHome(async ({ active, roots }) => {
    const historyFile = await writeHistory(active, "launch-task", [
      event("task_started", "assignment-turn"),
      event("task_complete", "assignment-turn"),
      event("task_started", "newer-turn"),
    ]);

    assert.deepEqual(
      await observeExactTurn("launch-task", "assignment-turn", { roots }),
      {
        taskId: "launch-task",
        location: "active",
        historyFile,
        turnId: "assignment-turn",
        turnState: "ended",
        diagnostics: [],
      },
    );

    const missingTurn = await observeExactTurn(
      "launch-task",
      "absent-turn",
      { roots },
    );
    assert.equal(missingTurn.turnId, "absent-turn");
    expectDiagnostic(missingTurn, "TASK_TURN_NOT_FOUND");
  });
});

test("reads an exact final answer only through the opt-in observation path", async () => {
  await withCodexHome(async ({ active, roots }) => {
    const taskId = "answer-task";
    await writeHistory(active, taskId, [
      event("task_started", "answer-turn"),
      event("task_complete", "answer-turn", {
        last_agent_message: "One material answer.",
      }),
    ]);

    const ordinary = await observeExactTurn(taskId, "answer-turn", { roots });
    const withAnswer = await observeExactTurn(taskId, "answer-turn", {
      roots,
      includeFinalAnswer: true,
    });

    assert.equal(Object.hasOwn(ordinary, "finalAnswer"), false);
    assert.equal(withAnswer.turnState, "ended");
    assert.equal(withAnswer.finalAnswer, "One material answer.");
  });
});

test("returns unknown snapshots for contradictory, malformed, and unreadable history", async () => {
  await withCodexHome(async ({ active, roots }) => {
    await writeHistory(active, "contradictory-task", [
      event("task_started", "turn-a"),
      event("task_complete", "turn-a"),
      event("turn_aborted", "turn-a"),
    ]);
    const malformedFile = await writeHistory(active, "malformed-task", []);
    await writeFile(malformedFile, "{broken}\n");

    const openHistory = async (historyFile) => {
      if (historyFile.endsWith("unreadable-task.jsonl")) {
        throw new Error("x".repeat(5_000));
      }
      return Readable.from([await readFile(historyFile)]);
    };
    await writeHistory(active, "unreadable-task", [
      event("task_started", "turn-a"),
    ]);

    const snapshots = await observeTasks([
      { taskId: "contradictory-task", mode: "latest" },
      { taskId: "malformed-task", mode: "latest" },
      { taskId: "unreadable-task", mode: "latest" },
    ], { roots, openHistory });

    expectDiagnostic(snapshots[0], "TASK_EVENT_CONTRADICTORY");
    expectDiagnostic(snapshots[1], "TASK_JSONL_MALFORMED");
    expectDiagnostic(snapshots[2], "TASK_HISTORY_UNREADABLE");
  });
});

test("keeps batch order and bounds concurrent independent history reads", async () => {
  await withCodexHome(async ({ active, roots }) => {
    const taskIds = ["task-c", "task-a", "task-d", "task-b"];
    for (const taskId of taskIds) {
      await writeHistory(active, taskId, [
        event("task_started", `${taskId}-turn`),
      ], taskId);
    }

    let activeReads = 0;
    let maximumReads = 0;
    const openHistory = async (historyFile) => {
      activeReads += 1;
      maximumReads = Math.max(maximumReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const contents = await readFile(historyFile);
      activeReads -= 1;
      return Readable.from([contents]);
    };

    const snapshots = await observeTasks(
      taskIds.map((taskId) => ({ taskId, mode: "latest" })),
      { roots, concurrency: 2, openHistory },
    );

    assert.deepEqual(snapshots.map(({ taskId }) => taskId), taskIds);
    assert.equal(maximumReads, 2);
    assert.ok(snapshots.every(({ turnState }) => turnState === "in_progress"));
  });
});

test("one degraded task does not hide healthy sibling snapshots", async () => {
  await withCodexHome(async ({ active, roots }) => {
    await writeHistory(active, "healthy-task", [
      event("task_started", "healthy-turn"),
      event("task_complete", "healthy-turn"),
    ]);
    const brokenFile = await writeHistory(active, "broken-task", []);
    await writeFile(brokenFile, "{broken}\n");

    const snapshots = await observeTasks([
      { taskId: "broken-task", mode: "latest" },
      { taskId: "healthy-task", mode: "latest" },
    ], { roots });

    expectDiagnostic(snapshots[0], "TASK_JSONL_MALFORMED");
    assert.equal(snapshots[1].turnState, "ended");
    assert.deepEqual(snapshots[1].diagnostics, []);
  });
});

test("returns a replacement cache path after history moves to archive", async () => {
  await withCodexHome(async ({ active, archived, roots }) => {
    const taskId = "moved-task";
    const oldPath = await writeHistory(active, taskId, [
      event("task_started", "turn-a"),
    ]);
    const newPath = path.join(archived, `rollout-${taskId}.jsonl`);
    await rename(oldPath, newPath);

    const snapshot = await observeLatestTask(taskId, {
      roots,
      cachedPaths: new Map([[taskId, oldPath]]),
    });

    assert.equal(snapshot.location, "archived");
    assert.equal(snapshot.historyFile, newPath);
    assert.equal(snapshot.turnState, "in_progress");
  });
});

test("re-observes the current file instead of reusing an earlier turn snapshot", async () => {
  await withCodexHome(async ({ active, roots }) => {
    const taskId = "changing-task";
    const historyFile = await writeHistory(active, taskId, [
      event("task_started", "turn-a"),
    ]);
    const first = await observeLatestTask(taskId, { roots });

    await writeFile(historyFile, jsonl([
      event("task_started", "turn-a"),
      event("task_complete", "turn-a"),
    ]));
    const second = await observeLatestTask(taskId, { roots });

    assert.equal(first.turnState, "in_progress");
    assert.equal(second.turnState, "ended");
    assert.equal(sameTurnBoundary(first, second), false);
  });
});

test("scans one history once for latest and exact requests for the same task", async () => {
  await withCodexHome(async ({ active, roots }) => {
    await writeHistory(active, "shared-task", [
      event("task_started", "turn-a"),
      event("task_complete", "turn-a"),
      event("task_started", "turn-b"),
    ]);
    let opens = 0;
    const openHistory = async (historyFile) => {
      opens += 1;
      return Readable.from([await readFile(historyFile)]);
    };

    const snapshots = await observeTasks([
      { taskId: "shared-task", mode: "latest" },
      { taskId: "shared-task", mode: "exact", turnId: "turn-a" },
    ], { roots, openHistory });

    assert.equal(opens, 1);
    assert.equal(snapshots[0].latestTurnId, "turn-b");
    assert.equal(snapshots[0].turnState, "in_progress");
    assert.equal(snapshots[1].turnId, "turn-a");
    assert.equal(snapshots[1].turnState, "ended");
  });
});

test("sameTurnBoundary requires one unchanged active terminal latest turn", () => {
  const baseline = latestShape(
    "task-a",
    "active",
    "/history-a.jsonl",
    "turn-a",
    "ended",
  );

  assert.equal(sameTurnBoundary(baseline, { ...baseline }), true);
  assert.equal(
    sameTurnBoundary(baseline, { ...baseline, taskId: "task-b" }),
    false,
  );
  assert.equal(
    sameTurnBoundary(baseline, { ...baseline, location: "archived" }),
    false,
  );
  assert.equal(
    sameTurnBoundary(baseline, { ...baseline, latestTurnId: "turn-b" }),
    false,
  );
  assert.equal(
    sameTurnBoundary(baseline, { ...baseline, turnState: "aborted" }),
    false,
  );
  assert.equal(
    sameTurnBoundary(
      { ...baseline, turnState: "in_progress" },
      { ...baseline, turnState: "in_progress" },
    ),
    false,
  );
  assert.equal(sameTurnBoundary(null, baseline), false);
});

test("rejects invalid requests and concurrency before filesystem work", async () => {
  const roots = resolveCodexSessionRoots(path.join(path.sep, "tmp", "codex"));

  await assert.rejects(
    observeTasks([], { roots }),
    (error) => error.code === "TASK_EVENT_INVALID",
  );
  await assert.rejects(
    observeTasks([{ taskId: "task-a", mode: "other" }], { roots }),
    (error) => error.code === "TASK_EVENT_INVALID",
  );
  await assert.rejects(
    observeTasks([{ taskId: "task-a", mode: "exact", turnId: "" }], { roots }),
    (error) => error.code === "TASK_EVENT_INVALID",
  );
  await assert.rejects(
    observeTasks([{ taskId: "task-a", mode: "latest" }], {
      roots,
      concurrency: 0,
    }),
    (error) => error.code === "TASK_EVENT_INVALID",
  );
});
