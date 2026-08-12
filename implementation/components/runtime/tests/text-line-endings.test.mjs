import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeLineEndings,
} from "../source/text-line-endings.mjs";

test("normalizes CRLF and lone CR without changing LF text", () => {
  assert.equal(
    normalizeLineEndings("one\r\ntwo\rthree\nfour\n"),
    "one\ntwo\nthree\nfour\n",
  );
});

test("rejects non-text input", () => {
  assert.throws(() => normalizeLineEndings(null), /must be a string/);
});
