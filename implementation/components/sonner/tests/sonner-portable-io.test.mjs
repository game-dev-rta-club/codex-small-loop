import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { resolveProject } from "../../runtime/source/project.mjs";
import { buildSonnerProject, loadWorkGraph } from "../source/sonner.mjs";
import {
  detectPortableSonnerPath,
  readPortableSonnerRegularFile,
} from "../source/sonner-portable-io.mjs";
import {
  openSonnerProjectReadSession,
} from "../source/sonner-project-reader.mjs";

const execFileAsync = promisify(execFile);

test("Win32 portable Sonner separates path detection from regular file reading", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-sonner-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "README.md"), "portable\n");
  const project = await resolveProject(root);
  const session = await openSonnerProjectReadSession(project, { platform: "win32" });
  t.after(() => session.close());

  assert.equal(await detectPortableSonnerPath(session, "README.md"), "regular-file");
  assert.equal(
    await detectPortableSonnerPath(session, "README.md", {
      lstatPath: async () => ({
        isFile: () => false,
        isSymbolicLink: () => true,
      }),
    }),
    "symlink",
  );
  assert.equal(
    (await readPortableSonnerRegularFile(session, "README.md", 64)).toString("utf8"),
    "portable\n",
  );
});

test("Win32 portable Sonner publishes Work Graph, Files, and bounded Runtime without Mach-O helpers", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-sonner-win32-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet", root]);
  await mkdir(path.join(root, "overview"));
  await writeFile(path.join(root, "overview", ".WORK_NODE.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<work-node id="overview" type="Overview">
  <keyPoints>Defines the portable project.</keyPoints>
  <inputs>
  </inputs>
</work-node>
`);
  await writeFile(path.join(root, "overview", "WORK_NODE.xml"), "legacy marker contents are not read\n");
  await writeFile(path.join(root, ".gitignore"), "Library/\n");
  await writeFile(path.join(root, "README.md"), "---\nkeyPoints: Portable keyPoints.\n---\n\nBody is never projected.\n");
  await writeFile(path.join(root, "image.unknown"), Buffer.concat([
    Buffer.from([1, 2, 0, 3]),
    Buffer.alloc(1024, 0xff),
  ]));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "generated.md"), "---\nkeyPoints: Generated output.\n---\n");
  await execFileAsync("git", ["-C", root, "add", ".gitignore", "README.md", "image.unknown", "dist/generated.md"]);
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

  assert.equal(projection.version, 13);
  assert.equal(projection.workGraph.status, "valid");
  assert.deepEqual(projection.workGraph.works.map(({ id }) => id), ["overview"]);
  assert.deepEqual(projection.files.root.children.find(({ path: entryPath }) => entryPath === "overview").children, [{
    path: "overview/WORK_NODE.xml",
    name: "WORK_NODE.xml",
    type: "warning",
    code: "legacy-work-node",
    renameTo: "overview/.WORK_NODE.xml",
  }, { type: "file-counts", counts: [{ extension: "xml", count: 1 }] }]);
  assert.equal(projection.runtime.status, "missing");
  const readme = projection.files.root.children.find(({ path: entryPath }) => entryPath === "README.md");
  assert.equal(readme.type, "file");
  assert.equal(readme.keyPoints, "Portable keyPoints.");
  assert.deepEqual(projection.files.root.children.find(({ type }) => type === "file-counts"), {
    type: "file-counts",
    counts: [
      { extension: null, count: 1 },
      { extension: "sh", count: 1 },
      { extension: "unknown", count: 1 },
    ],
  });
  assert.equal(projection.files.root.children.some(({ path: entryPath }) => entryPath === "dist"), false);
  await assert.rejects(access(marker), (error) => error.code === "ENOENT");
});

test("Win32 portable Sonner discovers Work Graph without a Git repository", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-sonner-work-win32-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "overview"));
  await writeFile(path.join(root, "overview", ".WORK_NODE.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<work-node id="overview" type="Overview">
  <keyPoints>Defines a non-Git portable project.</keyPoints>
  <inputs>
  </inputs>
</work-node>
`);

  const works = await loadWorkGraph(root, { readerOptions: { platform: "win32" } });

  assert.deepEqual(works.map(({ id }) => id), ["overview"]);
});
