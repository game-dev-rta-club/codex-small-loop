import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  runSignalCli,
} from "../../commands/signal.mjs";

const snapshot = "a".repeat(40);
const PROJECT_ROOT = path.resolve("/workspace/project");

function capture() {
  let output = "";
  return {
    write(chunk) {
      output += chunk;
    },
    text() {
      return output;
    },
    json() {
      return JSON.parse(output);
    },
  };
}

test("creates a Review Signal with explicit identifiers", async () => {
  const stdout = capture();
  const calls = [];
  const exitCode = await runSignalCli([
    "create",
    "--task",
    "primary-task-1",
    "--snapshot",
    snapshot,
    "--name",
    "role-provenance",
    "--template",
    "review-signal",
  ], {
    cwd: "/workspace/project",
    stdout,
    async create(input) {
      calls.push(input);
      return {
        run: "ok",
        operation: "signal-create",
        relativeFile:
          `.codex-small-loop/signals/primary-task-1/${snapshot}/role-provenance.md`,
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{
    primaryTaskId: "primary-task-1",
    currentSnapshot: snapshot,
    signalName: "role-provenance",
    templateName: "review-signal",
    projectRoot: PROJECT_ROOT,
  }]);
  assert.equal(
    stdout.text(),
    `Created: .codex-small-loop/signals/primary-task-1/${snapshot}/role-provenance.md\n`,
  );
});

test("emits JSON only when create receives --json", async () => {
  const stdout = capture();
  const result = {
    run: "ok",
    operation: "signal-create",
    primaryTaskId: "primary-task-1",
    currentSnapshot: snapshot,
    signalName: "role-provenance",
    relativeFile:
      `.codex-small-loop/signals/primary-task-1/${snapshot}/role-provenance.md`,
  };
  const exitCode = await runSignalCli([
    "create",
    "--task",
    "primary-task-1",
    "--snapshot",
    snapshot,
    "--name",
    "role-provenance",
    "--template",
    "review-signal",
    "--json",
  ], {
    cwd: "/workspace/project",
    stdout,
    async create() {
      return result;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(stdout.json(), result);
});

test("sets one Signal severity with explicit identity", async () => {
  const stdout = capture();
  const calls = [];
  const exitCode = await runSignalCli([
    "set-severity",
    "--task",
    "primary-task-1",
    "--snapshot",
    snapshot,
    "--name",
    "incorrect-total",
    "--severity",
    "required",
  ], {
    cwd: "/workspace/project",
    stdout,
    async setSeverity(input) {
      calls.push(input);
      return {
        run: "ok",
        operation: "signal-set-severity",
        severity: "required",
        relativeFile:
          `.codex-small-loop/signals/primary-task-1/${snapshot}/incorrect-total.md`,
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{
    primaryTaskId: "primary-task-1",
    currentSnapshot: snapshot,
    signalName: "incorrect-total",
    severity: "required",
    projectRoot: PROJECT_ROOT,
  }]);
  assert.equal(
    stdout.text(),
    `Severity: .codex-small-loop/signals/primary-task-1/${snapshot}/incorrect-total.md (REQUIRED)\n`,
  );
});

test("requires complete set-severity arguments and rejects decide", async () => {
  for (const argv of [
    ["set-severity"],
    [
      "set-severity",
      "--task",
      "primary-task-1",
      "--snapshot",
      snapshot,
      "--name",
      "incorrect-total",
    ],
    [
      "set-severity",
      "--task",
      "primary-task-1",
      "--snapshot",
      snapshot,
      "--name",
      "incorrect-total",
      "--severity",
      "required",
      "--decision",
      "old argument",
    ],
    ["decide"],
  ]) {
    const stdout = capture();
    let called = false;
    const exitCode = await runSignalCli(argv, {
      cwd: "/workspace/project",
      stdout,
      async setSeverity() {
        called = true;
      },
    });
    assert.equal(exitCode, 1);
    assert.equal(called, false);
    assert.match(stdout.text(), /^Signal command failed \[SIGNAL_CLI_USAGE\]:/);
  }
});

test("rejects missing, repeated, and unsupported create arguments", async () => {
  const cases = [
    [],
    ["create"],
    ["create", "--task", "primary-task-1", "--snapshot", snapshot],
    [
      "create",
      "--task",
      "primary-task-1",
      "--snapshot",
      snapshot,
      "--name",
      "one",
      "--template",
      "review-signal",
      "--name",
      "two",
    ],
    [
      "create",
      "--task",
      "primary-task-1",
      "--snapshot",
      snapshot,
      "--name",
      "one",
      "--template",
      "review-signal",
      "--unknown",
    ],
  ];

  for (const argv of cases) {
    const stdout = capture();
    let called = false;
    const exitCode = await runSignalCli(argv, {
      cwd: "/workspace/project",
      stdout,
      async create() {
        called = true;
      },
    });
    assert.equal(exitCode, 1);
    assert.equal(called, false);
    assert.match(stdout.text(), /^Signal command failed \[SIGNAL_CLI_USAGE\]:/);
  }
});

test("lists Review Signals by severity without disposition", async () => {
  const stdout = capture();
  const calls = [];
  const result = {
    run: "ok",
    operation: "signal-list",
    primaryTaskId: "primary-task-1",
    currentSnapshot: snapshot,
    directory: `.codex-small-loop/signals/primary-task-1/${snapshot}`,
    signals: [
      {
        template: "review-signal",
        severity: "required",
        summary: "Runtime API exposes project metadata",
        file: "api-project-metadata.md",
      },
      {
        template: "review-signal",
        severity: "consider",
        summary: "Infrequent compatibility risk",
        file: "future-compatibility.md",
      },
      {
        template: "review-signal",
        severity: "dismiss",
        summary: "Imperceptible opportunity",
        file: "minor-opportunity.md",
      },
    ],
  };

  const exitCode = await runSignalCli([
    "list",
    "--task",
    "primary-task-1",
    "--snapshot",
    snapshot,
  ], {
    cwd: "/workspace/project",
    stdout,
    async list(input) {
      calls.push(input);
      return result;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{
    primaryTaskId: "primary-task-1",
    currentSnapshot: snapshot,
    projectRoot: PROJECT_ROOT,
  }]);
  assert.equal(
    stdout.text(),
    [
      `Directory: .codex-small-loop/signals/primary-task-1/${snapshot}/`,
      "",
      "SEVERITY  SUMMARY                               FILE",
      "REQUIRED  Runtime API exposes project metadata  api-project-metadata.md",
      "CONSIDER  Infrequent compatibility risk         future-compatibility.md",
      "DISMISS   Imperceptible opportunity             minor-opportunity.md",
      "",
    ].join("\n"),
  );
});

test("prints a compact successful result when no Signals exist", async () => {
  const stdout = capture();
  const exitCode = await runSignalCli([
    "list",
    "--task",
    "primary-task-empty",
    "--snapshot",
    snapshot,
  ], {
    cwd: "/workspace/project",
    stdout,
    async list() {
      return {
        run: "ok",
        operation: "signal-list",
        primaryTaskId: "primary-task-empty",
        currentSnapshot: snapshot,
        directory: `.codex-small-loop/signals/primary-task-empty/${snapshot}`,
        signals: [],
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(
    stdout.text(),
    [
      `Directory: .codex-small-loop/signals/primary-task-empty/${snapshot}/`,
      "",
      "No signals.",
      "",
    ].join("\n"),
  );
});

test("emits the structured list only when list receives --json", async () => {
  const stdout = capture();
  const result = {
    run: "ok",
    operation: "signal-list",
    primaryTaskId: "primary-task-1",
    currentSnapshot: snapshot,
    directory: `.codex-small-loop/signals/primary-task-1/${snapshot}`,
    signals: [],
  };
  const exitCode = await runSignalCli([
    "list",
    "--task",
    "primary-task-1",
    "--snapshot",
    snapshot,
    "--json",
  ], {
    cwd: "/workspace/project",
    stdout,
    async list() {
      return result;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(stdout.json(), result);
});

test("requires exactly task and snapshot identifiers for list", async () => {
  for (const argv of [
    ["list"],
    ["list", "--task", "primary-task-1"],
    ["list", "--snapshot", snapshot],
    [
      "list",
      "--task",
      "primary-task-1",
      "--snapshot",
      snapshot,
      "--name",
      "not-a-filter",
    ],
  ]) {
    const stdout = capture();
    let called = false;
    const exitCode = await runSignalCli(argv, {
      cwd: "/workspace/project",
      stdout,
      async list() {
        called = true;
      },
    });
    assert.equal(exitCode, 1);
    assert.equal(called, false);
    assert.match(stdout.text(), /^Signal command failed \[SIGNAL_CLI_USAGE\]:/);
  }
});
