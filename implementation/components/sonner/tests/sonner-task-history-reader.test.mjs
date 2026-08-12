import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  encodeSonnerHistoryRequest,
  observeSonnerTasks,
  SONNER_HISTORY_MAX_TASKS,
} from "../source/sonner-task-history-reader.mjs";

function operation() {
  const controller = new AbortController();
  let reason = null;
  return {
    signal: controller.signal,
    deadline: Date.now() + 5_000,
    remainingMs: () => 5_000,
    abort(error = Object.assign(new Error("aborted"), { code: "SONNER_OPERATION_ABORTED" })) {
      if (controller.signal.aborted) return false;
      reason = error;
      controller.abort(error);
      return true;
    },
    throwIfAborted() { if (controller.signal.aborted) throw reason; },
  };
}

function event(type, turnId) {
  return JSON.stringify({ type: "event_msg", payload: { type, turn_id: turnId } });
}

async function roots(t) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "sonner-history-reader-")));
  const active = path.join(home, "sessions");
  const archived = path.join(home, "archived_sessions");
  await mkdir(active); await mkdir(archived);
  t.after(() => rm(home, { recursive: true, force: true }));
  return [
    { location: "active", directory: active },
    { location: "archived", directory: archived },
  ];
}

test("bounds and orders Task IDs before starting native observation", () => {
  const identity = { dev: 1n, ino: 2n };
  assert.throws(() => encodeSonnerHistoryRequest(
    Array.from({ length: SONNER_HISTORY_MAX_TASKS + 1 }, (_, index) => `task-${index}`),
    [{ identity }, null],
  ));
  assert.throws(() => encodeSonnerHistoryRequest(["task-b", "task-a"], [{ identity }, null]));
  assert.throws(() => encodeSonnerHistoryRequest(["../escape"], [{ identity }, null]));
  const request = encodeSonnerHistoryRequest(["task-a", "task-b"], [{ identity }, null]);
  assert.equal(request.includes(Buffer.from("/Users/")), false);
});

test("observes active and archived histories without publishing their paths", { skip: process.platform !== "darwin" }, async (t) => {
  const configured = await roots(t);
  await mkdir(path.join(configured[0].directory, "2026", "08"), { recursive: true });
  await writeFile(path.join(configured[0].directory, "2026", "08", "active-task.jsonl"), `${event("task_started", "turn-active")}\n`);
  await writeFile(path.join(configured[1].directory, "archived-task.jsonl"), `${event("task_started", "turn-archive")}\n${event("task_complete", "turn-archive")}\n`);

  const result = await observeSonnerTasks([
    { taskId: "active-task", mode: "latest" },
    { taskId: "archived-task", mode: "latest" },
    { taskId: "missing-task", mode: "latest" },
  ], {
    roots: configured,
    cachedPaths: new Map([
      ["active-task", path.join(configured[0].directory, "2026", "08", "active-task.jsonl")],
      ["archived-task", path.join(path.dirname(configured[1].directory), "outside-archived-task.jsonl")],
    ]),
  });
  assert.deepEqual(result.map(({ taskId, location, turnState }) => ({ taskId, location, turnState })), [
    { taskId: "active-task", location: "active", turnState: "in_progress" },
    { taskId: "archived-task", location: "archived", turnState: "ended" },
    { taskId: "missing-task", location: "missing", turnState: "unknown" },
  ]);
  assert.equal(JSON.stringify(result).includes(configured[0].directory), false);
});

test("reads only a bounded tail of oversized histories when it proves the latest Turn", { skip: process.platform !== "darwin" }, async (t) => {
  const configured = await roots(t);
  const history = path.join(configured[0].directory, "oversized-task.jsonl");
  const size = 100 * 1024 * 1024;
  const handle = await open(history, "w+");
  try {
    await handle.truncate(size);
    const tail = Buffer.from(`\n${event("task_started", "tail-turn")}\n${event("task_complete", "tail-turn")}\n`);
    await handle.write(tail, 0, tail.length, size - 1024 * 1024);
  } finally {
    await handle.close();
  }

  const [result] = await observeSonnerTasks([{ taskId: "oversized-task", mode: "latest" }], {
    roots: configured,
  });
  assert.deepEqual({ location: result.location, latestTurnId: result.latestTurnId, turnState: result.turnState }, {
    location: "active",
    latestTurnId: "tail-turn",
    turnState: "ended",
  });
  assert.deepEqual(result.diagnostics, []);
});

