import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { resolveProject } from "../../../runtime/source/project.mjs";
import { loadWorkGraph } from "../../source/sonner.mjs";
import { buildSonner, buildSonnerProject } from "../../source/sonner.mjs";
import {
  encodeSonnerReaderRequest,
  encodeSonnerGitRequest,
  inspectSonnerUniversalMachO,
  PACKAGED_SONNER_PROJECT_READER,
  parseSonnerGitOutput,
  readSonnerProject,
  SONNER_GIT_MAX_OUTPUT_BYTES,
  SONNER_READER_MAX_OUTPUT_BYTES,
  SONNER_READER_MAX_PATHS,
} from "../../source/sonner-project-reader.mjs";

const exec = promisify(execFile);
const componentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nativeSource = path.join(componentRoot, "native", "sonner-project-reader.c");
const ORIGINAL = "ORIGINAL_PROJECT_SUMMARY";
const EXTERNAL = "EXTERNAL_SECRET_SHOULD_NOT_CROSS";
let buildRoot;
let testHelper;

before(async () => {
  buildRoot = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-sonner-reader-build-"));
  testHelper = path.join(buildRoot, "sonner-project-reader-test");
  await exec("clang", ["-DSONNER_PROJECT_READER_TEST_HOOKS", "-O0", "-std=c11", "-Wall", "-Wextra", "-Werror", nativeSource, "-o", testHelper]);
});

after(async () => rm(buildRoot, { recursive: true, force: true }));

async function git(root, ...arguments_) {
  return exec("git", ["-C", root, ...arguments_]);
}

function marker(summary = "Original graph summary.") {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<work-node id="docs" type="Overview">\n  <summary>${summary}</summary>\n  <inputs></inputs>\n</work-node>\n`;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-sonner-reader-project-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-sonner-reader-external-"));
  const movedRoot = `${root}-anchored`;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(movedRoot, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  });
  await git(root, "init", "-q");
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs", "WORK_NODE.xml"), marker());
  await writeFile(path.join(root, "docs", "secret.md"), `---\nsummary: ${ORIGINAL}\n---\n# Original\n`);
  await mkdir(path.join(external, "docs"), { recursive: true });
  await writeFile(path.join(external, "docs", "WORK_NODE.xml"), marker(EXTERNAL));
  await writeFile(path.join(external, "docs", "secret.md"), `---\nsummary: ${EXTERNAL}\n---\n`);
  await git(root, "add", "docs");
  return { root, external, movedRoot };
}

async function candidate(root, options = {}) {
  return buildSonner(root, { readerOptions: { helperPath: testHelper, validateArchitecture: false, ...options } });
}

function serialized(result) {
  const value = JSON.stringify(result);
  assert.doesNotMatch(value, new RegExp(EXTERNAL));
  return value;
}

function find(node, projectPath) {
  if (node.path === projectPath) return node;
  for (const child of node.children ?? []) {
    const found = child.type === "directory" ? find(child, projectPath) : child.path === projectPath ? child : null;
    if (found) return found;
  }
  return null;
}

test("packaged helper is executable, signed universal arm64/x86_64, and reads protocol v2", async (t) => {
  const details = await inspectSonnerUniversalMachO(PACKAGED_SONNER_PROJECT_READER);
  assert.deepEqual(details, { arm64: true, x86_64: true });
  await exec("/usr/bin/codesign", ["--verify", "--strict", PACKAGED_SONNER_PROJECT_READER], { env: {} });
  const { root } = await fixture(t);
  const result = await buildSonner(root);
  assert.equal(find(result.files.root, "docs/secret.md").summary, ORIGINAL);
});

test("request contains Root identity but never its pathname and rejects path/count/output over-bounds", async (t) => {
  const { root } = await fixture(t);
  const project = await resolveProject(root);
  const request = encodeSonnerReaderRequest({
    rootIdentity: project.rootIdentity,
    paths: [{ path: "docs/secret.md", maxBytes: 64 * 1024 }],
    maxWorks: 1,
    maxWorkBytes: 256 * 1024,
    maxOutputBytes: SONNER_READER_MAX_OUTPUT_BYTES,
  });
  assert.equal(request[4], 2);
  assert.equal(request.includes(Buffer.from(root)), false);
  assert.throws(() => encodeSonnerReaderRequest({ rootIdentity: project.rootIdentity,
    paths: Array.from({ length: SONNER_READER_MAX_PATHS + 1 }, (_, index) => ({ path: `p${index}`, maxBytes: 0 })),
    maxWorks: 0, maxWorkBytes: 0, maxOutputBytes: 1 }));
  assert.throws(() => encodeSonnerReaderRequest({ rootIdentity: project.rootIdentity, paths: [],
    maxWorks: 0, maxWorkBytes: 0, maxOutputBytes: SONNER_READER_MAX_OUTPUT_BYTES + 1 }));
});

