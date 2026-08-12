import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveCodexRuntime,
} from "../source/codex-runtime-resolver.mjs";

test("normalizes a platform adapter result into one immutable runtime contract", async () => {
  const runtime = await resolveCodexRuntime({
    platform: "darwin",
    adapters: {
      darwin: {
        source: "desktop-bundled",
        resolve: async () => ({
          executablePath: "/Applications/ChatGPT.app/Contents/Resources/codex",
          appBundlePath: "/Applications/ChatGPT.app",
          version: "0.147.0",
        }),
      },
    },
  });

  assert.deepEqual(runtime, {
    executablePath: "/Applications/ChatGPT.app/Contents/Resources/codex",
    appBundlePath: "/Applications/ChatGPT.app",
    version: "0.147.0",
    source: "desktop-bundled",
    platform: "darwin",
  });
  assert.equal(Object.isFrozen(runtime), true);
});

test("uses platform-native absolute path semantics", async () => {
  const runtime = await resolveCodexRuntime({
    platform: "win32",
    adapters: {
      win32: {
        source: "external-cli",
        resolve: async () => ({
          executablePath: "C:\\Program Files\\Codex\\codex.exe",
          version: "0.147.0",
        }),
      },
    },
  });

  assert.equal(runtime.executablePath, "C:\\Program Files\\Codex\\codex.exe");
  assert.equal(runtime.source, "external-cli");
});

test("rejects unsupported platforms before attempting resolution", async () => {
  await assert.rejects(
    resolveCodexRuntime({ platform: "win32", adapters: {} }),
    (error) => error.code === "CODEX_RUNTIME_PLATFORM_UNSUPPORTED",
  );
});

test("rejects malformed adapter results", async () => {
  await assert.rejects(
    resolveCodexRuntime({
      platform: "darwin",
      adapters: {
        darwin: {
          source: "desktop-bundled",
          resolve: async () => ({
            executablePath: "relative/codex",
            version: "0.147.0",
          }),
        },
      },
    }),
    (error) => error.code === "CODEX_RUNTIME_INVALID",
  );
});
