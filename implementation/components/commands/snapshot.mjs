#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createReviewSnapshot,
} from "../runtime/source/review-snapshot.mjs";

const MAX_MESSAGE_LENGTH = 512;
const MAX_TASK_ID_LENGTH = 512;

function bounded(value, maximum = MAX_MESSAGE_LENGTH) {
  const text = String(value);
  return text.length <= maximum
    ? text
    : `${text.slice(0, maximum - 1)}…`;
}

function cliError(code, message) {
  const error = new Error(message);
  error.name = "SnapshotCliError";
  error.code = code;
  return error;
}

function validTaskId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_TASK_ID_LENGTH
    && !/\s/.test(value);
}

function parseArgs(argv, cwd) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")) {
    throw cliError(
      "SNAPSHOT_CLI_USAGE",
      "snapshot arguments must be an array of strings.",
    );
  }
  if (argv[0] !== "create") {
    throw cliError(
      "SNAPSHOT_CLI_USAGE",
      "snapshot requires create --task <primary-task-id>.",
    );
  }

  let primaryTaskId;
  let projectRoot = cwd;
  let forceNew = false;
  const seen = new Set();

  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (!new Set(["--task", "--project-root", "--force-new"]).has(option)) {
      throw cliError(
        "SNAPSHOT_CLI_USAGE",
        `Unsupported snapshot argument: ${bounded(option, 128)}`,
      );
    }
    if (seen.has(option)) {
      throw cliError(
        "SNAPSHOT_CLI_USAGE",
        `Snapshot argument is repeated: ${option}`,
      );
    }
    seen.add(option);
    if (option === "--force-new") {
      forceNew = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw cliError(
        "SNAPSHOT_CLI_USAGE",
        `Snapshot argument requires a value: ${option}`,
      );
    }
    index += 1;
    if (option === "--task") {
      primaryTaskId = value;
    } else {
      projectRoot = path.resolve(cwd, value);
    }
  }

  if (primaryTaskId === undefined) {
    throw cliError(
      "PRIMARY_TASK_REQUIRED",
      "snapshot create requires --task <primary-task-id>.",
    );
  }
  if (!validTaskId(primaryTaskId)) {
    throw cliError(
      "PRIMARY_TASK_INVALID",
      "Primary Task ID must be a non-empty bounded identifier.",
    );
  }

  return {
    primaryTaskId,
    projectRoot,
    forceNew,
  };
}

function errorResult(error) {
  return {
    run: "failed",
    operation: "snapshot-create",
    code: typeof error?.code === "string"
      ? bounded(error.code, 128)
      : "REVIEW_SNAPSHOT_FAILED",
    message: bounded(error?.message ?? "Review snapshot creation failed."),
  };
}

export async function runSnapshotCli(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const create = options.create ?? createReviewSnapshot;
  try {
    const input = parseArgs(
      argv,
      path.resolve(options.cwd ?? process.cwd()),
    );
    const result = await create(input);
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
  process.exitCode = await runSnapshotCli(process.argv.slice(2));
}