test("keeps an oversized history unknown when its bounded tail cannot prove a Turn boundary", { skip: process.platform !== "darwin" }, async (t) => {
  const configured = await roots(t);
  const history = path.join(configured[0].directory, "insufficient-tail.jsonl");
  const size = 4 * 1024 * 1024;
  const handle = await open(history, "w+");
  try {
    await handle.truncate(size);
    const started = Buffer.from(`\n${event("task_started", "outside-tail")}\n`);
    const completed = Buffer.from(`\n${event("task_complete", "outside-tail")}\n`);
    await handle.write(started, 0, started.length, 512 * 1024);
    await handle.write(completed, 0, completed.length, size - 512 * 1024);
  } finally {
    await handle.close();
  }

  const [result] = await observeSonnerTasks([{ taskId: "insufficient-tail", mode: "latest" }], {
    roots: configured,
  });
  assert.equal(result.turnState, "unknown");
  assert.deepEqual(result.diagnostics, [{ code: "TASK_HISTORY_UNAVAILABLE" }]);
});

test("returns unknown for ambiguous and symlinked histories", { skip: process.platform !== "darwin" }, async (t) => {
  const configured = await roots(t);
  await mkdir(path.join(configured[0].directory, "one"));
  await mkdir(path.join(configured[0].directory, "two"));
  await writeFile(path.join(configured[0].directory, "one", "ambiguous.jsonl"), `${event("task_complete", "one")}\n`);
  await writeFile(path.join(configured[0].directory, "two", "ambiguous.jsonl"), `${event("task_complete", "two")}\n`);
  const outside = path.join(path.dirname(configured[0].directory), "outside.jsonl");
  await writeFile(outside, `${event("task_complete", "outside")}\n`);
  await symlink(outside, path.join(configured[0].directory, "symlinked.jsonl"));

  const result = await observeSonnerTasks([
    { taskId: "ambiguous", mode: "latest" },
    { taskId: "symlinked", mode: "latest" },
  ], { roots: configured });
  assert.ok(result.every(({ turnState }) => turnState === "unknown"));
  assert.equal(JSON.stringify(result).includes("outside"), false);
});

test("retains the authorized session Root across pathname replacement", { skip: process.platform !== "darwin" }, async (t) => {
  const configured = await roots(t);
  const active = configured[0].directory;
  await writeFile(path.join(active, "retained-task.jsonl"), `${event("task_started", "authorized")}\n${event("task_complete", "authorized")}\n`);
  let replaced = false;
  const result = await observeSonnerTasks([{ taskId: "retained-task", mode: "latest" }], {
    roots: configured,
    async openImpl(directory, flags) {
      const handle = await open(directory, flags);
      if (!replaced && directory === active) {
        replaced = true;
        const retained = `${active}-retained`;
        await rename(active, retained);
        await mkdir(active);
        await writeFile(path.join(active, "retained-task.jsonl"), `${event("task_started", "REPLACEMENT_SENTINEL")}\n`);
      }
      return handle;
    },
  });
  assert.equal(result[0].location, "active");
  assert.equal(result[0].latestTurnId, "authorized");
  assert.equal(JSON.stringify(result).includes("REPLACEMENT_SENTINEL"), false);
});

