import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveProject } from "../source/project.mjs";
import {
  assertRuntimeAvailable,
  inspectProjectRuntime,
  prepareProjectRuntime,
  repairProjectRuntime,
} from "../source/project-setup.mjs";

async function withProject(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "whole-job-runtime-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("initializes a project-local runtime without Codex Automation", async () => {
  await withProject(async (root) => {
    const project = await resolveProject(root);
    const result = await assertRuntimeAvailable(project, {
      now: "2026-07-27T00:00:00.000Z",
    });

    assert.equal(result.project.root, project.root);
    assert.equal(
      JSON.parse(await readFile(project.stateFile, "utf8")).version,
      10,
    );
    await assert.rejects(readFile(
      path.join(project.directory, "automation.toml"),
      "utf8",
    ), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(
      path.join(project.directory, "message-automation.toml"),
      "utf8",
    ), {
      code: "ENOENT",
    });
  });
});

test("creates the runtime automatically on first use", async () => {
  await withProject(async (root) => {
    const project = await resolveProject(root);
    const runtime = await assertRuntimeAvailable(project, {
      now: "2026-07-27T00:00:00.000Z",
    });

    assert.equal(runtime.project.root, project.root);
    assert.deepEqual(runtime.ledger.links, []);
    assert.match(await readFile(path.join(root, ".gitignore"), "utf8"),
      /\/\.codex-small-loop\//);
  });
});

test("adds the private runtime without rewriting existing gitignore layout", async () => {
  await withProject(async (root) => {
    const gitignore = path.join(root, ".gitignore");
    await writeFile(gitignore, "# Generated files\n\nbuild/\n", "utf8");
    const project = await resolveProject(root);

    await prepareProjectRuntime(project);

    assert.equal(
      await readFile(gitignore, "utf8"),
      "# Generated files\n\nbuild/\n/.codex-small-loop/\n",
    );
  });
});

test("rejects a pre-existing private runtime link or junction", async (t) => {
  await withProject(async (root) => {
    const external = await mkdtemp(path.join(os.tmpdir(), "whole-job-runtime-external-"));
    t.after(() => rm(external, { recursive: true, force: true }));
    const project = await resolveProject(root);
    try {
      await symlink(
        external,
        project.directory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("link creation is unavailable for this Windows account");
        return;
      }
      throw error;
    }
    await assert.rejects(
      prepareProjectRuntime(project),
      (error) => error?.code === "PROJECT_RUNTIME_DIRECTORY_UNSAFE",
    );
  });
});

test("repairs stale terminal data without creating Automation files", async () => {
  await withProject(async (root) => {
    const project = await resolveProject(root);
    await assertRuntimeAvailable(project, {
      now: "2026-07-27T00:00:00.000Z",
    });
    const automationFile = path.join(project.directory, "automation.toml");
    const messageAutomationFile = path.join(
      project.directory,
      "message-automation.toml",
    );
    await writeFile(automationFile, "legacy");
    await writeFile(messageAutomationFile, "legacy");

    const result = await repairProjectRuntime(root, {
      now: "2026-07-27T00:01:00.000Z",
    });

    assert.equal(result.run, "ok");
    assert.equal(result.inspection.readiness, "ready");
    await assert.rejects(readFile(automationFile, "utf8"), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(messageAutomationFile, "utf8"), {
      code: "ENOENT",
    });
  });
});

test("reports setup_required before explicit inspection initialization", async () => {
  await withProject(async (root) => {
    const result = await inspectProjectRuntime(root);
    assert.equal(result.run, "degraded");
    assert.equal(result.readiness, "setup_required");
    assert.equal(result.configured, false);
  });
});

test("reports the latest Recovery Supervisor failure through runtime status", async () => {
  await withProject(async (root) => {
    const project = await resolveProject(root);
    await assertRuntimeAvailable(project, {
      now: "2026-07-27T00:00:00.000Z",
    });
    await writeFile(path.join(
      root,
      ".codex-small-loop",
      "recovery-supervisor-error.json",
    ), `${JSON.stringify({
      version: 1,
      code: "HEARTBEAT_BROKEN",
      message: "Heartbeat could not read one task.",
      consecutiveFailures: 2,
      updatedAt: "2026-07-27T00:01:00.000Z",
      events: [{
        type: "recovery_degraded",
        taskIds: ["task-1"],
        reason: "conversation-state-missing",
      }],
    })}\n`, "utf8");

    const result = await inspectProjectRuntime(root);

    assert.equal(result.run, "degraded");
    assert.equal(result.readiness, "repair_required");
    assert.deepEqual(result.issues, [{
      code: "RECOVERY_SUPERVISOR_HEARTBEAT_FAILED",
      message: "Heartbeat could not read one task.",
      details: {
        causeCode: "HEARTBEAT_BROKEN",
        consecutiveFailures: 2,
        updatedAt: "2026-07-27T00:01:00.000Z",
        events: [{
          type: "recovery_degraded",
          taskIds: ["task-1"],
          reason: "conversation-state-missing",
        }],
      },
    }]);
  });
});

test("repair does not claim readiness while a Supervisor failure remains", async () => {
  await withProject(async (root) => {
    const project = await resolveProject(root);
    await assertRuntimeAvailable(project, {
      now: "2026-07-27T00:00:00.000Z",
    });
    await writeFile(path.join(
      project.directory,
      "recovery-supervisor-error.json",
    ), `${JSON.stringify({
      version: 1,
      code: "HEARTBEAT_BROKEN",
      message: "Heartbeat still needs attention.",
      consecutiveFailures: 1,
      updatedAt: "2026-07-27T00:01:00.000Z",
    })}\n`, "utf8");

    const result = await repairProjectRuntime(root, {
      now: "2026-07-27T00:02:00.000Z",
    });

    assert.equal(result.run, "degraded");
    assert.equal(result.inspection.readiness, "repair_required");
    assert.equal(
      result.issues[0].code,
      "RECOVERY_SUPERVISOR_HEARTBEAT_FAILED",
    );
  });
});
