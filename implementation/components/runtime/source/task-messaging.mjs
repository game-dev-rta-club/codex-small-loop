import path from "node:path";

import {
  observeExactTurn,
  observeLatestTask,
  observeTasks,
} from "./task-state-observer.mjs";
import { requireTaskRunContext } from "./task-run-context.mjs";
import { pathsEqual } from "./path-identity.mjs";

const MAX_TASK_ID_LENGTH = 512;
const MAX_MESSAGE_LENGTH = 512;
const MAX_TASK_MESSAGE_LENGTH = 64 * 1_024;
const MAX_DISPLAY_LINE_LENGTH = 256;
const ACTION_KINDS = new Set(["interrupt", "recovery", "resume"]);
const FINISHED_TURN_STATES = new Set([
  "aborted",
  "ended",
  "not_started",
]);
const MESSAGE_TERMINAL_STATES = new Set(["aborted", "ended"]);
const DEFAULT_MESSAGE_TIMEOUT_MS = 30_000;
const DEFAULT_MESSAGE_POLL_INTERVAL_MS = 250;
const DEFAULT_MESSAGE_ROUTE_ATTEMPTS = 4;
const PROGRAM_PROTOCOL_MARKER = /^===.*===$/m;

function requireExactOptions(options, expectedKeys) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  const actualKeys = Object.keys(options).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length
    || actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new TypeError(`options may contain only ${sortedExpectedKeys.join(", ")}`);
  }
}

function requireTaskId(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_TASK_ID_LENGTH
    || /\s/.test(value)
  ) {
    throw new TypeError(`${label} must be a non-empty bounded Task ID`);
  }
  return value;
}

function requireNullableTaskId(value, label) {
  return value === null ? null : requireTaskId(value, label);
}

export function isMessageDisplayLine(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_DISPLAY_LINE_LENGTH
    && value.trim() === value
    && !/[\r\n]/.test(value);
}

function requireDisplayLine(value, label) {
  if (!isMessageDisplayLine(value)) {
    throw new TypeError(`${label} must be one non-empty bounded line`);
  }
  return value;
}

function requireJobRole(value, label) {
  if (
    typeof value !== "string"
    || value.length > 128
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)
  ) {
    throw new TypeError(`${label} must be a bounded kebab-case job role`);
  }
  return value;
}

function displayJobRole(value, label) {
  return requireJobRole(value, label)
    .split("-")
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function requireMessageText(value, label = "text") {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_TASK_MESSAGE_LENGTH
  ) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  return value;
}

export function containsProgramProtocolMarker(text) {
  return typeof text === "string" && PROGRAM_PROTOCOL_MARKER.test(text);
}

function requireAgentBody(value, label) {
  const text = requireMessageText(value, label);
  if (containsProgramProtocolMarker(text)) {
    throw new TypeError(
      `${label} must not contain program-owned protocol marker lines`,
    );
  }
  return text;
}

export function renderConversationMessage(options) {
  requireExactOptions(
    options,
    [
      "conversationId",
      "initiatorTaskId",
      "initiatorRole",
      "operation",
      "responderTaskId",
      "responderRole",
      "scheduleId",
      "text",
    ],
  );
  const conversationId = requireTaskId(
    options.conversationId,
    "conversationId",
  );
  const initiatorTaskId = requireTaskId(
    options.initiatorTaskId,
    "initiatorTaskId",
  );
  const responderTaskId = requireTaskId(
    options.responderTaskId,
    "responderTaskId",
  );
  const initiatorRole = displayJobRole(
    options.initiatorRole,
    "initiatorRole",
  );
  const responderRole = displayJobRole(
    options.responderRole,
    "responderRole",
  );
  if (!new Set(["start", "reply", "continue"]).has(options.operation)) {
    throw new TypeError(
      "operation must be start, reply, or continue",
    );
  }
  const text = requireAgentBody(options.text, "text");
  const scheduleId = requireNullableTaskId(options.scheduleId, "scheduleId");
  const arrow = options.operation === "reply" ? "←" : "→";
  const actions = [];
  if (scheduleId !== null) {
    actions.push({
      type: "delete_schedule",
      scheduleId,
      targetTaskId: options.operation === "reply"
        ? initiatorTaskId
        : responderTaskId,
    });
  }
  actions.push(options.operation === "reply"
    ? {
      type: "continue_or_accept_conversation",
      conversationId,
    }
    : {
      type: "reply_to_conversation",
      conversationId,
    });

  return `=== Codex Small Loop · ${initiatorRole} ${arrow} ${responderRole} ===

=== Conversation ===
Initiator Task ID: ${initiatorTaskId}
Responder Task ID: ${responderTaskId}
Conversation ID: ${conversationId}

=== Message ===
${text}

${renderNextActions(actions)}`;
}

