import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { pathsEqual } from "./path-identity.mjs";

import {
  readCodexSessionMetadata,
  readCodexTaskRunSettings,
} from "./codex-jsonl.mjs";
import {
  executionProfileFromTaskRunContext,
  requireTaskRunContext,
  taskRunContextFromSettings,
  threadSettingsFromTaskRunContext,
  turnSettingsFromTaskRunContext,
} from "./task-run-context.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 4_096;
const DEFAULT_MAX_FRAME_BYTES = 32 * 1_024 * 1_024;
const MAX_ERROR_LENGTH = 512;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_INPUT_LENGTH = 64 * 1_024;
const BRIDGE_DETACH_TIMEOUT_MS = 1_000;
const RESUME_ROLLOUT_RETRY_TIMEOUT_MS = 2_000;
const RESUME_ROLLOUT_RETRY_INTERVAL_MS = 50;
const DEFAULT_BRIDGE = fileURLToPath(
  new URL("./codex-app-server-bridge.mjs", import.meta.url),
);

function bounded(value, maximum = MAX_ERROR_LENGTH) {
  const text = String(value);
  return text.length <= maximum
    ? text
    : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function boundedBytes(previous, chunk, maximum) {
  if (Buffer.byteLength(previous) >= maximum) {
    return previous;
  }
  const available = maximum - Buffer.byteLength(previous);
  return previous + Buffer.from(chunk).subarray(0, available).toString();
}

function validIdentifier(value) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH;
}

function requireIdentifier(value, label) {
  if (!validIdentifier(value)) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function validTaskHistoryPath(value, taskId) {
  return typeof value === "string"
    && path.isAbsolute(value)
    && path.basename(value).endsWith(`${taskId}.jsonl`);
}

async function persistedThreadSource(thread, taskId) {
  if (!validTaskHistoryPath(thread?.path, taskId)) {
    return null;
  }
  try {
    const metadata = await readCodexSessionMetadata(
      createReadStream(thread.path),
      taskId,
    );
    return metadata.threadSource;
  } catch {
    return null;
  }
}

function requireCwd(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError("cwd must be an absolute path");
  }
  return value;
}

function requireText(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_INPUT_LENGTH
  ) {
    throw new TypeError("text must be a non-empty bounded string");
  }
  return value;
}

function readTaskRunContext(result, operation, expected = null) {
  let context;
  try {
    if (
      result === null
      || typeof result !== "object"
      || Array.isArray(result)
      || !Object.hasOwn(result, "reasoningEffort")
      || !Object.hasOwn(result, "serviceTier")
    ) {
      throw new TypeError(
        "task run context must include reasoningEffort and serviceTier",
      );
    }
    context = taskRunContextFromSettings({
      ...result,
      sandboxPolicy: result.sandboxPolicy ?? result.sandbox,
    });
  } catch (cause) {
    throw createError(
      "APP_SERVER_RESPONSE_INVALID",
      operation,
      "Codex app-server returned no valid task run context",
      { cause },
    );
  }
  if (expected !== null) {
    expected = requireTaskRunContext(expected);
    const expectedProfile = executionProfileFromTaskRunContext(expected);
    const actualProfile = executionProfileFromTaskRunContext(context);
    if (!isDeepStrictEqual(actualProfile, expectedProfile)) {
      throw createError(
        "TASK_EXECUTION_PROFILE_MISMATCH",
        operation,
        "Codex app-server returned a Task with a different execution profile",
        {
          expectedProfile: cloneProtocolValue(expectedProfile),
          actualProfile: cloneProtocolValue(actualProfile),
        },
      );
    }
    if (
      !isDeepStrictEqual(context.approvalPolicy, expected.approvalPolicy)
      || !isDeepStrictEqual(context.permission, expected.permission)
    ) {
      throw createError(
        "TASK_RUN_CONTEXT_MISMATCH",
        operation,
        "Codex app-server returned a Task with different authority settings",
        {
          expectedContext: cloneProtocolValue(expected),
          actualContext: cloneProtocolValue(context),
        },
      );
    }
  }
  return context;
}

