import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inspectUniversalMachO } from "../../../board/source/activity-signal-reader.mjs";

const repositoryRoot = path.resolve(
  fileURLToPath(new URL("../../../../../", import.meta.url)),
);

test("packaged macOS helpers are executable, signed, and universal", async () => {
  for (const relative of [
    "implementation/components/board/native/activity-signal-reader",
    "implementation/components/board/native/sonner-open-file",
    "implementation/components/sonner/native/sonner-project-reader",
    "implementation/components/sonner/native/sonner-runtime-reader",
    "implementation/components/sonner/native/sonner-task-history-reader",
  ]) {
    const helper = path.join(repositoryRoot, relative);
    await access(helper, constants.X_OK);
    assert.deepEqual(
      await inspectUniversalMachO(helper),
      { arm64: true, x86_64: true },
      relative,
    );
    assert.equal(
      spawnSync(
        "/usr/bin/codesign",
        ["--verify", "--strict", helper],
        { shell: false },
      ).status,
      0,
      relative,
    );
  }
});
