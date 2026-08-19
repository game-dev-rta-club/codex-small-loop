#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  forkTask,
  launchTask,
} from "../runtime/source/task-launch.mjs";
import {
  startRecoverySupervisor,
} from "../runtime/source/recovery-supervisor.mjs";
import { runLifecycleOperation } from "../runtime/source/task-lifecycle.mjs";
import {
  MAX_TASK_WAIT_TIMEOUT_MS,
  readExactTaskTurn,
  waitForExactTaskTurn,
} from "../runtime/source/task-turn-observation.mjs";

const MAX_MESSAGE_LENGTH = 512;
const MAX_ASSIGNMENT_BYTES = 64 * 1_024;
const MAX_TASK_ID_LENGTH = 512;
const REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const LIFECYCLE_COMMANDS = new Map([
  ["resume", "resume"],
  ["stop", "stop"],
]);
const ERROR_FIELDS = [
  "launchId",
  "parentTaskId",
  "sourceTaskId",
  "childTaskId",
  "roleTurnId",
  "assignmentTurnId",
  "phase",
  "operationId",
  "taskId",
];
const TASK_HELP = `Codex Small Loop task lifecycle

Create a new managed Task without inherited conversation context:
  task create --name <name> --parent <task-id> --role <role> [options]

Fork a new managed Task with inherited conversation context:
  task fork --name <name> --parent <task-id> --role <role> [options]

Stop or resume a managed Task tree:
  task stop|resume --task <task-id> [--project-root <directory>]

Read one exact Task turn without waiting:
  task read --task <task-id> --turn <turn-id>

Wait for one exact Task turn to end or abort:
  task wait --task <task-id> --turn <turn-id> [--timeout-ms <0-${MAX_TASK_WAIT_TIMEOUT_MS}>]

Pipe or here-document the Child assignment to create and fork without a PTY.
Use --service-tier default to explicitly select the normal Codex tier.
Results are one JSON object: exit 0 for ok, 2 for partial, and 1 for failed.
`;

function bounded(value, maximum = MAX_MESSAGE_LENGTH) {
  const text = String(value);
  return text.length <= maximum
    ? text
    : `${text.slice(0, maximum - 1)}…`;
}

function cliError(code, message, operation = "task") {
  const error = new Error(message);
  error.name = "TaskCliError";
  error.code = code;
  error.run = "failed";
  error.operation = operation;
  return error;
}

function validTaskId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_TASK_ID_LENGTH
    && !/\s/.test(value);
}

function validRole(value) {
  return typeof value === "string"
    && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)
    && value.length <= 128;
}

