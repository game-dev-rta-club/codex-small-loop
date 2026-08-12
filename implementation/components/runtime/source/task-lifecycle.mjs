import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AtomicJsonStore } from "./atomic-json-store.mjs";
import { CodexAppServerClient } from "./codex-app-server.mjs";
import { assertRuntimeAvailable } from "./project-setup.mjs";
import { resolveProject } from "./project.mjs";
import {
  buildTaskForest,
  parentLink,
  subtreeLinks,
} from "./task-forest.mjs";
import { deliverMechanicalActions } from "./task-messaging.mjs";
import {
  acknowledgeDelivery,
  enqueueDeliveries,
  leaseDeliveries,
  releaseDelivery,
  transactTaskLedger,
} from "./task-ledger.mjs";

const MAX_ID_LENGTH = 1_024;
const MAX_AFFECTED_TASK_IDS = 20;
const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1_000;
const PUBLIC_OPERATIONS = new Set(["resume", "stop"]);
const RUNTIME_SCRIPT = fileURLToPath(
  new URL("../../commands/runtime.mjs", import.meta.url),
);

export class TaskLifecycleError extends Error {
  constructor(code, message, taskIds = []) {
    super(message);
    this.name = "TaskLifecycleError";
    this.code = code;
    this.taskIds = [...new Set(taskIds)].sort();
  }
}

function requireId(value, label) {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > MAX_ID_LENGTH
  ) {
    throw new TaskLifecycleError(
      "TASK_LIFECYCLE_INVALID",
      `${label} must be a bounded non-empty string.`,
    );
  }

  return value;
}

