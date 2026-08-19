import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  appendFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  encodeActivitySignalRequest,
  inspectUniversalMachO,
  isValidActivitySignalName,
  isValidActivitySnapshotName,
  PACKAGED_ACTIVITY_SIGNAL_READER,
  readActivitySignals,
} from "../../source/activity-signal-reader.mjs";
import { resolveProject } from "../../../runtime/source/project.mjs";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.join(root, "native", "activity-signal-reader.c");
const PRIMARY = "22222222-2222-4222-8222-222222222222";
const UNAUTHORIZED = "99999999-9999-4999-8999-999999999999";
const SNAPSHOT = "a".repeat(40);
const ORIGINAL = "---\ntemplate: review-signal\nseverity: required\nsummary: Original finding\n---\n\n## Explanation\n\nORIGINAL RAW SIGNAL\n\n## Implementation Approach\n";
const OUTSIDE = "OUTSIDE RAW SIGNAL SENTINEL";
let testBuildRoot;
let testHelper;
let validatorHelper;

before(async () => {
  testBuildRoot = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-signal-reader-build-"));
  testHelper = path.join(testBuildRoot, "activity-signal-reader-test");
  await exec("clang", ["-DACTIVITY_SIGNAL_READER_TEST_HOOKS", "-O0", "-std=c11", "-Wall", "-Wextra", "-Werror", source, "-o", testHelper]);
  const validatorSource = path.join(testBuildRoot, "validator.c");
  validatorHelper = path.join(testBuildRoot, "validator");
  await writeFile(validatorSource, `#define main activity_signal_reader_main\n#include ${JSON.stringify(source)}\n#undef main\nint main(int argc, char **argv) { if (argc != 3) return 2; return (strcmp(argv[1], "signal") == 0 ? valid_signal_name(argv[2]) : valid_snapshot(argv[2])) ? 0 : 1; }\n`);
  await exec("clang", ["-O0", "-std=c11", "-Wall", "-Wextra", "-Werror", validatorSource, "-o", validatorHelper]);
});

after(async () => {
  await rm(testBuildRoot, { recursive: true, force: true });
});

async function makeTree(t, raw = ORIGINAL) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-signal-tree-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const privateRuntime = path.join(projectRoot, ".codex-small-loop");
  const signals = path.join(privateRuntime, "signals");
  const primary = path.join(signals, PRIMARY);
  const snapshot = path.join(primary, SNAPSHOT);
  const file = path.join(snapshot, "signal.md");
  await mkdir(snapshot, { recursive: true });
  await writeFile(file, raw);
  return { projectRoot, privateRuntime, signals, primary, snapshot, file };
}

async function makeExternal(t) {
  const external = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-signal-external-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  const privateRuntime = path.join(external, "private");
  const signals = path.join(privateRuntime, "signals");
  const primary = path.join(signals, PRIMARY);
  const snapshot = path.join(primary, SNAPSHOT);
  const file = path.join(snapshot, "signal.md");
  await mkdir(snapshot, { recursive: true });
  await writeFile(file, OUTSIDE);
  return { privateRuntime, signals, primary, snapshot, file };
}

async function inspect(projectRoot, options = {}) {
  const project = options.project ?? await resolveProject(projectRoot);
  return readActivitySignals({
    project,
    authorizedPrimaryIds: new Set([PRIMARY]),
    helperPath: options.helperPath ?? PACKAGED_ACTIVITY_SIGNAL_READER,
    validateArchitecture: options.validateArchitecture ?? options.helperPath == null,
    maxSignals: options.maxSignals ?? 1_000,
    maxSignalBytes: options.maxSignalBytes ?? 256 * 1024,
    maxOutputBytes: options.maxOutputBytes,
    timeoutMs: options.timeoutMs,
    platform: options.platform,
    spawnImpl: options.spawnImpl,
    openImpl: options.openImpl,
    onTransition: options.onTransition,
});
}

async function nativeValid(kind, value) {
  const child = spawn(validatorHelper, [kind, value], { stdio: "ignore", env: {} });
  const code = await new Promise((resolve) => child.once("close", resolve));
  return code === 0;
}

