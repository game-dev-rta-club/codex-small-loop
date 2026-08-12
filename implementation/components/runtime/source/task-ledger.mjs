import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { parseAtomicJsonSource } from "./atomic-json-store.mjs";
import { validateConversationState } from "./conversation.mjs";
import { buildTaskForest } from "./task-forest.mjs";

const VERSION = 10;
const MAX_ID_LENGTH = 1_024;
const MAX_ERROR_MESSAGE_LENGTH = 1_024;
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
const LAUNCH_PHASES = new Set([
  "prepared",
  "creating",
  "child_created",
  "role_started",
  "assignment_starting",
  "assignment_started",
  "fork_queued",
  "fork_creating",
  "fork_child_created",
  "fork_role_started",
  "fork_assignment_starting",
  "fork_assignment_started",
]);
const ACCEPTANCE_REASONS = new Set([
  "direct",
  "ancestor",
  "archive",
]);
const DELIVERY_KINDS = new Set(["recovery", "resume", "interrupt"]);
const DELIVERY_STATUSES = new Set(["ready", "leased", "delivered"]);
const APP_MESSAGE_STATUSES = new Set([
  "ready",
  "leased",
  "scheduled",
  "delivered",
  "discarded",
]);

const TOP_LEVEL_KEYS = [
  "appMessages",
  "conversations",
  "createdAt",
  "deliveries",
  "links",
  "managedTasks",
  "pendingLaunches",
  "projectKey",
  "projectRoot",
  "revision",
  "updatedAt",
  "version",
];
const PENDING_LAUNCH_KEYS = [
  "assignment",
  "assignmentTurnId",
  "childTaskId",
  "createdAt",
  "id",
  "lastError",
  "model",
  "name",
  "parentTaskId",
  "phase",
  "reasoningEffort",
  "role",
  "roleTurnId",
  "serviceTier",
  "updatedAt",
];
const SOURCED_PENDING_LAUNCH_KEYS = [
  ...PENDING_LAUNCH_KEYS,
  "sourceTaskId",
];
const MANAGED_TASK_KEYS = ["createdAt", "name", "role", "taskId"];
const APP_MESSAGE_KEYS = [
  "attemptCount",
  "createdAt",
  "id",
  "lastError",
  "leaseExpiresAt",
  "leaseOwner",
  "status",
  "sourceTaskId",
  "targetTaskId",
  "terminalAt",
  "terminalReason",
  "text",
  "updatedAt",
];
const LEGACY_APP_MESSAGE_KEYS = APP_MESSAGE_KEYS.filter(
  (key) => key !== "sourceTaskId",
);
const LINK_KEYS = [
  "acceptanceReason",
  "acceptedAt",
  "childTaskId",
  "createdAt",
  "historyFile",
  "lifecycle",
  "parentTaskId",
  "role",
  "updatedAt",
];
const SOURCED_LINK_KEYS = [
  ...LINK_KEYS,
  "sourceTaskId",
];
const DELIVERY_KEYS = [
  "attemptCount",
  "conversationId",
  "createdAt",
  "dedupeKey",
  "deliveredAt",
  "id",
  "kind",
  "lastError",
  "leaseExpiresAt",
  "leaseOwner",
  "observedTurnId",
  "operationId",
  "parentTaskId",
  "resultTurnId",
  "status",
  "targetTaskId",
  "updatedAt",
];
const STORED_ERROR_KEYS = ["at", "code", "message"];

export class TaskLedgerError extends Error {
  constructor(code, message, {
    project,
    operation,
    cause,
  }) {
    super(message, cause ? { cause } : undefined);
    this.name = "TaskLedgerError";
    this.code = code;
    this.stateFile = project?.stateFile ?? "";
    this.operation = operation;
  }
}

function ledgerError(code, message, project, operation, cause) {
  return new TaskLedgerError(code, message, {
    project,
    operation,
    cause,
  });
}

function schemaError(message, project, operation, cause) {
  return ledgerError(
    "LEDGER_SCHEMA_INVALID",
    message,
    project,
    operation,
    cause,
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactObject(value, expectedKeys, label, project, operation) {
  if (!isPlainObject(value)) {
    throw schemaError(`${label} must be an object.`, project, operation);
  }

  const actualKeys = Object.keys(value).sort();
  const requiredKeys = [...expectedKeys].sort();

  if (!isDeepStrictEqual(actualKeys, requiredKeys)) {
    throw schemaError(
      `${label} has missing or unsupported fields.`,
      project,
      operation,
    );
  }

  return value;
}

function requireArray(value, label, project, operation) {
  if (!Array.isArray(value)) {
    throw schemaError(`${label} must be an array.`, project, operation);
  }

  return value;
}

function requireId(value, label, project, operation) {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > MAX_ID_LENGTH
  ) {
    throw schemaError(
      `${label} must be a bounded non-empty string.`,
      project,
      operation,
    );
  }

  return value;
}

function requireRole(value, label, project, operation) {
  if (
    typeof value !== "string"
    || value.length > 128
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)
  ) {
    throw schemaError(
      `${label} must be a bounded kebab-case job role.`,
      project,
      operation,
    );
  }
  return value;
}

function requireName(value, label, project, operation) {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length === 0
    || value.length > 128
    || /[\r\n]/.test(value)
  ) {
    throw schemaError(
      `${label} must be a bounded, trimmed single line.`,
      project,
      operation,
    );
  }
  return value;
}

function requireText(value, label, project, operation) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > 64 * 1_024
  ) {
    throw schemaError(
      `${label} must be non-empty UTF-8 text of at most 64 KiB.`,
      project,
      operation,
    );
  }
  return value;
}

function requireNullableText(value, label, project, operation) {
  if (value === null) {
    return null;
  }
  return requireText(value, label, project, operation);
}

function requireNullableId(value, label, project, operation) {
  if (value === null) {
    return null;
  }

  return requireId(value, label, project, operation);
}

function requireNullableExecutionProfile(
  model,
  reasoningEffort,
  serviceTier,
  label,
  project,
  operation,
) {
  if (model !== null || reasoningEffort !== null) {
    requireId(model, `${label}.model`, project, operation);
    reasoningEffort = requireId(
      reasoningEffort,
      `${label}.reasoningEffort`,
      project,
      operation,
    );
    if (!REASONING_EFFORTS.has(reasoningEffort)) {
      throw schemaError(
        `${label}.reasoningEffort is unsupported.`,
        project,
        operation,
      );
    }
  }
  if (serviceTier !== null) {
    requireId(
      serviceTier,
      `${label}.serviceTier`,
      project,
      operation,
    );
  }
}

