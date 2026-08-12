import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createReviewSnapshot,
  listReviewSnapshots,
  reviewSnapshotRef,
  ReviewSnapshotError,
  runReviewSnapshotGit,
} from "../source/review-snapshot.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  }).trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "csl review snapshot "));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Codex Small Loop Test");
  git(root, "config", "user.email", "codex-small-loop@example.invalid");
  await writeFile(path.join(root, "tracked.txt"), "baseline\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "baseline");
  return root;
}

test("runs Git without a shell or visible Windows window", async () => {
  const calls = [];
  const env = { GIT_OPTIONAL_LOCKS: "0" };
  const cwd = path.resolve("Project With Spaces");
  const output = await runReviewSnapshotGit(
    cwd,
    ["rev-parse", "--show-toplevel"],
    env,
    async (...args) => {
      calls.push(args);
      return { stdout: "  verified root  \n" };
    },
  );

  assert.equal(output, "verified root");
  assert.deepEqual(calls, [[
    "git",
    ["-C", cwd, "rev-parse", "--show-toplevel"],
    {
      encoding: "utf8",
      env,
      maxBuffer: 16 * 1_024 * 1_024,
      shell: false,
      windowsHide: true,
    },
  ]]);
});

test("captures dirty tracked, staged, and untracked files without changing user Git state", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(path.join(root, "tracked.txt"), "worktree change\n");
  await writeFile(path.join(root, "staged.txt"), "staged content\n");
  git(root, "add", "staged.txt");
  await writeFile(path.join(root, "untracked name.txt"), "untracked content\n");

  const before = {
    head: git(root, "rev-parse", "HEAD"),
    status: git(root, "status", "--porcelain=v1", "-z"),
    cached: git(root, "diff", "--cached", "--binary"),
    worktree: git(root, "diff", "--binary"),
  };

  const result = await createReviewSnapshot({
    primaryTaskId: "primary-task-1",
    projectRoot: root,
  });

  assert.equal(result.run, "ok");
  assert.equal(result.operation, "snapshot-create");
  assert.equal(result.created, true);
  assert.equal(result.previousSnapshot, before.head);
  assert.match(result.currentSnapshot, /^[0-9a-f]{40,64}$/);
  assert.match(result.tree, /^[0-9a-f]{40,64}$/);
  assert.match(result.ref, /^refs\/codex-small-loop\/review-snapshots\/[0-9a-f]{64}$/);
  assert.deepEqual(result.diff, {
    command: "git",
    args: [
      "-C",
      result.gitRoot,
      "diff",
      "--find-renames",
      "--no-ext-diff",
      "--no-color",
      result.previousSnapshot,
      result.currentSnapshot,
      "--",
      ".",
    ],
  });

  assert.equal(
    git(root, "show", `${result.currentSnapshot}:tracked.txt`),
    "worktree change",
  );
  assert.equal(
    git(root, "show", `${result.currentSnapshot}:staged.txt`),
    "staged content",
  );
  assert.equal(
    git(root, "show", `${result.currentSnapshot}:untracked name.txt`),
    "untracked content",
  );

  assert.deepEqual({
    head: git(root, "rev-parse", "HEAD"),
    status: git(root, "status", "--porcelain=v1", "-z"),
    cached: git(root, "diff", "--cached", "--binary"),
    worktree: git(root, "diff", "--binary"),
  }, before);
});