function parseLaunchArgs(argv, cwd, command) {
  let name;
  let parentTaskId;
  let sourceTaskId;
  let role;
  let model;
  let reasoningEffort;
  let serviceTier;
  let projectRoot = cwd;
  const seen = new Set();

  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    const allowedOptions = new Set([
      "--name",
      "--parent",
      "--role",
      "--model",
      "--reasoning-effort",
      "--service-tier",
      "--project-root",
    ]);
    if (command === "fork") allowedOptions.add("--source");
    if (!allowedOptions.has(option)) {
      throw cliError(
        "TASK_CLI_USAGE",
        `Unsupported task ${command} argument: ${bounded(option, 128)}`,
        command,
      );
    }
    if (seen.has(option)) {
      throw cliError(
        "TASK_CLI_USAGE",
        `Task ${command} argument is repeated: ${option}`,
        command,
      );
    }
    seen.add(option);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw cliError(
        "TASK_CLI_USAGE",
        `Task ${command} argument requires a value: ${option}`,
        command,
      );
    }
    index += 1;

    if (option === "--name") name = value;
    else if (option === "--parent") parentTaskId = value;
    else if (option === "--source") sourceTaskId = value;
    else if (option === "--role") role = value;
    else if (option === "--model") model = value;
    else if (option === "--reasoning-effort") reasoningEffort = value;
    else if (option === "--service-tier") serviceTier = value;
    else projectRoot = path.resolve(cwd, value);
  }

  if (parentTaskId === undefined) {
    throw cliError(
      "PARENT_TASK_REQUIRED",
      `task ${command} requires --parent <task-id>`,
      command,
    );
  }
  if (!validTaskId(parentTaskId)) {
    throw cliError(
      "PARENT_TASK_INVALID",
      "Task ID must be a non-empty bounded identifier",
      command,
    );
  }
  if (sourceTaskId !== undefined && !validTaskId(sourceTaskId)) {
    throw cliError(
      "SOURCE_TASK_INVALID",
      "Fork source Task ID must be a non-empty bounded identifier",
      command,
    );
  }
  if (
    typeof name !== "string"
    || name.trim() !== name
    || name.length === 0
    || name.length > 128
    || /[\r\n]/.test(name)
  ) {
    throw cliError(
      name === undefined ? "TASK_NAME_REQUIRED" : "TASK_NAME_INVALID",
      `task ${command} requires --name with a bounded single-line agent name`,
      command,
    );
  }
  if (role === undefined) {
    throw cliError(
      "TASK_ROLE_REQUIRED",
      `task ${command} requires --role <job-role>`,
      command,
    );
  }
  if (!validRole(role)) {
    throw cliError(
      "TASK_ROLE_INVALID",
      "Job role must be a bounded kebab-case name",
      command,
    );
  }
  if ((model === undefined) !== (reasoningEffort === undefined)) {
    throw cliError(
      "TASK_EXECUTION_PROFILE_INCOMPLETE",
      `task ${command} requires --model and --reasoning-effort together`,
      command,
    );
  }
  if (
    model !== undefined
    && (
      model.length === 0
      || model.length > 512
      || /\s/.test(model)
    )
  ) {
    throw cliError(
      "TASK_MODEL_INVALID",
      "Model must be a non-empty bounded identifier",
      command,
    );
  }
  if (
    reasoningEffort !== undefined
    && !REASONING_EFFORTS.has(reasoningEffort)
  ) {
    throw cliError(
      "TASK_REASONING_EFFORT_INVALID",
      "Reasoning effort is unsupported",
      command,
    );
  }
  if (
    serviceTier !== undefined
    && (
      serviceTier.length === 0
      || serviceTier.length > 512
      || /\s/.test(serviceTier)
    )
  ) {
    throw cliError(
      "TASK_SERVICE_TIER_INVALID",
      "Service tier must be a non-empty bounded identifier",
      command,
    );
  }
  return {
    projectRoot,
    name,
    parentTaskId,
    ...(sourceTaskId === undefined ? {} : { sourceTaskId }),
    role,
    ...(model === undefined ? {} : { model, reasoningEffort }),
    ...(serviceTier === undefined
      ? {}
      : { serviceTier: serviceTier === "default" ? null : serviceTier }),
  };
}

function parseCommandArgs(argv, cwd, {
  command,
  idOption,
  idKey,
  requiredCode,
  invalidCode,
}) {
  let taskId;
  let projectRoot = cwd;
  const seen = new Set();

  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== idOption && option !== "--project-root") {
      throw cliError(
        "TASK_CLI_USAGE",
        `Unsupported task ${command} argument: ${bounded(option, 128)}`,
        command,
      );
    }
    if (seen.has(option)) {
      throw cliError(
        "TASK_CLI_USAGE",
        `Task ${command} argument is repeated: ${option}`,
        command,
      );
    }
    seen.add(option);

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw cliError(
        "TASK_CLI_USAGE",
        `Task ${command} argument requires a value: ${option}`,
        command,
      );
    }
    index += 1;
    if (option === idOption) {
      taskId = value;
    } else {
      projectRoot = path.resolve(cwd, value);
    }
  }

  if (taskId === undefined) {
    throw cliError(
      requiredCode,
      `task ${command} requires ${idOption} <task-id>`,
      command,
    );
  }
  if (!validTaskId(taskId)) {
    throw cliError(
      invalidCode,
      "Task ID must be a non-empty bounded identifier",
      command,
    );
  }
  return {
    projectRoot,
    [idKey]: taskId,
  };
}

