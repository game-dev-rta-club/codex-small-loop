import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { resolveProject } from "../../runtime/source/project.mjs";
import { readSonnerProject } from "../source/sonner-project-reader.mjs";

const exec = promisify(execFile);
const platforms = process.platform === "darwin" ? ["darwin", "win32"] : ["win32"];
for (const platform of platforms) {
  test(`${platform}: Work and Files share Git ignore rules, including nested exceptions and tracked files`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sonner-ignore-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const git = (...args) => exec("git", ["-C", root, ...args]);
    const write = async (name, content = "<work-node/>") => {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), content);
    };
    await git("init", "--quiet");
    await write(".gitignore", "/Library/\n/Generated/*\n!/Generated/keep/\n/hidden/.WORK_NODE.xml\n");
    await write(".git/info/exclude", "/LocalOnly/\n");
    await write("Docs/.gitignore", "scratch/\n*.xml\n!.WORK_NODE.xml\n");
    const visible = [".WORK_NODE.xml", "Docs/.WORK_NODE.xml", "Generated/keep/.WORK_NODE.xml", "Library/tracked/.WORK_NODE.xml"];
    const ignored = ["Library/generated/.WORK_NODE.xml", "Library/generated/WORK_NODE.xml", "Generated/drop/.WORK_NODE.xml",
      "Docs/scratch/.WORK_NODE.xml", "Docs/WORK_NODE.xml", "hidden/.WORK_NODE.xml", "LocalOnly/.WORK_NODE.xml"];
    for (const name of [...visible, ...ignored]) await write(name);
    await write("hidden/readme.md", "Ordinary admitted file beside an ignored marker.");
    await git("add", "--force", "Library/tracked/.WORK_NODE.xml");
    const project = await resolveProject(root);
    for (const includeFiles of [true, false]) {
      const result = await readSonnerProject({ project, platform, includeFiles, timeoutMs: 30000 });
      assert.deepEqual(result.works.map((work) => work.relativePath), visible);
      assert.deepEqual(result.legacyWorkNodes, []);
      assert.equal(result.workUnsafe, false);
      assert.ok(result.entries.every((entry) => !ignored.includes(entry.path)));
      if (!includeFiles) assert.deepEqual(result.entries, []);
    }
    // Corrupt repository metadata must fail, never trigger a full-tree fallback.
    await rm(path.join(root, ".git"), { recursive: true, force: true });
    await write(".git", "not a valid gitfile");
    await assert.rejects(readSonnerProject({ project, platform, includeFiles: false }));
  });
}
