#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";

import { AtomicJsonStore } from "./atomic-json-store.mjs";
import { CodexAppServerClient } from "./codex-app-server.mjs";
import {
  acceptConversation,
  continueConversation,
  replyToConversation,
  startConversation,
} from "./conversation.mjs";
import { appMessageScheduleId } from "./schedule.mjs";
import { resolveProject } from "./project.mjs";
import {
  enqueueAppMessage,
  readTaskLedger,
  transactTaskLedger,
} from "./task-ledger.mjs";
import {
  containsProgramProtocolMarker,
  renderConversationMessage,
  renderNotificationMessage,
  renderRoleReloadInstructions,
  sendTaskMessage,
} from "./task-messaging.mjs";
import {
  startRecoverySupervisor,
} from "./recovery-supervisor.mjs";

const MAX_MESSAGE_BYTES = 64 * 1_024;
const MAX_OUTPUT_MESSAGE_LENGTH = 512;
const MAX_TASK_ID_LENGTH = 512;
const DIRECT_THREAD_SOURCES = new Set(["codex-small-loop"]);
const SCHEDULE_THREAD_SOURCES = new Set(["user", "subagent"]);
const BODY_OPERATIONS = new Set(["notify", "start", "reply", "continue"]);
const MESSAGE_OPERATIONS = new Set([
  "notify",
]);
const CONVERSATION_OPERATIONS = new Set([
  "start",
  "reply",
  "continue",
  "accept",
]);
const MESSAGE_HELP = `Codex Small Loop task messaging

Information only (no reply or acknowledgement):
  message notify --task <task-id> [--message <text>] [--project-root <directory>]

Pass the Notification body with --message, or write it to standard input.
Results are one JSON object: exit 0 for ok, 2 for partial, and 1 for failed.
`;
const CONVERSATION_HELP = `Codex Small Loop managed Conversations

Start a Conversation with an existing managed Task:
  conversation start --task <managed-task-id> [--message <text>] [--reload-role] [--project-root <directory>]

Continue an existing Conversation:
  conversation reply|continue --conversation <conversation-id> [--message <text>] [--project-root <directory>]
  conversation accept --conversation <conversation-id> [--project-root <directory>]

Pass the natural-language body for start, reply, and continue with --message,
or write it to standard input.
Results are one JSON object: exit 0 for ok, 2 for partial, and 1 for failed.
`;

function messageError(code, message) {
  const error = new Error(message);
  error.name = "MessageCliError";
  error.code = code;
  return error;
}

function bounded(value, maximum = MAX_OUTPUT_MESSAGE_LENGTH) {
  const text = String(value);
  return text.length <= maximum
    ? text
    : `${text.slice(0, maximum - 1)}…`;
}

function validIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_TASK_ID_LENGTH
    && !/\s/.test(value);
}

function validRole(value) {
  return typeof value === "string"
    && value.length <= 128
    && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
}

function scheduleDeliveryFor(threadSource) {
  if (DIRECT_THREAD_SOURCES.has(threadSource)) return false;
  if (SCHEDULE_THREAD_SOURCES.has(threadSource)) return true;
  throw messageError(
    "MESSAGE_TASK_SOURCE_UNSUPPORTED",
    "Target Task has no supported threadSource",
  );
}

function taskRole(ledger, taskId, fallbackRole = null) {
  const managedTask = ledger.managedTasks.find(
    (task) => task?.taskId === taskId,
  );
  const incomingLink = ledger.links.find(
    (link) => link?.childTaskId === taskId,
  );
  const role = managedTask?.role ?? incomingLink?.role ?? fallbackRole;
  if (!validRole(role)) {
    throw messageError(
      "MESSAGE_ROLE_INVALID",
      "Task Ledger returned no readable Job Role for the message route",
    );
  }
  return role;
}

function requireManagedTarget(ledger, taskId) {
  if (
    !Array.isArray(ledger?.managedTasks)
    || !Array.isArray(ledger?.links)
    || !Array.isArray(ledger?.conversations)
  ) {
    throw messageError(
      "MESSAGE_LEDGER_INVALID",
      "Task Ledger must contain managedTasks, links, and conversations",
    );
  }
  if (!ledger.managedTasks.some((task) => task?.taskId === taskId)) {
    throw messageError(
      "MESSAGE_TARGET_UNMANAGED",
      "A new Conversation must target a managed Task in this project",
    );
  }
}

