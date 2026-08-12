import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveProject } from "../../runtime/source/project.mjs";
import { openSonnerProjectReadSession } from "../source/sonner-project-reader.mjs";
import { readSonnerRuntimeRecord } from "../source/sonner-runtime-reader.mjs";
import { SONNER_RUNTIME_DIAGNOSTIC_MAX_BYTES } from "../source/sonner-runtime-reader.mjs";

async function fixture(t, sessionOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sonner-runtime-reader-"));
  await mkdir(path.join(root, ".codex-small-loop"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await resolveProject(root);
  const session = await openSonnerProjectReadSession(project, sessionOptions);
  t.after(() => session.close());
  return { root, session };
}

async function helper(t, root, name, source) {
  const filename = path.join(root, name);
  await writeFile(filename, source);
  await chmod(filename, 0o755);
  return filename;
}

test("reads ledger and diagnostic records from the retained Project descriptor", { skip: process.platform !== "darwin" }, async (t) => {
  const { root, session } = await fixture(t);
  await writeFile(path.join(root, ".codex-small-loop", "state.json"), "{\"version\":10}\n");
  await writeFile(path.join(root, ".codex-small-loop", "recovery-supervisor-error.json"), "{\"code\":\"TEST\"}\n");

  const ledger = await readSonnerRuntimeRecord({ session, mode: "ledger" });
  const diagnostic = await readSonnerRuntimeRecord({ session, mode: "diagnostic" });
  assert.equal(ledger.status, "present");
  assert.equal(ledger.bytes.toString(), "{\"version\":10}\n");
  assert.equal(diagnostic.status, "present");
  assert.equal(diagnostic.bytes.toString(), "{\"code\":\"TEST\"}\n");
});

test("fails closed for missing records and final symlinks", { skip: process.platform !== "darwin" }, async (t) => {
  const { root, session } = await fixture(t);
  assert.deepEqual(await readSonnerRuntimeRecord({ session, mode: "ledger" }), { status: "missing" });
  const outside = path.join(root, "outside.json");
  await writeFile(outside, "PRIVATE");
  await symlink(outside, path.join(root, ".codex-small-loop", "state.json"));
  assert.deepEqual(await readSonnerRuntimeRecord({ session, mode: "ledger" }), { status: "unsafe" });
});

test("keeps reading the authorized Root after its pathname is replaced", { skip: process.platform !== "darwin" }, async (t) => {
  const { root, session } = await fixture(t);
  await writeFile(path.join(root, ".codex-small-loop", "state.json"), "AUTHORIZED\n");
  const retained = `${root}-retained`;
  await rename(root, retained);
  await mkdir(path.join(root, ".codex-small-loop"), { recursive: true });
  await writeFile(path.join(root, ".codex-small-loop", "state.json"), "REPLACEMENT_SENTINEL\n");
  t.after(() => rm(retained, { recursive: true, force: true }));

  const result = await readSonnerRuntimeRecord({ session, mode: "ledger" });
  assert.equal(result.status, "present");
  assert.equal(result.bytes.toString(), "AUTHORIZED\n");
});

test("accepts the exact diagnostic byte bound and rejects one byte over", { skip: process.platform !== "darwin" }, async (t) => {
  const { root, session } = await fixture(t);
  const target = path.join(root, ".codex-small-loop", "recovery-supervisor-error.json");
  await writeFile(target, Buffer.alloc(SONNER_RUNTIME_DIAGNOSTIC_MAX_BYTES, 0x20));
  const exact = await readSonnerRuntimeRecord({ session, mode: "diagnostic" });
  assert.equal(exact.status, "present");
  assert.equal(exact.bytes.length, SONNER_RUNTIME_DIAGNOSTIC_MAX_BYTES);
  await writeFile(target, Buffer.alloc(SONNER_RUNTIME_DIAGNOSTIC_MAX_BYTES + 1, 0x20));
  assert.deepEqual(await readSonnerRuntimeRecord({ session, mode: "diagnostic" }), { status: "unsafe" });
});

test("operation abort prevents spawn and timeout kills and reaps once", { skip: process.platform !== "darwin" }, async (t) => {
  const before = await fixture(t);
  before.session.abort();
  let spawned = 0;
  await assert.rejects(readSonnerRuntimeRecord({
    session: before.session,
    mode: "ledger",
    helperPath: "/usr/bin/true",
    validateArchitecture: false,
    spawnImpl() { spawned += 1; throw new Error("must not spawn"); },
  }), { code: "SONNER_OPERATION_ABORTED" });
  assert.equal(spawned, 0);

  const timed = await fixture(t, { timeoutMs: 40 });
  const sleeper = await helper(t, timed.root, "sleep-helper", "#!/bin/sh\nsleep 2\n");
  let kills = 0;
  let closes = 0;
  await assert.rejects(readSonnerRuntimeRecord({
    session: timed.session,
    mode: "ledger",
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
  assert.equal(kills, 1);
  assert.equal(closes, 1);
});

test("crash and malformed Runtime helpers fail closed after child settlement", { skip: process.platform !== "darwin" }, async (t) => {
  for (const [name, source] of [
    ["crash-helper", "#!/bin/sh\nexit 3\n"],
    ["malformed-helper", "#!/bin/sh\nprintf garbage\n"],
  ]) {
    const item = await fixture(t);
    const filename = await helper(t, item.root, name, source);
    await assert.rejects(readSonnerRuntimeRecord({
      session: item.session,
      mode: "ledger",
      helperPath: filename,
      validateArchitecture: false,
    }), { code: "SONNER_RUNTIME_READER_UNAVAILABLE" });
  }
});
