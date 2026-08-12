#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveProject } from "../../runtime/source/project.mjs";
import {
  BOARD_SERVER_BUILD_VERSION,
  createLeaseTracker,
  listenBoard,
  publishBoardRuntimeState,
} from "../server.mjs";

function parse(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--control-state", "--runtime-state", "--instance-id", "--stop-token", "--idle-timeout-ms"].includes(flag) || value == null) {
      throw new Error(`Unsupported Board Host argument: ${flag}`);
    }
    result[flag.slice(2).replaceAll("-", "_")] = value;
  }
  for (const field of ["control_state", "runtime_state", "instance_id", "stop_token"]) {
    if (typeof result[field] !== "string" || result[field].length === 0) throw new Error(`Missing ${field}`);
  }
  result.idle_timeout_ms = Number(result.idle_timeout_ms ?? 300_000);
  if (!Number.isSafeInteger(result.idle_timeout_ms) || result.idle_timeout_ms < 1_000) throw new Error("Invalid idle timeout");
  return result;
}

function parseControl(value) {
  if (!value || value.version !== 1 || !value.projects || typeof value.projects !== "object" || Array.isArray(value.projects)) {
    throw new Error("Invalid Board Host control state");
  }
  return value;
}

const options = parse(process.argv.slice(2));
let server;
let leaseTracker;
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  leaseTracker?.close();
  if (!server) return process.exit(0);
  server.close(() => process.exit(0));
  const forceClose = setTimeout(() => server.closeAllConnections(), 100);
  forceClose.unref?.();
};

try {
  const projectResolver = async (key) => {
    const control = parseControl(JSON.parse(await readFile(options.control_state, "utf8")));
    const record = control.projects[key];
    if (!record || record.key !== key || typeof record.root !== "string") return null;
    const project = await resolveProject(record.root);
    return project.key === key
      && project.rootIdentity.dev.toString() === record.dev
      && project.rootIdentity.ino.toString() === record.ino
      ? project : null;
  };
  leaseTracker = createLeaseTracker({ idleTimeoutMs: options.idle_timeout_ms, onIdle: close });
  const listened = await listenBoard({
    projectResolver,
    leaseTracker,
    stopToken: options.stop_token,
    onStop: close,
    runtimeIdentity: { instanceId: options.instance_id, pid: process.pid },
  });
  server = listened.server;
  const port = Number(new URL(listened.url).port);
  await publishBoardRuntimeState(options.runtime_state, {
    version: 1,
    instanceId: options.instance_id,
    pid: process.pid,
    port,
    baseUrl: listened.url,
    buildVersion: BOARD_SERVER_BUILD_VERSION,
    serverPath: fileURLToPath(import.meta.url),
    startedAt: new Date().toISOString(),
    stopToken: options.stop_token,
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, close);
} catch (error) {
  process.stderr.write(`Codex Small Loop Board Host could not start: ${error.message}\n`);
  process.exitCode = 1;
}
