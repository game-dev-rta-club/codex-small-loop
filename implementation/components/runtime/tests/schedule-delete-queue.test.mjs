import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { queueScheduleDeletion, processScheduleDeletions } from "../source/schedule-delete-queue.mjs";
import { applySchedule, deleteSchedule, readSchedule } from "../source/schedule.mjs";
import { resolveProject } from "../source/project.mjs";
import { supervisorHasWork } from "../source/recovery-supervisor.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "small-loop-delete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".codex-small-loop"));
  const project = await resolveProject(root);
  const automationRoot = path.join(project.root, "automations");
  const base = { automationRoot, scheduleId: "codex-small-loop-monitor-another-runtime", targetTaskId: "task-other" };
  const created = await applySchedule({ ...base, ifMatch: "absent", intervalMinutes: 1, prompt: "A monitor not created by this runtime", nowMs: 100 });
  const request = { project, scheduleId: base.scheduleId, targetTaskId: base.targetTaskId, ifMatch: created.etag };
  return { project, automationRoot, base, request };
}

test("accepts schedules from another runtime, deduplicates concurrent requests, and retains completion across restarts", async (t) => {
  const { project, automationRoot, base, request } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => queueScheduleDeletion(request)));
  assert.equal(new Set(results.map((r) => r.requestId)).size, 1);
  assert.equal((await readSchedule(base)).present, true);
  let deletes = 0;
  const result = await processScheduleDeletions(project, { automationRoot, remove: (input) => { deletes++; return deleteSchedule(input); } });
  assert.equal(result.pending, 0);
  assert.equal(deletes, 1);
  assert.equal((await readSchedule(base)).present, false);
  assert.equal((await queueScheduleDeletion(request)).completed, true);
  await processScheduleDeletions(project, { automationRoot, remove: () => { throw new Error("must not delete twice"); } });
  assert.equal((await readdir(path.join(project.directory, "schedule-deletions"))).length, 1);
});

test("stale etags and task mismatches become failed receipts without deleting the schedule", async (t) => {
  for (const mismatch of ["etag", "task"]) {
    const { project, automationRoot, base, request } = await fixture(t);
    if (mismatch === "task") request.targetTaskId = "wrong-task";
    await queueScheduleDeletion(request);
    if (mismatch === "etag") await applySchedule({ ...base, ifMatch: request.ifMatch, intervalMinutes: 2, prompt: "Updated", nowMs: 200 });
    const result = await processScheduleDeletions(project, { automationRoot });
    assert.equal(result.events[0].type, "schedule_delete_failed");
    assert.equal((await readSchedule(base)).present, true);
    await assert.rejects(queueScheduleDeletion(request));
  }
});

test("transient failures retry on runtime ticks, remain alive between attempts, and stop after three failures", async (t) => {
  const { project, automationRoot, request } = await fixture(t);
  await queueScheduleDeletion(request);
  let attempts = 0;
  const remove = async () => { attempts++; throw Object.assign(new Error("denied"), { code: "SCHEDULE_WRITE_FAILED" }); };
  let result = await processScheduleDeletions(project, { automationRoot, remove, now: 1000 });
  assert.equal(result.pending, 1);
  assert.equal(supervisorHasWork({ summary: { pendingScheduleDeletes: result.pending } }), true);
  await processScheduleDeletions(project, { automationRoot, remove, now: 1001 });
  assert.equal(attempts, 1);
  await processScheduleDeletions(project, { automationRoot, remove, now: 31000 });
  result = await processScheduleDeletions(project, { automationRoot, remove, now: 61000 });
  assert.equal(attempts, 3);
  assert.equal(result.pending, 0);
  await assert.rejects(queueScheduleDeletion(request), { code: "SCHEDULE_WRITE_FAILED" });
});

test("crash after deletion before receipt publication recovers idempotently", async (t) => {
  const { project, automationRoot, base, request } = await fixture(t);
  await queueScheduleDeletion(request);
  await deleteSchedule({ ...base, ifMatch: request.ifMatch });
  await processScheduleDeletions(project, { automationRoot });
  assert.equal((await queueScheduleDeletion(request)).completed, true);
});

test("requests cannot substitute filesystem locations or malformed identities", async (t) => {
  const { project, automationRoot, request } = await fixture(t);
  await assert.rejects(queueScheduleDeletion({ ...request, scheduleId: "../../outside" }));
  const queued = await queueScheduleDeletion(request);
  const file = path.join(project.directory, "schedule-deletions", `${queued.requestId}.json`);
  const contents = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...contents, automationRoot: "/must-not-use" }));
  await processScheduleDeletions(project, { automationRoot, remove: async (input) => { assert.equal(input.automationRoot, automationRoot); } });
});

test("linked queue directories are rejected without following them", { skip: process.platform === "win32" }, async (t) => {
  const { project, request } = await fixture(t);
  const external = path.join(project.root, "external");
  await mkdir(external);
  await symlink(external, path.join(project.directory, "schedule-deletions"));
  await assert.rejects(queueScheduleDeletion(request), { code: "SCHEDULE_DELETE_QUEUE_UNSAFE" });
  assert.deepEqual(await readdir(external), []);
});
