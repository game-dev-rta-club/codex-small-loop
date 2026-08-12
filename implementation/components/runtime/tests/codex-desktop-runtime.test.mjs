import assert from "node:assert/strict";
import test from "node:test";

import {
  attestInstalledDesktopCodex,
} from "../source/codex-desktop-runtime.mjs";

const EXPECTED_IDENTITY = Object.freeze({
  identifier: "com.openai.codex",
  teamIdentifier: "2DC432GLL2",
});

const APP_BUNDLE = "/Applications/ChatGPT.app";
const EXECUTABLE = `${APP_BUNDLE}/Contents/Resources/codex`;

function validDependencies(overrides = {}) {
  return {
    platform: "darwin",
    locateApplication: async () => `${APP_BUNDLE}/\n`,
    realpath: async (value) => value.replace(/\/$/, ""),
    inspectSignature: async () => EXPECTED_IDENTITY,
    readVersion: async () => "codex-cli 0.146.0-alpha.3.1",
    ...overrides,
  };
}

test("attests the installed Codex App without process ancestry", async () => {
  const locatedBundleIds = [];

  const result = await attestInstalledDesktopCodex({
    ...validDependencies({
      locateApplication: async (bundleId) => {
        locatedBundleIds.push(bundleId);
        return `${APP_BUNDLE}/\n`;
      },
    }),
  });

  assert.deepEqual(result, {
    executablePath: EXECUTABLE,
    appBundlePath: APP_BUNDLE,
    version: "0.146.0-alpha.3.1",
  });
  assert.deepEqual(locatedBundleIds, ["com.openai.codex"]);
});

test("rejects execution when LaunchServices cannot locate Codex App", async () => {
  await assert.rejects(
    attestInstalledDesktopCodex({
      ...validDependencies({ locateApplication: async () => "" }),
    }),
    (error) => error.code === "CODEX_DESKTOP_APP_NOT_FOUND"
      && /Codex App/.test(error.message),
  );
});

test("rejects a lookalike app bundle with the wrong signing identity", async () => {
  await assert.rejects(
    attestInstalledDesktopCodex({
      ...validDependencies({
        locateApplication: async () => "/tmp/ChatGPT.app\n",
        inspectSignature: async () => ({
          identifier: "example.lookalike",
          teamIdentifier: "NOT-OPENAI",
        }),
      }),
    }),
    (error) => error.code === "CODEX_DESKTOP_IDENTITY_INVALID",
  );
});

test("rejects an embedded codex executable that resolves outside the signed bundle", async () => {
  await assert.rejects(
    attestInstalledDesktopCodex({
      ...validDependencies({
        realpath: async (value) => value.endsWith("/Contents/Resources/codex")
          ? "/tmp/codex"
          : value.replace(/\/$/, ""),
      }),
    }),
    (error) => error.code === "CODEX_DESKTOP_IDENTITY_INVALID",
  );
});

test("rejects malformed or empty Desktop version output", async () => {
  await assert.rejects(
    attestInstalledDesktopCodex({
      ...validDependencies({ readVersion: async () => "unexpected" }),
    }),
    (error) => error.code === "CODEX_DESKTOP_VERSION_INVALID",
  );
});