test("partial root acquisition and stat failure close every acquired handle exactly once", async () => {
  const configured = [
    { location: "active", directory: "/active" },
    { location: "archived", directory: "/archive" },
  ];
  let activeClosed = 0;
  const active = {
    fd: 10,
    async stat() { return { isDirectory: () => true, dev: 1n, ino: 1n }; },
    async close() { activeClosed += 1; },
  };
  let calls = 0;
  const result = await observeSonnerTasks([{ taskId: "partial", mode: "latest" }], {
    roots: configured,
    helperPath: "/usr/bin/true",
    validateArchitecture: false,
    spawnImpl() { throw new Error("spawn must not be reached"); },
    async openImpl() {
      calls += 1;
      if (calls === 1) return active;
      await new Promise((resolve) => setImmediate(resolve));
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
  });
  assert.equal(result[0].turnState, "unknown");
  assert.equal(activeClosed, 1);

  let statFailureClosed = 0;
  await observeSonnerTasks([{ taskId: "stat-failure", mode: "latest" }], {
    roots: configured,
    helperPath: "/usr/bin/true",
    validateArchitecture: false,
    spawnImpl() { throw new Error("spawn must not be reached"); },
    async openImpl() {
      return {
        fd: 11,
        async stat() { throw Object.assign(new Error("stat failed"), { code: "EIO" }); },
        async close() { statFailureClosed += 1; },
      };
    },
  });
  assert.equal(statFailureClosed, 1);

  let rejectingCloseCalls = 0;
  calls = 0;
  const closeFailure = await observeSonnerTasks([{ taskId: "close-failure", mode: "latest" }], {
    roots: configured,
    helperPath: "/usr/bin/true",
    validateArchitecture: false,
    spawnImpl() { throw new Error("spawn must not be reached"); },
    async openImpl() {
      calls += 1;
      if (calls === 1) {
        return {
          fd: 12,
          async stat() { return { isDirectory: () => true, dev: 1n, ino: 2n }; },
          async close() {
            rejectingCloseCalls += 1;
            throw Object.assign(new Error("close failed"), { code: "EIO" });
          },
        };
      }
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
  });
  assert.equal(closeFailure[0].turnState, "unknown");
  assert.equal(rejectingCloseCalls, 1);
});

test("abort between sequential roots closes late and earlier handles and rejects outward", async () => {
  const configured = [
    { location: "active", directory: "/active" },
    { location: "archived", directory: "/archive" },
  ];
  const owner = operation();
  const closes = [0, 0];
  let calls = 0;
  await assert.rejects(observeSonnerTasks([{ taskId: "aborted", mode: "latest" }], {
    roots: configured,
    session: owner,
    helperPath: "/usr/bin/true",
    validateArchitecture: false,
    async openImpl() {
      const index = calls++;
      if (index === 1) owner.abort();
      return {
        fd: 20 + index,
        async stat() { return { isDirectory: () => true, dev: BigInt(index + 1), ino: 1n }; },
        async close() { closes[index] += 1; },
      };
    },
  }), { code: "SONNER_OPERATION_ABORTED" });
  assert.deepEqual(closes, [1, 1]);
});

test("active history child abort kills and reaps once before rejecting outward", { skip: process.platform !== "darwin" }, async (t) => {
  const configured = await roots(t);
  const sleeper = path.join(path.dirname(configured[0].directory), "sleep-history-helper");
  await writeFile(sleeper, "#!/bin/sh\nsleep 2\n");
  await chmod(sleeper, 0o755);
  const owner = operation();
  let kills = 0;
  let closes = 0;
  const timer = setTimeout(() => owner.abort(), 40);
  await assert.rejects(observeSonnerTasks([{ taskId: "timeout-task", mode: "latest" }], {
    roots: configured,
    session: owner,
    helperPath: sleeper,
    validateArchitecture: false,
    spawnImpl(command, arguments_, options) {
      const child = spawn(command, arguments_, options);
      const kill = child.kill.bind(child);
      child.kill = (...arguments__) => { kills += 1; return kill(...arguments__); };
      child.once("close", () => { closes += 1; });
      return child;
    },
  }), { code: "SONNER_OPERATION_ABORTED" });
  clearTimeout(timer);
  assert.equal(kills, 1);
  assert.equal(closes, 1);
});

test("malformed history output returns bounded unknown only after cleanup", { skip: process.platform !== "darwin" }, async (t) => {
  const configured = await roots(t);
  const malformed = path.join(path.dirname(configured[0].directory), "malformed-history-helper");
  await writeFile(malformed, "#!/bin/sh\nprintf garbage\n");
  await chmod(malformed, 0o755);
  let closes = 0;
  const result = await observeSonnerTasks([{ taskId: "malformed-task", mode: "latest" }], {
    roots: configured,
    helperPath: malformed,
    validateArchitecture: false,
    spawnImpl(command, arguments_, options) {
      const child = spawn(command, arguments_, options);
      child.once("close", () => { closes += 1; });
      return child;
    },
  });
  assert.equal(result[0].turnState, "unknown");
  assert.equal(closes, 1);
});

test("JSONL parser rejection while backpressured settles the active stream", { skip: process.platform !== "darwin" }, async (t) => {
  const configured = await roots(t);
  const producer = path.join(path.dirname(configured[0].directory), "backpressure-history-helper");
  await writeFile(producer, `#!/usr/bin/env node
const frame = (payload) => { const header = Buffer.alloc(4); header.writeUInt32BE(payload.length); process.stdout.write(header); process.stdout.write(payload); };
process.stdin.resume();
process.stdin.on("end", () => {
  frame(Buffer.from([1, 2]));
  frame(Buffer.from([2, 0, 0, 1, 0]));
  const body = Buffer.alloc(65536, 0x78); body[body.length - 1] = 0x0a;
  for (let index = 0; index < 40; index += 1) {
    const payload = Buffer.alloc(7 + body.length); payload[0] = 3; payload.writeUInt16BE(0, 1); payload.writeUInt32BE(body.length, 3); body.copy(payload, 7); frame(payload);
  }
  frame(Buffer.from([4, 0, 0]));
  frame(Buffer.from([5, 0, 1]));
});
`);
  await chmod(producer, 0o755);
  let watchdog;
  const timeout = new Promise((_, reject) => {
    watchdog = setTimeout(() => reject(new Error("history parser did not settle")), 1_500);
  });
  const result = await Promise.race([
    observeSonnerTasks([{ taskId: "parser-failure", mode: "latest" }], {
      roots: configured,
      helperPath: producer,
      validateArchitecture: false,
      timeoutMs: 1_000,
    }),
    timeout,
  ]).finally(() => clearTimeout(watchdog));
  assert.equal(result[0].turnState, "unknown");
});
