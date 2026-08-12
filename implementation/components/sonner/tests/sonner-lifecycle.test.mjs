import assert from "node:assert/strict";
import test from "node:test";

import { buildSonnerProject } from "../source/sonner.mjs";
import {
  openSonnerProjectReadSession,
} from "../source/sonner-project-reader.mjs";

const project = Object.freeze({
  root: "/authorized-project",
  key: "a".repeat(64),
  rootIdentity: Object.freeze({ dev: 1n, ino: 2n }),
});

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function fakeSession(events) {
  const controller = new AbortController();
  let closed = false;
  let aborts = 0;
  let closes = 0;
  return {
    project,
    rootHandle: { fd: 3 },
    deadline: Date.now() + 5_000,
    signal: controller.signal,
    remainingMs: () => 5_000,
    get closed() { return closed; },
    get aborts() { return aborts; },
    get closes() { return closes; },
    abort(reason) {
      if (controller.signal.aborted) return false;
      aborts += 1;
      events.push("abort");
      controller.abort(reason);
      return true;
    },
    throwIfAborted() {
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    async close() {
      if (closed) return;
      closed = true;
      closes += 1;
      events.push("root-close");
    },
  };
}

const readerResult = { entries: [], works: [], workUnsafe: false, admittedPaths: [] };

test("Files fatal abort waits for Runtime cleanup before the Project Root closes", async () => {
  const events = [];
  const cleanup = deferred();
  const session = fakeSession(events);
  const failure = Object.assign(new Error("files failed"), { code: "SONNER_PROJECT_READER_UNAVAILABLE" });
  const operation = buildSonnerProject(project, {
    openSession: async () => session,
    readProject: async () => { throw failure; },
    runtimeBuilder: async (_project, { projectSession }) => new Promise((resolve, reject) => {
      projectSession.signal.addEventListener("abort", () => {
        events.push("runtime-abort");
        cleanup.promise.then(() => {
          events.push("runtime-clean");
          reject(projectSession.signal.reason);
        });
      }, { once: true });
    }),
  });
  let settled = false;
  operation.catch(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(events, ["abort", "runtime-abort"]);
  assert.equal(session.closes, 0);
  cleanup.resolve();
  await assert.rejects(operation, failure);
  assert.deepEqual(events, ["abort", "runtime-abort", "runtime-clean", "root-close"]);
  assert.equal(session.aborts, 1);
  assert.equal(session.closes, 1);
});

test("Runtime fatal abort waits for Files cleanup before the Project Root closes", async () => {
  const events = [];
  const cleanup = deferred();
  const session = fakeSession(events);
  const failure = new Error("runtime failed");
  const operation = buildSonnerProject(project, {
    openSession: async () => session,
    readProject: async ({ session: projectSession }) => new Promise((resolve, reject) => {
      projectSession.signal.addEventListener("abort", () => {
        events.push("files-abort");
        cleanup.promise.then(() => {
          events.push("files-clean");
          reject(projectSession.signal.reason);
        });
      }, { once: true });
    }),
    runtimeBuilder: async () => { throw failure; },
  });
  let settled = false;
  operation.catch(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(events, ["abort", "files-abort"]);
  assert.equal(session.closes, 0);
  cleanup.resolve();
  await assert.rejects(operation, failure);
  assert.deepEqual(events, ["abort", "files-abort", "files-clean", "root-close"]);
  assert.equal(session.aborts, 1);
  assert.equal(session.closes, 1);
});

test("expected Runtime states do not abort Files and close the Root after both branches", async () => {
  for (const runtime of [{ status: "missing" }, { status: "invalid" }, {
    status: "available", health: "unknown", reasons: ["observation_failed"], tasks: [],
  }]) {
    const events = [];
    const session = fakeSession(events);
    const result = await buildSonnerProject(project, {
      openSession: async () => session,
      readProject: async () => readerResult,
      runtimeBuilder: async () => runtime,
    });
    assert.deepEqual(result.runtime, runtime);
    assert.equal(session.aborts, 0);
    assert.equal(session.closes, 1);
    assert.deepEqual(events, ["root-close"]);
  }
});

test("the absolute deadline begins before Root acquisition and closes a late handle", async () => {
  let closes = 0;
  const lateHandle = {
    async stat() { return { isDirectory: () => true, dev: 1n, ino: 2n }; },
    async close() { closes += 1; },
  };
  await assert.rejects(openSonnerProjectReadSession(project, {
    platform: "darwin",
    timeoutMs: 10,
    openImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return lateHandle;
    },
  }), { code: "SONNER_OPERATION_ABORTED" });
  assert.equal(closes, 1);
});

test("Project Root close failure rejects instead of releasing a successful response", async () => {
  const events = [];
  const session = fakeSession(events);
  session.close = async () => {
    events.push("root-close");
    throw new Error("close failed");
  };
  await assert.rejects(buildSonnerProject(project, {
    openSession: async () => session,
    readProject: async () => readerResult,
    runtimeBuilder: async () => ({ status: "missing" }),
  }), /close failed/);
  assert.deepEqual(events, ["root-close"]);
});