export function renderNotificationMessage(options) {
  requireExactOptions(options, ["scheduleId", "targetTaskId", "text"]);
  const text = requireAgentBody(options.text, "text");
  const scheduleId = requireNullableTaskId(options.scheduleId, "scheduleId");
  const targetTaskId = requireTaskId(options.targetTaskId, "targetTaskId");
  const rendered = `=== Codex Small Loop · Notification ===

No reply or acknowledgement is required.

=== Message ===
${text}`;
  return scheduleId === null
    ? rendered
    : `${rendered}

${renderNextActions([{
  type: "delete_schedule",
  scheduleId,
  targetTaskId,
}])}`;
}

export function renderNextActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new TypeError("next actions must be a non-empty array");
  }

  const rendered = actions.map((action, index) => {
    if (action === null || typeof action !== "object" || Array.isArray(action)) {
      throw new TypeError("next action must be an object");
    }
    if (action.type === "delete_schedule") {
      requireExactOptions(action, ["scheduleId", "targetTaskId", "type"]);
      const scheduleId = requireTaskId(action.scheduleId, "scheduleId");
      const targetTaskId = requireTaskId(
        action.targetTaskId,
        "targetTaskId",
      );
      return `${index + 1}. Delete this delivery schedule before continuing.
   First run Codex Small Loop \`schedule read --schedule ${scheduleId} --task ${targetTaskId}\`.
   Then run \`schedule delete --schedule ${scheduleId} --task ${targetTaskId} --if-match <returned-etag>\`.`;
    }
    if (action.type === "reply_to_conversation") {
      requireExactOptions(action, ["conversationId", "type"]);
      const conversationId = requireTaskId(
        action.conversationId,
        "conversationId",
      );
      return `${index + 1}. Reply to this Conversation after completing the requested work.
   Conversation ID: ${conversationId}
   Use Codex Small Loop \`conversation reply --conversation ${conversationId}\`.`;
    }
    if (action.type === "continue_or_accept_conversation") {
      requireExactOptions(action, ["conversationId", "type"]);
      const conversationId = requireTaskId(
        action.conversationId,
        "conversationId",
      );
      return `${index + 1}. Continue or accept this replied Conversation.
   Conversation ID: ${conversationId}
   Use Codex Small Loop \`conversation continue --conversation ${conversationId}\` to ask for another reply.
   Use Codex Small Loop \`conversation accept --conversation ${conversationId}\` to close only this Conversation.`;
    }
    throw new TypeError("next action has an unsupported type");
  });

  return `=== Next Actions ===
${rendered.join("\n\n")}`;
}

export function renderSystemInstructions(options) {
  requireExactOptions(options, ["systemName", "text"]);
  const systemName = requireDisplayLine(options.systemName, "systemName");
  const text = requireMessageText(options.text);

  return `=== Codex Small Loop · ${systemName} (System) ===

=== System Instructions ===
${text}`;
}

export function renderRoleReloadInstructions(options) {
  requireExactOptions(options, ["role"]);
  const role = requireJobRole(options.role, "role");
  return renderSystemInstructions({
    systemName: "Role Reload",
    text: `Before handling the following Conversation message:
1. Run \`node <plugin-root>/components/commands/role.mjs ${role}\`.
2. Read the command's complete output and apply it as the current role.
3. Continue in this same turn with the Conversation message.`,
  });
}

