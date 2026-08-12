#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createSignal,
  listSignals,
  setSignalSeverity,
} from "../runtime/source/signal.mjs";

const MAX_MESSAGE_LENGTH = 512;

function bounded(value, maximum = MAX_MESSAGE_LENGTH) {
  const text = String(value);
  return text.length <= maximum
    ? text
    : `${text.slice(0, maximum - 1)}…`;
}

function cliError(message) {
  const error = new Error(message);
  error.name = "SignalCliError";
  error.code = "SIGNAL_CLI_USAGE";
  return error;
}

function requireOption(options, command, name) {
  const value = options.get(name);
  if (value === undefined) {
    throw cliError(`signal ${command} requires ${name} <value>.`);
  }
  return value;
}

function parseCreateArgs(argv, cwd) {
  const options = new Map();
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--json") {
      if (json) throw cliError("Signal argument is repeated: --json");
      json = true;
      continue;
    }
    if (!new Set([
      "--task",
      "--snapshot",
      "--name",
      "--template",
    ]).has(option)) {
      throw cliError(`Unsupported signal argument: ${bounded(option, 128)}`);
    }
    if (options.has(option)) {
      throw cliError(`Signal argument is repeated: ${option}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw cliError(`Signal argument requires a value: ${option}`);
    }
    options.set(option, value);
    index += 1;
  }

  return {
    input: {
      primaryTaskId: requireOption(options, "create", "--task"),
      currentSnapshot: requireOption(options, "create", "--snapshot"),
      signalName: requireOption(options, "create", "--name"),
      templateName: requireOption(options, "create", "--template"),
      projectRoot: cwd,
    },
    json,
  };
}

function parseListArgs(argv, cwd) {
  const options = new Map();
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--json") {
      if (json) throw cliError("Signal argument is repeated: --json");
      json = true;
      continue;
    }
    if (!new Set(["--task", "--snapshot"]).has(option)) {
      throw cliError(`Unsupported signal argument: ${bounded(option, 128)}`);
    }
    if (options.has(option)) {
      throw cliError(`Signal argument is repeated: ${option}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw cliError(`Signal argument requires a value: ${option}`);
    }
    options.set(option, value);
    index += 1;
  }

  return {
    input: {
      primaryTaskId: requireOption(options, "list", "--task"),
      currentSnapshot: requireOption(options, "list", "--snapshot"),
      projectRoot: cwd,
    },
    json,
  };
}

function parseSetSeverityArgs(argv, cwd) {
  const options = new Map();
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--json") {
      if (json) throw cliError("Signal argument is repeated: --json");
      json = true;
      continue;
    }
    if (!new Set([
      "--task",
      "--snapshot",
      "--name",
      "--severity",
    ]).has(option)) {
      throw cliError(`Unsupported signal argument: ${bounded(option, 128)}`);
    }
    if (options.has(option)) {
      throw cliError(`Signal argument is repeated: ${option}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw cliError(`Signal argument requires a value: ${option}`);
    }
    options.set(option, value);
    index += 1;
  }

  return {
    input: {
      primaryTaskId: requireOption(options, "set-severity", "--task"),
      currentSnapshot: requireOption(options, "set-severity", "--snapshot"),
      signalName: requireOption(options, "set-severity", "--name"),
      severity: requireOption(options, "set-severity", "--severity"),
      projectRoot: cwd,
    },
    json,
  };
}

function parseArgs(argv, cwd) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")) {
    throw cliError("signal arguments must be an array of strings.");
  }
  if (argv[0] === "create") {
    return {
      command: "create",
      ...parseCreateArgs(argv, cwd),
    };
  }
  if (argv[0] === "list") {
    return {
      command: "list",
      ...parseListArgs(argv, cwd),
    };
  }
  if (argv[0] === "set-severity") {
    return {
      command: "set-severity",
      ...parseSetSeverityArgs(argv, cwd),
    };
  }
  throw cliError("signal requires create, list, or set-severity.");
}

function errorResult(error) {
  return {
    run: "failed",
    operation: "signal",
    code: typeof error?.code === "string"
      ? bounded(error.code, 128)
      : "SIGNAL_FAILED",
    message: bounded(error?.message ?? "Review signal operation failed."),
  };
}

function writeError(stdout, error, json) {
  const result = errorResult(error);
  if (json) {
    stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  stdout.write(
    `Signal command failed [${result.code}]: ${result.message}\n`,
  );
}

function formatSignalList(result) {
  const lines = [`Directory: ${result.directory}/`, ""];
  if (result.signals.length === 0) {
    return `${lines.concat("No signals.", "").join("\n")}`;
  }

  const severityWidth = Math.max(
    "SEVERITY".length,
    ...result.signals.map(({ severity }) => severity.length),
  );
  const summaryWidth = Math.max(
    "SUMMARY".length,
    ...result.signals.map(({ summary }) => summary.length),
  );
  lines.push(
    `${"SEVERITY".padEnd(severityWidth)}  `
    + `${"SUMMARY".padEnd(summaryWidth)}  FILE`,
  );
  for (const signal of result.signals) {
    lines.push(
      `${signal.severity.toUpperCase().padEnd(severityWidth)}  `
      + `${signal.summary.padEnd(summaryWidth)}  ${signal.file}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export async function runSignalCli(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const create = options.create ?? createSignal;
  const list = options.list ?? listSignals;
  const setSeverity = options.setSeverity ?? setSignalSeverity;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const jsonRequested = Array.isArray(argv) && argv.includes("--json");
  try {
    const parsed = parseArgs(argv, cwd);
    const result = parsed.command === "create"
      ? await create(parsed.input)
      : parsed.command === "set-severity"
        ? await setSeverity(parsed.input)
        : await list(parsed.input);
    if (parsed.json) {
      stdout.write(`${JSON.stringify(result)}\n`);
    } else if (parsed.command === "create") {
      stdout.write(`Created: ${result.relativeFile}\n`);
    } else if (parsed.command === "set-severity") {
      stdout.write(
        `Severity: ${result.relativeFile} (${result.severity.toUpperCase()})\n`,
      );
    } else {
      stdout.write(formatSignalList(result));
    }
    return 0;
  } catch (error) {
    writeError(stdout, error, jsonRequested);
    return 1;
  }
}

const main = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (main) {
  process.exitCode = await runSignalCli(process.argv.slice(2));
}