function requireTimestamp(value, label, project, operation) {
  if (typeof value !== "string") {
    throw schemaError(`${label} must be an ISO timestamp.`, project, operation);
  }

  const parsed = new Date(value);

  if (
    Number.isNaN(parsed.getTime())
    || parsed.toISOString() !== value
  ) {
    throw schemaError(`${label} must be an ISO timestamp.`, project, operation);
  }

  return value;
}

function requireNullableTimestamp(value, label, project, operation) {
  if (value === null) {
    return null;
  }

  return requireTimestamp(value, label, project, operation);
}

function requireAbsolutePath(value, label, project, operation) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw schemaError(`${label} must be an absolute path.`, project, operation);
  }

  return value;
}

function requireNullableAbsolutePath(value, label, project, operation) {
  if (value === null) {
    return null;
  }

  return requireAbsolutePath(value, label, project, operation);
}

function requireStoredError(value, label, project, operation) {
  if (value === null) {
    return null;
  }

  requireExactObject(
    value,
    STORED_ERROR_KEYS,
    label,
    project,
    operation,
  );
  requireId(value.code, `${label}.code`, project, operation);

  if (
    typeof value.message !== "string"
    || value.message.length === 0
    || value.message.length > MAX_ERROR_MESSAGE_LENGTH
  ) {
    throw schemaError(
      `${label}.message must be a bounded non-empty string.`,
      project,
      operation,
    );
  }

  requireTimestamp(value.at, `${label}.at`, project, operation);
  return value;
}

function requireTimeOrder(createdAt, updatedAt, label, project, operation) {
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw schemaError(
      `${label}.updatedAt must not precede createdAt.`,
      project,
      operation,
    );
  }
}

function validatePendingLaunches(value, project, operation) {
  const launches = requireArray(
    value,
    "pendingLaunches",
    project,
    operation,
  );
  const launchIds = new Set();
  const childTaskIds = new Set();

  for (const launch of launches) {
    requireExactObject(
      launch,
      Object.hasOwn(launch, "sourceTaskId")
        ? SOURCED_PENDING_LAUNCH_KEYS
        : PENDING_LAUNCH_KEYS,
      "pendingLaunch",
      project,
      operation,
    );
    requireId(launch.id, "pendingLaunch.id", project, operation);
    requireId(
      launch.parentTaskId,
      "pendingLaunch.parentTaskId",
      project,
      operation,
    );
    if (Object.hasOwn(launch, "sourceTaskId")) {
      requireId(
        launch.sourceTaskId,
        "pendingLaunch.sourceTaskId",
        project,
        operation,
      );
      if (!launch.phase.startsWith("fork_")) {
        throw schemaError(
          "pendingLaunch.sourceTaskId is valid only for a fork.",
          project,
          operation,
        );
      }
    }
    requireRole(
      launch.role,
      "pendingLaunch.role",
      project,
      operation,
    );
    requireName(
      launch.name,
      "pendingLaunch.name",
      project,
      operation,
    );
    requireNullableText(
      launch.assignment,
      "pendingLaunch.assignment",
      project,
      operation,
    );
    requireNullableId(
      launch.childTaskId,
      "pendingLaunch.childTaskId",
      project,
      operation,
    );
    requireNullableId(
      launch.assignmentTurnId,
      "pendingLaunch.assignmentTurnId",
      project,
      operation,
    );
    requireNullableId(
      launch.roleTurnId,
      "pendingLaunch.roleTurnId",
      project,
      operation,
    );
    requireNullableExecutionProfile(
      launch.model,
      launch.reasoningEffort,
      launch.serviceTier,
      "pendingLaunch",
      project,
      operation,
    );

    if (!LAUNCH_PHASES.has(launch.phase)) {
      throw schemaError(
        "pendingLaunch.phase is unsupported.",
        project,
        operation,
      );
    }

    const childRequired = new Set([
      "child_created",
      "role_started",
      "assignment_starting",
      "assignment_started",
      "fork_child_created",
      "fork_role_started",
      "fork_assignment_starting",
      "fork_assignment_started",
    ]).has(launch.phase);
    const assignmentRequired = new Set([
      "assignment_started",
      "fork_assignment_started",
    ]).has(launch.phase);
    const roleRequired = new Set([
      "role_started",
      "assignment_starting",
      "assignment_started",
      "fork_role_started",
      "fork_assignment_starting",
      "fork_assignment_started",
    ]).has(launch.phase);

    if (
      (childRequired && launch.childTaskId === null)
      || (!childRequired && launch.childTaskId !== null)
      || (roleRequired && launch.roleTurnId === null)
      || (!roleRequired && launch.roleTurnId !== null)
      || (assignmentRequired && launch.assignmentTurnId === null)
      || (!assignmentRequired && launch.assignmentTurnId !== null)
    ) {
      throw schemaError(
        "pendingLaunch fields do not match its phase.",
        project,
        operation,
      );
    }

    requireTimestamp(
      launch.createdAt,
      "pendingLaunch.createdAt",
      project,
      operation,
    );
    requireTimestamp(
      launch.updatedAt,
      "pendingLaunch.updatedAt",
      project,
      operation,
    );
    requireTimeOrder(
      launch.createdAt,
      launch.updatedAt,
      "pendingLaunch",
      project,
      operation,
    );
    requireStoredError(
      launch.lastError,
      "pendingLaunch.lastError",
      project,
      operation,
    );

    if (launchIds.has(launch.id)) {
      throw schemaError(
        "pendingLaunch IDs must be unique.",
        project,
        operation,
      );
    }

    launchIds.add(launch.id);

    if (launch.childTaskId !== null) {
      if (childTaskIds.has(launch.childTaskId)) {
        throw schemaError(
          "A pending Child Task may belong to only one launch.",
          project,
          operation,
        );
      }

      childTaskIds.add(launch.childTaskId);
    }
  }

  return childTaskIds;
}

function validateManagedTasks(value, project, operation) {
  const tasks = requireArray(value, "managedTasks", project, operation);
  const taskIds = new Set();

  for (const task of tasks) {
    requireExactObject(
      task,
      MANAGED_TASK_KEYS,
      "managedTask",
      project,
      operation,
    );
    requireId(task.taskId, "managedTask.taskId", project, operation);
    requireName(task.name, "managedTask.name", project, operation);
    requireRole(task.role, "managedTask.role", project, operation);
    requireTimestamp(
      task.createdAt,
      "managedTask.createdAt",
      project,
      operation,
    );
    if (taskIds.has(task.taskId)) {
      throw schemaError(
        "managedTask IDs must be unique.",
        project,
        operation,
      );
    }
    taskIds.add(task.taskId);
  }
  return new Map(tasks.map((task) => [task.taskId, task]));
}

