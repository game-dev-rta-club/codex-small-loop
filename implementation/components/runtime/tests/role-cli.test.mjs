import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  runRoleCli,
} from "../../commands/role.mjs";

function capture() {
  let output = "";
  return {
    stream: { write(chunk) { output += chunk; } },
    text() { return output; },
  };
}

async function withRoles(run) {
  const root = await mkdtemp(path.join(tmpdir(), "codex-small-loop-role-"));
  try {
    const roleDirectory = path.join(root, "controller");
    await mkdir(roleDirectory, { recursive: true });
    await writeFile(
      path.join(roleDirectory, "role.md"),
      "# Controller\r\n\r\nComplete role.\r\n",
    );
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("loads the complete selected role as model-readable Markdown", async () => {
  await withRoles(async (rolesRoot) => {
    const stdout = capture();
    const stderr = capture();

    assert.equal(await runRoleCli(["controller"], {
      rolesRoot,
      stdout: stdout.stream,
      stderr: stderr.stream,
    }), 0);
    assert.equal(stdout.text(), "# Controller\n\nComplete role.\n");
    assert.equal(stderr.text(), "");
  });
});

test("rejects unsafe and missing role names without reading outside roles", async () => {
  await withRoles(async (rolesRoot) => {
    for (const [role, code] of [
      ["../controller", "ROLE_NAME_INVALID"],
      ["missing", "ROLE_NOT_FOUND"],
    ]) {
      const stdout = capture();
      const stderr = capture();
      assert.equal(await runRoleCli([role], {
        rolesRoot,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }), 1);
      assert.equal(stdout.text(), "");
      assert.equal(JSON.parse(stderr.text()).code, code);
    }
  });
});

test("installed role command loads the Controller role directly", () => {
  const command = fileURLToPath(new URL("../../commands/role.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [command, "controller"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^---\nsummary:/);
  assert.match(result.stdout, /# Controller Job Role/);
  assert.equal(result.stderr, "");
});