function parseObservationArgs(argv, command) {
  let taskId;
  let turnId;
  let timeoutMs;
  const seen = new Set();
  const allowedOptions = new Set(["--task", "--turn"]);
  if (command === "wait") allowedOptions.add("--timeout-ms");

  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (!allowedOptions.has(option)) {
      throw cliError(
        "TASK_CLI_USAGE",
        `Unsupported task ${command} argument: ${bounded(option, 128)}`,
        command,
      );
    }
    if (seen.has(option)) {
      throw cliError(
        "TASK_CLI_USAGE",
        `Task ${command} argument is repeated: ${option}`,
        command,
      );
    }
    seen.add(option);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw cliError(
        "TASK_CLI_USAGE",
        `Task ${command} argument requires a value: ${option}`,
        command,
      );
    }
    index += 1;
    if (option === "--task") taskId = value;
    else if (option === "--turn") turnId = value;
    else {
      if (!/^(?:0|[1-9]\d*)$/.test(value)) {
        throw cliError(
          "TASK_WAIT_TIMEOUT_INVALID",
          `--timeout-ms must be an integer from 0 to ${MAX_TASK_WAIT_TIMEOUT_MS}`,
          command,
        );
      }
      timeoutMs = Number(value);
      if (
        !Number.isSafeInteger(timeoutMs)
        || timeoutMs > MAX_TASK_WAIT_TIMEOUT_MS
      ) {
        throw cliError(
          "TASK_WAIT_TIMEOUT_INVALID",
          `--timeout-ms must be an integer from 0 to ${MAX_TASK_WAIT_TIMEOUT_MS}`,
          command,
        );
      }
    }
  }

  if (!validTaskId(taskId)) {
    throw cliError(
      taskId === undefined ? "TASK_ID_REQUIRED" : "TASK_ID_INVALID",
      `task ${command} requires --task <task-id>`,
      command,
    );
  }
  if (!validTaskId(turnId)) {
    throw cliError(
      turnId === undefined ? "TURN_ID_REQUIRED" : "TURN_ID_INVALID",
      `task ${command} requires --turn <turn-id>`,
      command,
    );
  }
  return {
    taskId,
    turnId,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function parseArgs(argv, cwd) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")) {
    throw new TypeError("argv must be an array of strings");
  }
  const command = argv[0];
  if (command === "create" || command === "launch" || command === "fork") {
    return {
      command,
      input: parseLaunchArgs(argv, cwd, command),
    };
  }
  if (command === "read" || command === "wait") {
    return {
      command,
      input: parseObservationArgs(argv, command),
    };
  }
  const lifecycleCommand = LIFECYCLE_COMMANDS.get(command);
  if (lifecycleCommand) {
    return {
      command: lifecycleCommand,
      input: {
        operation: lifecycleCommand,
        ...parseCommandArgs(argv, cwd, {
          command: lifecycleCommand,
          idOption: "--task",
          idKey: "taskId",
          requiredCode: "TASK_ID_REQUIRED",
          invalidCode: "TASK_ID_INVALID",
        }),
      },
    };
  }
  {
    throw cliError(
      "TASK_COMMAND_INVALID",
      argv.length === 0
        ? "A task command is required"
        : `Unsupported task command: ${bounded(command, 128)}`,
    );
  }
}

function errorResult(error, operation = "task") {
  const run = error?.run === "partial" ? "partial" : "failed";
  operation = typeof error?.operation === "string"
    ? bounded(error.operation, 128)
    : operation;
  const causeCode = typeof error?.cause?.code === "string"
    && error.cause.code.length > 0
    ? bounded(error.cause.code, 128)
    : null;
  const result = {
    run,
    operation,
    code: typeof error?.code === "string"
      ? bounded(error.code, 128)
        : operation === "launch"
          ? "TASK_LAUNCH_FAILED"
          : operation === "fork"
            ? "TASK_FORK_FAILED"
            : "TASK_LIFECYCLE_FAILED",
    ...(causeCode ? { causeCode } : {}),
    message: bounded(error?.message ?? "Task operation failed"),
  };
  for (const field of ERROR_FIELDS) {
    if (
      typeof error?.[field] === "string"
      && error[field].length > 0
      && error[field].length <= MAX_TASK_ID_LENGTH
    ) {
      result[field] = error[field];
    }
  }
  return result;
}

function writeJson(stdout, result) {
  stdout.write(`${JSON.stringify(result)}\n`);
}

