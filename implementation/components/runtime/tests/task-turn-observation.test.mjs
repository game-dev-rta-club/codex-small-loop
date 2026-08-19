import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_TASK_WAIT_TIMEOUT_MS,
  readExactTaskTurn,
  waitForExactTaskTurn,
} from "../source/task-turn-observation.mjs";

function snapshot(overrides = {}) {
  return {
    taskId: "task-a",
    turnId: "turn-a",
    location: "active",
    historyFile: "/codex/sessions/task-a.jsonl",
    turnState: "in_progress",
    finalAnswer: null,
    diagnostics: [],
    ...overrides,
  };
}

test("reads one exact turn immediately with opt-in final answer access", async () => {
  const calls = [];
  const result = await readExactTaskTurn({
    taskId: "task-a",
    turnId: "turn-a",
  }, {
    async observeExactTurn(taskId, turnId, options) {
      calls.push({ taskId, turnId, options });
      return snapshot({
        turnState: "ended",
        finalAnswer: "READY_FOR_EXECUTION",
      });
    },
  });

  assert.deepEqual(calls, [{
    taskId: "task-a",
    turnId: "turn-a",
    options: { includeFinalAnswer: true },
  }]);
  assert.deepEqual(result, {
    run: "ok",
    operation: "read",
    taskId: "task-a",
    turnId: "turn-a",
    location: "active",
    turnState: "ended",
    finalAnswer: "READY_FOR_EXECUTION",
  });
});

test("waits for only the selected turn and returns its final answer", async () => {
  let now = 1_000;
  const sleeps = [];
  const states = [
    snapshot(),
    snapshot({ turnState: "ended", finalAnswer: "Complete." }),
  ];
  const result = await waitForExactTaskTurn({
    taskId: "task-a",
    turnId: "turn-a",
    timeoutMs: 1_000,
  }, {
    nowMs: () => now,
    async sleep(milliseconds) {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    async readExactTaskTurn() {
      const current = states.shift();
      return {
        run: "ok",
        operation: "read",
        taskId: current.taskId,
        turnId: current.turnId,
        location: current.location,
        turnState: current.turnState,
        finalAnswer: current.finalAnswer,
      };
    },
  });

  assert.deepEqual(sleeps, [250]);
  assert.equal(result.operation, "wait");
  assert.equal(result.turnState, "ended");
  assert.equal(result.finalAnswer, "Complete.");
  assert.equal(result.timedOut, false);
});

test("returns an in-progress snapshot on timeout without treating it as failure", async () => {
  let reads = 0;
  const result = await waitForExactTaskTurn({
    taskId: "task-a",
    turnId: "turn-a",
    timeoutMs: 0,
  }, {
    async readExactTaskTurn() {
      reads += 1;
      return {
        run: "ok",
        operation: "read",
        taskId: "task-a",
        turnId: "turn-a",
        location: "active",
        turnState: "in_progress",
        finalAnswer: null,
      };
    },
  });

  assert.equal(reads, 1);
  assert.equal(result.run, "ok");
  assert.equal(result.turnState, "in_progress");
  assert.equal(result.timedOut, true);
});

test("fails closed for unknown exact turns and invalid wait bounds", async () => {
  await assert.rejects(
    readExactTaskTurn({ taskId: "task-a", turnId: "missing-turn" }, {
      async observeExactTurn() {
        return snapshot({
          turnId: "missing-turn",
          turnState: "unknown",
          diagnostics: [{
            code: "TASK_TURN_NOT_FOUND",
            message: "The exact turn was not found.",
          }],
        });
      },
    }),
    (error) => error.code === "TASK_TURN_NOT_FOUND",
  );

  await assert.rejects(
    waitForExactTaskTurn({
      taskId: "task-a",
      turnId: "turn-a",
      timeoutMs: MAX_TASK_WAIT_TIMEOUT_MS + 1,
    }),
    (error) => error.code === "TASK_WAIT_TIMEOUT_INVALID",
  );
});