function validateLinks(value, project, operation) {
  const links = requireArray(value, "links", project, operation);

  for (const currentLink of links) {
    requireExactObject(
      currentLink,
      Object.hasOwn(currentLink, "sourceTaskId")
        ? SOURCED_LINK_KEYS
        : LINK_KEYS,
      "link",
      project,
      operation,
    );
    requireId(
      currentLink.parentTaskId,
      "link.parentTaskId",
      project,
      operation,
    );
    requireId(
      currentLink.childTaskId,
      "link.childTaskId",
      project,
      operation,
    );
    if (Object.hasOwn(currentLink, "sourceTaskId")) {
      requireId(
        currentLink.sourceTaskId,
        "link.sourceTaskId",
        project,
        operation,
      );
    }
    requireRole(currentLink.role, "link.role", project, operation);
    requireTimestamp(
      currentLink.createdAt,
      "link.createdAt",
      project,
      operation,
    );
    requireTimestamp(
      currentLink.updatedAt,
      "link.updatedAt",
      project,
      operation,
    );
    requireTimeOrder(
      currentLink.createdAt,
      currentLink.updatedAt,
      "link",
      project,
      operation,
    );
    requireNullableAbsolutePath(
      currentLink.historyFile,
      "link.historyFile",
      project,
      operation,
    );
    requireNullableTimestamp(
      currentLink.acceptedAt,
      "link.acceptedAt",
      project,
      operation,
    );

    if (currentLink.lifecycle === "accepted") {
      if (
        !ACCEPTANCE_REASONS.has(currentLink.acceptanceReason)
        || currentLink.acceptedAt === null
      ) {
        throw schemaError(
          "Accepted links require an acceptance reason and timestamp.",
          project,
          operation,
        );
      }
    } else if (
      !new Set(["open", "stopped"]).has(currentLink.lifecycle)
      || currentLink.acceptanceReason !== null
      || currentLink.acceptedAt !== null
    ) {
      throw schemaError(
        "Open and stopped links must not contain acceptance metadata.",
        project,
        operation,
      );
    }
  }

  try {
    return buildTaskForest(links);
  } catch (error) {
    throw schemaError(
      "Task relationships are structurally invalid.",
      project,
      operation,
      error,
    );
  }
}

function validateCombinedPendingForest(links, pendingLaunches, project, operation) {
  const retainedEndpoints = new Set(links.flatMap(({ parentTaskId, childTaskId }) => [
    parentTaskId,
    childTaskId,
  ]));
  const pendingEdges = pendingLaunches
    .filter(({ childTaskId }) => childTaskId !== null)
    .map(({ parentTaskId, childTaskId }) => {
      if (retainedEndpoints.has(childTaskId)) {
        throw schemaError(
          "Pending Task relationships are structurally invalid.",
          project,
          operation,
        );
      }
      return { parentTaskId, childTaskId, lifecycle: "open" };
    });
  try {
    buildTaskForest([...links, ...pendingEdges]);
  } catch (error) {
    throw schemaError(
      "Pending Task relationships are structurally invalid.",
      project,
      operation,
      error,
    );
  }
}

function expectedDedupeKey(delivery) {
  if (delivery.kind === "recovery") {
    return `recovery:${delivery.targetTaskId}:${delivery.observedTurnId}`;
  }

  return `${delivery.kind}:${delivery.operationId}:${delivery.targetTaskId}`;
}

function validateDeliveries(
  value,
  forest,
  conversations,
  project,
  operation,
) {
  const deliveries = requireArray(value, "deliveries", project, operation);
  const deliveryIds = new Set();
  const dedupeKeys = new Set();

  for (const delivery of deliveries) {
    requireExactObject(
      delivery,
      DELIVERY_KEYS,
      "delivery",
      project,
      operation,
    );
    requireId(delivery.id, "delivery.id", project, operation);
    requireId(
      delivery.targetTaskId,
      "delivery.targetTaskId",
      project,
      operation,
    );
    requireId(
      delivery.parentTaskId,
      "delivery.parentTaskId",
      project,
      operation,
    );
    requireId(delivery.dedupeKey, "delivery.dedupeKey", project, operation);
    requireNullableId(
      delivery.operationId,
      "delivery.operationId",
      project,
      operation,
    );
    requireNullableId(
      delivery.conversationId,
      "delivery.conversationId",
      project,
      operation,
    );
    requireNullableId(
      delivery.observedTurnId,
      "delivery.observedTurnId",
      project,
      operation,
    );
    requireNullableId(
      delivery.resultTurnId,
      "delivery.resultTurnId",
      project,
      operation,
    );
    requireNullableId(
      delivery.leaseOwner,
      "delivery.leaseOwner",
      project,
      operation,
    );
    requireNullableTimestamp(
      delivery.leaseExpiresAt,
      "delivery.leaseExpiresAt",
      project,
      operation,
    );
    requireNullableTimestamp(
      delivery.deliveredAt,
      "delivery.deliveredAt",
      project,
      operation,
    );
    requireTimestamp(
      delivery.createdAt,
      "delivery.createdAt",
      project,
      operation,
    );
    requireTimestamp(
      delivery.updatedAt,
      "delivery.updatedAt",
      project,
      operation,
    );
    requireTimeOrder(
      delivery.createdAt,
      delivery.updatedAt,
      "delivery",
      project,
      operation,
    );
    requireStoredError(
      delivery.lastError,
      "delivery.lastError",
      project,
      operation,
    );

    if (!DELIVERY_KINDS.has(delivery.kind)) {
      throw schemaError("delivery.kind is unsupported.", project, operation);
    }

    if (!DELIVERY_STATUSES.has(delivery.status)) {
      throw schemaError("delivery.status is unsupported.", project, operation);
    }

    if (
      !Number.isSafeInteger(delivery.attemptCount)
      || delivery.attemptCount < 0
    ) {
      throw schemaError(
        "delivery.attemptCount must be a non-negative integer.",
        project,
        operation,
      );
    }

    const recovery = delivery.kind === "recovery";

    if (
      (recovery
        && (
          delivery.operationId !== null
          || delivery.observedTurnId === null
          || (
            delivery.status !== "delivered"
            && delivery.resultTurnId !== null
          )
        ))
      || (!recovery
        && (
          delivery.operationId === null
          || delivery.observedTurnId !== null
          || delivery.resultTurnId !== null
        ))
      || delivery.dedupeKey !== expectedDedupeKey(delivery)
    ) {
      throw schemaError(
        "delivery cause fields or dedupe key are inconsistent.",
        project,
        operation,
      );
    }

    if (
      (delivery.status === "ready"
        && (
          delivery.leaseOwner !== null
          || delivery.leaseExpiresAt !== null
          || delivery.deliveredAt !== null
        ))
      || (delivery.status === "leased"
        && (
          delivery.leaseOwner === null
          || delivery.leaseExpiresAt === null
          || delivery.deliveredAt !== null
        ))
      || (delivery.status === "delivered"
        && (
          delivery.leaseOwner !== null
          || delivery.leaseExpiresAt !== null
          || delivery.deliveredAt === null
        ))
    ) {
      throw schemaError(
        "delivery lease fields do not match its status.",
        project,
        operation,
      );
    }

    if (
      delivery.status === "leased"
      && Date.parse(delivery.leaseExpiresAt) <= Date.parse(delivery.updatedAt)
    ) {
      throw schemaError(
        "A leased delivery requires a future lease expiry.",
        project,
        operation,
      );
    }

    if (
      delivery.status !== "ready"
      && delivery.attemptCount === 0
    ) {
      throw schemaError(
        "A leased or delivered action requires at least one attempt.",
        project,
        operation,
      );
    }

    const conversationRelationship = conversations.find((conversation) =>
      conversation.initiatorTaskId === delivery.parentTaskId
      && conversation.responderTaskId === delivery.targetTaskId
      && (
        delivery.conversationId === null
        || conversation.id === delivery.conversationId
      )
    );
    if (
      new Set(["recovery", "resume"]).has(delivery.kind)
      && delivery.conversationId === null
    ) {
      throw schemaError(
        "Recovery and resume deliveries require a Conversation ID.",
        project,
        operation,
      );
    }
    const relationshipExists = new Set(["recovery", "resume"])
      .has(delivery.kind)
      ? conversationRelationship !== undefined
      : conversationRelationship !== undefined
        || forest.linkByChildTaskId.get(delivery.targetTaskId)?.parentTaskId
          === delivery.parentTaskId;

    if (!relationshipExists) {
      throw schemaError(
        "delivery must target a proven task or Conversation relationship.",
        project,
        operation,
      );
    }

    if (deliveryIds.has(delivery.id) || dedupeKeys.has(delivery.dedupeKey)) {
      throw schemaError(
        "delivery IDs and dedupe keys must be unique.",
        project,
        operation,
      );
    }

    deliveryIds.add(delivery.id);
    dedupeKeys.add(delivery.dedupeKey);
  }
}

