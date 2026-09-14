import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AtomicJsonStore } from "../source/atomic-json-store.mjs";
import { resolveProject } from "../source/project.mjs";
import { initializeTaskLedger, enqueueAppMessage, readTaskLedger, transactTaskLedger } from "../source/task-ledger.mjs";
import { retryProjectOperation, inspectProjectRuntime } from "../source/project-setup.mjs";

test("exhausted operations remain visible after restart and only the selected operation is rearmed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "retry-operation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await resolveProject(root);
  const store = new AtomicJsonStore(project.stateFile);
  const now = new Date().toISOString();
  await initializeTaskLedger(store, project, now);
  await transactTaskLedger(store, project, (state) => {
    for (const id of ["one", "two"]) state = enqueueAppMessage(state, { id, targetTaskId: "app-task", text: id }, { now }).state;
    return { state: { ...state, appMessages: state.appMessages.map((x) => ({ ...x, attemptCount: 6000 })) }, result: null };
  }, { now });
  const before = await inspectProjectRuntime(root);
  assert.equal(before.issues[0].code, "RETRY_LIMIT_REACHED");
  await retryProjectOperation(root, "one");
  const after = await readTaskLedger(new AtomicJsonStore(project.stateFile), project);
  assert.equal(after.appMessages.find((x) => x.id === "one").attemptCount, 0);
  assert.equal(after.appMessages.find((x) => x.id === "two").attemptCount, 6000);
  await assert.rejects(retryProjectOperation(root, "one"), { code: "RETRY_OPERATION_INVALID" });
});

test("early fork preflight failures also consume a persisted budget", async (t) => {
  const { preparePendingLaunch } = await import("../source/task-launch.mjs");
  const { runDeferredForks, planPendingLaunchReconciliation } = await import("../source/heartbeat.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "retry-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await resolveProject(root);
  const store = new AtomicJsonStore(project.stateFile);
  const now = new Date().toISOString();
  await initializeTaskLedger(store, project, now);
  await transactTaskLedger(store, project, (state) => preparePendingLaunch(state, {
    launchId: "launch", name: "child", parentTaskId: "parent", sourceTaskId: "parent", role: "execute",
    phase: "fork_queued", assignment: "test", now,
  }), { now });
  let state = await readTaskLedger(store, project);
  let calls = 0;
  for (let i = 0; i < 50; i++) {
    ({ state } = await runDeferredForks({ store, project }, { deferredForks: [{ launchId: "launch" }] }, {
      state, continueDeferredFork: async () => { calls++; throw Object.assign(new Error("unavailable"), { code: "PREFLIGHT_FAILED" }); },
    }));
  }
  assert.equal(calls, 50);
  assert.equal(state.pendingLaunches[0].attemptCount, 50);
  assert.equal(planPendingLaunchReconciliation(state.pendingLaunches, []).deferredForks.length, 0);
});
