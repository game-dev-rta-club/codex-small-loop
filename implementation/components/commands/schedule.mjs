#!/usr/bin/env node
import { startRecoverySupervisor } from "../runtime/source/recovery-supervisor.mjs";

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  applySchedule,
  defaultAutomationRoot,
  readSchedule,
} from "../runtime/source/schedule.mjs";
import { queueScheduleDeletion, waitScheduleDeletion } from "../runtime/source/schedule-delete-queue.mjs";
import { resolveProject } from "../runtime/source/project.mjs";

const MAX_MESSAGE_BYTES = 64 * 1_024;
const HELP = `Codex Small Loop schedules

Create or update the current Task's schedule:
  schedule apply --schedule <id> --task <task-id> --if-match <absent|etag> --interval-minutes <n> [--message <prompt>]

Read the current Task's exact schedule definition and etag:
  schedule read --schedule <id> --task <task-id>

Delete the current Task's exact schedule through the project runtime and wait for completion:
  schedule delete --schedule <id> --task <task-id> --if-match <etag> [--project-root <path>]
  Run from the project root, or supply --project-root.
  Waits up to 120 seconds for the runtime, then confirms the schedule is absent.
  Exit 0 means completed=true and present=false. Timeout does not cancel the request.
  Repeat the same command to inspect or finish the same saved request.

Pass the apply prompt with --message, or write it to standard input.
Results are one JSON object: exit 0 for ok, 1 for failed, and 2 for an unconfirmed saved request.
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
    "--project-root",
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
  if (operation !== "delete" && values["--project-root"] !== undefined) {
    throw cliError("SCHEDULE_CLI_USAGE", "--project-root is only used for deletion requests");
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
    projectRoot: values["--project-root"],
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
  let queuedDeletion = null;
  let recommendedAction = "inspect_deletion";
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
      const project = await resolveProject(path.resolve(parsed.projectRoot ?? options.cwd ?? process.cwd()));
      result = await (options.queueScheduleDeletion ?? queueScheduleDeletion)({
        project,
        scheduleId: parsed.scheduleId,
        targetTaskId: parsed.targetTaskId,
        ifMatch: parsed.ifMatch,
      });
      if (!result.completed) {
        queuedDeletion = result;
        recommendedAction = "start_supervisor";
        await (options.startSupervisor ?? startRecoverySupervisor)(project.root, { env });
        recommendedAction = "inspect_deletion";
        result = await (options.waitScheduleDeletion ?? waitScheduleDeletion)({
          project, scheduleId: parsed.scheduleId, targetTaskId: parsed.targetTaskId, ifMatch: parsed.ifMatch,
        }, options.deletionWaitOptions);
      }
      const current = await (options.readSchedule ?? readSchedule)({
        automationRoot, scheduleId: parsed.scheduleId, targetTaskId: parsed.targetTaskId,
      });
      if (current.present) throw cliError("SCHEDULE_DELETE_UNCONFIRMED", "The schedule is present after the deletion receipt; read its current definition before taking further action.");
      result = { ...result, present: false };
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
      run: queuedDeletion ? "partial" : "failed",
      operation,
      ...(queuedDeletion ? { ...queuedDeletion, recommendedAction } : {}),
      code: bounded(error?.code ?? "SCHEDULE_FAILED", 128),
      message: bounded(error?.message ?? "Schedule operation failed"),
    })}\n`);
    return queuedDeletion ? 2 : 1;
  }
}

const main = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (main) {
  process.exitCode = await runScheduleCli(process.argv.slice(2));
}