test("C and Node snapshot/Signal validators have exact grammar parity", async () => {
  const signalCases = [
    ["a.md", true],
    ["good.md", true],
    ["a-b.md", true],
    ["a0-z9.md", true],
    [`${"a".repeat(509)}.md`, true],
    ["a--b.md", false],
    ["-a.md", false],
    ["a-.md", false],
    ["A.md", false],
    ["a.MD", false],
    ["a.txt", false],
    [".md", false],
    ["a/b.md", false],
    ["a.b.md", false],
    ["a\nb.md", false],
    [`${"a".repeat(510)}.md`, false],
  ];
  for (const [name, expected] of signalCases) {
    assert.equal(isValidActivitySignalName(name), expected, `Node Signal ${JSON.stringify(name)}`);
    assert.equal(await nativeValid("signal", name), expected, `C Signal ${JSON.stringify(name)}`);
  }
  const snapshotCases = [
    ["a".repeat(40), true], ["0".repeat(64), true], ["a".repeat(39), false],
    ["a".repeat(65), false], ["A".repeat(40), false], ["g".repeat(40), false],
    [`${"a".repeat(39)}-`, false], [`${"a".repeat(39)}\n`, false],
  ];
  for (const [name, expected] of snapshotCases) {
    assert.equal(isValidActivitySnapshotName(name), expected, `Node snapshot ${JSON.stringify(name)}`);
    assert.equal(await nativeValid("snapshot", name), expected, `C snapshot ${JSON.stringify(name)}`);
  }
});

test("malformed Signal names cause zero child I/O and do not hide healthy raw text", async (t) => {
  const tree = await makeTree(t);
  await rename(tree.file, path.join(tree.snapshot, "good.md"));
  await writeFile(path.join(tree.snapshot, "a--b.md"), OUTSIDE);
  const transitions = [];
  const result = await inspect(tree.projectRoot, {
    helperPath: testHelper,
    validateArchitecture: false,
    onTransition(value) { transitions.push(value); },
  });
  assert.equal(result.partial, false);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].name, "good.md");
  assert.equal(result.entries[0].raw, ORIGINAL);
  assert.equal(transitions.filter((value) => value === "before-file-open").length, 1);
  assert.doesNotMatch(JSON.stringify(result), /a--b|OUTSIDE/);
});

test("protocol v2 request contains Root identity but no Root pathname", async (t) => {
  const tree = await makeTree(t);
  const project = await resolveProject(tree.projectRoot);
  const request = encodeActivitySignalRequest({
    rootIdentity: project.rootIdentity,
    authorizedPrimaryIds: new Set([PRIMARY]),
    maxSignals: 1_000,
    maxSignalBytes: 256 * 1024,
    maxOutputBytes: 6 * 1024 * 1024,
  });
  assert.equal(request[4], 2);
  assert.equal(request.includes(Buffer.from(project.root)), false);
  assert.equal(request.subarray(5, 13).readBigUInt64BE(), project.rootIdentity.dev);
  assert.equal(request.subarray(13, 21).readBigUInt64BE(), project.rootIdentity.ino);
});

test("resolved project Root identity is bigint and transitively immutable", async (t) => {
  const tree = await makeTree(t);
  const project = await resolveProject(tree.projectRoot);
  assert.equal(typeof project.rootIdentity.dev, "bigint");
  assert.equal(typeof project.rootIdentity.ino, "bigint");
  assert.equal(Object.isFrozen(project.rootIdentity), true);
  assert.equal(Object.isFrozen(project), true);
});

