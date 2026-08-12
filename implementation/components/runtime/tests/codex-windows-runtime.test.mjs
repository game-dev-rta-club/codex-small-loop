import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectWindowsAuthenticode,
  readWindowsProcess,
  resolveWindowsExternalCodex,
} from "../source/codex-windows-runtime.mjs";

const ENV = Object.freeze({
  LOCALAPPDATA: "C:\\Users\\person\\AppData\\Local",
  SystemRoot: "C:\\Windows",
});
const INSTALLED = "C:\\Users\\person\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";

function validDependencies(overrides = {}) {
  return {
    platform: "win32",
    env: ENV,
    realpath: async (value) => value,
    stat: async () => ({ isFile: () => true }),
    inspectSignature: async () => ({
      status: "Valid",
      publisher: "OpenAI OpCo, LLC",
    }),
    execute: async () => ({ stdout: "codex-cli 0.147.0\n", stderr: "" }),
    ...overrides,
  };
}

test("resolves and attests the known standalone Windows Codex installation", async () => {
  const runtime = await resolveWindowsExternalCodex(validDependencies());

  assert.deepEqual(runtime, {
    executablePath: INSTALLED,
    version: "0.147.0",
    publisher: "OpenAI OpCo, LLC",
  });
  assert.equal(Object.isFrozen(runtime), true);
});

test("gives an explicit absolute path precedence over the known location", async () => {
  const explicit = "D:\\Tools\\codex.exe";
  let received;
  const runtime = await resolveWindowsExternalCodex(validDependencies({
    env: { ...ENV, CODEX_SMALL_LOOP_CODEX_PATH: explicit },
    realpath: async (value) => {
      received = value;
      return value;
    },
  }));

  assert.equal(received, explicit);
  assert.equal(runtime.executablePath, explicit);
});

test("rejects relative overrides and packaged WindowsApps executables", async () => {
  await assert.rejects(
    resolveWindowsExternalCodex(validDependencies({
      env: { ...ENV, CODEX_SMALL_LOOP_CODEX_PATH: "codex.exe" },
    })),
    (error) => error.code === "CODEX_EXTERNAL_PATH_INVALID",
  );
  await assert.rejects(
    resolveWindowsExternalCodex(validDependencies({
      env: {
        ...ENV,
        CODEX_SMALL_LOOP_CODEX_PATH: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe",
      },
    })),
    (error) => error.code === "CODEX_EXTERNAL_WINDOWS_APPS_UNSUPPORTED",
  );
});

test("rejects an unexpected Authenticode publisher", async () => {
  await assert.rejects(
    resolveWindowsExternalCodex(validDependencies({
      inspectSignature: async () => ({
        status: "Valid",
        publisher: "Example Publisher",
      }),
    })),
    (error) => error.code === "CODEX_EXTERNAL_IDENTITY_INVALID",
  );
});

test("passes the executable path through a child-only PowerShell environment", async () => {
  const calls = [];
  const result = await inspectWindowsAuthenticode(INSTALLED, {
    env: ENV,
    execute: async (...args) => {
      calls.push(args);
      return {
        stdout: '{"status":"Valid","publisher":"OpenAI OpCo, LLC"}',
        stderr: "",
      };
    },
  });

  assert.deepEqual(result, {
    status: "Valid",
    publisher: "OpenAI OpCo, LLC",
  });
  assert.equal(calls[0][0], "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(calls[0][1].join(" ").includes(INSTALLED), false);
  assert.equal(calls[0][2].env.CODEX_SMALL_LOOP_SIGNATURE_TARGET, INSTALLED);
});

test("reads a Windows process executable path through a child-only PID", async () => {
  const calls = [];
  const result = await readWindowsProcess(42_123, {
    env: ENV,
    execute: async (...args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({ executablePath: INSTALLED }),
        stderr: "",
      };
    },
  });

  assert.deepEqual(result, { executablePath: INSTALLED });
  assert.equal(calls[0][1].join(" ").includes("42123"), false);
  assert.equal(calls[0][2].env.CODEX_SMALL_LOOP_PROCESS_ID, "42123");
});