function validateAppMessages(value, managedTasks, project, operation) {
  const messages = requireArray(value, "appMessages", project, operation);
  const ids = new Set();

  for (const message of messages) {
    requireExactObject(
      message,
      Object.hasOwn(message, "sourceTaskId")
        ? APP_MESSAGE_KEYS
        : LEGACY_APP_MESSAGE_KEYS,
      "appMessage",
      project,
      operation,
    );
    requireId(message.id, "appMessage.id", project, operation);
    if (Object.hasOwn(message, "sourceTaskId")) {
      requireNullableId(
        message.sourceTaskId,
        "appMessage.sourceTaskId",
        project,
        operation,
      );
    }
    requireId(
      message.targetTaskId,
      "appMessage.targetTaskId",
      project,
      operation,
    );
    requireText(message.text, "appMessage.text", project, operation);
    requireNullableId(
      message.leaseOwner,
      "appMessage.leaseOwner",
      project,
      operation,
    );
    requireNullableTimestamp(
      message.leaseExpiresAt,
      "appMessage.leaseExpiresAt",
      project,
      operation,
    );
    requireNullableTimestamp(
      message.terminalAt,
      "appMessage.terminalAt",
      project,
      operation,
    );
    if (
      message.terminalReason !== null
      && message.terminalReason !== "target_archived"
    ) {
      throw schemaError(
        "appMessage.terminalReason is unsupported.",
        project,
        operation,
      );
    }
    requireTimestamp(
      message.createdAt,
      "appMessage.createdAt",
      project,
      operation,
    );
    requireTimestamp(
      message.updatedAt,
      "appMessage.updatedAt",
      project,
      operation,
    );
    requireTimeOrder(
      message.createdAt,
      message.updatedAt,
      "appMessage",
      project,
      operation,
    );
    requireStoredError(
      message.lastError,
      "appMessage.lastError",
      project,
      operation,
    );
    if (
      !Number.isSafeInteger(message.attemptCount)
      || message.attemptCount < 0
      || !APP_MESSAGE_STATUSES.has(message.status)
    ) {
      throw schemaError(
        "appMessage status or attempt count is invalid.",
        project,
        operation,
      );
    }
    const ready = message.status === "ready";
    const leased = message.status === "leased";
    const scheduled = message.status === "scheduled";
    const terminal = message.status === "delivered"
      || message.status === "discarded";
    if (
      (ready && (
        message.leaseOwner !== null
        || message.leaseExpiresAt !== null
        || message.terminalAt !== null
        || message.terminalReason !== null
      ))
      || (leased && (
        message.leaseOwner === null
        || message.leaseExpiresAt === null
        || message.terminalAt !== null
        || message.terminalReason !== null
      ))
      || (scheduled && (
        message.leaseOwner !== null
        || message.leaseExpiresAt !== null
        || message.terminalAt !== null
        || message.terminalReason !== null
        || message.lastError !== null
      ))
      || (terminal && (
        message.leaseOwner !== null
        || message.leaseExpiresAt !== null
        || message.terminalAt === null
        || (
          message.status === "delivered"
          && message.terminalReason !== null
        )
        || (
          message.status === "discarded"
          && message.terminalReason !== "target_archived"
        )
      ))
    ) {
      throw schemaError(
        "appMessage lease and terminal fields do not match its status.",
        project,
        operation,
      );
    }
    if (
      leased
      && Date.parse(message.leaseExpiresAt) <= Date.parse(message.updatedAt)
    ) {
      throw schemaError(
        "A leased appMessage requires a future lease expiry.",
        project,
        operation,
      );
    }
    if (!ready && message.attemptCount === 0) {
      throw schemaError(
        "A leased or terminal appMessage requires an attempt.",
        project,
        operation,
      );
    }
    if (ids.has(message.id)) {
      throw schemaError(
        "appMessage IDs must be unique.",
        project,
        operation,
      );
    }
    ids.add(message.id);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function normalizeTimestamp(value, project, operation) {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  return requireTimestamp(timestamp, "now", project, operation);
}

export function validateTaskLedger(raw, project, operation = "validate") {
  let snapshot;

  try {
    snapshot = structuredClone(raw);
  } catch (error) {
    throw schemaError(
      "The ledger must contain JSON-compatible data.",
      project,
      operation,
      error,
    );
  }

  if (!isPlainObject(snapshot)) {
    throw schemaError("The ledger must be an object.", project, operation);
  }

  requireExactObject(
    snapshot,
    TOP_LEVEL_KEYS,
    "ledger",
    project,
    operation,
  );

  if (snapshot.version !== VERSION) {
    throw ledgerError(
      "LEDGER_VERSION_UNSUPPORTED",
      "The ledger version is unsupported.",
      project,
      operation,
    );
  }

  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw schemaError(
      "ledger.revision must be a non-negative integer.",
      project,
      operation,
    );
  }

  requireAbsolutePath(
    snapshot.projectRoot,
    "ledger.projectRoot",
    project,
    operation,
  );
  requireId(snapshot.projectKey, "ledger.projectKey", project, operation);

  if (
    snapshot.projectRoot !== project.root
    || snapshot.projectKey !== project.key
  ) {
    throw ledgerError(
      "LEDGER_PROJECT_MISMATCH",
      "The ledger belongs to a different canonical project.",
      project,
      operation,
    );
  }

  requireTimestamp(
    snapshot.createdAt,
    "ledger.createdAt",
    project,
    operation,
  );
  requireTimestamp(
    snapshot.updatedAt,
    "ledger.updatedAt",
    project,
    operation,
  );
  requireTimeOrder(
    snapshot.createdAt,
    snapshot.updatedAt,
    "ledger",
    project,
    operation,
  );
  const managedTasks = validateManagedTasks(
    snapshot.managedTasks,
    project,
    operation,
  );
  const pendingChildTaskIds = validatePendingLaunches(
    snapshot.pendingLaunches,
    project,
    operation,
  );
  const forest = validateLinks(snapshot.links, project, operation);
  validateCombinedPendingForest(
    snapshot.links,
    snapshot.pendingLaunches,
    project,
    operation,
  );

  const siblingNames = new Set();
  for (const currentLink of snapshot.links) {
    const managed = managedTasks.get(currentLink.childTaskId);
    if (!managed) continue;
    const key = `${currentLink.parentTaskId}\0${managed.name}`;
    if (siblingNames.has(key)) {
      throw schemaError(
        "Direct Child Task names must be unique under one parent.",
        project,
        operation,
      );
    }
    siblingNames.add(key);
  }

  for (const childTaskId of pendingChildTaskIds) {
    if (forest.linkByChildTaskId.has(childTaskId)) {
      throw schemaError(
        "A pending Child Task cannot also have a ready link.",
        project,
        operation,
      );
    }
  }

  validateDeliveries(
    snapshot.deliveries,
    forest,
    snapshot.conversations,
    project,
    operation,
  );
  validateAppMessages(
    snapshot.appMessages,
    managedTasks,
    project,
    operation,
  );
  try {
    validateConversationState(snapshot.conversations);
  } catch (error) {
    throw schemaError(
      error?.message ?? "Conversation state is invalid.",
      project,
      operation,
      error,
    );
  }
  return deepFreeze(snapshot);
}

export async function initializeTaskLedger(
  store,
  project,
  now,
) {
  const timestamp = normalizeTimestamp(now, project, "initialize");
  const initialState = validateTaskLedger({
    version: VERSION,
    revision: 0,
    projectRoot: project.root,
    projectKey: project.key,
    createdAt: timestamp,
    updatedAt: timestamp,
    managedTasks: [],
    pendingLaunches: [],
    links: [],
    conversations: [],
    deliveries: [],
    appMessages: [],
  }, project, "initialize");
  let stored = await store.initialize(initialState);
  if (stored?.version !== VERSION) {
    const migration = await store.transact((raw) => ({
      state: migrateTaskLedger(raw, VERSION, { project }),
      result: null,
    }));
    stored = migration.state;
  }
  return validateTaskLedger(stored, project, "initialize");
}

export async function readTaskLedger(store, project) {
  return migrateTaskLedger(await store.read(), VERSION, { project });
}

export function parseTaskLedgerRecord(source, project) {
  return migrateTaskLedger(parseAtomicJsonSource(source, {
    stateFile: project.stateFile,
    operation: "read",
  }), VERSION, { project });
}

export async function transactTaskLedger(
  store,
  project,
  transform,
  options = {},
) {
  const timestamp = normalizeTimestamp(options.now, project, "transact");
  const transaction = await store.transact((raw) => {
    const current = migrateTaskLedger(raw, VERSION, { project });
    const migrated = raw.version !== VERSION;
    const transformed = transform(current);

    if (transformed?.then instanceof Function) {
      throw new TypeError("Task Ledger transforms must be synchronous.");
    }

    if (
      !isPlainObject(transformed)
      || !Object.hasOwn(transformed, "state")
    ) {
      throw new TypeError(
        "Task Ledger transforms must return { state, result }.",
      );
    }

    const proposed = validateTaskLedger(
      transformed.state,
      project,
      "transact",
    );

    if (proposed.createdAt !== current.createdAt) {
      throw schemaError(
        "A transaction cannot change ledger.createdAt.",
        project,
        "transact",
      );
    }

    const comparable = validateTaskLedger({
      ...proposed,
      revision: current.revision,
      updatedAt: current.updatedAt,
    }, project, "transact");

    if (!migrated && isDeepStrictEqual(comparable, current)) {
      return {
        state: current,
        result: transformed.result,
        commit: false,
      };
    }

    const nextState = validateTaskLedger({
      ...proposed,
      revision: current.revision + 1,
      updatedAt: timestamp,
    }, project, "transact");

    return {
      state: nextState,
      result: transformed.result,
    };
  }, {
    beforeCommit: options.beforeCommit,
    afterCommit: options.afterCommit,
    onNoCommit: options.onNoCommit,
  });

  return {
    state: validateTaskLedger(transaction.state, project, "transact"),
    result: transaction.result,
  };
}

export function hasRecoveryWork(state) {
  const stoppedTaskIds = new Set(
    state.links
      .filter(({ lifecycle }) => lifecycle === "stopped")
      .map(({ childTaskId }) => childTaskId),
  );
  return (
    state.pendingLaunches.length > 0
    || state.conversations.some(
      ({ responderTaskId, state: conversationState }) =>
        conversationState === "awaiting_reply"
        && !stoppedTaskIds.has(responderTaskId),
    )
    || state.deliveries.some(
      ({ status }) => status === "ready" || status === "leased",
    )
  );
}

export function hasPendingAppMessages(state) {
  return state.appMessages.some(
    ({ status }) =>
      status === "ready"
      || status === "leased"
      || status === "scheduled",
  );
}

export function hasPendingWork(state) {
  return hasRecoveryWork(state) || hasPendingAppMessages(state);
}

export function compactTaskLedger(state) {
  const forest = buildTaskForest(state.links);
  const protectedTaskIds = new Set();

  for (const delivery of state.deliveries) {
    if (delivery.status === "ready" || delivery.status === "leased") {
      protectedTaskIds.add(delivery.targetTaskId);
    }
  }
  for (const message of state.appMessages) {
    if (
      (
        message.status === "ready"
        || message.status === "leased"
        || message.status === "scheduled"
      )
      && typeof message.sourceTaskId === "string"
    ) {
      protectedTaskIds.add(message.sourceTaskId);
    }
  }

  for (const taskId of [...protectedTaskIds]) {
    let incoming = forest.linkByChildTaskId.get(taskId);
    while (incoming) {
      protectedTaskIds.add(incoming.childTaskId);
      incoming = forest.linkByChildTaskId.get(incoming.parentTaskId);
    }
  }

  const links = state.links.filter((link) =>
    link.lifecycle !== "accepted"
    || protectedTaskIds.has(link.childTaskId)
  );
  const retainedTaskIds = new Set(
    links.map(({ childTaskId }) => childTaskId),
  );
  for (const launch of state.pendingLaunches) {
    if (typeof launch.childTaskId === "string") {
      retainedTaskIds.add(launch.childTaskId);
    }
  }

  return validateDerivedState({
    ...state,
    links,
    managedTasks: state.managedTasks.filter(({ taskId }) =>
      retainedTaskIds.has(taskId)
    ),
    deliveries: state.deliveries.filter((delivery) =>
      retainedTaskIds.has(delivery.targetTaskId)
    ),
    appMessages: state.appMessages.filter(({ status }) =>
      status === "ready"
      || status === "leased"
      || status === "scheduled"
    ),
  }, "compactTaskLedger");
}

function projectFromState(state) {
  return {
    root: state.projectRoot,
    key: state.projectKey,
    stateFile: path.join(
      state.projectRoot,
      ".codex-small-loop",
      "state.json",
    ),
  };
}

function validateDerivedState(state, operation) {
  return validateTaskLedger(state, projectFromState(state), operation);
}

function deliveryOperationError(code, message, state, cause) {
  return ledgerError(
    code,
    message,
    projectFromState(state),
    "delivery",
    cause,
  );
}

function requireDelivery(state, deliveryId) {
  const project = projectFromState(state);
  requireId(deliveryId, "deliveryId", project, "delivery");
  const index = state.deliveries.findIndex(
    ({ id }) => id === deliveryId,
  );

  if (index === -1) {
    throw deliveryOperationError(
      "DELIVERY_NOT_FOUND",
      "The delivery does not exist.",
      state,
    );
  }

  return {
    delivery: state.deliveries[index],
    index,
  };
}

function requireLeaseOwner(delivery, leaseOwner, state) {
  const project = projectFromState(state);
  requireId(leaseOwner, "leaseOwner", project, "delivery");

  if (
    delivery.status !== "leased"
    || delivery.leaseOwner !== leaseOwner
  ) {
    throw deliveryOperationError(
      "DELIVERY_LEASE_CONFLICT",
      "The delivery is not leased by this owner.",
      state,
    );
  }
}

function withDelivery(state, index, delivery, operation) {
  const deliveries = [...state.deliveries];
  deliveries[index] = delivery;
  return validateDerivedState({
    ...state,
    deliveries,
  }, operation);
}

export function enqueueDeliveries(state, actions, options = {}) {
  const project = projectFromState(state);
  const timestamp = normalizeTimestamp(
    options.now,
    project,
    "enqueueDeliveries",
  );
  requireArray(actions, "actions", project, "enqueueDeliveries");
  const deliveries = [...state.deliveries];
  const protectedDedupeKeys = [];

  for (const action of actions) {
    const hasConversationId = Object.hasOwn(action, "conversationId");
    requireExactObject(
      action,
      [
        ...(hasConversationId ? ["conversationId"] : []),
        "id",
        "kind",
        "observedTurnId",
        "operationId",
        "parentTaskId",
        "targetTaskId",
      ],
      "action",
      project,
      "enqueueDeliveries",
    );
    if (hasConversationId) {
      requireNullableId(
        action.conversationId,
        "action.conversationId",
        project,
        "enqueueDeliveries",
      );
    }
    requireId(action.id, "action.id", project, "enqueueDeliveries");
    requireId(
      action.targetTaskId,
      "action.targetTaskId",
      project,
      "enqueueDeliveries",
    );
    requireId(
      action.parentTaskId,
      "action.parentTaskId",
      project,
      "enqueueDeliveries",
    );
    requireNullableId(
      action.operationId,
      "action.operationId",
      project,
      "enqueueDeliveries",
    );
    requireNullableId(
      action.observedTurnId,
      "action.observedTurnId",
      project,
      "enqueueDeliveries",
    );

    if (!DELIVERY_KINDS.has(action.kind)) {
      throw schemaError(
        "action.kind is unsupported.",
        project,
        "enqueueDeliveries",
      );
    }

    const candidate = {
      ...action,
      conversationId: action.conversationId ?? null,
      dedupeKey: action.kind === "recovery"
        ? `recovery:${action.targetTaskId}:${action.observedTurnId}`
        : `${action.kind}:${action.operationId}:${action.targetTaskId}`,
      status: "ready",
      attemptCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deliveredAt: null,
      resultTurnId: null,
      lastError: null,
    };
    const existing = deliveries.find(
      ({ dedupeKey }) => dedupeKey === candidate.dedupeKey,
    );

    if (!existing) {
      deliveries.push(candidate);
    }

    protectedDedupeKeys.push(candidate.dedupeKey);
  }

  const nextState = validateDerivedState({
    ...state,
    deliveries,
  }, "enqueueDeliveries");
  const added = protectedDedupeKeys.map((dedupeKey) =>
    nextState.deliveries.find((delivery) => delivery.dedupeKey === dedupeKey)
  );

  return {
    state: isDeepStrictEqual(nextState, state) ? state : nextState,
    added,
  };
}

export function leaseDeliveries(state, options = {}) {
  const project = projectFromState(state);
  const timestamp = normalizeTimestamp(
    options.now,
    project,
    "leaseDeliveries",
  );
  const leaseExpiresAt = normalizeTimestamp(
    options.leaseExpiresAt,
    project,
    "leaseDeliveries",
  );
  const leaseOwner = requireId(
    options.leaseOwner,
    "leaseOwner",
    project,
    "leaseDeliveries",
  );

  if (Date.parse(leaseExpiresAt) <= Date.parse(timestamp)) {
    throw schemaError(
      "leaseExpiresAt must be later than now.",
      project,
      "leaseDeliveries",
    );
  }

  let requestedIds = null;

  if (options.deliveryIds !== undefined) {
    requireArray(
      options.deliveryIds,
      "deliveryIds",
      project,
      "leaseDeliveries",
    );
    requestedIds = new Set(
      options.deliveryIds.map((deliveryId) =>
        requireId(
          deliveryId,
          "deliveryId",
          project,
          "leaseDeliveries",
        )
      ),
    );
  }

  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  if (
    limit !== Number.POSITIVE_INFINITY
    && (!Number.isSafeInteger(limit) || limit < 0)
  ) {
    throw schemaError(
      "lease limit must be a non-negative integer.",
      project,
      "leaseDeliveries",
    );
  }

  const eligibleIds = state.deliveries
    .filter((delivery) => {
      if (requestedIds && !requestedIds.has(delivery.id)) {
        return false;
      }

      return (
        delivery.status === "ready"
        || (
          delivery.status === "leased"
          && Date.parse(delivery.leaseExpiresAt) <= Date.parse(timestamp)
        )
      );
    })
    .map(({ id }) => id)
    .sort()
    .slice(0, limit);
  const selectedIds = new Set(eligibleIds);

  if (selectedIds.size === 0) {
    return {
      state,
      leased: [],
    };
  }

  const deliveries = state.deliveries.map((delivery) =>
    selectedIds.has(delivery.id)
      ? {
          ...delivery,
          status: "leased",
          attemptCount: delivery.attemptCount + 1,
          leaseOwner,
          leaseExpiresAt,
          updatedAt: timestamp,
          deliveredAt: null,
          lastError: null,
        }
      : delivery
  );
  const nextState = validateDerivedState({
    ...state,
    deliveries,
  }, "leaseDeliveries");

  return {
    state: nextState,
    leased: eligibleIds.map((deliveryId) =>
      nextState.deliveries.find(({ id }) => id === deliveryId)
    ),
  };
}

export function acknowledgeDelivery(
  state,
  deliveryId,
  leaseOwner,
  now,
  options = {},
) {
  const project = projectFromState(state);
  const timestamp = normalizeTimestamp(
    now,
    project,
    "acknowledgeDelivery",
  );
  const { delivery, index } = requireDelivery(state, deliveryId);
  requireLeaseOwner(delivery, leaseOwner, state);
  const resultTurnId = options.resultTurnId;

  if (resultTurnId !== undefined) {
    requireId(
      resultTurnId,
      "resultTurnId",
      project,
      "acknowledgeDelivery",
    );
    if (delivery.kind !== "recovery") {
      throw deliveryOperationError(
        "DELIVERY_RESULT_TURN_INVALID",
        "Only a recovery delivery may protect its resulting Turn.",
        state,
      );
    }
  }

  return withDelivery(state, index, {
    ...delivery,
    resultTurnId: resultTurnId ?? delivery.resultTurnId,
    status: "delivered",
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: timestamp,
    deliveredAt: timestamp,
    lastError: null,
  }, "acknowledgeDelivery");
}

function boundedStoredError(error, timestamp) {
  const rawCode = typeof error?.code === "string" && error.code.trim().length > 0
    ? error.code
    : "DELIVERY_FAILED";
  const rawMessage = typeof error?.message === "string"
    && error.message.length > 0
    ? error.message
    : "Delivery failed.";

  return {
    code: rawCode.slice(0, MAX_ID_LENGTH),
    message: rawMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    at: timestamp,
  };
}

export function releaseDelivery(
  state,
  deliveryId,
  leaseOwner,
  error,
  now,
) {
  const project = projectFromState(state);
  const timestamp = normalizeTimestamp(
    now,
    project,
    "releaseDelivery",
  );
  const { delivery, index } = requireDelivery(state, deliveryId);
  requireLeaseOwner(delivery, leaseOwner, state);

  return withDelivery(state, index, {
    ...delivery,
    status: "ready",
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: timestamp,
    deliveredAt: null,
    lastError: boundedStoredError(error, timestamp),
  }, "releaseDelivery");
}

export function discardDelivery(
  state,
  deliveryId,
  leaseOwner,
  now,
) {
  const project = projectFromState(state);
  normalizeTimestamp(now, project, "discardDelivery");
  const { delivery, index } = requireDelivery(state, deliveryId);
  requireLeaseOwner(delivery, leaseOwner, state);
  const deliveries = [...state.deliveries];
  deliveries.splice(index, 1);

  return validateDerivedState({
    ...state,
    deliveries,
  }, "discardDelivery");
}

function appMessageOperationError(code, message, state, cause) {
  return ledgerError(
    code,
    message,
    projectFromState(state),
    "appMessage",
    cause,
  );
}

function requireAppMessage(state, messageId) {
  const project = projectFromState(state);
  requireId(messageId, "messageId", project, "appMessage");
  const index = state.appMessages.findIndex(({ id }) => id === messageId);
  if (index === -1) {
    throw appMessageOperationError(
      "APP_MESSAGE_NOT_FOUND",
      "The App message does not exist.",
      state,
    );
  }
  return { message: state.appMessages[index], index };
}

function withAppMessage(state, index, message, operation) {
  const appMessages = [...state.appMessages];
  appMessages[index] = message;
  return validateDerivedState({ ...state, appMessages }, operation);
}

export function enqueueAppMessage(state, input, options = {}) {
  const project = projectFromState(state);
  const timestamp = normalizeTimestamp(
    options.now,
    project,
    "enqueueAppMessage",
  );
  requireExactObject(
    input,
    Object.hasOwn(input, "sourceTaskId")
      ? ["id", "sourceTaskId", "targetTaskId", "text"]
      : ["id", "targetTaskId", "text"],
    "appMessageInput",
    project,
    "enqueueAppMessage",
  );
  requireId(input.id, "appMessageInput.id", project, "enqueueAppMessage");
  if (Object.hasOwn(input, "sourceTaskId")) {
    requireNullableId(
      input.sourceTaskId,
      "appMessageInput.sourceTaskId",
      project,
      "enqueueAppMessage",
    );
  }
  requireId(
    input.targetTaskId,
    "appMessageInput.targetTaskId",
    project,
    "enqueueAppMessage",
  );
  requireText(
    input.text,
    "appMessageInput.text",
    project,
    "enqueueAppMessage",
  );
  if (state.appMessages.some(({ id }) => id === input.id)) {
    throw appMessageOperationError(
      "APP_MESSAGE_CONFLICT",
      "The App message ID already exists.",
      state,
    );
  }
  const queued = {
    id: input.id,
    ...(Object.hasOwn(input, "sourceTaskId")
      ? { sourceTaskId: input.sourceTaskId }
      : {}),
    targetTaskId: input.targetTaskId,
    text: input.text,
    status: "ready",
    attemptCount: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    terminalAt: null,
    terminalReason: null,
    lastError: null,
  };
  return {
    state: validateDerivedState({
      ...state,
      appMessages: [...state.appMessages, queued],
    }, "enqueueAppMessage"),
    queued,
  };
}

export function leaseAppMessages(state, options = {}) {
  const project = projectFromState(state);
  const timestamp = normalizeTimestamp(
    options.now,
    project,
    "leaseAppMessages",
  );
  const leaseExpiresAt = normalizeTimestamp(
    options.leaseExpiresAt,
    project,
    "leaseAppMessages",
  );
  const leaseOwner = requireId(
    options.leaseOwner,
    "leaseOwner",
    project,
    "leaseAppMessages",
  );
  const limit = options.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw schemaError(
      "App message lease limit must be a non-negative integer.",
      project,
      "leaseAppMessages",
    );
  }
  if (Date.parse(leaseExpiresAt) <= Date.parse(timestamp)) {
    throw schemaError(
      "leaseExpiresAt must be later than now.",
      project,
      "leaseAppMessages",
    );
  }
  const selectedIds = new Set(
    state.appMessages
      .filter((message) =>
        message.status === "ready"
        || (
          message.status === "leased"
          && Date.parse(message.leaseExpiresAt) <= Date.parse(timestamp)
        )
      )
      .map(({ id }) => id)
      .sort()
      .slice(0, limit),
  );
  if (selectedIds.size === 0) {
    return { state, leased: [] };
  }
  const appMessages = state.appMessages.map((message) =>
    selectedIds.has(message.id)
      ? {
          ...message,
          status: "leased",
          attemptCount: message.attemptCount + 1,
          leaseOwner,
          leaseExpiresAt,
          updatedAt: timestamp,
          terminalAt: null,
          terminalReason: null,
          lastError: null,
        }
      : message
  );
  const nextState = validateDerivedState(
    { ...state, appMessages },
    "leaseAppMessages",
  );
  return {
    state: nextState,
    leased: [...selectedIds].map((id) =>
      nextState.appMessages.find((message) => message.id === id)
    ),
  };
}