test("Root replacement before open is rejected and replacement during spawn stays on the verified descriptor", async (t) => {
  await t.test("before-open-identity-mismatch", async (t) => {
    const tree = await makeTree(t);
    const project = await resolveProject(tree.projectRoot);
    const held = `${tree.projectRoot}.held`;
    await rename(tree.projectRoot, held);
    t.after(() => rm(held, { recursive: true, force: true }));
    await mkdir(path.join(tree.projectRoot, ".codex-small-loop", "signals", PRIMARY, SNAPSHOT), { recursive: true });
    await writeFile(path.join(tree.projectRoot, ".codex-small-loop", "signals", PRIMARY, SNAPSHOT, "signal.md"), OUTSIDE);
    const result = await inspect(tree.projectRoot, { project });
    assertNoEscape(result, tree.projectRoot);
  });

  await t.test("spawn-transition-replacement", async (t) => {
    const tree = await makeTree(t);
    const replacement = await makeTree(t, OUTSIDE);
    const project = await resolveProject(tree.projectRoot);
    const held = `${tree.projectRoot}.held`;
    let swapped = false;
    const result = await inspect(tree.projectRoot, {
      project,
      spawnImpl(file, args, options) {
        assert.equal(args.length, 0);
        assert.deepEqual(options.env, {});
        assert.equal(JSON.stringify(options).includes(project.root), false);
        renameSync(tree.projectRoot, held);
        renameSync(replacement.projectRoot, tree.projectRoot);
        swapped = true;
        return spawn(file, args, options);
      },
    });
    t.after(() => rm(held, { recursive: true, force: true }));
    assert.equal(swapped, true);
    assert.equal(result.entries[0].raw, ORIGINAL);
    assert.doesNotMatch(JSON.stringify(result), /OUTSIDE RAW SIGNAL SENTINEL/);
  });

  await t.test("after-child-adoption-replacement", async (t) => {
    const tree = await makeTree(t);
    const replacement = await makeTree(t, OUTSIDE);
    const project = await resolveProject(tree.projectRoot);
    const held = `${tree.projectRoot}.held`;
    let swapped = false;
    const result = await inspect(tree.projectRoot, {
      project,
      helperPath: testHelper,
      validateArchitecture: false,
      onTransition(value) {
        if (!swapped && value === "after-root-adopt") {
          renameSync(tree.projectRoot, held);
          renameSync(replacement.projectRoot, tree.projectRoot);
          swapped = true;
        }
      },
    });
    t.after(() => rm(held, { recursive: true, force: true }));
    assert.equal(swapped, true);
    assert.equal(result.entries[0].raw, ORIGINAL);
    assert.doesNotMatch(JSON.stringify(result), /OUTSIDE RAW SIGNAL SENTINEL/);
  });
});

function assertNoEscape(result, external) {
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /OUTSIDE RAW SIGNAL SENTINEL/);
  assert.equal(serialized.includes(external), false);
  assert.equal(result.entries.length, 0);
  assert.equal(result.partial, true);
}

