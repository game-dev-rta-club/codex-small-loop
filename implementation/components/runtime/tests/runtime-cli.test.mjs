import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { runRuntimeCli } from "../../commands/runtime.mjs";

function output() {
  const values = [];
  return {
    values,
    stream: { write(value) { values.push(JSON.parse(value)); } },
  };
}

test("runs status and repair without Automation arguments", async () => {
  const project = path.resolve("project");
  for (const command of ["status", "repair"]) {
    const capture = output();
    let received;
    const options = {
      cwd: project,
      stdout: capture.stream,
      inspect: async (projectRoot) => {
        received = { projectRoot };
        return { run: "ok" };
      },
      repair: async (projectRoot) => {
        received = { projectRoot };
        return { run: "ok" };
      },
    };

    assert.equal(await runRuntimeCli([command], options), 0);
    assert.deepEqual(received, { projectRoot: project });
    assert.equal(capture.values[0].run, "ok");
  }
});

test("runs the host-level runtime doctor without a project root", async () => {
  const capture = output();
  let calls = 0;
  assert.equal(await runRuntimeCli(["doctor"], {
    stdout: capture.stream,
    doctor: async () => {
      calls += 1;
      return { run: "ok", platform: "win32" };
    },
  }), 0);
  assert.equal(calls, 1);
  assert.deepEqual(capture.values[0], { run: "ok", platform: "win32" });

  const invalid = output();
  assert.equal(await runRuntimeCli([
    "doctor",
    "--project-root",
    "/project",
  ], { stdout: invalid.stream }), 1);
  assert.equal(invalid.values[0].code, "RUNTIME_CLI_USAGE");
});

test("supports one explicit project root and rejects Automation options", async () => {
  const capture = output();
  let projectRoot;
  const workspace = path.resolve("workspace", "current");
  assert.equal(await runRuntimeCli([
    "status",
    "--project-root",
    "../target",
  ], {
    cwd: workspace,
    stdout: capture.stream,
    inspect: async (value) => {
      projectRoot = value;
      return { run: "ok" };
    },
  }), 0);
  assert.equal(projectRoot, path.resolve(workspace, "..", "target"));

  const invalid = output();
  assert.equal(await runRuntimeCli([
    "status",
    "--automation-id",
    "old",
  ], {
    cwd: path.resolve("project"),
    stdout: invalid.stream,
  }), 1);
  assert.equal(invalid.values[0].code, "RUNTIME_CLI_USAGE");
});

test("returns bounded runtime failures", async () => {
  const capture = output();
  const message = "x".repeat(700);
  assert.equal(await runRuntimeCli(["repair"], {
    cwd: path.resolve("project"),
    stdout: capture.stream,
    repair: async () => {
      throw Object.assign(new Error(message), { code: "REPAIR_FAILED" });
    },
  }), 1);
  assert.equal(capture.values[0].code, "REPAIR_FAILED");
  assert.ok(capture.values[0].message.length <= 512);
});
