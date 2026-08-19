import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveProject } from "../../runtime/source/project.mjs";
import {
  isPortableActivitySignalMetadata,
  readPortableActivitySignals,
} from "../source/activity-signal-reader-portable.mjs";

const primaryTaskId = "019fedf9-654d-7143-8147-b85caf1ec2c0";
const snapshot = "a".repeat(40);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-activity-win32-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, ".codex-small-loop", "signals", primaryTaskId, snapshot);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "portable-review.md"), "portable signal\n");
  return { root, directory, project: await resolveProject(root) };
}

test("Win32 portable Activity Signal reader publishes only authorized stable regular files", async (t) => {
  const { project } = await fixture(t);
  const result = await readPortableActivitySignals({
    project,
    authorizedPrimaryIds: new Set([primaryTaskId]),
  });
  assert.equal(result.partial, false);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].primaryTaskId, primaryTaskId);
  assert.equal(result.entries[0].snapshot, snapshot);
  assert.equal(result.entries[0].name, "portable-review.md");
  assert.equal(result.entries[0].raw, "portable signal\n");
});

test("Win32 portable Activity detects non-regular metadata without creating an OS link", () => {
  assert.equal(isPortableActivitySignalMetadata({
    isFile: () => true,
    isSymbolicLink: () => true,
    nlink: 1n,
  }), false);
});