function readThreadStartSettings(runContext, operation) {
  try {
    const context = requireTaskRunContext(runContext);
    return {
      context,
      settings: threadSettingsFromTaskRunContext(context),
    };
  } catch (cause) {
    throw createError(
      "TASK_RUN_CONTEXT_INVALID",
      operation,
      "Task authority cannot be represented safely for creation or fork",
      { cause },
    );
  }
}

function requireTimeout(value, label = "timeoutMs") {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function cloneProtocolValue(value) {
  return JSON.parse(JSON.stringify(value));
}

export class CodexAppServerError extends Error {
  constructor(code, operation, message, details = {}) {
    super(bounded(message));
    this.name = "CodexAppServerError";
    this.code = code;
    this.operation = operation;
    Object.assign(this, details);
  }
}

function createError(code, operation, message, details = {}) {
  return new CodexAppServerError(code, operation, message, details);
}

function terminalKey(taskId, turnId) {
  return `${taskId}\u0000${turnId}`;
}

export class CodexAppServerClient {
  constructor({
    command = process.execPath,
    args = [DEFAULT_BRIDGE],
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxDiagnosticBytes = DEFAULT_MAX_DIAGNOSTIC_BYTES,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    spawnProcess = spawn,
    resumeRetryTimeoutMs = RESUME_ROLLOUT_RETRY_TIMEOUT_MS,
    resumeRetryIntervalMs = RESUME_ROLLOUT_RETRY_INTERVAL_MS,
    now = Date.now,
    sleep = (milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
  } = {}) {
    if (typeof command !== "string" || command.length === 0) {
      throw new TypeError("command must be a non-empty string");
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new TypeError("args must be an array of strings");
    }
    if (typeof spawnProcess !== "function") {
      throw new TypeError("spawnProcess must be a function");
    }
    if (typeof now !== "function" || typeof sleep !== "function") {
      throw new TypeError("now and sleep must be functions");
    }

    this.command = command;
    this.args = [...args];
    this.cwd = requireCwd(path.resolve(cwd));
    this.env = env;
    this.timeoutMs = requireTimeout(timeoutMs);
    this.maxDiagnosticBytes = requireTimeout(
      maxDiagnosticBytes ?? DEFAULT_MAX_DIAGNOSTIC_BYTES,
      "maxDiagnosticBytes",
    );
    this.maxFrameBytes = requireTimeout(maxFrameBytes, "maxFrameBytes");
    this.spawnProcess = spawnProcess;
    this.resumeRetryTimeoutMs = requireTimeout(
      resumeRetryTimeoutMs,
      "resumeRetryTimeoutMs",
    );
    this.resumeRetryIntervalMs = requireTimeout(
      resumeRetryIntervalMs,
      "resumeRetryIntervalMs",
    );
    this.now = now;
    this.sleep = sleep;
    this.detachableBridge = command === process.execPath
      && args.length === 1
      && args[0] === DEFAULT_BRIDGE;

    this.child = null;
    this.connected = false;
    this.connecting = null;
    this.closed = false;
    this.intentionalClose = false;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.knownTasks = new Set();
    this.taskResumes = new Map();
    this.turnWaiters = new Map();
    this.terminalTurns = new Map();
    this.stdoutBuffer = "";
    this.stdoutDecoder = new StringDecoder("utf8");
    this.stderr = "";
  }

  async connect() {
    if (this.connected) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }
    if (this.closed) {
      throw createError(
        "APP_SERVER_CLOSED",
        "initialize",
        "Codex app-server client is closed",
      );
    }

    this.connecting = this.#connect();
    try {
      await this.connecting;
      this.connected = true;
    } finally {
      this.connecting = null;
    }
  }

  async createTask({ cwd, runContext }) {
    await this.connect();
    const { context: expectedContext, settings } = readThreadStartSettings(
      runContext,
      "createTask",
    );
    const result = await this.#request(
      "thread/start",
      {
        cwd: requireCwd(cwd),
        model: settings.model,
        config: {
          model_reasoning_effort: settings.reasoningEffort,
          ...settings.config,
        },
        serviceTier: settings.serviceTier,
        approvalPolicy: settings.approvalPolicy,
        ...(settings.permissions === undefined
          ? { sandbox: settings.sandbox }
          : { permissions: settings.permissions }),
        threadSource: "codex-small-loop",
      },
      "createTask",
    );
    const taskId = result?.thread?.id;
    if (!validIdentifier(taskId)) {
      throw createError(
        "APP_SERVER_RESPONSE_INVALID",
        "createTask",
        "thread/start returned no valid task ID",
      );
    }
    const actualContext = readTaskRunContext(
      result,
      "createTask",
      expectedContext,
    );
    this.knownTasks.add(taskId);
    return Object.freeze({ taskId, runContext: actualContext });
  }

  async forkTask({
    taskId,
    cwd,
    runContext,
  }) {
    await this.connect();
    taskId = requireIdentifier(taskId, "taskId");
    cwd = requireCwd(cwd);
    const { context: expectedContext, settings } = readThreadStartSettings(
      runContext,
      "forkTask",
    );
    const result = await this.#request(
      "thread/fork",
      {
        threadId: taskId,
        cwd,
        model: settings.model,
        config: {
          model_reasoning_effort: settings.reasoningEffort,
          ...settings.config,
        },
        serviceTier: settings.serviceTier,
        approvalPolicy: settings.approvalPolicy,
        ...(settings.permissions === undefined
          ? { sandbox: settings.sandbox }
          : { permissions: settings.permissions }),
        threadSource: "codex-small-loop",
      },
      "forkTask",
    );
    const childTaskId = result?.threadId
      ?? result?.id
      ?? result?.thread?.id;
    if (!validIdentifier(childTaskId)) {
      throw createError(
        "APP_SERVER_RESPONSE_INVALID",
        "forkTask",
        "thread/fork returned no valid task ID",
      );
    }
    const actualContext = readTaskRunContext(
      result,
      "forkTask",
      expectedContext,
    );
    this.knownTasks.add(childTaskId);
    return Object.freeze({ taskId: childTaskId, runContext: actualContext });
  }

  async setTaskName({ taskId, name }) {
    await this.connect();
    taskId = requireIdentifier(taskId, "taskId");
    name = requireIdentifier(name, "name");
    await this.#request(
      "thread/name/set",
      {
        threadId: taskId,
        name,
      },
      "setTaskName",
    );
    return Object.freeze({ taskId, name });
  }

  async startTurn({
    taskId,
    text,
    cwd,
    runContext,
  }) {
    await this.connect();
    taskId = requireIdentifier(taskId, "taskId");
    cwd = requireCwd(cwd);
    await this.#ensureTask(taskId);
    const settings = turnSettingsFromTaskRunContext(runContext);
    const params = {
      threadId: taskId,
      input: [{ type: "text", text: requireText(text) }],
      cwd,
      model: settings.model,
      effort: settings.reasoningEffort,
      serviceTier: settings.serviceTier,
      approvalPolicy: settings.approvalPolicy,
      ...(settings.permissions === undefined
        ? { sandboxPolicy: settings.sandboxPolicy }
        : { permissions: settings.permissions }),
    };
    const result = await this.#request(
      "turn/start",
      params,
      "startTurn",
    );
    const turnId = result?.turn?.id;
    if (!validIdentifier(turnId)) {
      throw createError(
        "APP_SERVER_RESPONSE_INVALID",
        "startTurn",
        "turn/start returned no valid turn ID",
      );
    }
    return Object.freeze({ turnId });
  }

  async steerTurn({
    taskId,
    turnId,
    text,
    cwd,
  }) {
    await this.connect();
    taskId = requireIdentifier(taskId, "taskId");
    turnId = requireIdentifier(turnId, "turnId");
    cwd = requireCwd(cwd);
    await this.#ensureTask(taskId);

    let result;
    try {
      result = await this.#request(
        "turn/steer",
        {
          threadId: taskId,
          expectedTurnId: turnId,
          input: [{ type: "text", text: requireText(text) }],
        },
        "steerTurn",
      );
    } catch (cause) {
      if (
        cause instanceof CodexAppServerError
        && cause.code === "APP_SERVER_REQUEST_FAILED"
      ) {
        const message = cause.message.toLowerCase();
        let code;
        let turnKind;
        if (message.includes("no active turn to steer")) {
          code = "APP_SERVER_STEER_NO_ACTIVE_TURN";
        } else if (
          message.includes("expected active turn id")
          && message.includes("but found")
        ) {
          code = "APP_SERVER_STEER_TURN_MISMATCH";
        } else {
          const match = message.match(/cannot steer a (review|compact) turn/);
          if (match) {
            code = "APP_SERVER_STEER_NOT_STEERABLE";
            turnKind = match[1];
          }
        }
        if (code) {
          throw createError(code, "steerTurn", cause.message, {
            cause,
            rpcCode: cause.rpcCode,
            rpcData: cause.rpcData,
            taskId,
            turnId,
            ...(turnKind ? { turnKind } : {}),
          });
        }
      }
      throw cause;
    }

    if (result?.turnId !== turnId) {
      throw createError(
        "APP_SERVER_RESPONSE_INVALID",
        "steerTurn",
        "turn/steer returned no matching active turn ID",
      );
    }
    return Object.freeze({ turnId });
  }

  async waitForTurn({ taskId, turnId, timeoutMs = this.timeoutMs }) {
    await this.connect();
    requireIdentifier(taskId, "taskId");
    requireIdentifier(turnId, "turnId");
    requireTimeout(timeoutMs);

    const key = terminalKey(taskId, turnId);
    if (this.terminalTurns.has(key)) {
      return this.terminalTurns.get(key);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.turnWaiters.get(key) ?? [];
        this.turnWaiters.set(
          key,
          waiters.filter((waiter) => waiter.resolve !== resolve),
        );
        const error = createError(
          "APP_SERVER_TIMEOUT",
          "waitForTurn",
          `Codex app-server turn wait timed out after ${timeoutMs}ms`,
          { stderr: this.stderr },
        );
        this.#failAll(error);
        reject(error);
      }, timeoutMs);

      const waiters = this.turnWaiters.get(key) ?? [];
      waiters.push({
        resolve: (observation) => {
          clearTimeout(timer);
          resolve(observation);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.turnWaiters.set(key, waiters);
    });
  }

  async interruptTurn({ taskId, turnId }) {
    await this.connect();
    taskId = requireIdentifier(taskId, "taskId");
    turnId = requireIdentifier(turnId, "turnId");
    await this.#ensureTask(taskId);
    try {
      await this.#request(
        "turn/interrupt",
        { threadId: taskId, turnId },
        "interruptTurn",
      );
    } catch (error) {
      if (
        error instanceof CodexAppServerError
        && error.code === "APP_SERVER_REQUEST_FAILED"
        && error.rpcCode === -32600
        && /no active turn to interrupt/i.test(error.message)
      ) {
        return Object.freeze({ taskId, turnId, interrupted: false });
      }
      throw error;
    }
    return Object.freeze({ taskId, turnId, interrupted: true });
  }

  async readTask({ taskId }) {
    await this.connect();
    taskId = requireIdentifier(taskId, "taskId");
    const result = await this.#request(
      "thread/read",
      {
        threadId: taskId,
        includeTurns: false,
      },
      "readTask",
    );
    if (result?.thread?.id !== taskId) {
      throw createError(
        "APP_SERVER_RESPONSE_INVALID",
        "readTask",
        "thread/read returned no matching task ID",
      );
    }
    const name = result.thread.name ?? null;
    if (
      name !== null
      && (
        typeof name !== "string"
        || name.length === 0
        || name.length > MAX_IDENTIFIER_LENGTH
        || name.trim() !== name
        || /[\r\n]/.test(name)
      )
    ) {
      throw createError(
        "APP_SERVER_RESPONSE_INVALID",
        "readTask",
        "thread/read returned an invalid task name",
      );
    }
    const threadSource = result.thread.threadSource
      ?? await persistedThreadSource(result.thread, taskId);
    if (
      threadSource !== null
      && (
        typeof threadSource !== "string"
        || threadSource.length > MAX_IDENTIFIER_LENGTH
      )
    ) {
      throw createError(
        "APP_SERVER_RESPONSE_INVALID",
        "readTask",
        "thread/read returned an invalid thread source",
      );
    }
    return Object.freeze({ taskId, name, threadSource });
  }

  async readTaskProfile({ taskId }) {
    await this.connect();
    taskId = requireIdentifier(taskId, "taskId");
    const result = await this.#request(
      "thread/read",
      {
        threadId: taskId,
        includeTurns: false,
      },
      "readTaskProfile",
    );
    const thread = result?.thread;
    if (
      thread?.id !== taskId
      || !validTaskHistoryPath(thread.path, taskId)
      || typeof thread.cwd !== "string"
      || !path.isAbsolute(thread.cwd)
    ) {
      throw createError(
        "APP_SERVER_RESPONSE_INVALID",
        "readTaskProfile",
        "thread/read returned no matching persisted Task profile",
      );
    }

    let persisted;
    try {
      persisted = await readCodexTaskRunSettings(
        createReadStream(thread.path),
        taskId,
      );
    } catch (cause) {
      throw createError(
        "TASK_EXECUTION_PROFILE_UNKNOWN",
        "readTaskProfile",
        "The persisted Task execution profile could not be read safely",
        { cause },
      );
    }
    if (!pathsEqual(thread.cwd, persisted.cwd)) {
      throw createError(
        "TASK_EXECUTION_PROFILE_UNKNOWN",
        "readTaskProfile",
        "The persisted Task cwd does not match thread/read",
      );
    }

    let runContext;
    try {
      runContext = taskRunContextFromSettings(persisted.settings);
    } catch (cause) {
      throw createError(
        "TASK_EXECUTION_PROFILE_UNKNOWN",
        "readTaskProfile",
        "The persisted Task execution profile is not representable",
        { cause },
      );
    }
    return Object.freeze({
      taskId,
      cwd: persisted.cwd,
      runContext,
    });
  }

  async resumeTask({ taskId, runContext = null }) {
    await this.connect();
    taskId = requireIdentifier(taskId, "taskId");
    const expected = runContext === null
      ? null
      : readThreadStartSettings(runContext, "resumeTask");
    if (this.taskResumes.has(taskId)) {
      return this.taskResumes.get(taskId);
    }

    const resume = (async () => {
      const params = {
        threadId: taskId,
        excludeTurns: true,
        ...(expected === null
          ? {}
          : {
            model: expected.settings.model,
            config: {
              model_reasoning_effort: expected.settings.reasoningEffort,
                ...expected.settings.config,
            },
            serviceTier: expected.settings.serviceTier,
            approvalPolicy: expected.settings.approvalPolicy,
            ...(expected.settings.permissions === undefined
              ? { sandbox: expected.settings.sandbox }
              : { permissions: expected.settings.permissions }),
          }),
      };
      const retryDeadline = this.now() + this.resumeRetryTimeoutMs;
      let result;
      for (;;) {
        try {
          result = await this.#request(
            "thread/resume",
            params,
            "resumeTask",
          );
          break;
        } catch (cause) {
          const transient = cause instanceof CodexAppServerError
            && cause.code === "APP_SERVER_REQUEST_FAILED"
            && /no rollout found for thread id/i.test(cause.message);
          const remaining = retryDeadline - this.now();
          if (!transient || remaining <= 0) throw cause;
          await this.sleep(Math.min(this.resumeRetryIntervalMs, remaining));
        }
      }
      if (result?.thread?.id !== taskId) {
        throw createError(
          "APP_SERVER_RESPONSE_INVALID",
          "resumeTask",
          "thread/resume returned no matching task ID",
        );
      }
      if (
        typeof result.cwd !== "string"
        || !path.isAbsolute(result.cwd)
      ) {
        throw createError(
          "APP_SERVER_RESPONSE_INVALID",
          "resumeTask",
          "thread/resume returned no valid cwd",
        );
      }
      const activePermissionProfile = result.activePermissionProfile ?? null;
      if (
        activePermissionProfile !== null
        && (
          typeof activePermissionProfile !== "object"
          || Array.isArray(activePermissionProfile)
          || !validIdentifier(activePermissionProfile.id)
          || (
            activePermissionProfile.extends !== undefined
            && activePermissionProfile.extends !== null
            && !validIdentifier(activePermissionProfile.extends)
          )
        )
      ) {
        throw createError(
          "TASK_PERMISSION_UNKNOWN",
          "resumeTask",
          "thread/resume returned an invalid active permission profile",
        );
      }

      let runContext;
      try {
        runContext = readTaskRunContext({
          ...result,
          activePermissionProfile,
          sandboxPolicy: result.sandbox,
        }, "resumeTask", expected?.context ?? null);
      } catch (cause) {
        if (
          cause?.code === "APP_SERVER_RESPONSE_INVALID"
          && /approval|permission|sandbox/i.test(cause?.cause?.message ?? "")
        ) {
          throw createError(
            "TASK_PERMISSION_UNKNOWN",
            "resumeTask",
            "thread/resume returned no valid active permission settings",
            { cause },
          );
        }
        throw cause;
      }

      this.knownTasks.add(taskId);
      return Object.freeze({
        taskId,
        cwd: path.normalize(result.cwd),
        runContext,
      });
    })();
    this.taskResumes.set(taskId, resume);

    try {
      return await resume;
    } finally {
      this.taskResumes.delete(taskId);
    }
  }

  async #ensureTask(taskId) {
    if (this.knownTasks.has(taskId)) {
      return;
    }
    await this.resumeTask({ taskId });
  }

  async close() {
    if (this.closed && !this.child) {
      return;
    }
    this.intentionalClose = true;
    this.closed = true;
    this.connected = false;

    const error = createError(
      "APP_SERVER_CLOSED",
      "close",
      "Codex app-server client closed",
      { stderr: this.stderr },
    );
    this.#rejectOutstanding(error);

    const child = this.child;
    this.child = null;
    if (!child) {
      return;
    }
    if (this.detachableBridge) {
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("bridge detach timed out"));
          }, BRIDGE_DETACH_TIMEOUT_MS);
          const cleanup = () => {
            clearTimeout(timer);
            child.off("message", onMessage);
          };
          const onMessage = (message) => {
            if (message?.type !== "detached") {
              return;
            }
            cleanup();
            resolve();
          };
          child.on("message", onMessage);
          child.send({ type: "detach" }, (cause) => {
            if (cause) {
              cleanup();
              reject(cause);
            }
          });
        });
      } catch {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
        return;
      }
      child.stdin?.end();
      child.stdin?.unref?.();
      child.stdout?.unref?.();
      child.stderr?.unref?.();
      child.unref?.();
      return;
    }
    child.stdin?.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }

  async #connect() {
    let child;
    try {
      child = this.spawnProcess(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        detached: this.detachableBridge,
        shell: false,
        stdio: this.detachableBridge
          ? ["pipe", "pipe", "pipe", "ipc"]
          : ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (cause) {
      this.closed = true;
      throw createError(
        "APP_SERVER_START_FAILED",
        "initialize",
        "Could not start Codex app-server",
        { cause, stderr: this.stderr },
      );
    }
    this.child = child;
    this.#attach(child);

    await this.#request(
      "initialize",
      {
        clientInfo: {
          name: "codex-small-loop",
          title: "Codex Small Loop",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      },
      "initialize",
    );
    this.#write({ method: "initialized", params: {} }, "initialize");
  }

  #attach(child) {
    child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr = boundedBytes(
        this.stderr,
        chunk,
        this.maxDiagnosticBytes,
      );
    });
    child.stdin.on("error", (cause) => {
      if (!this.intentionalClose) {
        this.#failAll(createError(
          "APP_SERVER_WRITE_FAILED",
          this.#currentOperation(),
          "Could not write to Codex app-server",
          { cause, stderr: this.stderr },
        ));
      }
    });
    child.on("error", (cause) => {
      if (!this.intentionalClose) {
        this.#failAll(createError(
          "APP_SERVER_START_FAILED",
          this.#currentOperation(),
          "Codex app-server process failed",
          { cause, stderr: this.stderr },
        ));
      }
    });
    child.on("exit", (code, signal) => {
      this.child = null;
      this.connected = false;
      if (!this.intentionalClose && !this.closed) {
        this.#failAll(createError(
          "APP_SERVER_EXITED",
          this.#currentOperation(),
          `Codex app-server exited unexpectedly (${code ?? signal ?? "unknown"})`,
          { exitCode: code, signal, stderr: this.stderr },
        ));
      }
    });
  }

  #onStdout(chunk) {
    if (this.closed) {
      return;
    }
    this.stdoutBuffer += this.stdoutDecoder.write(chunk);
    if (
      !this.stdoutBuffer.includes("\n")
      && Buffer.byteLength(this.stdoutBuffer) > this.maxFrameBytes
    ) {
      const receivedBytes = Buffer.byteLength(this.stdoutBuffer);
      this.#failAll(createError(
        "APP_SERVER_RESPONSE_TOO_LARGE",
        this.#currentOperation(),
        `Codex app-server response exceeds ${this.maxFrameBytes} bytes`,
        {
          direction: "server-to-client",
          receivedBytes,
          limitBytes: this.maxFrameBytes,
          stderr: this.stderr,
        },
      ));
      return;
    }

    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      const receivedBytes = Buffer.byteLength(line);
      if (receivedBytes > this.maxFrameBytes) {
        this.#failAll(createError(
          "APP_SERVER_RESPONSE_TOO_LARGE",
          this.#currentOperation(),
          `Codex app-server response exceeds ${this.maxFrameBytes} bytes`,
          {
            direction: "server-to-client",
            receivedBytes,
            limitBytes: this.maxFrameBytes,
            stderr: this.stderr,
          },
        ));
        return;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch (cause) {
        this.#failAll(createError(
          "APP_SERVER_PROTOCOL_ERROR",
          this.#currentOperation(),
          "Codex app-server emitted malformed JSON",
          { cause, stderr: this.stderr },
        ));
        return;
      }
      this.#handleMessage(message);
      if (this.closed) {
        return;
      }
    }
  }

  #handleMessage(message) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      this.#failAll(createError(
        "APP_SERVER_PROTOCOL_ERROR",
        this.#currentOperation(),
        "Codex app-server emitted an invalid protocol message",
        { stderr: this.stderr },
      ));
      return;
    }

    if (message.method === "codex-small-loop/bridge-error") {
      const code = typeof message.params?.code === "string"
        ? bounded(message.params.code, 128)
        : "APP_SERVER_BRIDGE_FAILED";
      const errorMessage = typeof message.params?.message === "string"
        ? bounded(message.params.message)
        : "Codex app-server bridge failed";
      this.#failAll(createError(
        code,
        this.#currentOperation(),
        errorMessage,
        {
          direction: message.params?.direction,
          receivedBytes: message.params?.receivedBytes,
          limitBytes: message.params?.limitBytes,
          stderr: this.stderr,
        },
      ));
      return;
    }

    if (message.method === "turn/completed") {
      const taskId = message.params?.threadId;
      const turnId = message.params?.turn?.id;
      const status = message.params?.turn?.status;
      if (
        !validIdentifier(taskId)
        || !validIdentifier(turnId)
        || !["completed", "interrupted", "failed"].includes(status)
      ) {
        this.#failAll(createError(
          "APP_SERVER_PROTOCOL_ERROR",
          "waitForTurn",
          "Codex app-server emitted an invalid turn/completed notification",
          { stderr: this.stderr },
        ));
        return;
      }
      const observation = Object.freeze({ taskId, turnId, status });
      const key = terminalKey(taskId, turnId);
      this.terminalTurns.set(key, observation);
      const waiters = this.turnWaiters.get(key) ?? [];
      this.turnWaiters.delete(key);
      for (const waiter of waiters) {
        waiter.resolve(observation);
      }
      return;
    }

    if (!Object.hasOwn(message, "id")) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(createError(
        "APP_SERVER_REQUEST_FAILED",
        pending.operation,
        `Codex app-server rejected ${pending.operation}: ${bounded(
          message.error.message ?? "unknown request error",
          256,
        )}`,
        {
          rpcCode: message.error.code,
          rpcData: message.error.data,
          stderr: this.stderr,
        },
      ));
      return;
    }
    if (!Object.hasOwn(message, "result")) {
      pending.reject(createError(
        "APP_SERVER_PROTOCOL_ERROR",
        pending.operation,
        `Codex app-server returned no result for ${pending.operation}`,
        { stderr: this.stderr },
      ));
      return;
    }
    pending.resolve(message.result);
  }

  #request(method, params, operation, timeoutMs = this.timeoutMs) {
    if (this.closed) {
      return Promise.reject(createError(
        "APP_SERVER_CLOSED",
        operation,
        "Codex app-server client is closed",
        { stderr: this.stderr },
      ));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = createError(
          "APP_SERVER_TIMEOUT",
          operation,
          `Codex app-server ${operation} timed out after ${timeoutMs}ms`,
          { stderr: this.stderr },
        );
        this.#failAll(error);
      }, timeoutMs);
      this.pending.set(id, { operation, reject, resolve, timer });
      this.#write({ id, method, params }, operation);
    });
  }

  #write(message, operation) {
    if (!this.child?.stdin?.writable) {
      this.#failAll(createError(
        "APP_SERVER_WRITE_FAILED",
        operation,
        "Codex app-server stdin is unavailable",
        { stderr: this.stderr },
      ));
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (cause) => {
      if (cause && !this.intentionalClose) {
        this.#failAll(createError(
          "APP_SERVER_WRITE_FAILED",
          operation,
          "Could not write to Codex app-server",
          { cause, stderr: this.stderr },
        ));
      }
    });
  }

  #currentOperation() {
    return this.pending.values().next().value?.operation
      ?? (this.turnWaiters.size > 0 ? "waitForTurn" : "protocol");
  }

  #failAll(error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.connected = false;
    this.#rejectOutstanding(error);
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }

  #rejectOutstanding(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(createError(
        error.code,
        pending.operation,
        error.message,
        {
          cause: error.cause,
          exitCode: error.exitCode,
          signal: error.signal,
          direction: error.direction,
          receivedBytes: error.receivedBytes,
          limitBytes: error.limitBytes,
          stderr: error.stderr ?? this.stderr,
        },
      ));
    }
    this.pending.clear();

    for (const waiters of this.turnWaiters.values()) {
      for (const waiter of waiters) {
        waiter.reject(createError(
          error.code,
          "waitForTurn",
          error.message,
          {
            cause: error.cause,
            exitCode: error.exitCode,
            signal: error.signal,
            direction: error.direction,
            receivedBytes: error.receivedBytes,
            limitBytes: error.limitBytes,
            stderr: error.stderr ?? this.stderr,
          },
        ));
      }
    }
    this.turnWaiters.clear();
  }
}