test("static final and ancestor symlinks never expose target bytes", async (t) => {
  await t.test("final", async (t) => {
    const { root, external } = await fixture(t);
    await unlink(path.join(root, "docs", "secret.md"));
    await symlink(path.join(external, "docs", "secret.md"), path.join(root, "docs", "secret.md"));
    const result = await candidate(root);
    serialized(result);
    assert.equal(find(result.files.root, "docs/secret.md").type, "symlink");
    assert.equal(find(result.files.root, "docs/secret.md").summary, undefined);
  });
  await t.test("ancestor", async (t) => {
    const { root, external } = await fixture(t);
    await rename(path.join(root, "docs"), path.join(root, "docs-original"));
    await symlink(path.join(external, "docs"), path.join(root, "docs"));
    const result = await candidate(root);
    serialized(result);
    assert.equal(find(result.files.root, "docs/secret.md"), null);
  });
  await t.test("Work marker final symlink", async (t) => {
    const { root, external } = await fixture(t);
    await unlink(path.join(root, "docs", "WORK_NODE.xml"));
    await symlink(path.join(external, "docs", "WORK_NODE.xml"), path.join(root, "docs", "WORK_NODE.xml"));
    const result = await candidate(root);
    serialized(result);
    assert.deepEqual(result.workGraph, { status: "invalid" });
    assert.equal(find(result.files.root, "docs/secret.md").summary, ORIGINAL);
  });
});

test("Markdown Root, ancestor, final-open, opened-file, and in-place read transitions stay confined", async (t) => {
  const cases = [
    ["ancestor-before-open", "before-path-ancestor-open:docs", async ({ root, external }) => {
      await rename(path.join(root, "docs"), path.join(root, "docs-original"));
      await symlink(path.join(external, "docs"), path.join(root, "docs"));
    }, "omit"],
    ["final-before-open", "before-path-open:docs/secret.md", async ({ root, external }) => {
      await rename(path.join(root, "docs", "secret.md"), path.join(root, "docs", "secret-original.md"));
      await rename(path.join(external, "docs", "secret.md"), path.join(root, "docs", "secret.md"));
    }, "omit"],
    ["replacement-after-open", "after-path-open:docs/secret.md", async ({ root, external }) => {
      await rename(path.join(root, "docs", "secret.md"), path.join(root, "docs", "secret-original.md"));
      await symlink(path.join(external, "docs", "secret.md"), path.join(root, "docs", "secret.md"));
    }, "omit"],
    ["in-place-after-read", "after-path-read:docs/secret.md", async ({ root }) => {
      await appendFile(path.join(root, "docs", "secret.md"), EXTERNAL);
    }, "omit"],
  ];
  for (const [name, transition, mutate, expected] of cases) {
    await t.test(name, async (t) => {
      const tree = await fixture(t); let changed = false;
      const result = await candidate(tree.root, { onTransition: async (value) => {
        if (!changed && value === transition) { changed = true; await mutate(tree); }
      } });
      serialized(result); assert.equal(changed, true);
      const file = find(result.files.root, "docs/secret.md");
      if (expected === "original") assert.equal(file.summary, ORIGINAL);
      else assert.equal(file, null);
    });
  }

  await t.test("Root replacement after fd retention", async (t) => {
    const tree = await fixture(t); let changed = false;
    const result = await candidate(tree.root, { onTransition: async (value) => {
      if (!changed && value === "after-root-adopt") {
        changed = true; await rename(tree.root, tree.movedRoot); await mkdir(tree.root);
        await mkdir(path.join(tree.root, "docs"));
        await writeFile(path.join(tree.root, "docs", "secret.md"), `---\nsummary: ${EXTERNAL}\n---\n`);
      }
    } });
    serialized(result); assert.equal(changed, true);
    assert.equal(find(result.files.root, "docs/secret.md").summary, ORIGINAL);
  });

  await t.test("Root replacement before descriptor open fails the whole projection", async (t) => {
    const tree = await fixture(t); let changed = false;
    await assert.rejects(candidate(tree.root, { openImpl: async (filename, flags) => {
      if (!changed) {
        changed = true; await rename(tree.root, tree.movedRoot); await mkdir(tree.root);
        await writeFile(path.join(tree.root, "external.md"), `---\nsummary: ${EXTERNAL}\n---\n`);
      }
      return open(filename, flags);
    } }), { code: "SONNER_PROJECT_READER_UNAVAILABLE" });
    assert.equal(changed, true);
  });
});

