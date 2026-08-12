import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createAppMessageSchedule,
  inspectAppMessageSchedule,
  removeAppMessageSchedule,
} from "../source/app-message-schedule.mjs";

function tomlString(source, field) {
  const match = source.match(
    new RegExp(`^${field} = (.+)$`, "m"),
  );
  assert.ok(match, `missing TOML string field: ${field}`);
  return JSON.parse(match[1]);
}

function tomlInteger(source, field) {
  const match = source.match(
    new RegExp(`^${field} = (\\d+)$`, "m"),
  );
  assert.ok(match, `missing TOML integer field: ${field}`);
  return Number(match[1]);
}

test("creates one safe one-minute App message schedule", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "codex-small-loop-app-message-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const nowMs = Date.UTC(2026, 6, 27, 4, 12, 34);
  const text = [
    "=== Codex Small Loop · Primary ← Execute ===",
    "",
    "=== Message ===",
    "The result is \"55\".",
  ].join("\n");
  const result = await createAppMessageSchedule({
    messageId: "unsafe/message id:1",
    targetTaskId: "019f9e29-b221-7d22-9fe8-6e8ad7c63f43",
    text,
    nowMs,
    automationRoot: root,
  });

  assert.match(
    result.automationId,
    /^codex-small-loop-message-[a-f0-9]{32,64}$/,
  );
  assert.equal(
    result.file,
    path.join(root, result.automationId, "automation.toml"),
  );
  assert.equal(result.created, true);

  const source = await readFile(result.file, "utf8");
  const metadata = await stat(result.file);
  assert.equal(metadata.isFile(), true);
  if (process.platform !== "win32") {
    assert.equal(metadata.mode & 0o777, 0o600);
  }
  assert.deepEqual(
    await readdir(path.dirname(result.file)),
    ["automation.toml"],
  );

  assert.equal(tomlInteger(source, "version"), 1);
  assert.equal(tomlString(source, "id"), result.automationId);
  assert.equal(tomlString(source, "kind"), "heartbeat");
  assert.equal(tomlString(source, "status"), "ACTIVE");
  assert.equal(
    tomlString(source, "rrule"),
    "RRULE:FREQ=MINUTELY;INTERVAL=1",
  );
  assert.equal(
    tomlString(source, "target_thread_id"),
    "019f9e29-b221-7d22-9fe8-6e8ad7c63f43",
  );
  assert.equal(tomlInteger(source, "created_at"), nowMs - 60_000);
  assert.equal(tomlInteger(source, "updated_at"), nowMs - 60_000);

  assert.equal(
    tomlString(source, "prompt"),
    text,
  );

  const inspection = await inspectAppMessageSchedule({
    messageId: "unsafe/message id:1",
    automationRoot: root,
  });
  assert.equal(inspection.present, true);
  assert.equal(inspection.automationId, result.automationId);
  assert.equal(inspection.file, result.file);
});

test("re-materializes the same exact prompt idempotently", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "codex-small-loop-app-message-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const input = {
    messageId: "message-1",
    targetTaskId: "target-task",
    text: "Exact message text.",
    nowMs: Date.UTC(2026, 6, 27, 4, 20, 0),
    automationRoot: root,
  };
  const first = await createAppMessageSchedule(input);
  const firstSource = await readFile(first.file, "utf8");
  const second = await createAppMessageSchedule({
    ...input,
    nowMs: input.nowMs + 30_000,
  });
  const secondSource = await readFile(second.file, "utf8");

  assert.equal(second.automationId, first.automationId);
  assert.equal(second.file, first.file);
  assert.equal(second.created, false);
  assert.equal(secondSource, firstSource);
  assert.equal(tomlString(secondSource, "prompt"), input.text);
});

test("reports a deterministic missing schedule without creating it", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "codex-small-loop-app-message-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await inspectAppMessageSchedule({
    messageId: "missing-message",
    automationRoot: root,
  });
  const second = await inspectAppMessageSchedule({
    messageId: "missing-message",
    automationRoot: root,
  });

  assert.equal(first.present, false);
  assert.equal(first.automationId, second.automationId);
  assert.match(
    first.automationId,
    /^codex-small-loop-message-[a-f0-9]{32,64}$/,
  );
  assert.equal(
    first.file,
    path.join(root, first.automationId, "automation.toml"),
  );
  await assert.rejects(stat(first.file), { code: "ENOENT" });
});

test("removes only the exact schedule addressed to the receiving Task", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "codex-small-loop-app-message-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const created = await createAppMessageSchedule({
    messageId: "message-to-delete",
    targetTaskId: "receiving-task",
    text: "Exact message text.",
    nowMs: Date.UTC(2026, 6, 27, 4, 20, 0),
    automationRoot: root,
  });

  await assert.rejects(
    removeAppMessageSchedule({
      scheduleId: created.automationId,
      targetTaskId: "different-task",
      automationRoot: root,
    }),
    { code: "APP_MESSAGE_SCHEDULE_TARGET_MISMATCH" },
  );
  assert.equal((await stat(created.file)).isFile(), true);

  const removed = await removeAppMessageSchedule({
    scheduleId: created.automationId,
    targetTaskId: "receiving-task",
    automationRoot: root,
  });
  assert.equal(removed.removed, true);
  await assert.rejects(stat(created.file), { code: "ENOENT" });
  await assert.rejects(stat(path.dirname(created.file)), { code: "ENOENT" });

  const repeated = await removeAppMessageSchedule({
    scheduleId: created.automationId,
    targetTaskId: "receiving-task",
    automationRoot: root,
  });
  assert.equal(repeated.removed, false);
});