export function renderLaunchRoleInstructions(options) {
  requireExactOptions(
    options,
    ["childTaskId", "parentTaskId", "role"],
  );
  const childTaskId = requireTaskId(options.childTaskId, "childTaskId");
  const parentTaskId = requireTaskId(options.parentTaskId, "parentTaskId");
  const role = requireTaskId(options.role, "role");

  return renderSystemInstructions({
    systemName: "Role System",
    text: `This is a new managed task with a Codex Small Loop identity and role.

Parent Task ID: ${parentTaskId}
Current Task ID: ${childTaskId}
Current role: ${role}

Before doing any assigned work:
1. Run \`node <plugin-root>/components/commands/role.mjs ${role}\`.
2. Read the command's complete output and apply it as the current role.
3. End this turn after confirming that the current role is active.

Do not execute the Parent assignment in this turn.
Do not act as the Parent or Root task.`,
  });
}

export function renderForkNotification(options) {
  requireExactOptions(
    options,
    [
      "currentRole",
      "currentTaskId",
      "parentTaskId",
      "previousRole",
      "sourceTaskId",
    ],
  );
  const currentRole = requireJobRole(options.currentRole, "currentRole");
  const currentTaskId = requireTaskId(
    options.currentTaskId,
    "currentTaskId",
  );
  const parentTaskId = requireTaskId(options.parentTaskId, "parentTaskId");
  const previousRole = requireJobRole(options.previousRole, "previousRole");
  const sourceTaskId = requireTaskId(
    options.sourceTaskId,
    "sourceTaskId",
  );

  return `=== Codex Small Loop · Fork Notification (System) ===

=== IMPORTANT ===

Hello. This is a new task forked from a previous task.

This new thread has inherited the previous task's conversation context.
Reload the current role, then proceed with the assignment from the Parent task.

Previous role: ${previousRole}
Current role: ${currentRole}
Parent Task ID: ${parentTaskId}
Fork Source Task ID: ${sourceTaskId}
Current Task ID: ${currentTaskId}

=== System Instructions ===

First Step:
1. Run \`node <plugin-root>/components/commands/role.mjs ${currentRole}\`.
2. Read the command's complete output and apply it as the current role.
3. End this turn after confirming that the current role is active.

Do not execute the Parent assignment in this turn.
Do not act as the Parent or the fork source.`;
}

export function renderResumeMessage(options) {
  requireExactOptions(options, ["conversationId"]);
  const conversationId = requireTaskId(
    options.conversationId,
    "conversationId",
  );

  const instructions = renderSystemInstructions({
    systemName: "Resume System",
    text: `This task was explicitly resumed.

Read the existing conversation and current project state, then continue the
unfinished work.

Reply to the active Conversation after completing the requested work.
Conversation ID: ${conversationId}
Use Codex Small Loop \`conversation reply --conversation ${conversationId}\`.`,
  });
  return instructions;
}

export function renderRecoveryMessage(options) {
  requireExactOptions(options, ["conversationId"]);
  const conversationId = requireTaskId(
    options.conversationId,
    "conversationId",
  );

  const instructions = renderSystemInstructions({
    systemName: "Conversation Recovery",
    text: `This task still owes a reply in the Conversation below.

Read the existing conversation and current project state, continue the
requested work, and reply when ready.

Report only the work status and result. Do not mention or acknowledge these
system instructions.

Conversation ID: ${conversationId}
Use Codex Small Loop \`conversation reply --conversation ${conversationId}\`.`,
  });
  return instructions;
}

