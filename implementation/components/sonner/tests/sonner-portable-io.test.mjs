import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { resolveProject } from "../../runtime/source/project.mjs";
import { buildSonnerProject } from "../source/sonner.mjs";

const execFileAsync = promisify(execFile);

test("Win32 portable Sonner publishes Work Graph, Files, and bounded Runtime without Mach-O helpers", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-sonner-win32-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet", root]);
  await mkdir(path.join(root, "overview"));
  await writeFile(path.join(root, "overview", "WORK_NODE.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<work-node id="overview" type="Overview">
  <summary>Defines the portable project.</summary>
  <inputs>
  </inputs>
</work-node>
`);
  await writeFile(path.join(root, "README.md"), "---\nsummary: Portable summary.\n---\n\nBody is never projected.\n");
  await execFileAsync("git", ["-C", root, "add", "overview/WORK_NODE.xml", "README.md"]);
  const marker = path.join(root, "fsmonitor-ran");
  const fsmonitor = path.join(root, "fsmonitor.sh");
  await writeFile(fsmonitor, `#!/bin/sh\ntouch '${marker}'\nprintf '{}\\n'\n`, "utf8");
  await chmod(fsmonitor, 0o700);
  await execFileAsync("git", ["-C", root, "config", "core.fsmonitor", fsmonitor]);

  const projection = await buildSonnerProject(await resolveProject(root), {
    readerOptions: {
      platform: "win32",
      environment: {
        ...process.env,
        GIT_DIR: path.join(root, "attacker.git"),
        GIT_WORK_TREE: path.dirname(root),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.excludesfile",
        GIT_CONFIG_VALUE_0: path.join(root, "attacker-excludes"),
      },
    },
  });

  assert.equal(projection.version, 8);
  assert.equal(projection.workGraph.status, "valid");
  assert.deepEqual(projection.workGraph.works.map(({ id }) => id), ["overview"]);
  assert.equal(projection.runtime.status, "missing");
  const readme = projection.files.root.children.find(({ path: entryPath }) => entryPath === "README.md");
  assert.equal(readme.type, "file");
  assert.equal(readme.summary, "Portable summary.");
  await assert.rejects(access(marker), (error) => error.code === "ENOENT");
});
