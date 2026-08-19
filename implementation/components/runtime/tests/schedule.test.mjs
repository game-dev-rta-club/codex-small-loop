import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appMessageScheduleId,
  applySchedule,
  deleteSchedule,
  readSchedule,
} from "../source/schedule.mjs";

async function fixture(t) {
  const automationRoot = await mkdtemp(
    path.join(os.tmpdir(), "codex-small-loop-schedule-"),
  );
  t.after(() => rm(automationRoot, { recursive: true, force: true }));
  return {
    automationRoot,
    scheduleId: "codex-small-loop-monitor-controller-1",
    targetTaskId: "controller-task",
  };
}

test("applies, reads, updates, and deletes one exact schedule with CAS", async (t) => {
  const base = await fixture(t);
  const created = await applySchedule({
    ...base,
    ifMatch: "absent",
    intervalMinutes: 1,
    prompt: "revision 1",
    nowMs: 100,
  });
  assert.equal(created.change, "created");
  assert.match(created.etag, /^sha256:[a-f0-9]{64}$/);

  const exact = await readSchedule(base);
  assert.deepEqual(exact, {
    present: true,
    scheduleId: base.scheduleId,
    targetTaskId: base.targetTaskId,
    prompt: "revision 1",
    intervalMinutes: 1,
    etag: created.etag,
  });

  const unchanged = await applySchedule({
    ...base,
    ifMatch: "absent",
    intervalMinutes: 1,
    prompt: "revision 1",
    nowMs: 200,
  });
  assert.equal(unchanged.change, "unchanged");
  assert.equal(unchanged.etag, created.etag);

  const updated = await applySchedule({
    ...base,
    ifMatch: created.etag,
    intervalMinutes: 10,
    prompt: "revision 2",
    nowMs: 300,
  });
  assert.equal(updated.change, "updated");
  assert.notEqual(updated.etag, created.etag);

  await assert.rejects(
    deleteSchedule({ ...base, ifMatch: created.etag }),
    { code: "SCHEDULE_ETAG_MISMATCH" },
  );
  const deleted = await deleteSchedule({ ...base, ifMatch: updated.etag });
  assert.equal(deleted.change, "deleted");
  assert.equal((await readSchedule(base)).present, false);
});

test("fails closed for a different Task or unmanaged automation content", async (t) => {
  const base = await fixture(t);
  const created = await applySchedule({
    ...base,
    ifMatch: "absent",
    intervalMinutes: 1,
    prompt: "exact",
    nowMs: 100,
  });
  await assert.rejects(
    readSchedule({ ...base, targetTaskId: "other-task" }),
    { code: "SCHEDULE_TARGET_MISMATCH" },
  );
  const file = path.join(base.automationRoot, base.scheduleId, "automation.toml");
  const source = await readFile(file, "utf8");
  await writeFile(file, source.replace('kind = "heartbeat"', 'kind = "other"'));
  await assert.rejects(readSchedule(base), { code: "SCHEDULE_CONFLICT" });
  assert.ok(created.etag);
});

test("serializes concurrent updates so one stale etag loses", async (t) => {
  const base = await fixture(t);
  const created = await applySchedule({
    ...base,
    ifMatch: "absent",
    intervalMinutes: 1,
    prompt: "revision 1",
    nowMs: 100,
  });
  const settled = await Promise.allSettled([
    applySchedule({
      ...base,
      ifMatch: created.etag,
      intervalMinutes: 2,
      prompt: "revision 2a",
      nowMs: 200,
    }),
    applySchedule({
      ...base,
      ifMatch: created.etag,
      intervalMinutes: 3,
      prompt: "revision 2b",
      nowMs: 300,
    }),
  ]);
  assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = settled.find(({ status }) => status === "rejected");
  assert.equal(rejected.reason.code, "SCHEDULE_ETAG_MISMATCH");
});

test("rejects a symlink schedule file and path-like schedule IDs", async (t) => {
  const base = await fixture(t);
  const directory = path.join(base.automationRoot, base.scheduleId);
  await rm(directory, { recursive: true, force: true });
  await import("node:fs/promises").then(({ mkdir }) => mkdir(directory));
  const target = path.join(base.automationRoot, "target.toml");
  await writeFile(target, "version = 1\n");
  await symlink(target, path.join(directory, "automation.toml"));
  await assert.rejects(readSchedule(base), { code: "SCHEDULE_CONFLICT" });
  await assert.rejects(
    readSchedule({ ...base, scheduleId: "codex-small-loop-../escape" }),
    /scheduleId/,
  );
});

test("derives stable opaque message schedule IDs", () => {
  assert.equal(
    appMessageScheduleId("message-1"),
    appMessageScheduleId("message-1"),
  );
  assert.match(
    appMessageScheduleId("unsafe/message id"),
    /^codex-small-loop-message-[a-f0-9]{32}$/,
  );
});

test("writes private schedule files on POSIX", async (t) => {
  const base = await fixture(t);
  await applySchedule({
    ...base,
    ifMatch: "absent",
    intervalMinutes: 1,
    prompt: "exact",
    nowMs: 100,
  });
  const metadata = await lstat(
    path.join(base.automationRoot, base.scheduleId, "automation.toml"),
  );
  if (process.platform !== "win32") {
    assert.equal(metadata.mode & 0o777, 0o600);
  }
});
