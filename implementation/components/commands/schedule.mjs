#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  applySchedule,
  defaultAutomationRoot,
  deleteSchedule,
  readSchedule,
} from "../runtime/source/schedule.mjs";

const MAX_MESSAGE_BYTES = 64 * 1_024;
const HELP = `Codex Small Loop schedules

Create or update the current Task's schedule:
  schedule apply --schedule <id> --task <task-id> --if-match <absent|etag> --interval-minutes <n> [--message <prompt>]

Read the current Task's exact schedule definition and etag:
  schedule read --schedule <id> --task <task-id>

Delete the current Task's exact schedule:
  schedule delete --schedule <id> --task <task-id> --if-match <etag>

Pass the apply prompt with --message, or write it to standard input.
Results are one JSON object: exit 0 for ok and 1 for failed.
`;

function cliError(code, message) {
  const error = new Error(message);
  error.name = "ScheduleCliError";
  error.code = code;
  return error;
}

function bounded(value, maximum = 512) {
  const text = String(value);
  return text.length <= maximum
    ? text
    : `${text.slice(0, maximum - 1)}…`;
}

function parseArgs(argv) {
  const operation = argv[0];
  if (!new Set(["apply", "read", "delete"]).has(operation)) {
    throw cliError("SCHEDULE_COMMAND_INVALID", "A valid schedule command is required");
  }
  const values = {};
  const allowed = new Set([
    "--schedule",
    "--task",
    "--if-match",
    "--interval-minutes",
    "--message",
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (!allowed.has(option) || Object.hasOwn(values, option)) {
      throw cliError("SCHEDULE_CLI_USAGE", `Unsupported or repeated argument: ${bounded(option)}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw cliError("SCHEDULE_CLI_USAGE", `Argument requires a value: ${option}`);
    }
    values[option] = value;
    index += 1;
  }
  const scheduleId = values["--schedule"];
  const targetTaskId = values["--task"];
  if (typeof scheduleId !== "string" || typeof targetTaskId !== "string") {
    throw cliError("SCHEDULE_CLI_USAGE", `${operation} requires --schedule and --task`);
  }
  if (operation === "apply") {
    if (
      typeof values["--if-match"] !== "string"
      || typeof values["--interval-minutes"] !== "string"
      || !/^[1-9]\d*$/.test(values["--interval-minutes"])
    ) {
      throw cliError(
        "SCHEDULE_CLI_USAGE",
        "apply requires --if-match and --interval-minutes",
      );
    }
  } else if (values["--message"] !== undefined || values["--interval-minutes"] !== undefined) {
    throw cliError("SCHEDULE_CLI_USAGE", `${operation} does not accept a prompt or interval`);
  }
  if (operation === "read" && values["--if-match"] !== undefined) {
    throw cliError("SCHEDULE_CLI_USAGE", "read does not accept --if-match");
  }
  if (operation === "delete" && typeof values["--if-match"] !== "string") {
    throw cliError("SCHEDULE_CLI_USAGE", "delete requires --if-match <etag>");
  }
  return {
    operation,
    scheduleId,
    targetTaskId,
    ifMatch: values["--if-match"],
    intervalMinutes: values["--interval-minutes"] === undefined
      ? undefined
      : Number(values["--interval-minutes"]),
    message: values["--message"],
  };
}

async function readPrompt(stdin) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > MAX_MESSAGE_BYTES) {
      throw cliError("SCHEDULE_PROMPT_TOO_LARGE", "Schedule prompt is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runScheduleCli(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  let operation = "schedule";
  try {
    if (argv.length === 1 && new Set(["help", "--help"]).has(argv[0])) {
      stdout.write(HELP);
      return 0;
    }
    const parsed = parseArgs(argv);
    operation = parsed.operation;
    if (env.CODEX_THREAD_ID !== parsed.targetTaskId) {
      throw cliError(
        "SCHEDULE_TASK_MISMATCH",
        "A schedule may be operated only by its exact target Task",
      );
    }
    const automationRoot = options.automationRoot ?? defaultAutomationRoot(env);
    let result;
    if (parsed.operation === "read") {
      result = await (options.readSchedule ?? readSchedule)({
        automationRoot,
        scheduleId: parsed.scheduleId,
        targetTaskId: parsed.targetTaskId,
      });
    } else if (parsed.operation === "delete") {
      result = await (options.deleteSchedule ?? deleteSchedule)({
        automationRoot,
        scheduleId: parsed.scheduleId,
        targetTaskId: parsed.targetTaskId,
        ifMatch: parsed.ifMatch,
      });
    } else {
      const prompt = parsed.message === undefined
        ? await readPrompt(options.stdin ?? process.stdin)
        : parsed.message;
      result = await (options.applySchedule ?? applySchedule)({
        automationRoot,
        scheduleId: parsed.scheduleId,
        targetTaskId: parsed.targetTaskId,
        ifMatch: parsed.ifMatch,
        intervalMinutes: parsed.intervalMinutes,
        prompt,
        nowMs: (options.now ?? Date.now)(),
      });
    }
    stdout.write(`${JSON.stringify({ run: "ok", operation, ...result })}\n`);
    return 0;
  } catch (error) {
    stdout.write(`${JSON.stringify({
      run: "failed",
      operation,
      code: bounded(error?.code ?? "SCHEDULE_FAILED", 128),
      message: bounded(error?.message ?? "Schedule operation failed"),
    })}\n`);
    return 1;
  }
}

const main = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (main) {
  process.exitCode = await runScheduleCli(process.argv.slice(2));
}
