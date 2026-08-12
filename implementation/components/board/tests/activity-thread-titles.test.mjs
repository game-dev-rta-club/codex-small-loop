import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ACTIVITY_THREAD_LOOKUP_TIMEOUT_MS, MAX_ACTIVITY_THREAD_DATABASE_BYTES, MAX_ACTIVITY_THREAD_TITLE_BYTES,
  MAX_ACTIVITY_THREAD_TITLE_ROWS, __activityThreadTitleTest, readActivityThreadTitles,
  validateDesktopThreadTitle } from "../source/activity-thread-titles.mjs";

const ROOT = "11111111-1111-4111-8111-111111111111";
const PROJECT = { root: "/canonical/project" };
const ROLLOUT = "/verified/rollout.jsonl";
const DATABASE = "/codex/state_5.sqlite";

function columns(primary = [{ name: "id", pk: 1 }]) {
  return [...primary, { name: "cwd", pk: 0 }, { name: "rollout_path", pk: 0 }, { name: "title", pk: 0 }];
}

function database({ rows = [], tableColumns = columns(), indexes = [], indexFields = new Map(), failQuery = false } = {}) {
  const state = { closed: 0, queries: [] };
  return { state, value: {
    prepare(sql) {
      if (sql === "PRAGMA table_info(threads)") return { all: () => tableColumns };
      if (sql.includes("pragma_index_list")) return { all: () => indexes };
      if (sql.includes("pragma_index_info")) return { all: (name) => indexFields.get(name) ?? [] };
      return { all(...parameters) { state.queries.push({ sql, parameters }); if (failQuery) throw new Error("locked"); return rows; } };
    },
    close() { state.closed += 1; },
  } };
}

function metadata({ kind = "file", size = 4096, dev = 1n, ino = 2n, mode = 0o100600n,
  mtimeNs = 3n, ctimeNs = 4n, symlink = false } = {}) {
  return { size: BigInt(size), dev, ino, mode, mtimeNs, ctimeNs, isFile: () => kind === "file",
    isDirectory: () => kind === "directory", isSymbolicLink: () => symlink };
}

function inspector(overrides = new Map()) {
  return async (file) => {
    if (overrides.has(file)) { const value = overrides.get(file); if (value instanceof Error) throw value; return value; }
    if (file === DATABASE) return metadata();
    if (file === `${DATABASE}-wal` || file === `${DATABASE}-shm`) { const error = new Error("absent"); error.code = "ENOENT"; throw error; }
    return metadata({ kind: "directory", mode: 0o40700n, ino: BigInt(file.length + 10) });
  };
}

async function coreLookup(fake, options = {}) {
  const input = { databasePath: DATABASE, projectRoot: PROJECT.root, authorized: [{ taskId: ROOT, rolloutPath: ROLLOUT }] };
  return __activityThreadTitleTest.queryDesktopTitles(input, { openDatabase: async () => fake.value,
    inspectPath: options.inspectPath ?? inspector(), transition: options.transition });
}

async function lookup(fake, options = {}) {
  return readActivityThreadTitles({ project: PROJECT, activityTaskIds: [ROOT], verifiedSessionPaths: new Map([[ROOT, ROLLOUT]]),
    codexHome: "/unused", databasePath: DATABASE, runLookup: () => coreLookup(fake, options) });
}

test("Desktop title requires one exact authorized id, cwd, verified rollout, and closes", async () => {
  const exact = database({ rows: [{ id: ROOT, cwd: PROJECT.root, rollout_path: ROLLOUT, title: "Exact Desktop title" }] });
  assert.equal((await lookup(exact)).get(ROOT), "Exact Desktop title");
  assert.equal(exact.state.queries.length, 1); assert.equal(exact.state.queries[0].parameters.at(-1), 2);
  assert.equal(exact.state.closed, 1);
  for (const row of [
    { id: "other", cwd: PROJECT.root, rollout_path: ROLLOUT, title: "wrong id" },
    { id: ROOT, cwd: "/other", rollout_path: ROLLOUT, title: "wrong cwd" },
    { id: ROOT, cwd: PROJECT.root, rollout_path: "/other", title: "wrong rollout" },
  ]) { const mismatch = database({ rows: [row] }); assert.equal((await lookup(mismatch)).size, 0); assert.equal(mismatch.state.closed, 1); }
});

