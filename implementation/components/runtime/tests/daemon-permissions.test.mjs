import assert from "node:assert/strict";
import test from "node:test";
import { requireFullAccess, verifyDaemonCaller } from "../source/daemon-permissions.mjs";

test("daemon authority rejects restricted and unknown profiles", () => {
  for (const permission of [null, { type: "profile", id: "custom" },
    { type: "sandbox", policy: { type: "workspaceWrite" } },
    { type: "sandbox", policy: { type: "readOnly" } }]) {
    assert.throws(() => requireFullAccess({ permission }), { code: "DAEMON_FULL_ACCESS_REQUIRED" });
  }
  for (const permission of [{ type: "profile", id: ":danger-full-access" },
    { type: "sandbox", policy: { type: "dangerFullAccess" } }]) {
    assert.doesNotThrow(() => requireFullAccess({ permission }));
  }
});

test("sandbox caller fails before any history or host access", async () => {
  await assert.rejects(verifyDaemonCaller({ env: { CODEX_SANDBOX: "seatbelt" },
    locate() { assert.fail("must not inspect or launch"); } }), { code: "DAEMON_FULL_ACCESS_REQUIRED" });
});

test("missing caller evidence fails closed", async () => {
  await assert.rejects(verifyDaemonCaller({ env: { CODEX_THREAD_ID: "missing" },
    async locate() { return { location: "missing" }; } }), { code: "DAEMON_FULL_ACCESS_REQUIRED" });
});