function requireTimestamp(value) {
  if (typeof value !== "string") {
    throw new TaskLifecycleError(
      "TASK_LIFECYCLE_INVALID",
      "now must be an ISO timestamp.",
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TaskLifecycleError(
      "TASK_LIFECYCLE_INVALID",
      "now must be an ISO timestamp.",
    );
  }

  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireOptions(options) {
  if (!isPlainObject(options)) {
    throw new TaskLifecycleError(
      "TASK_LIFECYCLE_INVALID",
      "Lifecycle options must be an object.",
    );
  }

  const keys = Object.keys(options).sort();
  if (keys.join(",") !== "now,operationId") {
    throw new TaskLifecycleError(
      "TASK_LIFECYCLE_INVALID",
      "Lifecycle options must contain only now and operationId.",
    );
  }

  return {
    now: requireTimestamp(options.now),
    operationId: requireId(options.operationId, "operationId"),
  };
}

function compareIds(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareChanges(left, right) {
  return compareIds(left.childTaskId, right.childTaskId);
}

function actionId(kind, operationId, targetTaskId) {
  const digest = createHash("sha256")
    .update(kind)
    .update("\0")
    .update(operationId)
    .update("\0")
    .update(targetTaskId)
    .digest("hex");
  return `action:${digest}`;
}

function basePlan(operation, taskId, options, changes, actionTargets) {
  const actions = actionTargets
    .map(({
      conversationId,
      kind,
      parentTaskId,
      targetTaskId,
    }) => ({
      id: actionId(kind, options.operationId, targetTaskId),
      kind,
      targetTaskId,
      parentTaskId,
      operationId: options.operationId,
      observedTurnId: null,
      ...(conversationId === undefined ? {} : { conversationId }),
    }))
    .sort((left, right) =>
      compareIds(left.targetTaskId, right.targetTaskId)
    );

  return {
    operation,
    operationId: options.operationId,
    taskId,
    at: options.now,
    changes: [...changes].sort(compareChanges),
    actions,
  };
}

function transitionLinks(forest, taskId, fromLifecycles, createChange) {
  const selectedLinks = subtreeLinks(forest, taskId);
  return selectedLinks
    .filter(({ lifecycle }) => fromLifecycles.has(lifecycle))
    .map(createChange)
    .sort(compareChanges);
}

function interruptTargets(forest, changes, excludedTaskId = null) {
  return changes
    .filter(({ childTaskId }) => childTaskId !== excludedTaskId)
    .map(({ childTaskId }) => {
      const incoming = parentLink(forest, childTaskId);
      return {
        kind: "interrupt",
        parentTaskId: incoming.parentTaskId,
        targetTaskId: childTaskId,
      };
    });
}

function requirePlan(plan) {
  if (!isPlainObject(plan)) {
    throw new TaskLifecycleError(
      "TASK_LIFECYCLE_INVALID",
      "Lifecycle plan must be an object.",
    );
  }
  const keys = Object.keys(plan).sort();
  if (
    keys.join(",")
    !== "actions,at,changes,operation,operationId,taskId"
    || !new Set(["archive", "resume", "stop"])
      .has(plan.operation)
    || !Array.isArray(plan.changes)
    || !Array.isArray(plan.actions)
  ) {
    throw new TaskLifecycleError(
      "TASK_LIFECYCLE_INVALID",
      "Lifecycle plan has missing or unsupported fields.",
    );
  }

  requireId(plan.taskId, "taskId");
  requireId(plan.operationId, "operationId");
  requireTimestamp(plan.at);
  return plan;
}

function applyLinkChange(currentLink, change, at) {
  if (currentLink.lifecycle !== change.from) {
    throw new TaskLifecycleError(
      "TASK_LIFECYCLE_INVALID",
      "Lifecycle plan no longer matches the current Task Forest.",
      [currentLink.childTaskId],
    );
  }
  if (Date.parse(at) < Date.parse(currentLink.updatedAt)) {
    throw new TaskLifecycleError(
      "TASK_LIFECYCLE_INVALID",
      "Lifecycle transition time cannot precede the current link update.",
      [currentLink.childTaskId],
    );
  }

  if (change.to === "accepted") {
    if (
      !new Set(["direct", "ancestor", "archive"])
        .has(change.acceptanceReason)
    ) {
      throw new TaskLifecycleError(
        "TASK_LIFECYCLE_INVALID",
        "Accepted lifecycle changes require a supported reason.",
        [currentLink.childTaskId],
      );
    }
    return {
      ...currentLink,
      lifecycle: "accepted",
      acceptanceReason: change.acceptanceReason,
      acceptedAt: at,
      updatedAt: at,
    };
  }

  if (
    !new Set(["open", "stopped"]).has(change.to)
    || Object.hasOwn(change, "acceptanceReason")
  ) {
    throw new TaskLifecycleError(
      "TASK_LIFECYCLE_INVALID",
      "Open and stopped changes cannot contain acceptance metadata.",
      [currentLink.childTaskId],
    );
  }
  return {
    ...currentLink,
    lifecycle: change.to,
    acceptanceReason: null,
    acceptedAt: null,
    updatedAt: at,
  };
}

export function applyLifecyclePlan(state, rawPlan) {
  const plan = requirePlan(rawPlan);

  if (plan.changes.length === 0 && plan.actions.length === 0) {
    return {
      state,
      result: {
        operation: plan.operation,
        operationId: plan.operationId,
        taskId: plan.taskId,
        changedLinks: 0,
        queuedActions: 0,
        affectedTaskIds: [],
      },
    };
  }

  const changeByTaskId = new Map();

  for (const change of plan.changes) {
    if (
      !isPlainObject(change)
      || typeof change.childTaskId !== "string"
      || changeByTaskId.has(change.childTaskId)
    ) {
      throw new TaskLifecycleError(
        "TASK_LIFECYCLE_INVALID",
        "Lifecycle changes must identify unique Child Tasks.",
      );
    }
    changeByTaskId.set(change.childTaskId, change);
  }

  const foundTaskIds = new Set();
  const links = state.links.map((currentLink) => {
    const change = changeByTaskId.get(currentLink.childTaskId);
    if (!change) {
      return currentLink;
    }
    foundTaskIds.add(currentLink.childTaskId);
    return applyLinkChange(currentLink, change, plan.at);
  });

  if (foundTaskIds.size !== changeByTaskId.size) {
    throw new TaskLifecycleError(
      "TASK_LIFECYCLE_INVALID",
      "Lifecycle plan references a Child Task outside the current ledger.",
      [...changeByTaskId.keys()].filter(
        (taskId) => !foundTaskIds.has(taskId),
      ),
    );
  }

  const enqueued = enqueueDeliveries({
    ...state,
    links,
  }, plan.actions, {
    now: plan.at,
  });
  const affectedTaskIds = [...changeByTaskId.keys()].sort(compareIds);

  return {
    state: enqueued.state,
    result: {
      operation: plan.operation,
      operationId: plan.operationId,
      taskId: plan.taskId,
      changedLinks: plan.changes.length,
      queuedActions: plan.actions.length,
      affectedTaskIds,
    },
  };
}

function conversationLifecycleView(state, taskId) {
  if (
    !state
    || !Array.isArray(state.links)
    || !Array.isArray(state.conversations)
  ) {
    throw new TaskLifecycleError(
      "TASK_LIFECYCLE_INVALID",
      "Task lifecycle requires links and conversations.",
    );
  }
  const active = state.conversations.filter(
    ({ state: conversationState }) =>
      conversationState === "awaiting_reply",
  );
  const children = new Map();
  const incoming = new Map();
  const represented = new Set();
  for (const conversation of active) {
    const current = children.get(conversation.initiatorTaskId) ?? [];
    current.push(conversation.responderTaskId);
    children.set(conversation.initiatorTaskId, current);
    incoming.set(conversation.responderTaskId, conversation);
    represented.add(conversation.initiatorTaskId);
    represented.add(conversation.responderTaskId);
  }
  for (const currentLink of state.links) {
    represented.add(currentLink.parentTaskId);
    represented.add(currentLink.childTaskId);
  }
  if (!represented.has(taskId)) {
    throw new TaskLifecycleError(
      "TASK_NOT_MANAGED",
      "Task is not represented by this project runtime.",
      [taskId],
    );
  }

  const selected = new Set();
  const pending = [taskId];
  while (pending.length > 0) {
    const currentTaskId = pending.pop();
    if (selected.has(currentTaskId)) continue;
    selected.add(currentTaskId);
    pending.push(...(children.get(currentTaskId) ?? []));
  }
  return {
    active,
    children,
    incoming,
    selected,
  };
}

function lifecycleParent(state, view, taskId) {
  return view.incoming.get(taskId)?.initiatorTaskId
    ?? state.links.find(({ childTaskId }) => childTaskId === taskId)
      ?.parentTaskId
    ?? null;
}

function requireNoStoppedConversationAncestor(state, view, taskId) {
  const linkByTaskId = new Map(
    state.links.map((link) => [link.childTaskId, link]),
  );
  let current = taskId;
  const visited = new Set();
  while (view.incoming.has(current)) {
    if (visited.has(current)) break;
    visited.add(current);
    current = view.incoming.get(current).initiatorTaskId;
    const link = linkByTaskId.get(current);
    if (link?.lifecycle === "stopped") {
      throw new TaskLifecycleError(
        "TASK_ANCESTOR_STOPPED",
        "A task beneath a stopped Conversation ancestor cannot be resumed directly.",
        [taskId, current],
      );
    }
  }
}

export function planStop(state, taskId, rawOptions) {
  const options = requireOptions(rawOptions);
  const view = conversationLifecycleView(state, taskId);
  const changes = state.links
    .filter((currentLink) =>
      view.selected.has(currentLink.childTaskId)
      && currentLink.lifecycle === "open"
    )
    .map((currentLink) => ({
      childTaskId: currentLink.childTaskId,
      from: "open",
      to: "stopped",
    }))
    .sort(compareChanges);
  const actionTargets = changes.map(({ childTaskId }) => ({
    kind: "interrupt",
    parentTaskId: lifecycleParent(state, view, childTaskId),
    targetTaskId: childTaskId,
  }));

  return basePlan(
    "stop",
    taskId,
    options,
    changes,
    actionTargets,
  );
}

export function planResume(state, taskId, rawOptions) {
  const options = requireOptions(rawOptions);
  const view = conversationLifecycleView(state, taskId);
  requireNoStoppedConversationAncestor(state, view, taskId);
  const changes = state.links
    .filter((currentLink) =>
      view.selected.has(currentLink.childTaskId)
      && currentLink.lifecycle === "stopped"
    )
    .map((currentLink) => ({
      childTaskId: currentLink.childTaskId,
      from: "stopped",
      to: "open",
    }))
    .sort(compareChanges);
  const reopenedTaskIds = new Set(
    changes.map(({ childTaskId }) => childTaskId),
  );
  const actionTargets = [...view.selected]
    .filter((selectedTaskId) =>
      reopenedTaskIds.has(selectedTaskId)
      && (view.children.get(selectedTaskId) ?? []).length === 0
    )
    .map((selectedTaskId) => {
      return {
        kind: "resume",
        parentTaskId: lifecycleParent(state, view, selectedTaskId),
        targetTaskId: selectedTaskId,
        conversationId: view.incoming.get(selectedTaskId)?.id ?? null,
      };
    });

  return basePlan(
    "resume",
    taskId,
    options,
    changes,
    actionTargets,
  );
}

export function planArchiveTermination(forest, taskId, rawOptions) {
  const options = requireOptions(rawOptions);
  const changes = transitionLinks(
    forest,
    taskId,
    new Set(["open", "stopped"]),
    (currentLink) => ({
      childTaskId: currentLink.childTaskId,
      from: currentLink.lifecycle,
      to: "accepted",
      acceptanceReason: "archive",
    }),
  );

  return basePlan(
    "archive",
    taskId,
    options,
    changes,
    interruptTargets(forest, changes, taskId),
  );
}

function requireCommitInput(input) {
  if (!isPlainObject(input)) {
    throw new TaskLifecycleError(
      "TASK_LIFECYCLE_INVALID",
      "Lifecycle input must be an object.",
    );
  }
  const keys = Object.keys(input).sort();
  if (
    keys.join(",") !== "operation,projectRoot,taskId"
    || !PUBLIC_OPERATIONS.has(input.operation)
    || typeof input.projectRoot !== "string"
    || !path.isAbsolute(input.projectRoot)
  ) {
    throw new TaskLifecycleError(
      "TASK_LIFECYCLE_INVALID",
      "Lifecycle input requires a supported operation, absolute projectRoot, and explicit taskId.",
    );
  }

  return {
    operation: input.operation,
    projectRoot: path.normalize(input.projectRoot),
    taskId: requireId(input.taskId, "taskId"),
  };
}

function lifecyclePlanner(operation) {
  if (operation === "resume") {
    return planResume;
  }
  return planStop;
}

function coordinatorDependencies(options) {
  return {
    assertRuntimeAvailable:
      options.assertRuntimeAvailable ?? assertRuntimeAvailable,
    createOperationId: options.createOperationId ?? randomUUID,
    createLeaseOwner: options.createLeaseOwner ?? randomUUID,
    now: options.now ?? (() => new Date().toISOString()),
    resolveProject: options.resolveProject ?? resolveProject,
    transactTaskLedger:
      options.transactTaskLedger ?? transactTaskLedger,
  };
}

async function commitLifecycleContext(input, options = {}) {
  const {
    operation,
    projectRoot,
    taskId,
  } = requireCommitInput(input);
  const dependencies = coordinatorDependencies(options);
  const project = await dependencies.resolveProject(projectRoot);
  const store = options.store ?? new AtomicJsonStore(project.stateFile);
  try {
    await dependencies.assertRuntimeAvailable(project, {
      roots: options.roots,
      sessionFileSystem: options.sessionFileSystem,
      openHistory: options.sessionOpenHistory,
      store,
      nowMs: options.nowMs,
    });
  } catch (cause) {
    const error = new TaskLifecycleError(
      "RUNTIME_NOT_AVAILABLE",
      `Codex Small Loop Project Runtime could not be read safely. Run node ${JSON.stringify(RUNTIME_SCRIPT)} status --project-root ${JSON.stringify(project.root)} to diagnose the current state. Resolve the reported issue, then retry task ${operation}.`,
      [taskId],
    );
    error.cause = cause;
    error.operation = operation;
    error.taskId = taskId;
    error.run = "failed";
    throw error;
  }

  const operationId = requireId(
    dependencies.createOperationId(),
    "operationId",
  );
  const now = requireTimestamp(dependencies.now());
  const planner = lifecyclePlanner(operation);
  const transaction = await dependencies.transactTaskLedger(
    store,
    project,
    (state) => {
      const plan = planner(state, taskId, { now, operationId });
      return applyLifecyclePlan(state, plan);
    },
    { now },
  );

  const result = {
    run: "ok",
    ...transaction.result,
  };

  return {
    dependencies,
    project,
    result,
    state: transaction.state,
    store,
  };
}

export async function commitLifecycleOperation(input, options = {}) {
  return (await commitLifecycleContext(input, options)).result;
}

function requireLeaseDuration(value) {
  const duration = value ?? DEFAULT_LEASE_DURATION_MS;
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new TaskLifecycleError(
      "TASK_LIFECYCLE_INVALID",
      "leaseDurationMs must be a positive integer.",
    );
  }
  return duration;
}

function operationDeliveries(state, operationId) {
  return state.deliveries.filter(
    (delivery) => delivery.operationId === operationId,
  );
}

function boundedResult(result, state) {
  const deliveries = operationDeliveries(state, result.operationId);
  const deliveredActions = deliveries.filter(
    ({ status }) => status === "delivered",
  ).length;
  const pendingActions = deliveries.length - deliveredActions;
  const allTaskIds = result.affectedTaskIds;
  const affectedTaskIds = allTaskIds.slice(0, MAX_AFFECTED_TASK_IDS);

  return {
    run: pendingActions === 0 ? "ok" : "partial",
    operation: result.operation,
    operationId: result.operationId,
    taskId: result.taskId,
    changedLinks: result.changedLinks,
    queuedActions: result.queuedActions,
    deliveredActions,
    pendingActions,
    affectedTaskIds,
    omitted: allTaskIds.length - affectedTaskIds.length,
  };
}

function cachedHistoryPaths(state) {
  return new Map(
    state.links
      .filter(({ historyFile }) => historyFile !== null)
      .map(({ childTaskId, historyFile }) => [
        childTaskId,
        historyFile,
      ]),
  );
}

function deliveryFailureOutcomes(deliveries, error) {
  const code = typeof error?.code === "string"
    ? error.code
    : "DELIVERY_FAILED";
  const message = typeof error?.message === "string"
    ? error.message
    : "Mechanical delivery failed.";
  return deliveries.map(({ id }) => ({
    deliveryId: id,
    status: "failed",
    error: { code, message },
  }));
}

function defaultAppServer(project, options) {
  return new CodexAppServerClient({
    command: options.codexCommand,
    args: options.codexArgs,
    cwd: project.root,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
}

function partialLifecycleError(error, result) {
  const wrapped = new TaskLifecycleError(
    "TASK_DELIVERY_STATE_FAILED",
    "Lifecycle state committed but delivery outcomes could not be persisted.",
    result.affectedTaskIds,
  );
  wrapped.cause = error;
  wrapped.run = "partial";
  wrapped.operation = result.operation;
  wrapped.operationId = result.operationId;
  wrapped.taskId = result.taskId;
  return wrapped;
}

async function finalLifecycleResult(context, state) {
  return boundedResult(context.result, state);
}

export async function runLifecycleOperation(input, options = {}) {
  const context = await commitLifecycleContext(input, options);
  const deliveryIds = operationDeliveries(
    context.state,
    context.result.operationId,
  ).map(({ id }) => id);

  if (deliveryIds.length === 0) {
    return finalLifecycleResult(context, context.state);
  }

  const leaseNow = requireTimestamp(context.dependencies.now());
  const leaseExpiresAt = new Date(
    Date.parse(leaseNow) + requireLeaseDuration(options.leaseDurationMs),
  ).toISOString();
  const leaseOwner = requireId(
    context.dependencies.createLeaseOwner(),
    "leaseOwner",
  );
  let leaseTransaction;
  try {
    leaseTransaction = await (
      context.dependencies.transactTaskLedger(
        context.store,
        context.project,
        (state) => {
          const leased = leaseDeliveries(state, {
            deliveryIds,
            leaseOwner,
            leaseExpiresAt,
            now: leaseNow,
          });
          return {
            state: leased.state,
            result: leased.leased,
          };
        },
        { now: leaseNow },
      )
    );
  } catch (error) {
    throw partialLifecycleError(error, context.result);
  }
  const leased = leaseTransaction.result;

  if (leased.length === 0) {
    return boundedResult(context.result, leaseTransaction.state);
  }

  const appServer = options.appServer
    ?? defaultAppServer(context.project, options);
  let outcomes;
  try {
    try {
      outcomes = await deliverMechanicalActions(leased, {
        projectRoot: context.project.root,
        appServer,
        observeTasks: options.observeTasks,
        roots: options.roots,
        cachedPaths: cachedHistoryPaths(leaseTransaction.state),
        fileSystem: options.sessionFileSystem,
        openHistory: options.sessionOpenHistory,
      });
    } catch (error) {
      outcomes = deliveryFailureOutcomes(leased, error);
    }

    const outcomeNow = requireTimestamp(context.dependencies.now());
    let outcomeTransaction;
    try {
      outcomeTransaction = await (
        context.dependencies.transactTaskLedger(
          context.store,
          context.project,
          (state) => {
            let nextState = state;
            for (const outcome of outcomes) {
              nextState = outcome.status === "delivered"
                ? acknowledgeDelivery(
                    nextState,
                    outcome.deliveryId,
                    leaseOwner,
                    outcomeNow,
                  )
                : releaseDelivery(
                    nextState,
                    outcome.deliveryId,
                    leaseOwner,
                    outcome.error,
                    outcomeNow,
                  );
            }
            return {
              state: nextState,
              result: null,
            };
          },
          { now: outcomeNow },
        )
      );
    } catch (error) {
      throw partialLifecycleError(error, context.result);
    }

    return finalLifecycleResult(context, outcomeTransaction.state);
  } finally {
    if (typeof appServer.close === "function") {
      await Promise.resolve(appServer.close()).catch(() => {});
    }
  }
}