test("unsafe Work discovery/open/read replacements invalidate Work without hiding safely read files", async (t) => {
  const cases = [
    ["ancestor-discovery", "before-work-directory-open:docs", async ({ root, external }) => {
      await rename(path.join(root, "docs"), path.join(root, "docs-original"));
      await symlink(path.join(external, "docs"), path.join(root, "docs"));
    }, "invalid"],
    ["marker-before-open", "before-work-open:docs/WORK_NODE.xml", async ({ root, external }) => {
      await rename(path.join(root, "docs", "WORK_NODE.xml"), path.join(root, "docs", "WORK_NODE-original.xml"));
      await rename(path.join(external, "docs", "WORK_NODE.xml"), path.join(root, "docs", "WORK_NODE.xml"));
    }, "invalid"],
    ["marker-after-open", "after-work-open:docs/WORK_NODE.xml", async ({ root, external }) => {
      await rename(path.join(root, "docs", "WORK_NODE.xml"), path.join(root, "docs", "WORK_NODE-original.xml"));
      await symlink(path.join(external, "docs", "WORK_NODE.xml"), path.join(root, "docs", "WORK_NODE.xml"));
    }, "invalid"],
    ["marker-after-read", "after-work-read:docs/WORK_NODE.xml", async ({ root }) => {
      await appendFile(path.join(root, "docs", "WORK_NODE.xml"), `<!--${EXTERNAL}-->`);
    }, "invalid"],
  ];
  for (const [name, transition, mutate, expected] of cases) {
    await t.test(name, async (t) => {
      const tree = await fixture(t); let changed = false;
      const result = await candidate(tree.root, { onTransition: async (value) => {
        if (!changed && value === transition) { changed = true; await mutate(tree); }
      } });
      serialized(result); assert.equal(changed, true);
      assert.equal(expected, "invalid");
      assert.deepEqual(result.workGraph, { status: "invalid" });
      assert.equal(find(result.files.root, "docs/secret.md").summary, ORIGINAL);
    });
  }
});

test("native byte/count/output bounds and crash/timeout/malformed helpers fail closed", async (t) => {
  const { root } = await fixture(t);
  const project = await resolveProject(root);
  const workSize = Buffer.byteLength(await readFile(path.join(root, "docs", "WORK_NODE.xml"), "utf8"));
  const exact = await readSonnerProject({ project, paths: [], helperPath: testHelper, validateArchitecture: false, maxWorkBytes: workSize });
  assert.equal(exact.workUnsafe, false);
  assert.equal(exact.works.length, 1);
  const oneOver = await readSonnerProject({ project, paths: [], helperPath: testHelper, validateArchitecture: false, maxWorkBytes: workSize - 1 });
  assert.equal(oneOver.workUnsafe, true);
  const bounded = await readSonnerProject({ project, paths: [], helperPath: testHelper, validateArchitecture: false, maxWorks: 0 });
  assert.equal(bounded.workUnsafe, true);

  await assert.rejects(readSonnerProject({ project, paths: [{ path: "docs/secret.md", maxBytes: 64 * 1024 }],
    helperPath: testHelper, validateArchitecture: false, maxOutputBytes: 20 }), { code: "SONNER_PROJECT_READER_UNAVAILABLE" });
  await assert.rejects(readSonnerProject({ project, paths: [], helperPath: "/usr/bin/false", validateArchitecture: false }),
    { code: "SONNER_PROJECT_READER_UNAVAILABLE" });
  await assert.rejects(readSonnerProject({ project, paths: [], helperPath: testHelper, validateArchitecture: false,
    timeoutMs: 20, onTransition: () => new Promise(() => {}) }), { code: "SONNER_PROJECT_READER_UNAVAILABLE" });

  const malformed = path.join(buildRoot, "malformed-helper");
  await writeFile(malformed, "#!/bin/sh\nprintf '\\000\\000\\000\\002\\001\\001\\000'\n"); await chmod(malformed, 0o755);
  await assert.rejects(readSonnerProject({ project, paths: [], helperPath: malformed, validateArchitecture: false }),
    { code: "SONNER_PROJECT_READER_UNAVAILABLE" });
});

