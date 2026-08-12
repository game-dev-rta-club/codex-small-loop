import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { resolveProject } from "../../runtime/source/project.mjs";
import { encodeSonnerOpenRequest, openSonnerFileReference } from "../source/sonner-open-file.mjs";

const execFileAsync = promisify(execFile);
const source = path.resolve("implementation/components/board/native/sonner-open-file.c");

async function compileHelper(directory) {
  const helper = path.join(directory, "sonner-open-file-test");
  await execFileAsync("clang", ["-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", "-DSONNER_OPEN_FILE_TEST_HOOKS",
    source, "-framework", "CoreFoundation", "-framework", "CoreServices", "-o", helper]);
  return helper;
}

async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-sonner-open-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "project");
  await mkdir(path.join(root, "overview"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "authorized\n");
  await writeFile(path.join(root, "overview/WORK_NODE.xml"), "<work-node />\n");
  await execFileAsync("git", ["-C", root, "init", "-q"]);
  await execFileAsync("git", ["-C", root, "add", "README.md", "overview/WORK_NODE.xml"]);
  return { parent, root, project: await resolveProject(root), helper: await compileHelper(parent) };
}

const options = (helper, onTransition) => ({ helperPath: helper, validateArchitecture: false, onTransition });

test("Windows Open fails with a bounded typed result before touching the Mach-O helper", async () => {
  let spawned = false;
  await assert.rejects(
    openSonnerFileReference({ rootIdentity: { dev: 1n, ino: 2n } }, "README.md", {
      platform: "win32",
      spawnImpl: () => { spawned = true; throw new Error("must not spawn"); },
    }),
    (error) => error.code === "SONNER_FILE_OPEN_UNAVAILABLE",
  );
  assert.equal(spawned, false);
});

test("native opener binds normal files and Work directories as retained references", async (t) => {
  const item = await fixture(t);
  await writeFile(path.join(item.root, "日本語.md"), "unicode\n");
  await link(path.join(item.root, "README.md"), path.join(item.root, "alias.md"));
  for (const name of ["README.md", "overview", "overview/WORK_NODE.xml", "日本語.md", "alias.md"]) {
    await openSonnerFileReference(item.project, name, options(item.helper, async () => {}));
  }
  assert.throws(() => encodeSonnerOpenRequest(item.project, "../outside"), (error) => error.code === "SONNER_FILE_INVALID");
  assert.throws(() => encodeSonnerOpenRequest(item.project, `${"a".repeat(4090)}/file`), (error) => error.code === "SONNER_FILE_INVALID");
});

test("static ancestor and final symlinks fail without dispatch", async (t) => {
  const item = await fixture(t);
  await symlink("/etc/hosts", path.join(item.root, "final-link"));
  await symlink("/tmp", path.join(item.root, "ancestor-link"));
  for (const name of ["final-link", "ancestor-link/outside"]) {
    await assert.rejects(openSonnerFileReference(item.project, name, options(item.helper, async () => {})),
      (error) => error.code === "SONNER_FILE_INVALID" || error.code === "SONNER_FILE_CHANGED");
  }
});

test("final and ancestor transition replacements never dispatch the replacement inode", async (t) => {
  for (const phase of ["before-final-open", "during-reference-creation", "after-reference-resolution"]) {
    await t.test(phase, async (t) => {
      const item = await fixture(t); const original = path.join(item.root, "README.md"); const moved = path.join(item.parent, "original.md");
      let changed = false;
      await assert.rejects(openSonnerFileReference(item.project, "README.md", options(item.helper, async (event) => {
        if (!changed && event === phase) { changed = true; await rename(original, moved); await symlink("/etc/hosts", original); }
      })), (error) => error.code === "SONNER_FILE_INVALID" || error.code === "SONNER_FILE_CHANGED");
    });
  }

  const retained = await fixture(t); const retainedPath = path.join(retained.root, "README.md"); const retainedMoved = path.join(retained.parent, "retained-original.md"); let retainedChanged = false;
  await openSonnerFileReference(retained.project, "README.md", options(retained.helper, async (event) => {
    if (!retainedChanged && event === "after-final-retention") { retainedChanged = true; await rename(retainedPath, retainedMoved); await symlink("/etc/hosts", retainedPath); }
  }));
  assert.equal(retainedChanged, true, "the test adapter accepted only the retained original file reference");

  const retainedDirectory = await fixture(t); const directoryPath = path.join(retainedDirectory.root, "overview");
  const directoryMoved = path.join(retainedDirectory.parent, "retained-overview"); let directoryChanged = false;
  await openSonnerFileReference(retainedDirectory.project, "overview", options(retainedDirectory.helper, async (event) => {
    if (!directoryChanged && event === "after-final-retention") {
      directoryChanged = true; await rename(directoryPath, directoryMoved); await symlink("/tmp", directoryPath);
    }
  }));
  assert.equal(directoryChanged, true, "the test adapter accepted only the retained original directory reference");

  const item = await fixture(t); const ancestor = path.join(item.root, "overview"); const moved = path.join(item.parent, "overview-original");
  let changed = false;
  await assert.rejects(openSonnerFileReference(item.project, "overview/WORK_NODE.xml", options(item.helper, async (event) => {
    if (!changed && event === "before-ancestor-open") { changed = true; await rename(ancestor, moved); await symlink("/tmp", ancestor); }
  })), (error) => error.code === "SONNER_FILE_INVALID" || error.code === "SONNER_FILE_CHANGED");
});

