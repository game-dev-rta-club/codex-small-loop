import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPortablePathMetadata,
} from "../source/portable-path-type.mjs";

function metadata({ file = false, link = false } = {}) {
  return {
    isFile: () => file,
    isSymbolicLink: () => link,
  };
}

test("classifies portable path metadata without creating OS links", () => {
  assert.equal(
    classifyPortablePathMetadata(metadata({ file: true })),
    "regular-file",
  );
  assert.equal(
    classifyPortablePathMetadata(metadata({ file: true, link: true })),
    "symlink",
  );
  assert.equal(classifyPortablePathMetadata(metadata()), "other");
});