function parseArgs(argv, cwd, namespace) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")) {
    throw new TypeError("argv must be an array of strings");
  }
  const operation = argv[0];
  const operations = namespace === "conversation"
    ? CONVERSATION_OPERATIONS
    : MESSAGE_OPERATIONS;
  if (!operations.has(operation)) {
    throw messageError(
      namespace === "conversation"
        ? "CONVERSATION_COMMAND_INVALID"
        : "MESSAGE_COMMAND_INVALID",
      operation === undefined
        ? `A ${namespace} command is required`
        : `Unsupported ${namespace} command: ${bounded(operation, 128)}`,
    );
  }

  let taskId;
  let conversationId;
  let message;
  let reloadRole = false;
  let projectRoot = cwd;
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    const allowedOptions = new Set([
      "--task",
      "--conversation",
      "--message",
      "--project-root",
    ]);
    if (namespace === "conversation") allowedOptions.add("--reload-role");
    if (!allowedOptions.has(option)) {
      throw messageError(
        namespace === "conversation"
          ? "CONVERSATION_CLI_USAGE"
          : "MESSAGE_CLI_USAGE",
        `Unsupported ${namespace} argument: ${bounded(option, 128)}`,
      );
    }
    if (seen.has(option)) {
      throw messageError(
        namespace === "conversation"
          ? "CONVERSATION_CLI_USAGE"
          : "MESSAGE_CLI_USAGE",
        `${namespace} argument is repeated: ${option}`,
      );
    }
    seen.add(option);
    if (option === "--reload-role") {
      reloadRole = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw messageError(
        namespace === "conversation"
          ? "CONVERSATION_CLI_USAGE"
          : "MESSAGE_CLI_USAGE",
        `${namespace} argument requires a value: ${option}`,
      );
    }
    index += 1;
    if (option === "--task") taskId = value;
    else if (option === "--conversation") conversationId = value;
    else if (option === "--message") message = value;
    else projectRoot = path.resolve(cwd, value);
  }

  if (operation === "notify" || operation === "start") {
    if (
      !validIdentifier(taskId)
      || conversationId !== undefined
    ) {
      throw messageError(
        operation === "start"
          ? "CONVERSATION_TASK_REQUIRED"
          : "MESSAGE_TASK_REQUIRED",
        `${namespace} ${operation} requires --task <task-id>`,
      );
    }
  } else if (
    !validIdentifier(conversationId)
    || taskId !== undefined
  ) {
    throw messageError(
      "CONVERSATION_ID_REQUIRED",
      `conversation ${operation} requires --conversation <conversation-id>`,
    );
  }
  if (reloadRole && operation !== "start") {
    throw messageError(
      "CONVERSATION_CLI_USAGE",
      "--reload-role is valid only for conversation start",
    );
  }
  if (message !== undefined && !BODY_OPERATIONS.has(operation)) {
    throw messageError(
      namespace === "conversation"
        ? "CONVERSATION_CLI_USAGE"
        : "MESSAGE_CLI_USAGE",
      `--message is not valid for ${namespace} ${operation}`,
    );
  }
  return {
    operation,
    projectRoot: path.resolve(projectRoot),
    taskId,
    conversationId,
    message,
    reloadRole,
  };
}

function isManagedTask(ledger, taskId) {
  return ledger.managedTasks.some((task) => task?.taskId === taskId);
}

function validateMessage(text) {
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
    throw messageError(
      "MESSAGE_TEXT_TOO_LARGE",
      `Message text exceeds ${MAX_MESSAGE_BYTES} bytes`,
    );
  }
  if (text.length === 0) {
    throw messageError(
      "MESSAGE_TEXT_REQUIRED",
      "Message text is required with --message or on standard input",
    );
  }
  if (containsProgramProtocolMarker(text)) {
    throw messageError(
      "MESSAGE_PROTOCOL_MARKER_RESERVED",
      "Message body must not contain program-owned protocol marker lines",
    );
  }
  return text;
}