function requireAppMessageLease(message, leaseOwner, state) {
  const project = projectFromState(state);
  requireId(leaseOwner, "leaseOwner", project, "appMessage");
  if (
    message.status !== "leased"
    || message.leaseOwner !== leaseOwner
  ) {
    throw appMessageOperationError(
      "APP_MESSAGE_LEASE_CONFLICT",
      "The App message is not leased by this owner.",
      state,
    );
  }
}

export function acknowledgeAppMessage(
  state,
  messageId,
  leaseOwner,
  now,
) {
  const project = projectFromState(state);
  const timestamp = normalizeTimestamp(
    now,
    project,
    "acknowledgeAppMessage",
  );
  const { message, index } = requireAppMessage(state, messageId);
  requireAppMessageLease(message, leaseOwner, state);
  return withAppMessage(state, index, {
    ...message,
    status: "delivered",
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: timestamp,
    terminalAt: timestamp,
    terminalReason: null,
    lastError: null,
  }, "acknowledgeAppMessage");
}

export function markAppMessageScheduled(
  state,
  messageId,
  leaseOwner,
  now,
) {
  const project = projectFromState(state);
  const timestamp = normalizeTimestamp(
    now,
    project,
    "markAppMessageScheduled",
  );
  const { message, index } = requireAppMessage(state, messageId);
  requireAppMessageLease(message, leaseOwner, state);
  return withAppMessage(state, index, {
    ...message,
    status: "scheduled",
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: timestamp,
    terminalAt: null,
    terminalReason: null,
    lastError: null,
  }, "markAppMessageScheduled");
}

