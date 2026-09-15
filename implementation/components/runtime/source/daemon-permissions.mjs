import { createReadStream } from "node:fs";
import { locateTaskHistory, resolveCodexSessionRoots } from "./codex-session-locator.mjs";
import { readCodexTaskRunSettings } from "./codex-jsonl.mjs";
import { taskRunContextFromSettings } from "./task-run-context.mjs";

export function requireFullAccess(context) {
  const permission = context?.permission;
  if (permission?.type === "profile" && permission.id === ":danger-full-access") return context;
  if (permission?.type === "sandbox"
      && permission.policy?.type === "dangerFullAccess") return context;
  const error = new Error("Codex Small Loop daemon operations require verified full access.");
  error.code = "DAEMON_FULL_ACCESS_REQUIRED";
  throw error;
}

// Check the invoking Codex turn before starting or connecting to the host.
// A standalone shell has no Codex turn; its OS permissions govern execution.
export async function verifyDaemonCaller({ env = process.env,
  locate = locateTaskHistory, read = readCodexTaskRunSettings } = {}) {
  if (env.CODEX_SANDBOX) requireFullAccess(null);
  if (!env.CODEX_THREAD_ID) return;
  try {
    const history = await locate(env.CODEX_THREAD_ID, {
      roots: resolveCodexSessionRoots(env.CODEX_HOME),
    });
    if (history?.location !== "active" || !history.historyFile) requireFullAccess(null);
    const result = await read(createReadStream(history.historyFile), env.CODEX_THREAD_ID);
    requireFullAccess(taskRunContextFromSettings(result.settings));
  } catch (cause) {
    if (cause.code === "DAEMON_FULL_ACCESS_REQUIRED") throw cause;
    const error = new Error("Cannot verify full access for the invoking Codex turn.", { cause });
    error.code = "DAEMON_FULL_ACCESS_REQUIRED";
    throw error;
  }
}