test("Desktop title uses native Windows path identity without weakening macOS", async () => {
  const project = { root: "C:\\Work\\Canonical Project" };
  const rollout = "C:\\Users\\Example\\.codex\\sessions\\rollout.jsonl";
  const windowsRows = [{
    id: ROOT,
    cwd: "c:/work/canonical project/",
    rollout_path: "c:/users/example/.codex/sessions/ROLLOUT.jsonl",
    title: "Windows title",
  }];
  const input = {
    project,
    activityTaskIds: [ROOT],
    verifiedSessionPaths: new Map([[ROOT, rollout]]),
    codexHome: "C:\\Users\\Example\\.codex",
    runLookup: async () => windowsRows,
  };

  assert.equal((await readActivityThreadTitles({
    ...input,
    platform: "win32",
  })).get(ROOT), "Windows title");

  const macInput = {
    project: { root: "/Users/Example/Canonical Project" },
    activityTaskIds: [ROOT],
    verifiedSessionPaths: new Map([[
      ROOT,
      "/Users/Example/.codex/sessions/rollout.jsonl",
    ]]),
    codexHome: "/Users/Example/.codex",
  };
  assert.equal((await readActivityThreadTitles({
    ...macInput,
    platform: "darwin",
    runLookup: async () => [{
      id: ROOT,
      cwd: macInput.project.root,
      rollout_path: macInput.verifiedSessionPaths.get(ROOT),
      title: "macOS title",
    }],
  })).get(ROOT), "macOS title");
  assert.equal((await readActivityThreadTitles({
    ...macInput,
    platform: "darwin",
    runLookup: async () => [{
      id: ROOT,
      cwd: "/Users/example/Canonical Project",
      rollout_path: macInput.verifiedSessionPaths.get(ROOT),
      title: "wrong case",
    }],
  })).size, 0);

  const relative = await readActivityThreadTitles({
    ...input,
    platform: "win32",
    runLookup: async () => [{
      ...windowsRows[0],
      rollout_path: "sessions/rollout.jsonl",
    }],
  });
  assert.equal(relative.size, 0);
});

test("sole id primary key or exact single-column unique index is required", async () => {
  const composite = database({ tableColumns: columns([{ name: "id", pk: 1 }, { name: "variant", pk: 2 }]), rows: [
    { id: ROOT, cwd: PROJECT.root, rollout_path: ROLLOUT, title: "must not pass" },
  ] });
  assert.equal((await lookup(composite)).size, 0); assert.equal(composite.state.queries.length, 0);
  const unique = database({ tableColumns: columns([{ name: "id", pk: 0 }]), indexes: [{ name: "threads_id", isUnique: 1, partial: 0 }],
    indexFields: new Map([["threads_id", [{ name: "id" }]]]), rows: [{ id: ROOT, cwd: PROJECT.root, rollout_path: ROLLOUT, title: "Unique" }] });
  assert.equal((await lookup(unique)).get(ROOT), "Unique");
  for (const fields of [[{ name: "id" }, { name: "variant" }], [{ name: "variant" }]]) {
    const unsupported = database({ tableColumns: columns([{ name: "id", pk: 0 }]), indexes: [{ name: "wrong", isUnique: 1, partial: 0 }],
      indexFields: new Map([["wrong", fields]]) });
    assert.equal((await lookup(unsupported)).size, 0);
  }
});

test("duplicate rows cannot be hidden by LIMIT and malformed titles silently fall back", async () => {
  const duplicate = database({ rows: [
    { id: ROOT, cwd: PROJECT.root, rollout_path: ROLLOUT, title: "one" },
    { id: ROOT, cwd: PROJECT.root, rollout_path: ROLLOUT, title: "two" },
  ] });
  assert.equal((await lookup(duplicate)).size, 0); assert.equal(duplicate.state.queries[0].parameters.at(-1), 2);
  for (const title of ["", " padded", "line\nbreak", "control\u0000", "x".repeat(MAX_ACTIVITY_THREAD_TITLE_BYTES + 1)]) {
    assert.equal(validateDesktopThreadTitle(title), null);
    const malformed = database({ rows: [{ id: ROOT, cwd: PROJECT.root, rollout_path: ROLLOUT, title }] });
    assert.equal((await lookup(malformed)).size, 0); assert.equal(malformed.state.closed, 1);
  }
});

