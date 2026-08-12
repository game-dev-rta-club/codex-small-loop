#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  inspectProjectRuntime,
  repairProjectRuntime,
} from "../runtime/source/project-setup.mjs";
import { diagnoseCodexRuntime } from "../runtime/source/codex-runtime-doctor.mjs";

const COMMANDS = new Set(["doctor", "repair", "status"]);

function parseArgs(argv, cwd) {
  if (
    !Array.isArray(argv)
    || !COMMANDS.has(argv[0])
    || (argv[0] === "doctor" && argv.length !== 1)
    || (argv[0] !== "doctor" && (
      argv.length !== 1
      && !(
        argv.length === 3
        && argv[1] === "--project-root"
        && !argv[2].startsWith("--")
      )
    ))
  ) {
    const error = new Error(
      "runtime requires doctor, or status or repair with an optional --project-root <path>.",
    );
    error.code = "RUNTIME_CLI_USAGE";
    throw error;
  }
  return {
    command: argv[0],
    ...(argv[0] === "doctor"
      ? {}
      : { projectRoot: path.resolve(cwd, argv[2] ?? ".") }),
  };
}

function errorResult(error, operation) {
  return {
    run: "failed",
    operation,
    code: typeof error?.code === "string"
      ? error.code
      : "RUNTIME_OPERATION_FAILED",
    message: String(error?.message ?? "Runtime operation failed").slice(0, 512),
  };
}

export async function runRuntimeCli(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  let operation = "runtime";
  try {
    const input = parseArgs(argv, path.resolve(options.cwd ?? process.cwd()));
    operation = input.command;
    const result = input.command === "doctor"
      ? await (options.doctor ?? diagnoseCodexRuntime)()
      : input.command === "repair"
        ? await (options.repair ?? repairProjectRuntime)(input.projectRoot)
        : await (options.inspect ?? inspectProjectRuntime)(input.projectRoot);
    stdout.write(`${JSON.stringify(result)}\n`);
    if (result.run === "failed") return 1;
    return result.run === "degraded" ? 2 : 0;
  } catch (error) {
    stdout.write(`${JSON.stringify(errorResult(error, operation))}\n`);
    return 1;
  }
}

const main = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (main) {
  process.exitCode = await runRuntimeCli(process.argv.slice(2));
}
