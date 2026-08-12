import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseCodexRuntime } from "../source/codex-runtime-doctor.mjs";

const RUNTIME = Object.freeze({
  executablePath: "C:\\Tools\\codex.exe",
  version: "0.147.0",
  source: "external-cli",
  publisher: "OpenAI OpCo, LLC",
});

test("reports the active Node runtime and verified Codex capabilities", async () => {
  const calls = [];
  const result = await diagnoseCodexRuntime({
    platform: "win32",
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    nodeVersion: "v24.19.0",
    resolveRuntime: async ({ platform }) => {
      assert.equal(platform, "win32");
      return RUNTIME;
    },
    execute: async (_executable, args) => {
      calls.push(args);
      return args[0] === "login"
        ? { stdout: "Logged in using ChatGPT\n", stderr: "" }
        : {
          stdout: [
            "--listen <URL> Supported: ws://IP:PORT",
            "--ws-auth <MODE> capability-token",
            "--ws-token-file <PATH>",
          ].join("\n"),
          stderr: "",
        };
    },
  });

  assert.deepEqual(result, {
    run: "ok",
    platform: "win32",
    node: {
      executablePath: "C:\\Program Files\\nodejs\\node.exe",
      version: "24.19.0",
    },
    codex: RUNTIME,
    authentication: { method: "chatgpt" },
    appServer: {
      transport: "loopback-websocket",
      authentication: "capability-token",
    },
  });
  assert.deepEqual(calls, [["login", "status"], ["app-server", "--help"]]);
});

test("retains the Unix WebSocket requirement on macOS", async () => {
  const result = await diagnoseCodexRuntime({
    platform: "darwin",
    nodeExecutable: "/usr/local/bin/node",
    nodeVersion: "v24.19.0",
    resolveRuntime: async () => ({
      executablePath: "/Applications/Codex.app/Contents/Resources/codex",
      version: "0.147.0",
      source: "desktop-bundled",
    }),
    execute: async (_executable, args) => args[0] === "login"
      ? { stdout: "Logged in using ChatGPT\n", stderr: "" }
      : { stdout: "--listen <URL> Supported: unix://PATH\n", stderr: "" },
  });

  assert.equal(result.run, "ok");
  assert.deepEqual(result.appServer, { transport: "unix-websocket" });
});

test("rejects Node versions below the supported cross-platform baseline", async () => {
  let resolved = false;
  const result = await diagnoseCodexRuntime({
    platform: "win32",
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    nodeVersion: "v23.11.1",
    resolveRuntime: async () => { resolved = true; return RUNTIME; },
  });

  assert.deepEqual(result, {
    run: "failed",
    check: "node",
    code: "NODE_VERSION_UNSUPPORTED",
    message: "Codex Small Loop requires Node.js 24 or newer.",
  });
  assert.equal(resolved, false);
});

test("returns a bounded structured failure without leaking command output", async () => {
  const result = await diagnoseCodexRuntime({
    platform: "win32",
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    nodeVersion: "v24.19.0",
    resolveRuntime: async () => RUNTIME,
    execute: async () => {
      const error = new Error(`secret:${"x".repeat(700)}`);
      error.stderr = "private output";
      throw error;
    },
  });

  assert.equal(result.run, "failed");
  assert.equal(result.check, "authentication");
  assert.equal(result.code, "CODEX_AUTH_STATUS_FAILED");
  assert.ok(result.message.length <= 512);
  assert.equal(result.message.includes("secret:"), false);
  assert.equal(JSON.stringify(result).includes("private output"), false);
});