test("exact source and parent replacement, symlink, ABA, and sidecar growth fall back after close", async () => {
  for (const scenario of ["main-replace", "parent-replace", "wal-growth", "source-symlink"]) {
    const fake = database({ rows: [{ id: ROOT, cwd: PROJECT.root, rollout_path: ROLLOUT, title: "sentinel" }] });
    const overrides = new Map(); let changed = false;
    if (scenario === "wal-growth") overrides.set(`${DATABASE}-wal`, metadata({ size: 1024, ino: 20n }));
    if (scenario === "source-symlink") overrides.set(DATABASE, metadata({ symlink: true }));
    const inspectPath = async (file, options) => {
      if (scenario === "main-replace" && changed && file === DATABASE) return metadata({ ino: 99n });
      if (scenario === "parent-replace" && changed && file === "/codex") return metadata({ kind: "directory", mode: 0o40700n, ino: 99n });
      if (scenario === "wal-growth" && changed && file === `${DATABASE}-wal`) return metadata({ size: 2048, ino: 20n });
      return inspector(overrides)(file, options);
    };
    const result = await lookup(fake, { inspectPath, transition: async (point) => { if (point === "database-opened") changed = true; } });
    assert.equal(result.size, 0, scenario); assert.equal(fake.state.closed, scenario === "source-symlink" ? 0 : 1, scenario);
  }
});

test("oversized aggregate and locked or failed databases stay bounded and non-authorizing", async () => {
  const oversized = new Map([[DATABASE, metadata({ size: MAX_ACTIVITY_THREAD_DATABASE_BYTES + 1 })]]);
  const unopened = database(); assert.equal((await lookup(unopened, { inspectPath: inspector(oversized) })).size, 0); assert.equal(unopened.state.closed, 0);
  const locked = database({ failQuery: true }); assert.equal((await lookup(locked)).size, 0); assert.equal(locked.state.closed, 1);
});

test("worker total deadline terminates a non-progressing SQLite lookup", async () => {
  let terminated = 0;
  class HangingWorker extends EventEmitter { terminate() { terminated += 1; return Promise.resolve(0); } }
  const started = Date.now();
  const rows = await __activityThreadTitleTest.runTitleWorker({ databasePath: DATABASE, projectRoot: PROJECT.root, authorized: [] },
    { timeoutMs: 15, WorkerClass: HangingWorker });
  assert.deepEqual(rows, []); assert.equal(terminated, 1); assert.ok(Date.now() - started < ACTIVITY_THREAD_LOOKUP_TIMEOUT_MS);
});

test("timed-out title worker retains the single-worker barrier until termination", async () => {
  let starts = 0; let releaseTermination; let options;
  class DelayedWorker extends EventEmitter {
    constructor(_url, currentOptions) { super(); starts += 1; options = currentOptions; }
    terminate() { return new Promise((resolve) => { releaseTermination = resolve; }); }
  }
  const first = __activityThreadTitleTest.runTitleWorker({ databasePath: DATABASE, projectRoot: PROJECT.root, authorized: [] },
    { timeoutMs: 5, terminationTimeoutMs: 5, WorkerClass: DelayedWorker });
  assert.deepEqual(await first, []); assert.equal(__activityThreadTitleTest.workerBarrierActive(), true);
  assert.deepEqual(await __activityThreadTitleTest.runTitleWorker({}, { WorkerClass: DelayedWorker }), []);
  assert.equal(starts, 1); assert.deepEqual(options.execArgv, ["--disable-warning=ExperimentalWarning"]);
  releaseTermination(0); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(__activityThreadTitleTest.workerBarrierActive(), false);
});

test("authorized ID admission remains one query and 256 IDs", async () => {
  let received;
  const ids = Array.from({ length: MAX_ACTIVITY_THREAD_TITLE_ROWS + 1 }, (_, index) => `root-${index}`);
  await readActivityThreadTitles({ project: PROJECT, activityTaskIds: ids,
    verifiedSessionPaths: new Map(ids.map((id) => [id, ROLLOUT])), codexHome: "/unused",
    runLookup: async (input) => { received = input; return []; } });
  assert.equal(received.authorized.length, MAX_ACTIVITY_THREAD_TITLE_ROWS);
});