async function readMessage(readable) {
  if (
    readable === null
    || typeof readable !== "object"
    || typeof readable[Symbol.asyncIterator] !== "function"
  ) {
    throw new TypeError("stdin must be an async iterable");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of readable) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > MAX_MESSAGE_BYTES) {
      throw messageError(
        "MESSAGE_TEXT_TOO_LARGE",
        `Message text exceeds ${MAX_MESSAGE_BYTES} bytes`,
      );
    }
    chunks.push(buffer);
  }
  return validateMessage(Buffer.concat(chunks).toString("utf8"));
}

function findConversation(ledger, conversationId) {
  if (!Array.isArray(ledger?.conversations)) {
    throw messageError(
      "MESSAGE_LEDGER_INVALID",
      "Task Ledger must contain conversations",
    );
  }
  const conversation = ledger.conversations.find(
    ({ id }) => id === conversationId,
  );
  if (!conversation) {
    throw messageError(
      "CONVERSATION_NOT_FOUND",
      "Conversation does not exist",
    );
  }
  return conversation;
}

function routeFor(parsed, ledger, senderTaskId, createId) {
  if (parsed.operation === "notify") {
    return {
      conversationId: null,
      initiatorTaskId: null,
      targetTaskId: parsed.taskId,
      responderTaskId: null,
      initiatorRole: null,
      responderRole: null,
    };
  }
  if (parsed.operation === "start") {
    requireManagedTarget(ledger, parsed.taskId);
    return {
      conversationId: createId(),
      initiatorTaskId: senderTaskId,
      targetTaskId: parsed.taskId,
      responderTaskId: parsed.taskId,
      initiatorRole: taskRole(ledger, senderTaskId, "controller"),
      responderRole: taskRole(ledger, parsed.taskId),
    };
  }
  const conversation = findConversation(ledger, parsed.conversationId);
  if (parsed.operation === "reply") {
    return {
      conversationId: conversation.id,
      initiatorTaskId: conversation.initiatorTaskId,
      targetTaskId: conversation.initiatorTaskId,
      responderTaskId: conversation.responderTaskId,
      initiatorRole: conversation.initiatorRole,
      responderRole: conversation.responderRole,
    };
  }
  return {
    conversationId: conversation.id,
    initiatorTaskId: conversation.initiatorTaskId,
    targetTaskId: conversation.responderTaskId,
    responderTaskId: conversation.responderTaskId,
    initiatorRole: conversation.initiatorRole,
    responderRole: conversation.responderRole,
  };
}

function transitionConversation(state, parsed, route, senderTaskId, now) {
  if (parsed.operation === "start") {
    return startConversation(state, {
      conversationId: route.conversationId,
      initiatorTaskId: senderTaskId,
      initiatorRole: route.initiatorRole,
      responderTaskId: route.targetTaskId,
      responderRole: route.responderRole,
      now,
    });
  }
  const input = {
    conversationId: route.conversationId,
    senderTaskId,
    now,
  };
  if (parsed.operation === "reply") {
    return replyToConversation(state, input);
  }
  if (parsed.operation === "continue") {
    return continueConversation(state, input);
  }
  return acceptConversation(state, input);
}

function writeJson(stdout, result) {
  stdout.write(`${JSON.stringify(result)}\n`);
}

function errorResult(error, operation = "message") {
  return {
    run: "failed",
    operation,
    code: typeof error?.code === "string"
      ? bounded(error.code, 128)
      : "MESSAGE_SEND_FAILED",
    message: bounded(error?.message ?? "Task message failed"),
    ...(error?.expectedContext ? { expectedContext: error.expectedContext } : {}),
    ...(error?.actualContext ? { actualContext: error.actualContext } : {}),
  };
}

function renderCommunication(parsed, route, text, scheduleId) {
  const message = parsed.operation === "notify"
    ? renderNotificationMessage({
      scheduleId,
      targetTaskId: route.targetTaskId,
      text,
    })
    : renderConversationMessage({
      conversationId: route.conversationId,
      initiatorTaskId: route.initiatorTaskId,
      initiatorRole: route.initiatorRole,
      operation: parsed.operation,
      responderTaskId: route.responderTaskId,
      responderRole: route.responderRole,
      scheduleId,
      text,
    });
  return parsed.reloadRole
    ? `${renderRoleReloadInstructions({ role: route.responderRole })}\n\n${message}`
    : message;
}

