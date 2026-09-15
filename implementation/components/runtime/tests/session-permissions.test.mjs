import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { readCodexTaskRunSettings } from "../source/codex-jsonl.mjs";
import { taskRunContextFromSettings, threadSettingsFromTaskRunContext } from "../source/task-run-context.mjs";

function context() {
  return { cwd: path.normalize("/project"), workspace_roots: [path.normalize("/project")], model: "gpt-5.6-sol", effort: "medium", approval_policy: "never",
    sandbox_policy: { type: "workspace-write", network_access: false, exclude_slash_tmp: false, exclude_tmpdir_env_var: false },
    permission_profile: { type: "managed", network: "restricted", file_system: { type: "restricted", entries: [
      { path: { type: "special", value: { kind: "root" } }, access: "read" },
      { path: { type: "path", path: path.normalize("/project") }, access: "write" },
      ...["slash_tmp", "tmpdir"].map((kind) => ({ path: { type: "special", value: { kind } }, access: "write" })),
      ...[".git", ".agents", ".codex"].map((name) => ({ path: { type: "path", path: path.join("/project", name) }, access: "read", missing_path_behavior: "skip" })),
    ] } } };
}
function read(...contexts) {
  return readCodexTaskRunSettings(Readable.from([
    JSON.stringify({ type: "session_meta", payload: { id: "task", cwd: path.normalize("/project") } }),
    ...contexts.map((payload) => JSON.stringify({ type: "turn_context", payload })),
  ].join("\n")), "task");
}
test("anonymous Desktop heartbeat permissions retain workspace and network restrictions through fork settings", async () => {
  const result = await read(context());
  const settings = threadSettingsFromTaskRunContext(taskRunContextFromSettings(result.settings));
  assert.equal(settings.sandbox, "workspace-write");
  assert.deepEqual(settings.config.sandbox_workspace_write, { writable_roots: [], network_access: false, exclude_slash_tmp: false, exclude_tmpdir_env_var: false });
});
test("custom read-only exceptions are rejected instead of granting workspace-wide writes", async () => {
  const value = context();
  value.permission_profile.file_system.entries.push({ path: { type: "path", path: path.join("/project", "private") }, access: "read" });
  await assert.rejects(read(value), { code: "TASK_TURN_CONTEXT_INVALID" });
});
test("only the latest context is authoritative, and an invalid latest context never falls back to older privileges", async () => {
  const invalid = { ...context(), permission_profile: { type: "managed" } };
  await read(invalid, context());
  await assert.rejects(read(context(), invalid), { code: "TASK_TURN_CONTEXT_INVALID" });
});
