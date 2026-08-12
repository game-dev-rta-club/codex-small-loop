import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { runSnapshotCli } from "../../commands/snapshot.mjs";

const execFileAsync = promisify(execFile);
const CURRENT_ROOT = path.resolve("/workspace/current");
const TARGET_ROOT = path.resolve("/workspace/current", "../target");

function capture() {
  let output = "";
  return {
    write(chunk) {
      output += chunk;
    },
    json() {
      assert.equal(output.endsWith("\n"), true);
      assert.equal(output.trim().split("\n").length, 1);
      return JSON.parse(output);
    },
  };
}

test("creates a review snapshot for an explicit Primary Task and project", async () => {
  const stdout = capture();
  const calls = [];
  const exitCode = await runSnapshotCli([
    "create",
    "--task",
    "primary-task-1",
    "--project-root",
    "../target",
  ], {
    cwd: "/workspace/current",
    stdout,
    async create(input) {
      calls.push(input);
      return {
        run: "ok",
        operation: "snapshot-create",
        currentSnapshot: "abc123",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{
    primaryTaskId: "primary-task-1",
    projectRoot: TARGET_ROOT,
    forceNew: false,
  }]);
  assert.deepEqual(stdout.json(), {
    run: "ok",
    operation: "snapshot-create",
    currentSnapshot: "abc123",
  });
});

test("defaults the project root to cwd", async () => {
  const stdout = capture();
  let received;
  const exitCode = await runSnapshotCli([
    "create",
    "--task",
    "primary-task-1",
  ], {
    cwd: "/workspace/current",
    stdout,
    async create(input) {
      received = input;
      return { run: "ok", operation: "snapshot-create" };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(received.projectRoot, CURRENT_ROOT);
  assert.equal(received.forceNew, false);
});

test("passes an explicit force-new Review pass flag", async () => {
  const stdout = capture();
  let received;
  const exitCode = await runSnapshotCli([
    "create",
    "--task",
    "primary-task-1",
    "--force-new",
  ], {
    cwd: "/workspace/current",
    stdout,
    async create(input) {
      received = input;
      return { run: "ok", operation: "snapshot-create" };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(received.forceNew, true);
});

test("rejects unsupported, missing, repeated, and malformed arguments", async () => {
  const cases = [
    { argv: [], code: "SNAPSHOT_CLI_USAGE" },
    { argv: ["list"], code: "SNAPSHOT_CLI_USAGE" },
    { argv: ["create"], code: "PRIMARY_TASK_REQUIRED" },
    {
      argv: ["create", "--task", "contains whitespace"],
      code: "PRIMARY_TASK_INVALID",
    },
    {
      argv: ["create", "--task", "one", "--task", "two"],
      code: "SNAPSHOT_CLI_USAGE",
    },
    {
      argv: ["create", "--task"],
      code: "SNAPSHOT_CLI_USAGE",
    },
    {
      argv: ["create", "--task", "one", "--unknown", "value"],
      code: "SNAPSHOT_CLI_USAGE",
    },
    {
      argv: ["create", "--task", "one", "--force-new", "--force-new"],
      code: "SNAPSHOT_CLI_USAGE",
    },
  ];

  for (const current of cases) {
    const stdout = capture();
    let called = false;
    const exitCode = await runSnapshotCli(current.argv, {
      cwd: "/workspace/current",
      stdout,
      async create() {
        called = true;
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(called, false);
    assert.equal(stdout.json().code, current.code);
  }
});

test("returns bounded structured failures", async () => {
  const stdout = capture();
  const exitCode = await runSnapshotCli([
    "create",
    "--task",
    "primary-task-1",
  ], {
    cwd: "/workspace/current",
    stdout,
    async create() {
      throw Object.assign(new Error("x".repeat(700)), {
        code: "REVIEW_SNAPSHOT_FAILED",
      });
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.json().code, "REVIEW_SNAPSHOT_FAILED");
  assert.ok(stdout.json().message.length <= 512);
});

test("the executable creates a real snapshot and emits one machine-readable result", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "csl-snapshot-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", [
    "-C",
    root,
    "config",
    "user.name",
    "Codex Small Loop Test",
  ]);
  execFileSync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "codex-small-loop@example.invalid",
  ]);
  await writeFile(path.join(root, "candidate.txt"), "baseline\n");
  execFileSync("git", ["-C", root, "add", "candidate.txt"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "baseline"]);
  await writeFile(path.join(root, "candidate.txt"), "review candidate\n");

  const command = new URL("../../commands/snapshot.mjs", import.meta.url);
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    fileURLToPath(command),
    "create",
    "--task",
    "primary-cli-integration",
    "--project-root",
    root,
  ], {
    encoding: "utf8",
  });

  assert.equal(stderr, "");
  assert.equal(stdout.trim().split("\n").length, 1);
  const result = JSON.parse(stdout);
  assert.equal(result.run, "ok");
  assert.equal(result.created, true);
  assert.equal(
    execFileSync(
      "git",
      ["-C", root, "show", `${result.currentSnapshot}:candidate.txt`],
      { encoding: "utf8" },
    ).trim(),
    "review candidate",
  );
});
