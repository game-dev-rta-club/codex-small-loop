import assert from "node:assert/strict";
import test from "node:test";

import { openSonnerFileReference } from "../../source/sonner-open-file.mjs";

test("Windows Open fails before touching the macOS native helper", async () => {
  let spawned = false;
  await assert.rejects(
    openSonnerFileReference(
      { rootIdentity: { dev: 1n, ino: 2n } },
      "README.md",
      {
        platform: "win32",
        spawnImpl: () => {
          spawned = true;
          throw new Error("must not spawn");
        },
      },
    ),
    (error) => error.code === "SONNER_FILE_OPEN_UNAVAILABLE",
  );
  assert.equal(spawned, false);
});