test("native protocol rejects a missing or wrong fd 3", async (t) => {
  const { root } = await fixture(t); const project = await resolveProject(root);
  const request = encodeSonnerReaderRequest({ rootIdentity: project.rootIdentity, paths: [],
    maxWorks: 1, maxWorkBytes: 256 * 1024, maxOutputBytes: SONNER_READER_MAX_OUTPUT_BYTES });
  for (const descriptor of ["ignore", "pipe"]) {
    const child = spawn(testHelper, [], { stdio: ["pipe", "ignore", "ignore", descriptor], env: {} });
    child.stdin.end(request);
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.notEqual(code, 0);
  }
});

test("repeated reads close inherited Root and child descriptors", async (t) => {
  const { root } = await fixture(t); const project = await resolveProject(root);
  const before = (await readdir("/dev/fd")).length;
  for (let index = 0; index < 20; index += 1) {
    const result = await readSonnerProject({ project, paths: [{ path: "docs/secret.md", maxBytes: 64 * 1024 }],
      helperPath: testHelper, validateArchitecture: false });
    assert.equal(result.entries.some((entry) => entry.path === "docs/secret.md"), true);
  }
  const afterValue = (await readdir("/dev/fd")).length;
  assert.ok(afterValue <= before + 2, `descriptor count grew from ${before} to ${afterValue}`);
});

test("Sonner Work-only graph loading consumes the same anchored helper records", async (t) => {
  const tree = await fixture(t); let changed = false;
  await assert.rejects(loadWorkGraph(tree.root, { readerOptions: {
    helperPath: testHelper,
    validateArchitecture: false,
    onTransition: async (value) => {
      if (!changed && value === "before-work-open:docs/WORK_NODE.xml") {
        changed = true;
        await rename(path.join(tree.root, "docs", "WORK_NODE.xml"), path.join(tree.root, "docs", "WORK_NODE-original.xml"));
        await rename(path.join(tree.external, "docs", "WORK_NODE.xml"), path.join(tree.root, "docs", "WORK_NODE.xml"));
      }
    },
  } }), { code: "INVALID_GRAPH" });
  assert.equal(changed, true);
});

async function admissionFixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-sonner-admission-"));
  const root = path.join(parent, "project");
  const external = path.join(parent, "external");
  const moved = path.join(parent, "authorized-root");
  t.after(() => rm(parent, { recursive: true, force: true }));
  for (const directory of [root, external]) {
    await mkdir(directory);
    await git(directory, "init", "-q");
  }
  await writeFile(path.join(root, ".gitignore"), "secret.md\n");
  await writeFile(path.join(root, "README.md"), `---\nsummary: ${ORIGINAL}\n---\n`);
  await writeFile(path.join(root, "secret.md"), `---\nsummary: IGNORED_SECRET_CROSSED_INDEX\n---\n`);
  await git(root, "add", ".gitignore", "README.md");
  await writeFile(path.join(external, "secret.md"), `---\nsummary: ${EXTERNAL}\n---\n`);
  await git(external, "add", "secret.md");
  return { parent, root, external, moved };
}

