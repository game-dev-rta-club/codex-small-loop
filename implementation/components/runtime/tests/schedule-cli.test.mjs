import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runScheduleCli } from "../../commands/schedule.mjs";
import { processScheduleDeletions } from "../source/schedule-delete-queue.mjs";
import { resolveProject } from "../source/project.mjs";
import { readSchedule } from "../source/schedule.mjs";

function output() {
  let source = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        source += chunk.toString();
        callback();
      },
    }),
    json: () => JSON.parse(source),
  };
}

test("runs the public apply/read/delete CAS flow in an isolated automation root", async (t) => {
  const automationRoot = await mkdtemp(
    path.join(os.tmpdir(), "codex-small-loop-schedule-cli-"),
  );
  t.after(() => rm(automationRoot, { recursive: true, force: true }));
  const base = [
    "--schedule", "codex-small-loop-monitor-cli",
    "--task", "task-cli",
  ];
  const options = {
    automationRoot,
    cwd: automationRoot,
    env: { CODEX_THREAD_ID: "task-cli" },
    now: () => 100,
  };
  await mkdir(path.join(automationRoot, ".codex-small-loop"));

  const appliedOutput = output();
  assert.equal(await runScheduleCli([
    "apply", ...base,
    "--if-match", "absent",
    "--interval-minutes", "1",
  ], {
    ...options,
    stdin: Readable.from(["exact prompt"]),
    stdout: appliedOutput.stream,
  }), 0);
  const applied = appliedOutput.json();
  assert.equal(applied.change, "created");

  const readOutput = output();
  assert.equal(await runScheduleCli(["read", ...base], {
    ...options,
    stdout: readOutput.stream,
  }), 0);
  assert.equal(readOutput.json().etag, applied.etag);

  const deletedOutput = output();
  assert.equal(await runScheduleCli([
    "delete", ...base, "--if-match", applied.etag,
  ], {
    ...options,
    stdout: deletedOutput.stream,
  }), 0);
  assert.equal(deletedOutput.json().change, "deletion_queued");
  assert.equal(deletedOutput.json().completed, false);
  const schedule = { automationRoot, scheduleId: base[1], targetTaskId: base[3] };
  assert.equal((await readSchedule(schedule)).present, true);
  await processScheduleDeletions(await resolveProject(automationRoot), { automationRoot });
  assert.equal((await readSchedule(schedule)).present, false);
  const receipt = output();
  assert.equal(await runScheduleCli(["delete", ...base, "--if-match", applied.etag], { ...options, stdout: receipt.stream }), 0);
  assert.equal(receipt.json().completed, true);
});

test("fails before storage access when the caller Task differs", async () => {
  const stdout = output();
  const exitCode = await runScheduleCli([
    "read",
    "--schedule", "codex-small-loop-monitor-cli",
    "--task", "other-task",
  ], {
    env: { CODEX_THREAD_ID: "task-cli" },
    stdout: stdout.stream,
    readSchedule() {
      throw new Error("must not be called");
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(stdout.json().code, "SCHEDULE_TASK_MISMATCH");
});