export function acknowledgeScheduledAppMessage(
  state,
  messageId,
  now,
) {
  const project = projectFromState(state);
  const timestamp = normalizeTimestamp(
    now,
    project,
    "acknowledgeScheduledAppMessage",
  );
  const { message, index } = requireAppMessage(state, messageId);
  if (message.status !== "scheduled") {
    throw appMessageOperationError(
      "APP_MESSAGE_STATUS_CONFLICT",
      "The App message is not waiting in a schedule.",
      state,
    );
  }
  return withAppMessage(state, index, {
    ...message,
    status: "delivered",
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: timestamp,
    terminalAt: timestamp,
    terminalReason: null,
    lastError: null,
  }, "acknowledgeScheduledAppMessage");
}

export function releaseAppMessage(
  state,
  messageId,
  leaseOwner,
  error,
  now,
) {
  const project = projectFromState(state);
  const timestamp = normalizeTimestamp(
    now,
    project,
    "releaseAppMessage",
  );
  const { message, index } = requireAppMessage(state, messageId);
  requireAppMessageLease(message, leaseOwner, state);
  return withAppMessage(state, index, {
    ...message,
    status: "ready",
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: timestamp,
    terminalAt: null,
    terminalReason: null,
    lastError: boundedStoredError(error, timestamp),
  }, "releaseAppMessage");
}

export function discardAppMessage(
  state,
  messageId,
  leaseOwner,
  now,
  reason = "target_archived",
) {
  const project = projectFromState(state);
  const timestamp = normalizeTimestamp(
    now,
    project,
    "discardAppMessage",
  );
  const { message, index } = requireAppMessage(state, messageId);
  requireAppMessageLease(message, leaseOwner, state);
  if (reason !== "target_archived") {
    throw appMessageOperationError(
      "APP_MESSAGE_DISCARD_REASON_INVALID",
      "The App message discard reason is unsupported.",
      state,
    );
  }
  return withAppMessage(state, index, {
    ...message,
    status: "discarded",
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: timestamp,
    terminalAt: timestamp,
    terminalReason: reason,
    lastError: null,
  }, "discardAppMessage");
}

export function migrateTaskLedger(raw, targetVersion, options = {}) {
  const project = options.project;

  if (
    targetVersion !== VERSION
    || !isPlainObject(raw)
    || raw.version !== VERSION
  ) {
    throw ledgerError(
      "LEDGER_VERSION_UNSUPPORTED",
      "No supported migration path exists for this ledger version.",
      project,
      "migrate",
    );
  }
  return validateTaskLedger(raw, project, "migrate");
}