test("chains review snapshots and returns an exact previous-to-current diff command", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(path.join(root, "tracked.txt"), "candidate one\n");
  const first = await createReviewSnapshot({
    primaryTaskId: "primary-task-2",
    projectRoot: root,
  });

  await writeFile(path.join(root, "tracked.txt"), "candidate two\n");
  await writeFile(path.join(root, "added.txt"), "second pass\n");
  const second = await createReviewSnapshot({
    primaryTaskId: "primary-task-2",
    projectRoot: root,
  });

  assert.equal(second.created, true);
  assert.equal(second.previousSnapshot, first.currentSnapshot);
  assert.notEqual(second.currentSnapshot, first.currentSnapshot);
  assert.equal(git(root, "rev-parse", second.ref), second.currentSnapshot);

  const diff = execFileSync(second.diff.command, second.diff.args, {
    encoding: "utf8",
  });
  assert.match(diff, /-candidate one/);
  assert.match(diff, /\+candidate two/);
  assert.match(diff, /\+second pass/);
  assert.doesNotMatch(diff, /-baseline/);

  const unchanged = await createReviewSnapshot({
    primaryTaskId: "primary-task-2",
    projectRoot: root,
  });
  assert.equal(unchanged.created, false);
  assert.equal(unchanged.previousSnapshot, second.currentSnapshot);
  assert.equal(unchanged.currentSnapshot, second.currentSnapshot);
  assert.equal(execFileSync(unchanged.diff.command, unchanged.diff.args, {
    encoding: "utf8",
  }), "");

  const forced = await createReviewSnapshot({
    primaryTaskId: "primary-task-2",
    projectRoot: root,
    forceNew: true,
  });
  assert.equal(forced.created, true);
  assert.equal(forced.previousSnapshot, second.currentSnapshot);
  assert.notEqual(forced.currentSnapshot, second.currentSnapshot);
  assert.equal(forced.tree, second.tree);
  assert.equal(execFileSync(forced.diff.command, forced.diff.args, {
    encoding: "utf8",
  }), "");
});

test("rejects invalid task IDs and projects without a committed Git baseline", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "csl-review-snapshot-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    createReviewSnapshot({
      primaryTaskId: "contains whitespace",
      projectRoot: root,
    }),
    (error) => {
      assert.ok(error instanceof ReviewSnapshotError);
      assert.equal(error.code, "REVIEW_SNAPSHOT_INVALID");
      return true;
    },
  );

  await assert.rejects(
    createReviewSnapshot({
      primaryTaskId: "primary-task-3",
      projectRoot: root,
    }),
    (error) => {
      assert.ok(error instanceof ReviewSnapshotError);
      assert.equal(error.code, "REVIEW_SNAPSHOT_GIT_UNAVAILABLE");
      return true;
    },
  );
});

test("lists first-parent Review Cycles including forced same-tree snapshots", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await createReviewSnapshot({ primaryTaskId: "primary-history", projectRoot: root });
  const second = await createReviewSnapshot({ primaryTaskId: "primary-history", projectRoot: root, forceNew: true });
  const result = await listReviewSnapshots({ primaryTaskId: "primary-history", projectRoot: root });
  assert.deepEqual(result.snapshots.map(({ snapshot, previousSnapshot, sequence }) => ({ snapshot, previousSnapshot, sequence })), [
    { snapshot: first.currentSnapshot, previousSnapshot: first.previousSnapshot, sequence: 0 },
    { snapshot: second.currentSnapshot, previousSnapshot: first.currentSnapshot, sequence: 1 },
  ]);
  assert.ok(result.snapshots.every((snapshot) => typeof snapshot.createdAt === "string"));
  assert.equal(result.partial, false);

  const absent = await listReviewSnapshots({ primaryTaskId: "independent-primary", projectRoot: root });
  assert.deepEqual(absent.snapshots, []);
});

test("bounds snapshot traversal and rejects non-attested or wrong-object refs", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await createReviewSnapshot({ primaryTaskId: "bounded-primary", projectRoot: root });
  await createReviewSnapshot({ primaryTaskId: "bounded-primary", projectRoot: root, forceNew: true });
  const bounded = await listReviewSnapshots({ primaryTaskId: "bounded-primary", projectRoot: root, maximum: 1 });
  assert.equal(bounded.snapshots.length, 1);
  assert.equal(bounded.partial, true);
  assert.equal(bounded.diagnostics[0].code, "REVIEW_SNAPSHOT_HISTORY_BOUNDED");

  const ordinaryRef = reviewSnapshotRef("non-attested");
  git(root, "update-ref", ordinaryRef, "HEAD");
  await assert.rejects(
    listReviewSnapshots({ primaryTaskId: "non-attested", projectRoot: root }),
    (error) => error.code === "REVIEW_SNAPSHOT_HISTORY_INVALID",
  );

  const blob = git(root, "hash-object", "-w", "tracked.txt");
  const blobRef = reviewSnapshotRef("wrong-object");
  git(root, "update-ref", blobRef, blob);
  await assert.rejects(
    listReviewSnapshots({ primaryTaskId: "wrong-object", projectRoot: root }),
    (error) => error.code === "REVIEW_SNAPSHOT_HISTORY_INVALID",
  );
});
