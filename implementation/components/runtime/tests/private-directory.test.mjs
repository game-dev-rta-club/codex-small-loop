import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  protectPrivateDirectory,
} from "../source/private-directory.mjs";

function validAclResult() {
  const current = "S-1-5-21-1001";
  return {
    protected: true,
    owner: current,
    current,
    rules: [
      { sid: current, rights: 2_032_127, type: 0 },
      { sid: "S-1-5-18", rights: 2_032_127, type: 0 },
      { sid: "S-1-5-32-544", rights: 2_032_127, type: 0 },
    ],
  };
}

test("protects a POSIX private directory with owner-only mode", async () => {
  const calls = [];
  const result = await protectPrivateDirectory("/private/runtime", {
    platform: "darwin",
    chmodDirectory: async (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [["/private/runtime", 0o700]]);
  assert.deepEqual(result, {
    directory: "/private/runtime",
    strategy: "posix-mode",
  });
});

test("protects and verifies a Windows private directory ACL", async () => {
  const directory = path.win32.resolve("C:\\private\\runtime");
  const calls = [];
  const result = await protectPrivateDirectory(directory, {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    execute: async (...args) => {
      calls.push(args);
      return { stdout: JSON.stringify(validAclResult()), stderr: "" };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0][2].env.CODEX_SMALL_LOOP_PRIVATE_DIRECTORY,
    directory,
  );
  assert.deepEqual(result, { directory, strategy: "windows-acl" });
});

test("fails closed when a Windows private ACL contains another principal", async () => {
  const acl = validAclResult();
  acl.rules.push({ sid: "S-1-5-21-1002", rights: 1, type: 0 });

  await assert.rejects(
    protectPrivateDirectory(path.win32.resolve("C:\\private\\runtime"), {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      execute: async () => ({ stdout: JSON.stringify(acl), stderr: "" }),
    }),
    (error) => error.code === "PRIVATE_DIRECTORY_ACL_INVALID",
  );
});

test("rejects relative private directory paths", async () => {
  await assert.rejects(
    protectPrivateDirectory("relative", { platform: "darwin" }),
    /absolute path/,
  );
});