async function runCommunicationCli(namespace, argv, options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  const createAppServer = options.createAppServer
    ?? ((input) => new CodexAppServerClient(input));
  const send = options.send ?? sendTaskMessage;
  const createId = options.createMessageId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const resolve = options.resolveProject ?? resolveProject;
  const transact = options.transactTaskLedger ?? transactTaskLedger;
  const startSupervisor = options.startSupervisor
    ?? startRecoverySupervisor;
  const readLedger = options.readLedger;
  let appServer;
  let operation = namespace;
  let committedEvidence = null;

  try {
    if (
      Array.isArray(argv)
      && argv.length === 1
      && new Set(["--help", "help"]).has(argv[0])
    ) {
      stdout.write(namespace === "conversation"
        ? CONVERSATION_HELP
        : MESSAGE_HELP);
      return 0;
    }
    const parsed = parseArgs(argv, cwd, namespace);
    operation = parsed.operation;
    const senderTaskId = env.CODEX_THREAD_ID;
    if (!validIdentifier(senderTaskId)) {
      throw messageError(
        "MESSAGE_SOURCE_TASK_REQUIRED",
        `${namespace} requires CODEX_THREAD_ID for the sending Task`,
      );
    }
    const text = BODY_OPERATIONS.has(parsed.operation)
      ? parsed.message === undefined
        ? await readMessage(stdin)
        : validateMessage(parsed.message)
      : null;
    const project = await resolve(parsed.projectRoot);
    const store = options.store ?? new AtomicJsonStore(project.stateFile);
    const ledger = readLedger
      ? await readLedger(parsed.projectRoot)
      : await readTaskLedger(store, project);
    const timestamp = now();

    const route = routeFor(parsed, ledger, senderTaskId, createId);

    if (parsed.operation === "accept") {
      const committed = await transact(
        store,
        project,
        (state) => {
          const transition = transitionConversation(
            state,
            parsed,
            route,
            senderTaskId,
            timestamp,
          );
          return {
            state: transition.state,
            result: transition.conversation,
          };
        },
        { now: timestamp },
      );
      writeJson(stdout, {
        run: "ok",
        operation: "accept",
        conversationId: committed.result.id,
        state: committed.result.state,
      });
      return 0;
    }

    const replyTargetsAppTask = parsed.operation === "reply"
      && !isManagedTask(ledger, route.targetTaskId);
    let target;
    if (replyTargetsAppTask) {
      target = {
        taskId: route.targetTaskId,
        threadSource: "user",
      };
    } else {
      appServer = createAppServer({ cwd: parsed.projectRoot });
      if (typeof appServer?.readTask !== "function") {
        throw messageError(
          "MESSAGE_TASK_SOURCE_UNAVAILABLE",
          "Codex App control cannot read the target Task source",
        );
      }
      target = await appServer.readTask({ taskId: route.targetTaskId });
    }
    if (
      target?.taskId !== route.targetTaskId
      || (
        target.threadSource !== null
        && typeof target.threadSource !== "string"
      )
    ) {
      throw messageError(
        "MESSAGE_TASK_SOURCE_INVALID",
        "Codex App returned no matching target Task source",
      );
    }
    const sourceUsesSchedule = scheduleDeliveryFor(target.threadSource);
    const scheduleDelivery = !isManagedTask(ledger, route.targetTaskId) && sourceUsesSchedule;
    const messageId = scheduleDelivery ? createId() : null;
    const scheduleId = messageId === null
      ? null
      : appMessageScheduleId(messageId);
    const rendered = renderCommunication(parsed, route, text, scheduleId);
    if (Buffer.byteLength(rendered, "utf8") > MAX_MESSAGE_BYTES) {
      throw messageError(
        "MESSAGE_TEXT_TOO_LARGE",
        `Rendered message exceeds ${MAX_MESSAGE_BYTES} bytes`,
      );
    }
    let committed = null;
    if (parsed.operation !== "notify" || scheduleDelivery) {
      committed = await transact(
        store,
        project,
        (state) => {
          const transitioned = parsed.operation === "notify"
            ? { state, conversation: null }
            : transitionConversation(
              state,
              parsed,
              route,
              senderTaskId,
              timestamp,
            );
          if (!scheduleDelivery) {
            return {
              state: transitioned.state,
              result: transitioned.conversation,
            };
          }
          const queued = enqueueAppMessage(transitioned.state, {
            id: messageId,
            sourceTaskId: senderTaskId,
            targetTaskId: route.targetTaskId,
            text: rendered,
          }, { now: timestamp });
          return {
            state: queued.state,
            result: transitioned.conversation,
          };
        },
        { now: timestamp },
      );
    }
    if (scheduleDelivery) {
      committedEvidence = {
        ...(parsed.operation === "notify"
          ? { replyExpected: false }
          : { conversationId: committed.result.id }),
        taskId: route.targetTaskId,
        messageId,
        delivery: "queued",
        recommendedAction: "start_supervisor",
      };
    } else if (committed?.result) {
      committedEvidence = {
        conversationId: committed.result.id,
        taskId: route.targetTaskId,
        delivery: "not_queued",
        recommendedAction: "inspect_delivery",
      };
    }

    if (scheduleDelivery) {
      await startSupervisor(project.root);
      writeJson(stdout, {
        run: "ok",
        operation: parsed.operation,
        ...(parsed.operation === "notify"
          ? { replyExpected: false }
          : { conversationId: committed.result.id }),
        taskId: route.targetTaskId,
        messageId,
        delivery: "queued",
      });
      return 0;
    }

    let deliveryCwd = parsed.projectRoot;
    if (parsed.operation === "notify") {
      if (typeof appServer?.readTaskProfile !== "function") {
        throw messageError(
          "MESSAGE_TASK_CWD_UNAVAILABLE",
          "Codex App control cannot read the notification target cwd",
        );
      }
      const settings = await appServer.readTaskProfile({
        taskId: route.targetTaskId,
      });
      if (
        settings?.taskId !== route.targetTaskId
        || typeof settings.cwd !== "string"
        || !path.isAbsolute(settings.cwd)
      ) {
        throw messageError(
          "MESSAGE_TASK_CWD_INVALID",
          "Codex App returned no matching absolute notification target cwd",
        );
      }
      deliveryCwd = path.normalize(settings.cwd);
    }
    let result;
    try {
      result = await send({
        taskId: route.targetTaskId,
        text: rendered,
        cwd: deliveryCwd,
      }, { appServer });
    } catch (error) {
      // A direct-runtime target must never be moved to a heartbeat, including
      // authority mismatches and writer conflicts. Preserve any committed
      // Conversation evidence and let the caller inspect the failed delivery.
      throw error;
    }

    committedEvidence = {
      ...(parsed.operation === "notify"
        ? { replyExpected: false }
        : { conversationId: committed.result.id }),
      taskId: route.targetTaskId,
      delivery: "unknown",
      recommendedAction: "inspect_delivery",
    };
    if (
      result?.taskId !== route.targetTaskId
      || !validIdentifier(result?.turnId)
      || !new Set(["started", "steered"]).has(result?.delivery)
    ) {
      throw messageError(
        "MESSAGE_RESPONSE_INVALID",
        "Codex App did not return the targeted Task ID and accepted Turn ID",
      );
    }
    committedEvidence = {
      ...(parsed.operation === "notify"
        ? { replyExpected: false }
        : { conversationId: committed.result.id }),
      taskId: route.targetTaskId,
      turnId: result.turnId,
      delivery: result.delivery,
      recommendedAction: parsed.operation === "notify"
        ? "none"
        : "start_supervisor",
    };
    if (parsed.operation !== "notify") {
      await startSupervisor(project.root);
    }
    writeJson(stdout, {
      run: "ok",
      operation: parsed.operation,
      ...(parsed.operation === "notify"
        ? { replyExpected: false }
        : { conversationId: committed.result.id }),
      taskId: route.targetTaskId,
      turnId: result.turnId,
      delivery: result.delivery,
    });
    return 0;
  } catch (error) {
    if (committedEvidence !== null) {
      writeJson(stdout, {
        ...errorResult(error, operation),
        run: "partial",
        ...committedEvidence,
      });
      return 2;
    }
    writeJson(stdout, errorResult(error, operation));
    return 1;
  } finally {
    await appServer?.close();
  }
}

export async function runMessageCli(argv, options = {}) {
  return runCommunicationCli("message", argv, options);
}

export async function runConversationCli(argv, options = {}) {
  return runCommunicationCli("conversation", argv, options);
}
