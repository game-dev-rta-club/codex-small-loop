#!/usr/bin/env node

// Internal process entry point; agents should not invoke this directly.

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  runRecoverySupervisor,
} from "../source/recovery-supervisor.mjs";

const MAX_MESSAGE_LENGTH = 512;

function bounded(value) {
  const text = String(value);
  return text.length <= MAX_MESSAGE_LENGTH
    ? text
    : `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

function usageError(message) {
  const error = new Error(message);
  error.code = "RECOVERY_SUPERVISOR_CLI_USAGE";
  return error;
}

function parseArgs(argv, cwd) {
  if (
    !Array.isArray(argv)
    || argv.some((argument) => typeof argument !== "string")
    || argv.length !== 2
    || argv[0] !== "--project-root"
    || argv[1].length === 0
    || argv[1].startsWith("--")
  ) {
    throw usageError(
      "recovery-supervisor requires --project-root <path>",
    );
  }
  return {
    projectRoot: path.resolve(cwd, argv[1]),
  };
}

function errorResult(error) {
  return {
    run: "failed",
    state: "failed",
    code: typeof error?.code === "string"
      ? bounded(error.code)
      : "RECOVERY_SUPERVISOR_FAILED",
    message: bounded(error?.message ?? "Recovery Supervisor failed."),
  };
}

export async function runRecoverySupervisorCli(argv, options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const stdout = options.stdout ?? process.stdout;
  const supervisor = options.supervisor ?? runRecoverySupervisor;

  try {
    const result = await supervisor(parseArgs(argv, cwd));
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    stdout.write(`${JSON.stringify(errorResult(error))}\n`);
    return 1;
  }
}

const main = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (main) {
  process.exitCode = await runRecoverySupervisorCli(
    process.argv.slice(2),
  );
}
