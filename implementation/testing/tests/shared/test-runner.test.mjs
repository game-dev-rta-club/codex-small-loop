import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyTestFile,
  discoverTestFiles,
  selectTestFiles,
} from "../../test-runner.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-test-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [
    "components/example/tests/legacy.test.mjs",
    "components/example/tests/shared/parser.test.mjs",
    "components/example/tests/darwin/native.test.mjs",
    "components/example/tests/win32/portable.test.mjs",
  ];
  for (const relative of files) {
    const filename = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, "");
  }
  return { root, files };
}

test("classifies shared and platform test directories without host path semantics", () => {
  assert.equal(classifyTestFile("components/example/tests/legacy.test.mjs"), "shared");
  assert.equal(classifyTestFile("components/example/tests/shared/parser.test.mjs"), "shared");
  assert.equal(classifyTestFile("components/example/tests/darwin/native.test.mjs"), "darwin");
  assert.equal(classifyTestFile("components/example/tests/win32/portable.test.mjs"), "win32");
  assert.equal(classifyTestFile("components/example/source/not-a-test.mjs"), null);
});

test("discovers deterministic shared and current-platform suites", async (t) => {
  const { root, files } = await fixture(t);
  const discovered = await discoverTestFiles(root);
  assert.deepEqual(
    discovered.map(({ relativePath, suite }) => ({ relativePath, suite })),
    files.map((relativePath) => ({
      relativePath,
      suite: relativePath.includes("/darwin/")
        ? "darwin"
        : relativePath.includes("/win32/") ? "win32" : "shared",
    })),
  );
  assert.deepEqual(
    selectTestFiles(discovered, "shared", "win32").map(({ relativePath }) => relativePath),
    files.slice(0, 2),
  );
  assert.deepEqual(
    selectTestFiles(discovered, "win32", "win32").map(({ relativePath }) => relativePath),
    [...files.slice(0, 2), files[3]],
  );
  assert.deepEqual(
    selectTestFiles(discovered, "darwin", "darwin").map(({ relativePath }) => relativePath),
    [...files.slice(0, 3)],
  );
});

test("rejects running an OS suite on a different host", async (t) => {
  const { root } = await fixture(t);
  const discovered = await discoverTestFiles(root);
  assert.throws(
    () => selectTestFiles(discovered, "darwin", "win32"),
    (error) => error.code === "TEST_SUITE_PLATFORM_MISMATCH",
  );
  assert.throws(
    () => selectTestFiles(discovered, "win32", "darwin"),
    (error) => error.code === "TEST_SUITE_PLATFORM_MISMATCH",
  );
});