test("Git admission ignores caller authority poisoning and the ignored-file ABA reproduction", async (t) => {
  const tree = await admissionFixture(t);
  const wrapper = path.join(tree.parent, "bin"); await mkdir(wrapper);
  await writeFile(path.join(wrapper, "git"), `#!/bin/sh\nprintf 'secret.md\\0'\n`); await chmod(path.join(wrapper, "git"), 0o755);
  const poisoned = {
    ...process.env,
    PATH: wrapper,
    GIT_DIR: path.join(tree.external, ".git"),
    GIT_WORK_TREE: tree.external,
    GIT_INDEX_FILE: path.join(tree.external, ".git", "index"),
    GIT_COMMON_DIR: path.join(tree.external, ".git"),
    GIT_OBJECT_DIRECTORY: path.join(tree.external, ".git", "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(tree.external, ".git", "objects"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.excludesfile",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_EXEC_PATH: wrapper,
    GIT_PAGER: path.join(wrapper, "git"),
    GIT_SSH_COMMAND: path.join(wrapper, "git"),
    DYLD_INSERT_LIBRARIES: path.join(tree.parent, "poison.dylib"),
  };
  const result = await candidate(tree.root, { environment: poisoned });
  const raw = serialized(result);
  assert.doesNotMatch(raw, /IGNORED_SECRET_CROSSED_INDEX/);
  assert.equal(find(result.files.root, "secret.md"), null);
  assert.equal(find(result.files.root, "README.md").summary, ORIGINAL);
});

test("one retained Root capability survives every Git/content phase replacement and ABA", async (t) => {
  for (const phase of ["after-root-open", "before-git-spawn", "after-git-output", "before-content-spawn"]) {
    await t.test(phase, async (t) => {
      const tree = await admissionFixture(t); let changed = false;
      const result = await candidate(tree.root, { onPhase: async (value) => {
        if (!changed && value === phase) {
          changed = true; await rename(tree.root, tree.moved); await rename(tree.external, tree.root);
        }
      } });
      serialized(result); assert.equal(changed, true);
      assert.equal(find(result.files.root, "README.md").summary, ORIGINAL);
      assert.equal(find(result.files.root, "secret.md"), null);
    });
  }
  await t.test("during Git before fixed exec", async (t) => {
    const tree = await admissionFixture(t); let changed = false;
    const result = await candidate(tree.root, { onTransition: async (value) => {
      if (!changed && value === "before-git-exec") {
        changed = true; await rename(tree.root, tree.moved); await rename(tree.external, tree.root);
      }
    } });
    serialized(result); assert.equal(changed, true);
    assert.equal(find(result.files.root, "README.md").summary, ORIGINAL);
  });
  await t.test("ABA after retention", async (t) => {
    const tree = await admissionFixture(t); let changed = false;
    const result = await candidate(tree.root, { onPhase: async (value) => {
      if (!changed && value === "before-git-spawn") {
        changed = true; await rename(tree.root, tree.moved); await rename(tree.external, tree.root);
        await rename(tree.root, tree.external); await rename(tree.moved, tree.root);
      }
    } });
    serialized(result); assert.equal(find(result.files.root, "README.md").summary, ORIGINAL);
  });
  await t.test("ABA before descriptor open", async (t) => {
    const tree = await admissionFixture(t); let changed = false;
    const result = await candidate(tree.root, { openImpl: async (filename, flags) => {
      if (!changed) {
        changed = true; await rename(tree.root, tree.moved); await rename(tree.external, tree.root);
        await rename(tree.root, tree.external); await rename(tree.moved, tree.root);
      }
      return open(filename, flags);
    } });
    serialized(result); assert.equal(find(result.files.root, "README.md").summary, ORIGINAL);
  });
});

test("fixed work-tree defeats repository core.worktree redirection", async (t) => {
  const tree = await admissionFixture(t);
  await git(tree.root, "config", "core.worktree", tree.external);
  const result = await candidate(tree.root);
  serialized(result);
  assert.equal(find(result.files.root, "README.md").summary, ORIGINAL);
  assert.equal(find(result.files.root, "secret.md"), null);
});

test("linked worktrees and absolute HOME global excludes retain standard Git semantics", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-sonner-linked-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const main = path.join(parent, "main"); const linked = path.join(parent, "linked"); const home = path.join(parent, "home");
  await mkdir(main); await mkdir(home); await git(main, "init", "-q");
  await git(main, "config", "user.name", "Sonner Test"); await git(main, "config", "user.email", "sonner@example.invalid");
  await writeFile(path.join(main, "README.md"), `---\nsummary: ${ORIGINAL}\n---\n`); await git(main, "add", "README.md"); await git(main, "commit", "-qm", "fixture");
  await git(main, "worktree", "add", "-qb", "linked-test", linked);
  const excludes = path.join(home, "global-excludes"); await writeFile(excludes, "global-secret.md\n");
  await writeFile(path.join(home, ".gitconfig"), `[core]\n\texcludesfile = ${excludes}\n`);
  await writeFile(path.join(linked, "global-secret.md"), `---\nsummary: ${EXTERNAL}\n---\n`);
  await writeFile(path.join(linked, "visible.md"), "---\nsummary: Visible untracked.\n---\n");
  const result = await candidate(linked, { environment: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "xdg") } });
  serialized(result);
  assert.equal(find(result.files.root, "README.md").summary, ORIGINAL);
  assert.equal(find(result.files.root, "global-secret.md"), null);
  assert.equal(find(result.files.root, "visible.md").summary, "Visible untracked.");
});