async function runNativeHelper(executable, request, fd3) {
  const child = spawn(executable, [], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe", fd3 ?? "ignore", "ignore"],
    env: {},
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.on("error", () => {});
  child.stdin.end(request);
  const result = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  return { ...result, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

test("native protocol v2 rejects missing, wrong, and forged fd 3 before HELLO", async (t) => {
  const tree = await makeTree(t);
  const project = await resolveProject(tree.projectRoot);
  const base = {
    authorizedPrimaryIds: new Set([PRIMARY]),
    maxSignals: 1_000,
    maxSignalBytes: 256 * 1024,
    maxOutputBytes: 6 * 1024 * 1024,
  };
  const request = encodeActivitySignalRequest({ ...base, rootIdentity: project.rootIdentity });
  const missing = await runNativeHelper(testHelper, request, null);
  assert.equal(missing.code, 64);
  assert.equal(missing.stdout.length, 0);

  const wrongHandle = await open("/dev/null", "r");
  t.after(() => wrongHandle.close().catch(() => {}));
  const wrong = await runNativeHelper(testHelper, request, wrongHandle.fd);
  assert.equal(wrong.code, 64);
  assert.equal(wrong.stdout.length, 0);

  const rootHandle = await open(project.root, "r");
  t.after(() => rootHandle.close().catch(() => {}));
  const forged = encodeActivitySignalRequest({
    ...base,
    rootIdentity: { dev: project.rootIdentity.dev, ino: project.rootIdentity.ino + 1n },
  });
  const mismatch = await runNativeHelper(testHelper, forged, rootHandle.fd);
  assert.equal(mismatch.code, 64);
  assert.equal(mismatch.stdout.length, 0);
});

test("packaged helper is executable universal arm64+x86_64 and speaks protocol v2", async (t) => {
  assert.deepEqual(await inspectUniversalMachO(PACKAGED_ACTIVITY_SIGNAL_READER), { arm64: true, x86_64: true });
  assert.equal(createHash("sha256").update(await readFile(PACKAGED_ACTIVITY_SIGNAL_READER)).digest("hex"), "9be1eb5e1360fa7a79352d49e71ac02e033720adb4608bd6ae0ff01a35b75079");
  const tree = await makeTree(t);
  const result = await inspect(tree.projectRoot);
  assert.equal(result.partial, false);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].raw, ORIGINAL);
});

test("static symlinks at every Signal component never expose external raw text", async (t) => {
  const cases = ["privateRuntime", "signals", "primary", "snapshot", "file"];
  for (const component of cases) {
    await t.test(component, async (t) => {
      const tree = await makeTree(t);
      const external = await makeExternal(t);
      await rm(tree[component], { recursive: true, force: true });
      await symlink(external[component], tree[component]);
      const result = await inspect(tree.projectRoot);
      assertNoEscape(result, external[component]);
      assert.ok(result.omissions.some((item) => item.code === (component === "file" ? "ACTIVITY_SIGNAL_NON_REGULAR" : "ACTIVITY_SIGNAL_DIRECTORY_UNSAFE")));
    });
  }
});

test("hard-linked Signal is rejected without raw leakage", async (t) => {
  const tree = await makeTree(t);
  const external = path.join(tree.projectRoot, "outside.md");
  await writeFile(external, OUTSIDE);
  await rm(tree.file);
  await link(external, tree.file);
  const result = await inspect(tree.projectRoot);
  assertNoEscape(result, external);
  assert.equal(result.omissions[0].code, "ACTIVITY_SIGNAL_NON_REGULAR");
});

test("unauthorized and malformed entries perform no child transition", async (t) => {
  const tree = await makeTree(t);
  await rm(tree.file);
  const unauthorizedSnapshot = path.join(tree.signals, UNAUTHORIZED, SNAPSHOT);
  await mkdir(unauthorizedSnapshot, { recursive: true });
  await writeFile(path.join(unauthorizedSnapshot, "signal.md"), OUTSIDE);
  await mkdir(path.join(tree.primary, "not-a-snapshot"));
  await symlink(path.join(tree.projectRoot, "missing"), path.join(tree.snapshot, "Bad.md"));
  const transitions = [];
  const result = await inspect(tree.projectRoot, {
    helperPath: testHelper,
    validateArchitecture: false,
    onTransition: async (value) => { transitions.push(value); },
  });
  assert.equal(result.entries.length, 0);
  assert.equal(result.omissions.length, 0);
  assert.equal(transitions.filter((value) => value === "before-primary-open").length, 1);
  assert.equal(transitions.includes("before-snapshot-open"), true);
  assert.equal(transitions.includes("before-file-open"), false);
});

async function swapToSymlink(target, external) {
  const held = `${target}.held`;
  await rename(target, held);
  await symlink(external, target);
  return held;
}

async function aba(target, external) {
  const held = await swapToSymlink(target, external);
  await unlink(target);
  await rename(held, target);
}

test("descriptor-chain replacement hooks return only anchored original or bounded omission", async (t) => {
  const transitions = [
    ["after-root-adopt", "privateRuntime"],
    ["after-private-open", "signals"],
    ["before-primary-open", "primary"],
    ["before-snapshot-open", "snapshot"],
    ["before-file-open", "file"],
  ];
  for (const [transition, component] of transitions) {
    await t.test(`${transition}-symlink`, async (t) => {
      const tree = await makeTree(t);
      const external = await makeExternal(t);
      let changed = false;
      const result = await inspect(tree.projectRoot, {
        helperPath: testHelper,
        validateArchitecture: false,
        onTransition: async (value) => {
          if (!changed && value === transition) {
            changed = true;
            await swapToSymlink(tree[component], external[component]);
          }
        },
      });
      assertNoEscape(result, external[component]);
    });

    await t.test(`${transition}-aba`, async (t) => {
      const tree = await makeTree(t);
      const external = await makeExternal(t);
      let changed = false;
      const result = await inspect(tree.projectRoot, {
        helperPath: testHelper,
        validateArchitecture: false,
        onTransition: async (value) => {
          if (!changed && value === transition) {
            changed = true;
            await aba(tree[component], external[component]);
          }
        },
      });
      assert.equal(result.entries.length, 1);
      assert.equal(result.entries[0].raw, ORIGINAL);
      assert.doesNotMatch(JSON.stringify(result), /OUTSIDE RAW SIGNAL SENTINEL/);
    });
  }
});

test("file-open replacement retains stable inode and in-place append is changed", async (t) => {
  await t.test("atomic-rename-before-open", async (t) => {
    const tree = await makeTree(t);
    let changed = false;
    const result = await inspect(tree.projectRoot, {
      helperPath: testHelper,
      validateArchitecture: false,
      onTransition: async (value) => {
        if (!changed && value === "before-file-open") {
          changed = true;
          const replacement = `${tree.file}.replacement`;
          await writeFile(replacement, "COMPLETE NEW SIGNAL");
          await rename(replacement, tree.file);
        }
      },
    });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].raw, "COMPLETE NEW SIGNAL");
  });

  await t.test("replacement", async (t) => {
    const tree = await makeTree(t);
    const external = await makeExternal(t);
    let changed = false;
    const result = await inspect(tree.projectRoot, {
      helperPath: testHelper,
      validateArchitecture: false,
      onTransition: async (value) => {
        if (!changed && value === "after-file-open") {
          changed = true;
          await swapToSymlink(tree.file, external.file);
        }
      },
    });
    if (result.entries.length === 1) assert.equal(result.entries[0].raw, ORIGINAL);
    else assert.equal(result.omissions[0].code, "ACTIVITY_SIGNAL_CHANGED");
    assert.doesNotMatch(JSON.stringify(result), /OUTSIDE RAW SIGNAL SENTINEL/);
  });

  await t.test("append", async (t) => {
    const tree = await makeTree(t);
    let changed = false;
    const result = await inspect(tree.projectRoot, {
      helperPath: testHelper,
      validateArchitecture: false,
      onTransition: async (value) => {
        if (!changed && value === "after-file-open") {
          changed = true;
          await appendFile(tree.file, "x".repeat(512 * 1024));
        }
      },
    });
    assert.equal(result.entries.length, 0);
    assert.equal(result.omissions[0].code, "ACTIVITY_SIGNAL_CHANGED");
  });

  await t.test("mutation-after-read", async (t) => {
    const tree = await makeTree(t);
    let changed = false;
    const result = await inspect(tree.projectRoot, {
      helperPath: testHelper,
      validateArchitecture: false,
      onTransition: async (value) => {
        if (!changed && value === "after-file-read") {
          changed = true;
          await appendFile(tree.file, "mutation");
        }
      },
    });
    assert.equal(result.entries.length, 0);
    assert.equal(result.omissions[0].code, "ACTIVITY_SIGNAL_CHANGED");
  });

  await t.test("disappearing-entry", async (t) => {
    const tree = await makeTree(t);
    let changed = false;
    const result = await inspect(tree.projectRoot, {
      helperPath: testHelper,
      validateArchitecture: false,
      onTransition: async (value) => {
        if (!changed && value === "before-file-open") {
          changed = true;
          await unlink(tree.file);
        }
      },
    });
    assert.equal(result.entries.length, 0);
    assert.equal(result.omissions[0].code, "ACTIVITY_SIGNAL_UNREADABLE");
  });
});