test("replacement after verification dispatches only the retained reference or fails", async (t) => {
  for (const phase of ["after-verification-reopen", "before-launch-services"]) {
    await t.test(phase, async (t) => {
      const item = await fixture(t); const original = path.join(item.root, "README.md"); const moved = path.join(item.parent, `retained-${phase}.md`); let changed = false;
      await openSonnerFileReference(item.project, "README.md", options(item.helper, async (event) => {
        if (!changed && event === phase) { changed = true; await rename(original, moved); await symlink("/etc/hosts", original); }
      }));
      assert.equal(changed, true, "the test adapter accepted only the retained reference");
    });
  }
});

test("unlink after final retention and Root replacement before open fail closed", async (t) => {
  const unlinked = await fixture(t); let removed = false;
  await assert.rejects(openSonnerFileReference(unlinked.project, "README.md", options(unlinked.helper, async (event) => {
    if (!removed && event === "after-final-retention") { removed = true; await rm(path.join(unlinked.root, "README.md")); }
  })), (error) => error.code === "SONNER_FILE_CHANGED");

  const replaced = await fixture(t); const moved = path.join(replaced.parent, "authorized-before-open"); const other = path.join(replaced.parent, "replacement-before-open");
  await mkdir(other); await writeFile(path.join(other, "README.md"), "external\n"); let swapped = false;
  await assert.rejects(openSonnerFileReference(replaced.project, "README.md", {
    helperPath: replaced.helper, validateArchitecture: false,
    openRootImpl: async (filename, flags) => {
      if (!swapped) { swapped = true; await rename(replaced.root, moved); await rename(other, replaced.root); }
      return open(filename, flags);
    },
  }), (error) => error.code === "SONNER_FILE_OPEN_UNAVAILABLE");
  assert.equal(swapped, true);
});

test("Root replacement after descriptor retention stays on the authorized Root", async (t) => {
  const item = await fixture(t); const moved = path.join(item.parent, "authorized"); const replacement = path.join(item.parent, "replacement");
  await mkdir(replacement); await writeFile(path.join(replacement, "README.md"), "external\n"); let changed = false;
  await openSonnerFileReference(item.project, "README.md", options(item.helper, async (event) => {
    if (!changed && event === "after-final-retention") { changed = true; await rename(item.root, moved); await rename(replacement, item.root); }
  }));
  assert.equal(changed, true);
});

test("crash, malformed output, stderr overflow, and timeout fail closed", async (t) => {
  const item = await fixture(t);
  for (const [name, script, timeoutMs] of [
    ["crash", "#!/bin/sh\nexit 9\n", 500],
    ["malformed", "#!/bin/sh\nprintf bad\n", 500],
    ["stderr", `#!/bin/sh\nprintf '${"x".repeat(4097)}' >&2\n`, 500],
    ["timeout", "#!/bin/sh\nsleep 2\n", 30],
  ]) {
    const helper = path.join(item.parent, name); await writeFile(helper, script); await chmod(helper, 0o755);
    await assert.rejects(openSonnerFileReference(item.project, "README.md", { helperPath: helper, validateArchitecture: false, timeoutMs }),
      (error) => error.code === "SONNER_FILE_OPEN_UNAVAILABLE");
  }
});

test("repeated opens settle helper and Root descriptors", async (t) => {
  const item = await fixture(t);
  for (let index = 0; index < 20; index += 1) await openSonnerFileReference(item.project, "README.md", options(item.helper, async () => {}));
});