async function readAssignment(readable) {
  if (
    readable === null
    || typeof readable !== "object"
    || typeof readable[Symbol.asyncIterator] !== "function"
  ) {
    throw new TypeError("stdin must be an async iterable");
  }
  if (readable.isTTY === true) {
    throw cliError(
      "TASK_ASSIGNMENT_STDIN_TTY_UNSUPPORTED",
      "Pipe or here-document the Task assignment so standard input closes automatically",
    );
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of readable) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > MAX_ASSIGNMENT_BYTES) {
      throw cliError(
        "TASK_ASSIGNMENT_TOO_LARGE",
        `Task assignment exceeds ${MAX_ASSIGNMENT_BYTES} bytes`,
      );
    }
    chunks.push(buffer);
  }

  const assignment = Buffer.concat(chunks).toString("utf8");
  if (assignment.length === 0) {
    throw cliError(
      "TASK_ASSIGNMENT_REQUIRED",
      "Task launch and fork require the Child assignment on standard input",
    );
  }
  return assignment;
}

export async function runTaskCli(argv, options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const launch = options.launch ?? launchTask;
  const fork = options.fork ?? forkTask;
  const lifecycle = options.lifecycle ?? runLifecycleOperation;
  const readTurn = options.readTurn ?? readExactTaskTurn;
  const waitTurn = options.waitTurn ?? waitForExactTaskTurn;
  const startSupervisor = options.startSupervisor
    ?? startRecoverySupervisor;
  let operation = "task";

  try {
    if (
      Array.isArray(argv)
      && argv.length === 1
      && new Set(["--help", "help"]).has(argv[0])
    ) {
      stdout.write(TASK_HELP);
      return 0;
    }
    const parsed = parseArgs(argv, cwd);
    operation = parsed.command;
    if (
      parsed.command === "create"
      || parsed.command === "launch"
      || parsed.command === "fork"
    ) {
      parsed.input.assignment = await readAssignment(stdin);
    }
    let result = parsed.command === "create" || parsed.command === "launch"
      ? await launch(parsed.input)
      : parsed.command === "fork"
        ? await fork(parsed.input)
        : parsed.command === "read"
          ? await readTurn(parsed.input)
          : parsed.command === "wait"
            ? await waitTurn(parsed.input)
            : await lifecycle(parsed.input);
    if (parsed.command === "create") {
      result = { ...result, operation: "create" };
    }
    if (parsed.command === "resume") {
      try {
        await startSupervisor(parsed.input.projectRoot);
      } catch (error) {
        writeJson(stdout, {
          run: "partial",
          operation: "resume",
          code: typeof error?.code === "string"
            ? bounded(error.code, 128)
            : "RECOVERY_SUPERVISOR_START_FAILED",
          message: "Resume was committed, but recovery supervision did not start. Retry the same task resume command.",
          phase: "supervisor_start",
          ...(typeof result.operationId === "string"
            ? { operationId: result.operationId }
            : {}),
          taskId: parsed.input.taskId,
          state: Number(result.changedLinks) > 0
            ? "resumed"
            : "already_active",
          recommendedAction: "retry_resume",
        });
        return 2;
      }
    } else if (
      parsed.command === "create"
      || parsed.command === "launch"
      || parsed.command === "fork"
    ) {
      try {
        await startSupervisor(parsed.input.projectRoot);
      } catch (error) {
        const operationName = parsed.command;
        writeJson(stdout, {
          run: "partial",
          operation: operationName,
          code: typeof error?.code === "string"
            ? bounded(error.code, 128)
            : "RECOVERY_SUPERVISOR_START_FAILED",
          message: `Task ${operationName} was committed, but recovery supervision did not start. Do not retry task ${operationName}.`,
          phase: "supervisor_start",
          ...(typeof result.launchId === "string"
            ? { launchId: result.launchId }
            : {}),
          ...(typeof result.childTaskId === "string"
            ? { childTaskId: result.childTaskId }
            : {}),
          ...(typeof result.phase === "string"
            ? { state: result.phase }
            : {}),
          recommendedAction: typeof result.childTaskId === "string"
            ? "resume_child_task"
            : "inspect_runtime",
        });
        return 2;
      }
    }
    writeJson(stdout, result);
    return result.run === "partial" ? 2 : 0;
  } catch (error) {
    const result = errorResult(error, operation);
    if (operation === "create" && result.operation === "launch") {
      result.operation = "create";
    }
    writeJson(stdout, result);
    return result.run === "partial" ? 2 : 1;
  }
}

const main = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (main) {
  process.exitCode = await runTaskCli(process.argv.slice(2));
}
