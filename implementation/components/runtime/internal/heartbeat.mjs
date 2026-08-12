#!/usr/bin/env node

// Internal process entry point; agents should not invoke this directly.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { runHeartbeat } from "../source/heartbeat.mjs";
import {
  startRecoverySupervisor,
  supervisorHasWork,
} from "../source/recovery-supervisor.mjs";

const MAX_MESSAGE_LENGTH = 512;

function bounded(value, maximum = MAX_MESSAGE_LENGTH) {
  const text = String(value);
  return text.length <= maximum
    ? text
    : `${text.slice(0, maximum - 1)}…`;
}

function usageError(message) {
  const error = new Error(message);
  error.code = "HEARTBEAT_CLI_USAGE";
  return error;
}

function parseArgs(argv, cwd) {
  if (
    !Array.isArray(argv)
    || argv.some((argument) => typeof argument !== "string")
  ) {
    throw usageError("Heartbeat arguments must be strings.");
  }
  if (argv.length !== 2 || argv[0] !== "--project-root") {
    throw usageError(
      "heartbeat requires --project-root <absolute-or-relative-path>",
    );
  }
  if (argv[1].length === 0 || argv[1].startsWith("--")) {
    throw usageError(
      "heartbeat --project-root requires one path.",
    );
  }
  return {
    projectRoot: path.resolve(cwd, argv[1]),
  };
}

function errorResult(error) {
  return {
    run: "failed",
    operation: "heartbeat",
    code: typeof error?.code === "string"
      ? bounded(error.code, 128)
      : "HEARTBEAT_FAILED",
    message: bounded(error?.message ?? "Heartbeat failed."),
  };
}

export async function runHeartbeatCli(argv, options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const stdout = options.stdout ?? process.stdout;
  const heartbeat = options.heartbeat ?? runHeartbeat;
  const startSupervisor = options.startSupervisor
    ?? startRecoverySupervisor;

  try {
    const input = parseArgs(argv, cwd);
    const result = await heartbeat(input);
    if (supervisorHasWork(result)) {
      await startSupervisor(input.projectRoot);
    }
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.run === "partial" ? 2 : 0;
  } catch (error) {
    stdout.write(`${JSON.stringify(errorResult(error))}\n`);
    return 1;
  }
}

const main = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (main) {
  process.exitCode = await runHeartbeatCli(process.argv.slice(2));
}