test("exact and over file/count bounds plus repeated descriptor cleanup", async (t) => {
  await t.test("file-size", async (t) => {
    const tree = await makeTree(t, "x".repeat(256 * 1024));
    await writeFile(path.join(tree.snapshot, "over.md"), "x".repeat((256 * 1024) + 1));
    const result = await inspect(tree.projectRoot);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].raw.length, 256 * 1024);
    assert.ok(result.omissions.some((item) => item.code === "ACTIVITY_SIGNAL_OVERSIZED"));
  });

  await t.test("signal-count", async (t) => {
    const tree = await makeTree(t, "");
    await rm(tree.file);
    const writes = [];
    for (let index = 0; index < 1001; index += 1) {
      writes.push(writeFile(path.join(tree.snapshot, `s${String(index).padStart(4, "0")}.md`), ""));
    }
    await Promise.all(writes);
    const transitions = [];
    const result = await inspect(tree.projectRoot, {
      helperPath: testHelper,
      validateArchitecture: false,
      timeoutMs: 20_000,
      onTransition(value) { transitions.push(value); },
    });
    assert.equal(result.entries.length, 1000);
    assert.equal(result.omissions.filter((item) => item.code === "ACTIVITY_SIGNAL_DISCOVERY_BOUNDED").length, 1);
    assert.equal(transitions.filter((value) => value === "signal-name-retained").length, 1000);
    assert.equal(transitions.filter((value) => value === "before-file-open").length, 1000);
  });

  await t.test("configured Signal-entry exact and one-over ceilings", async (t) => {
    for (const count of [64, 65]) {
      const tree = await makeTree(t, "");
      await rm(tree.file);
      await Promise.all(Array.from({ length: count }, (_, index) =>
        writeFile(path.join(tree.snapshot, `s${String(index).padStart(4, "0")}.md`), "")));
      const transitions = [];
      const result = await inspect(tree.projectRoot, {
        helperPath: testHelper,
        validateArchitecture: false,
        maxSignals: 64,
        onTransition(value) { transitions.push(value); },
      });
      assert.equal(result.entries.length, 64);
      assert.equal(transitions.filter((value) => value === "signal-name-retained").length, 64);
      assert.equal(transitions.filter((value) => value === "before-file-open").length, 64);
      assert.equal(result.partial, count === 65);
      assert.equal(result.omissions.filter((item) => item.code === "ACTIVITY_SIGNAL_DISCOVERY_BOUNDED").length, count === 65 ? 1 : 0);
    }
  });

  await t.test("configured snapshot-entry exact and one-over ceilings", async (t) => {
    for (const count of [64, 65]) {
      const tree = await makeTree(t);
      await rm(tree.primary, { recursive: true, force: true });
      await Promise.all(Array.from({ length: count }, (_, index) =>
        mkdir(path.join(tree.primary, index.toString(16).padStart(40, "0")), { recursive: true })));
      const transitions = [];
      const result = await inspect(tree.projectRoot, {
        helperPath: testHelper,
        validateArchitecture: false,
        maxSignals: 64,
        onTransition(value) { transitions.push(value); },
      });
      assert.equal(result.entries.length, 0);
      assert.equal(transitions.filter((value) => value === "snapshot-name-retained").length, 64);
      assert.equal(transitions.filter((value) => value === "before-snapshot-open").length, 64);
      assert.equal(result.partial, count === 65);
      assert.equal(result.omissions.filter((item) => item.code === "ACTIVITY_SIGNAL_DISCOVERY_BOUNDED").length, count === 65 ? 1 : 0);
    }
  });

  await t.test("large valid-name stress retains and opens only the configured bound", async (t) => {
    const tree = await makeTree(t, "");
    await rm(tree.file);
    await Promise.all(Array.from({ length: 2_000 }, (_, index) =>
      writeFile(path.join(tree.snapshot, `stress${String(index).padStart(4, "0")}.md`), "")));
    const transitions = [];
    const result = await inspect(tree.projectRoot, {
      helperPath: testHelper,
      validateArchitecture: false,
      maxSignals: 25,
      onTransition(value) { transitions.push(value); },
    });
    assert.equal(result.entries.length, 25);
    assert.equal(transitions.filter((value) => value === "signal-name-retained").length, 25);
    assert.equal(transitions.filter((value) => value === "before-file-open").length, 25);
    assert.equal(transitions.filter((value) => value === "after-file-read").length, 25);
    assert.equal(result.partial, true);
    assert.equal(result.omissions.filter((item) => item.code === "ACTIVITY_SIGNAL_DISCOVERY_BOUNDED").length, 1);
    assert.deepEqual(result.omissions[0], {
      code: "ACTIVITY_SIGNAL_DISCOVERY_BOUNDED",
      primaryTaskId: PRIMARY,
      container: false,
    });
  });

  await t.test("descriptor-cleanup", async (t) => {
    const tree = await makeTree(t);
    await rm(tree.primary, { recursive: true, force: true });
    for (let index = 0; index < 200; index += 1) {
      const snapshot = path.join(tree.primary, index.toString(16).padStart(40, "0"));
      await mkdir(snapshot, { recursive: true });
      await writeFile(path.join(snapshot, "signal.md"), "ok");
    }
    const result = await inspect(tree.projectRoot);
    assert.equal(result.entries.length, 200);
    assert.equal(result.partial, false);
  });
});