test("Git output protocol rejects malformed lists and normalizes Unicode by UTF-8 bytes", async (t) => {
  const invalid = [
    Buffer.from("missing-nul"), Buffer.from([0]), Buffer.from("/absolute\0"), Buffer.from("../escape\0"),
    Buffer.from("a\0a\0"), Buffer.from("c\0b\0a\0"), Buffer.from([0xff, 0]),
  ];
  for (const value of invalid) assert.throws(() => parseSonnerGitOutput(value));
  const exact = Buffer.from("a\0");
  assert.deepEqual(parseSonnerGitOutput(exact, { maxOutputBytes: exact.length, maxPaths: 1 }), ["a"]);
  assert.throws(() => parseSonnerGitOutput(exact, { maxOutputBytes: exact.length - 1, maxPaths: 1 }));
  assert.throws(() => parseSonnerGitOutput(Buffer.from("a\0b\0"), { maxOutputBytes: 4, maxPaths: 1 }));
  const exactPath = `${"a".repeat(512)}/${"b".repeat(512)}/${"c".repeat(512)}/${"d".repeat(512)}/${"e".repeat(512)}/${"f".repeat(512)}/${"g".repeat(512)}/${"h".repeat(505)}`;
  assert.equal(Buffer.byteLength(exactPath), 4096);
  assert.deepEqual(parseSonnerGitOutput(Buffer.from(`${exactPath}\0`)), [exactPath]);
  assert.throws(() => parseSonnerGitOutput(Buffer.from(`${exactPath}x\0`)));

  const tree = await admissionFixture(t);
  const first = "\uE000.md"; const second = "\u{10000}.md";
  await writeFile(path.join(tree.root, first), "---\nsummary: BMP.\n---\n");
  await writeFile(path.join(tree.root, second), "---\nsummary: Astral.\n---\n");
  await git(tree.root, "add", first, second);
  const result = await candidate(tree.root);
  const names = result.files.root.children.map((entry) => entry.path);
  assert.ok(names.indexOf(first) < names.indexOf(second), JSON.stringify(names));
});

test("Work-only mode skips Git and supports a non-Git project", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-sonner-work-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "docs")); await writeFile(path.join(root, "docs", "WORK_NODE.xml"), marker());
  const project = await resolveProject(root); let gitSpawned = false;
  const result = await readSonnerProject({ project, includeFiles: false, helperPath: testHelper, validateArchitecture: false,
    spawnImpl: (command, arguments_, options) => {
      if (arguments_[0] === "git-ls-files") gitSpawned = true;
      return spawn(command, arguments_, options);
    } });
  assert.equal(gitSpawned, false);
  assert.equal(result.entries.length, 0);
  assert.equal(result.works.length, 1);
});

test("Git v2 request is bounded and contains identity but no Root pathname", async (t) => {
  const tree = await admissionFixture(t); const project = await resolveProject(tree.root);
  const request = encodeSonnerGitRequest({ rootIdentity: project.rootIdentity });
  assert.equal(request[4], 2);
  assert.equal(request.length, 29);
  assert.equal(request.includes(Buffer.from(tree.root)), false);
  assert.throws(() => encodeSonnerGitRequest({ rootIdentity: project.rootIdentity, maxOutputBytes: SONNER_GIT_MAX_OUTPUT_BYTES + 1 }));
  await assert.rejects(buildSonnerProject({ root: tree.root, key: project.key, rootIdentity: project.rootIdentity }),
    { code: "SONNER_PROJECT_READER_UNAVAILABLE" });
});