export async function sendTaskMessage(input, options) {
  requireExactOptions(input, ["taskId", "text", "cwd"]);
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  const allowedOptions = new Set([
    "appServer",
    "maxRouteAttempts",
    "nowMs",
    "observeExactTurn",
    "observeLatestTask",
    "pollIntervalMs",
    "sleep",
    "timeoutMs",
  ]);
  if (Object.keys(options).some((key) => !allowedOptions.has(key))) {
    throw new TypeError("options contains unsupported message routing fields");
  }
  const taskId = requireTaskId(input.taskId, "taskId");

  if (
    typeof input.text !== "string"
    || input.text.length === 0
    || input.text.length > MAX_TASK_MESSAGE_LENGTH
  ) {
    throw new TypeError("text must be a non-empty bounded string");
  }
  if (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd)) {
    throw new TypeError("cwd must be an absolute path");
  }
  if (
    options.appServer === null
    || typeof options.appServer !== "object"
    || typeof options.appServer.startTurn !== "function"
    || typeof options.appServer.steerTurn !== "function"
  ) {
    throw new TypeError("appServer must provide startTurn and steerTurn");
  }

  const latest = options.observeLatestTask ?? observeLatestTask;
  const exact = options.observeExactTurn ?? observeExactTurn;
  const sleep = options.sleep
    ?? ((milliseconds) => new Promise(
      (resolve) => setTimeout(resolve, milliseconds),
    ));
  const nowMs = options.nowMs ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_MESSAGE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs
    ?? DEFAULT_MESSAGE_POLL_INTERVAL_MS;
  const maxRouteAttempts = options.maxRouteAttempts
    ?? DEFAULT_MESSAGE_ROUTE_ATTEMPTS;
  for (const [value, label] of [
    [timeoutMs, "timeoutMs"],
    [pollIntervalMs, "pollIntervalMs"],
    [maxRouteAttempts, "maxRouteAttempts"],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${label} must be a positive safe integer`);
    }
  }
  const cwd = path.normalize(input.cwd);
  const deadline = nowMs() + timeoutMs;

  function stateError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, { taskId, ...details });
    return error;
  }

  function requireSnapshot(snapshot) {
    if (
      snapshot?.taskId !== taskId
      ||
      snapshot?.location !== "active"
      || typeof snapshot.historyFile !== "string"
      || !path.isAbsolute(snapshot.historyFile)
    ) {
      throw stateError(
        "TASK_MESSAGE_TARGET_UNAVAILABLE",
        "Target task is missing, archived, or has no readable active history.",
      );
    }
    if (
      snapshot.turnState === "unknown"
      || (
        snapshot.turnState === "in_progress"
        && !validTurnId(snapshot.latestTurnId)
      )
    ) {
      throw stateError(
        "TASK_MESSAGE_STATE_UNKNOWN",
        "Target task state could not be proven from Codex history.",
      );
    }
    return snapshot;
  }

  async function currentStartSettings() {
    if (typeof options.appServer.resumeTask !== "function") {
      throw stateError(
        "TASK_PERMISSION_UNKNOWN",
        "Target task permissions cannot be read before starting a turn.",
      );
    }
    let persistedRunContext = null;
    if (typeof options.appServer.readTaskProfile === "function") {
      const persisted = await options.appServer.readTaskProfile({ taskId });
      if (persisted?.taskId !== taskId) {
        throw stateError(
          "TASK_PERMISSION_UNKNOWN",
          "Persisted task settings do not match the requested task.",
        );
      }
      try {
        persistedRunContext = requireTaskRunContext(persisted.runContext);
      } catch (cause) {
        throw stateError(
          "TASK_PERMISSION_UNKNOWN",
          "Persisted task run context is missing or invalid.",
          { causeCode: cause?.code ?? null },
        );
      }
    }
    const settings = await options.appServer.resumeTask({
      taskId,
      ...(persistedRunContext === null
        ? {}
        : { runContext: persistedRunContext }),
    });
    if (settings?.taskId !== taskId) {
      throw stateError(
        "TASK_PERMISSION_UNKNOWN",
        "Target task permission settings do not match the requested task.",
      );
    }
    if (
      typeof settings.cwd !== "string"
      || !path.isAbsolute(settings.cwd)
      || !pathsEqual(settings.cwd, cwd)
    ) {
      throw stateError(
        "TASK_MESSAGE_CWD_MISMATCH",
        "Target task cwd does not match the selected project root.",
        {
          expectedCwd: cwd,
          actualCwd: typeof settings?.cwd === "string"
            ? settings.cwd
            : null,
        },
      );
    }
    try {
      return requireTaskRunContext(settings.runContext);
    } catch (cause) {
      throw stateError(
        "TASK_PERMISSION_UNKNOWN",
        "Target task run context is missing or invalid.",
        { causeCode: cause?.code ?? null },
      );
    }
  }

  async function waitForExactTerminal(turnId) {
    for (;;) {
      const snapshot = await exact(taskId, turnId);
      if (MESSAGE_TERMINAL_STATES.has(snapshot?.turnState)) {
        return snapshot;
      }
      if (snapshot?.turnState !== "in_progress") {
        throw stateError(
          "TASK_MESSAGE_STATE_UNKNOWN",
          "Active target turn could not be tracked to a terminal event.",
          { turnId },
        );
      }
      const remaining = deadline - nowMs();
      if (remaining <= 0) {
        throw stateError(
          "TASK_MESSAGE_WAIT_TIMEOUT",
          "Timed out waiting for the target task's active turn to finish.",
          { turnId },
        );
      }
      await sleep(Math.min(pollIntervalMs, remaining));
    }
  }

  let snapshot = requireSnapshot(await latest(taskId));
  for (let attempt = 0; attempt < maxRouteAttempts; attempt += 1) {
    if (snapshot.turnState !== "in_progress") {
      const runContext = await currentStartSettings();
      const result = await options.appServer.startTurn({
        taskId,
        text: input.text,
        cwd,
        runContext,
      });
      if (!validTurnId(result?.turnId)) {
        throw stateError(
          "APP_SERVER_RESPONSE_INVALID",
          "Codex app-server returned no valid Turn ID.",
        );
      }
      return Object.freeze({
        taskId,
        turnId: result.turnId,
        delivery: "started",
      });
    }

    const observedTurnId = snapshot.latestTurnId;
    try {
      const result = await options.appServer.steerTurn({
        taskId,
        turnId: observedTurnId,
        text: input.text,
        cwd,
      });
      if (result?.turnId !== observedTurnId) {
        throw stateError(
          "APP_SERVER_RESPONSE_INVALID",
          "Codex app-server returned no matching steered Turn ID.",
          { turnId: observedTurnId },
        );
      }
      return Object.freeze({
        taskId,
        turnId: observedTurnId,
        delivery: "steered",
      });
    } catch (error) {
      if (error?.code === "APP_SERVER_STEER_TURN_MISMATCH") {
        snapshot = requireSnapshot(await latest(taskId));
        continue;
      }
      if (error?.code === "APP_SERVER_STEER_NOT_STEERABLE") {
        await waitForExactTerminal(observedTurnId);
        snapshot = requireSnapshot(await latest(taskId));
        continue;
      }
      if (error?.code === "APP_SERVER_STEER_NO_ACTIVE_TURN") {
        const refreshed = requireSnapshot(await latest(taskId));
        if (
          refreshed.turnState === "in_progress"
          && refreshed.latestTurnId === observedTurnId
        ) {
          await waitForExactTerminal(observedTurnId);
          snapshot = requireSnapshot(await latest(taskId));
        } else {
          snapshot = refreshed;
        }
        continue;
      }
      throw error;
    }
  }

  throw stateError(
    "TASK_MESSAGE_ROUTE_UNSTABLE",
    "Target task state changed repeatedly while routing the message.",
  );
}

function bounded(value, maximum = MAX_MESSAGE_LENGTH) {
  const text = String(value);
  return text.length <= maximum
    ? text
    : `${text.slice(0, maximum - 1)}…`;
}

function requireMechanicalActions(actions) {
  if (!Array.isArray(actions)) {
    throw new TypeError("actions must be an array");
  }

  return actions.map((action) => {
    if (
      action === null
      || typeof action !== "object"
      || Array.isArray(action)
      || typeof action.id !== "string"
      || action.id.length === 0
      || !ACTION_KINDS.has(action.kind)
    ) {
      throw new TypeError(
        "actions must contain leased interrupt, recovery, or resume deliveries",
      );
    }
    return {
      deliveryId: action.id,
      kind: action.kind,
      targetTaskId: requireTaskId(
        action.targetTaskId,
        "targetTaskId",
      ),
      parentTaskId: requireTaskId(
        action.parentTaskId,
        "parentTaskId",
      ),
      conversationId: action.conversationId === null
        || action.conversationId === undefined
        ? null
        : requireTaskId(action.conversationId, "conversationId"),
    };
  });
}

function requireDeliveryOptions(options) {
  if (
    options === null
    || typeof options !== "object"
    || Array.isArray(options)
    || typeof options.projectRoot !== "string"
    || !path.isAbsolute(options.projectRoot)
    || options.appServer === null
    || typeof options.appServer !== "object"
    || typeof options.appServer.startTurn !== "function"
    || typeof options.appServer.steerTurn !== "function"
    || typeof options.appServer.interruptTurn !== "function"
  ) {
    throw new TypeError(
      "options require an absolute projectRoot and appServer controls",
    );
  }

  return {
    appServer: options.appServer,
    observe: options.observeTasks ?? observeTasks,
    observationOptions: {
      roots: options.roots,
      cachedPaths: options.cachedPaths,
      fileSystem: options.fileSystem,
      openHistory: options.openHistory,
    },
    projectRoot: path.normalize(options.projectRoot),
  };
}

function failure(deliveryId, error, fallbackCode = "DELIVERY_FAILED") {
  return {
    deliveryId,
    status: "failed",
    error: {
      code: typeof error?.code === "string"
        ? bounded(error.code, 128)
        : fallbackCode,
      message: bounded(error?.message ?? "Mechanical delivery failed."),
    },
  };
}

function delivered(deliveryId, effect, details = {}) {
  return {
    deliveryId,
    status: "delivered",
    effect,
    ...details,
  };
}

function validTurnId(turnId) {
  return typeof turnId === "string"
    && turnId.trim().length > 0
    && turnId.length <= MAX_TASK_ID_LENGTH;
}

export async function deliverMechanicalActions(actions, rawOptions) {
  const normalized = requireMechanicalActions(actions);
  const options = requireDeliveryOptions(rawOptions);
  const interruptActions = normalized.filter(
    ({ kind }) => kind === "interrupt",
  );
  const observationByTaskId = new Map();
  let observationError = null;

  if (interruptActions.length > 0) {
    try {
      const snapshots = await options.observe(
        interruptActions.map(({ targetTaskId }) => ({
          taskId: targetTaskId,
          mode: "latest",
        })),
        options.observationOptions,
      );
      for (const snapshot of snapshots) {
        observationByTaskId.set(snapshot.taskId, snapshot);
      }
    } catch (error) {
      observationError = error;
    }
  }

  return Promise.all(normalized.map(async (action) => {
    try {
      if (action.kind === "resume" || action.kind === "recovery") {
        const { turnId, delivery: route } = await sendTaskMessage({
          taskId: action.targetTaskId,
          text: action.kind === "resume"
            ? renderResumeMessage({
                conversationId: action.conversationId,
              })
            : renderRecoveryMessage({
                conversationId: action.conversationId,
              }),
          cwd: options.projectRoot,
        }, {
          appServer: options.appServer,
          observeLatestTask: async (taskId) => (
            await options.observe(
              [{ taskId, mode: "latest" }],
              options.observationOptions,
            )
          )[0],
          observeExactTurn: async (taskId, turnId) => (
            await options.observe(
              [{ taskId, mode: "exact", turnId }],
              options.observationOptions,
            )
          )[0],
        });
        return delivered(action.deliveryId, "sent", { turnId, route });
      }

      if (observationError) {
        return failure(
          action.deliveryId,
          observationError,
          "TASK_OBSERVATION_FAILED",
        );
      }
      const snapshot = observationByTaskId.get(action.targetTaskId);

      if (snapshot?.location === "archived") {
        return delivered(action.deliveryId, "no_op");
      }
      if (
        snapshot?.location === "active"
        && FINISHED_TURN_STATES.has(snapshot.turnState)
      ) {
        return delivered(action.deliveryId, "no_op");
      }
      if (
        snapshot?.location !== "active"
        || snapshot.turnState !== "in_progress"
        || !validTurnId(snapshot.latestTurnId)
      ) {
        return failure(action.deliveryId, {
          code: "TASK_STATE_UNKNOWN",
          message: "Current in-progress Turn could not be proven.",
        });
      }

      await options.appServer.interruptTurn({
        taskId: action.targetTaskId,
        turnId: snapshot.latestTurnId,
      });
      return delivered(action.deliveryId, "interrupted");
    } catch (error) {
      return failure(action.deliveryId, error);
    }
  }));
}