async function makeScript(t, body, mode = 0o755) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-signal-fake-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "helper");
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, mode);
  return file;
}

test("helper architecture, executable, protocol, crash, timeout, and output failures fail closed", async (t) => {
  const tree = await makeTree(t);
  const missing = await inspect(tree.projectRoot, { helperPath: path.join(tree.projectRoot, "missing"), validateArchitecture: false });
  assert.equal(missing.omissions[0].code, "ACTIVITY_SIGNAL_READER_UNAVAILABLE");

  const nonExecutable = await makeScript(t, "exit 0", 0o644);
  assert.equal((await inspect(tree.projectRoot, { helperPath: nonExecutable, validateArchitecture: false })).partial, true);
  assert.equal((await inspect(tree.projectRoot, { helperPath: nonExecutable })).partial, true, "invalid universal architecture");
  assert.equal((await inspect(tree.projectRoot, { platform: "linux" })).partial, true);

  const crash = await makeScript(t, "exit 3");
  assert.equal((await inspect(tree.projectRoot, { helperPath: crash })).partial, true, "non-universal executable is rejected before spawn");
  assert.equal((await inspect(tree.projectRoot, { helperPath: crash, validateArchitecture: false })).partial, true);
  const timeout = await makeScript(t, "/bin/sleep 1");
  assert.equal((await inspect(tree.projectRoot, { helperPath: timeout, validateArchitecture: false, timeoutMs: 30 })).partial, true);
  const malformed = await makeScript(t, "/usr/bin/printf bad");
  assert.equal((await inspect(tree.projectRoot, { helperPath: malformed, validateArchitecture: false })).partial, true);
  const wrongProtocol = await makeScript(t, "/usr/bin/printf '\\000\\000\\000\\002\\001\\002'");
  assert.equal((await inspect(tree.projectRoot, { helperPath: wrongProtocol, validateArchitecture: false })).partial, true);
  const frameOverflow = await makeScript(t, "/usr/bin/printf '\\000\\050\\000\\001'");
  assert.equal((await inspect(tree.projectRoot, { helperPath: frameOverflow, validateArchitecture: false })).partial, true);
  const outputOverflow = await makeScript(t, "/usr/bin/yes x | /usr/bin/head -c 7000000");
  assert.equal((await inspect(tree.projectRoot, { helperPath: outputOverflow, validateArchitecture: false, maxOutputBytes: 6 * 1024 * 1024 })).partial, true);
  const closesInput = await makeScript(t, "exec 0<&-; /bin/sleep 0.1");
  const largeIds = new Set(Array.from({ length: 256 }, (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(230)}`));
  const project = await resolveProject(tree.projectRoot);
  const closedInput = await readActivitySignals({
    project,
    authorizedPrimaryIds: largeIds,
    helperPath: closesInput,
    validateArchitecture: false,
    timeoutMs: 500,
  });
  assert.equal(closedInput.omissions[0].code, "ACTIVITY_SIGNAL_READER_UNAVAILABLE");
});

test("EPIPE and ECONNRESET converge on one close settlement and one kill", async (t) => {
  const tree = await makeTree(t);
  const project = await resolveProject(tree.projectRoot);
  for (const code of ["EPIPE", "ECONNRESET"]) {
    await t.test(code, async () => {
      class FakeChild extends EventEmitter {
        constructor() {
          super();
          this.stdin = new PassThrough();
          this.stdout = new PassThrough();
          this.stderr = new PassThrough();
          this.stdio = [this.stdin, this.stdout, this.stderr, null, null];
          this.killCount = 0;
        }
        kill() {
          this.killCount += 1;
          setImmediate(() => this.emit("close", null, "SIGKILL"));
          return true;
        }
      }
      const child = new FakeChild();
      const resultPromise = readActivitySignals({
        project,
        authorizedPrimaryIds: new Set([PRIMARY]),
        helperPath: "/usr/bin/true",
        validateArchitecture: false,
        spawnImpl() {
          setImmediate(() => child.stdin.emit("error", Object.assign(new Error(code), { code })));
          return child;
        },
      });
      const result = await resultPromise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(result.omissions[0].code, "ACTIVITY_SIGNAL_READER_UNAVAILABLE");
      assert.equal(child.killCount, 1);
    });
  }
});

test("rejected and late control callbacks fail closed without terminal writes", async (t) => {
  await t.test("rejected", async (t) => {
    const tree = await makeTree(t);
    const result = await inspect(tree.projectRoot, {
      helperPath: testHelper,
      validateArchitecture: false,
      timeoutMs: 500,
      onTransition: async () => { throw new Error("rejected transition"); },
    });
    assert.equal(result.omissions[0].code, "ACTIVITY_SIGNAL_READER_UNAVAILABLE");
  });

  await t.test("late-after-timeout", async (t) => {
    const tree = await makeTree(t);
    let resolved = false;
    const result = await inspect(tree.projectRoot, {
      helperPath: testHelper,
      validateArchitecture: false,
      timeoutMs: 30,
      onTransition: () => new Promise((resolve) => setTimeout(() => { resolved = true; resolve(); }, 80)),
    });
    assert.equal(result.omissions[0].code, "ACTIVITY_SIGNAL_READER_UNAVAILABLE");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(resolved, true);
  });
});

test("500 early-exit helpers cannot escape as uncaught EPIPE or unhandled rejection", async (t) => {
  const tree = await makeTree(t);
  const moduleUrl = new URL("../../source/activity-signal-reader.mjs", import.meta.url).href;
  const projectUrl = new URL("../../../runtime/source/project.mjs", import.meta.url).href;
  const program = `
    import { readActivitySignals } from ${JSON.stringify(moduleUrl)};
    import { resolveProject } from ${JSON.stringify(projectUrl)};
    let uncaught = 0; let unhandled = 0;
    process.on("uncaughtException", () => { uncaught += 1; });
    process.on("unhandledRejection", () => { unhandled += 1; });
    const project = await resolveProject(process.argv[1]);
    let unavailable = 0;
    for (let index = 0; index < 500; index += 1) {
      const result = await readActivitySignals({ project, authorizedPrimaryIds: new Set([${JSON.stringify(PRIMARY)}]), helperPath: "/usr/bin/true", validateArchitecture: false, timeoutMs: 1000 });
      if (result.omissions?.[0]?.code === "ACTIVITY_SIGNAL_READER_UNAVAILABLE") unavailable += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    process.stdout.write(JSON.stringify({ unavailable, uncaught, unhandled }));
    if (uncaught || unhandled || unavailable !== 500) process.exitCode = 1;
  `;
  const { stdout, stderr } = await exec(process.execPath, ["--input-type=module", "-e", program, tree.projectRoot], { maxBuffer: 1024 * 1024 });
  assert.deepEqual(JSON.parse(stdout), { unavailable: 500, uncaught: 0, unhandled: 0 });
  assert.equal(stderr, "");
});

test("missing private runtime is partial unsafe while missing signals is complete zero", async (t) => {
  const privateMissing = await makeTree(t);
  await rm(privateMissing.privateRuntime, { recursive: true, force: true });
  const partial = await inspect(privateMissing.projectRoot);
  assert.equal(partial.partial, true);
  assert.equal(partial.omissions[0].code, "ACTIVITY_SIGNAL_DIRECTORY_UNSAFE");

  const signalsMissing = await makeTree(t);
  await rm(signalsMissing.signals, { recursive: true, force: true });
  assert.deepEqual(await inspect(signalsMissing.projectRoot), { entries: [], omissions: [], diagnostics: [], partial: false });
});

test("genuinely missing signals directory is verified complete zero", async (t) => {
  const tree = await makeTree(t);
  await rm(tree.signals, { recursive: true, force: true });
  const result = await inspect(tree.projectRoot);
  assert.deepEqual(result, { entries: [], omissions: [], diagnostics: [], partial: false });
});
