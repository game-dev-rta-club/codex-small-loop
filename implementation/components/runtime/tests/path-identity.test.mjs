import assert from "node:assert/strict";
import test from "node:test";

import { pathsEqual } from "../source/path-identity.mjs";

test("compares Windows paths with native separator and case semantics", () => {
  assert.equal(pathsEqual("C:\\Work\\Project", "c:/work/project/", "win32"), true);
  assert.equal(pathsEqual("C:\\Work\\Project", "D:\\Work\\Project", "win32"), false);
});

test("preserves POSIX case-sensitive path semantics", () => {
  assert.equal(pathsEqual("/work/project/", "/work/project", "darwin"), true);
  assert.equal(pathsEqual("/Work/Project", "/work/project", "darwin"), false);
});

test("rejects non-string path values", () => {
  assert.equal(pathsEqual(null, "/work/project", "darwin"), false);
  assert.equal(pathsEqual("work/project", "/work/project", "darwin"), false);
});
