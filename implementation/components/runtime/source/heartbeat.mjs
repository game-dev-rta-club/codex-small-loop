import {
  createHash,
  randomUUID,
} from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  createAppMessageSchedule,
  inspectAppMessageSchedule,
} from "./app-message-schedule.mjs";
import { AtomicJsonStore } from "./atomic-json-store.mjs";
import {
  planRecoveryCandidates,
  queueRecoveryCandidates,
  runRecoveryDeliveries,
} from "./abnormal-recovery.mjs";
import { CodexAppServerClient } from "./codex-app-server.mjs";
import { assertRuntimeAvailable } from "./project-setup.mjs";
import { resolveProject } from "./project.mjs";
import {
  continueDeferredFork,
  continuePendingRoleLaunch,
  promotePendingLaunch,
} from "./task-launch.mjs";
import {
  buildTaskForest,
  leafTaskIds,
  parentLink,
} from "./task-forest.mjs";
import {
  applyLifecyclePlan,
  planArchiveTermination,
} from "./task-lifecycle.mjs";
import {
  deliverMechanicalActions,
} from "./task-messaging.mjs";
import {
  acknowledgeScheduledAppMessage,
  acknowledgeDelivery,
  compactTaskLedger,
  discardDelivery,
  hasPendingAppMessages,
  hasPendingWork,
  leaseAppMessages,
  leaseDeliveries,
  markAppMessageScheduled,
  readTaskLedger,
  releaseDelivery,
  releaseAppMessage,
  transactTaskLedger,
} from "./task-ledger.mjs";
import { observeTasks } from "./task-state-observer.mjs";

export async function leaseHeartbeatAppMessages(ledger, options) {
  const leaseDurationMs = options.leaseDurationMs ?? 5 * 60 * 1_000;
  const limit = options.limit ?? 8;
  const leaseExpiresAt = new Date(
    Date.parse(options.now) + leaseDurationMs,
  ).toISOString();
  const transaction = await (
    options.transactTaskLedger ?? transactTaskLedger
  )(
    ledger.store,
    ledger.project,
    (state) => {
      const leased = leaseAppMessages(state, {
        now: options.now,
        leaseExpiresAt,
        leaseOwner: options.leaseOwner,
        limit,
      });
      return {
        state: leased.state,
        result: leased.leased,
      };
    },
    { now: options.now },
  );
  return {
    state: transaction.state,
    messages: transaction.result.map((message) => ({
      id: message.id,
      targetTaskId: message.targetTaskId,
      text: message.text,
    })),
  };
}

export async function reconcileAppMessageSchedules(ledger, options) {
  const leased = await leaseHeartbeatAppMessages(ledger, options);
  const automationRoot = options.automationRoot;
  const inspectSchedule = options.inspectAppMessageSchedule
    ?? inspectAppMessageSchedule;
  const createSchedule = options.createAppMessageSchedule
    ?? createAppMessageSchedule;
  const scheduledMessages = leased.state.appMessages.filter(
    ({ status }) => status === "scheduled",
  );
  const scheduledOutcomes = await Promise.all(
    scheduledMessages.map(async (message) => {
      try {
        const inspection = await inspectSchedule({
          messageId: message.id,
          automationRoot,
        });
        return {
          id: message.id,
          status: inspection.present ? "waiting" : "delivered",
        };
      } catch (error) {
        return { id: message.id, status: "waiting", error };
      }
    }),
  );
  const leasedOutcomes = await Promise.all(leased.messages.map(
    async (message) => {
    try {
      await createSchedule({
        messageId: message.id,
        targetTaskId: message.targetTaskId,
        text: message.text,
        nowMs: Date.parse(options.now),
        automationRoot,
      });
      return { id: message.id, status: "scheduled" };
    } catch (error) {
      return { id: message.id, status: "ready", error };
    }
  }));
  const outcomes = [...scheduledOutcomes, ...leasedOutcomes];

  if (outcomes.length === 0) {
    return {
      state: leased.state,
      deliveredMessageIds: [],
      failedMessageIds: [],
      pendingMessageIds: [],
    };
  }

  const transaction = await (
    options.transactTaskLedger ?? transactTaskLedger
  )(
    ledger.store,
    ledger.project,
    (state) => {
      let nextState = state;
      for (const outcome of outcomes) {
        const current = nextState.appMessages.find(
          ({ id }) => id === outcome.id,
        );
        if (!current) {
          continue;
        }
        if (
          outcome.status === "delivered"
          && current.status === "scheduled"
        ) {
          nextState = acknowledgeScheduledAppMessage(
              nextState,
              outcome.id,
              options.now,
            );
        } else if (
          outcome.status === "scheduled"
          && current.status === "leased"
          && current.leaseOwner === options.leaseOwner
        ) {
          nextState = markAppMessageScheduled(
            nextState,
            outcome.id,
            options.leaseOwner,
            options.now,
          );
        } else if (
          outcome.status === "ready"
          && current.status === "leased"
          && current.leaseOwner === options.leaseOwner
        ) {
          nextState = releaseAppMessage(
              nextState,
              outcome.id,
              options.leaseOwner,
              outcome.error,
              options.now,
            );
        }
      }
      return { state: nextState, result: null };
    },
    { now: options.now },
  );

  return {
    state: transaction.state,
    deliveredMessageIds: outcomes
      .filter(({ status }) => status === "delivered")
      .map(({ id }) => id)
      .sort(),
    failedMessageIds: outcomes
      .filter(({ error }) => error)
      .map(({ id }) => id)
      .sort(),
    pendingMessageIds: outcomes
      .filter(({ status }) =>
        status === "waiting"
        || status === "scheduled"
        || status === "ready"
      )
      .map(({ id }) => id)
      .sort(),
  };
}

function compareLaunches(left, right) {
  return left.launchId.localeCompare(right.launchId);
}

function snapshotIndex(snapshots) {
  if (!Array.isArray(snapshots)) {
    throw new TypeError(
      "Pending-launch observations must be an array.",
    );
  }

  return new Map(
    snapshots.map((snapshot) => [snapshot.taskId, snapshot]),
  );
}

function unavailableReason(snapshot) {
  if (!snapshot || snapshot.location === "missing") {
    return "observation_missing";
  }
  if (snapshot.turnState === "not_started") {
    return "assignment_not_started";
  }
  if (snapshot.turnState === "unknown") {
    return "observation_unknown";
  }
  return "observation_unavailable";
}

export function planPendingLaunchReconciliation(
  pendingLaunches,
  snapshots,
) {
  if (!Array.isArray(pendingLaunches)) {
    throw new TypeError("Pending launches must be an array.");
  }

  const snapshotsByTaskId = snapshotIndex(snapshots);
  const promotions = [];
  const deferredForks = [];
  const roleContinuations = [];
  const waitingForkLaunchIds = [];
  const runningLaunchIds = [];
  const repairRequired = [];
  const degraded = [];

  for (const launch of pendingLaunches) {
    if (typeof launch.assignment !== "string") {
      repairRequired.push({
        launchId: launch.id,
        reason: "assignment_missing",
      });
      continue;
    }
    if (launch.phase === "fork_queued") {
      const parentSnapshot = snapshotsByTaskId.get(launch.parentTaskId);
      if (parentSnapshot?.location === "archived") {
        repairRequired.push({
          launchId: launch.id,
          reason: "parent_archived",
        });
      } else if (
        !parentSnapshot
        || parentSnapshot.location !== "active"
      ) {
        degraded.push({
          launchId: launch.id,
          reason: unavailableReason(parentSnapshot),
        });
      } else if (parentSnapshot.turnState === "in_progress") {
        waitingForkLaunchIds.push(launch.id);
      } else if (parentSnapshot.turnState === "aborted") {
        repairRequired.push({
          launchId: launch.id,
          reason: "parent_turn_aborted",
        });
      } else if (parentSnapshot.turnState !== "ended") {
        degraded.push({
          launchId: launch.id,
          reason: unavailableReason(parentSnapshot),
        });
      } else {
        const sourceTaskId = launch.sourceTaskId ?? launch.parentTaskId;
        const sourceSnapshot = sourceTaskId === launch.parentTaskId
          ? parentSnapshot
          : snapshotsByTaskId.get(sourceTaskId);
        if (sourceSnapshot?.location === "archived") {
          repairRequired.push({
            launchId: launch.id,
            reason: "source_archived",
          });
        } else if (
          !sourceSnapshot
          || sourceSnapshot.location !== "active"
        ) {
          degraded.push({
            launchId: launch.id,
            reason: `source_${unavailableReason(sourceSnapshot)}`,
          });
        } else if (sourceSnapshot.turnState === "ended") {
          deferredForks.push({ launchId: launch.id });
        } else if (sourceSnapshot.turnState === "in_progress") {
          waitingForkLaunchIds.push(launch.id);
        } else if (sourceSnapshot.turnState === "aborted") {
          repairRequired.push({
            launchId: launch.id,
            reason: "source_turn_aborted",
          });
        } else {
          degraded.push({
            launchId: launch.id,
            reason: `source_${unavailableReason(sourceSnapshot)}`,
          });
        }
      }
      continue;
    }
    if (launch.phase === "prepared") {
      repairRequired.push({
        launchId: launch.id,
        reason: "launch_not_started",
      });
      continue;
    }
    if (
      launch.phase === "creating"
      || launch.phase === "fork_creating"
    ) {
      repairRequired.push({
        launchId: launch.id,
        reason: "child_creation_ambiguous",
      });
      continue;
    }
    if (
      launch.phase === "child_created"
      || launch.phase === "fork_child_created"
    ) {
      repairRequired.push({
        launchId: launch.id,
        reason: "assignment_turn_unrecorded",
      });
      continue;
    }
    if (
      launch.phase === "role_started"
      || launch.phase === "fork_role_started"
    ) {
      const snapshot = snapshotsByTaskId.get(launch.childTaskId);
      if (snapshot?.location === "archived") {
        repairRequired.push({
          launchId: launch.id,
          reason: "child_archived",
        });
      } else if (!snapshot || snapshot.location !== "active") {
        degraded.push({
          launchId: launch.id,
          reason: unavailableReason(snapshot),
        });
      } else if (snapshot.turnId !== launch.roleTurnId) {
        degraded.push({
          launchId: launch.id,
          reason: "turn_boundary_changed",
        });
      } else if (snapshot.turnState === "ended") {
        roleContinuations.push({ launchId: launch.id });
      } else if (snapshot.turnState === "in_progress") {
        runningLaunchIds.push(launch.id);
      } else if (snapshot.turnState === "aborted") {
        repairRequired.push({
          launchId: launch.id,
          reason: "role_turn_aborted",
        });
      } else {
        degraded.push({
          launchId: launch.id,
          reason: unavailableReason(snapshot),
        });
      }
      continue;
    }
    if (
      launch.phase === "assignment_starting"
      || launch.phase === "fork_assignment_starting"
    ) {
      repairRequired.push({
        launchId: launch.id,
        reason: "assignment_start_ambiguous",
      });
      continue;
    }
    if (
      launch.phase !== "assignment_started"
      && launch.phase !== "fork_assignment_started"
    ) {
      degraded.push({
        launchId: launch.id,
        reason: "launch_phase_unknown",
      });
      continue;
    }

    const snapshot = snapshotsByTaskId.get(launch.childTaskId);

    if (snapshot?.location === "archived") {
      repairRequired.push({
        launchId: launch.id,
        reason: "child_archived",
      });
      continue;
    }
    if (!snapshot || snapshot.location !== "active") {
      degraded.push({
        launchId: launch.id,
        reason: unavailableReason(snapshot),
      });
      continue;
    }
    if (snapshot.turnId !== launch.assignmentTurnId) {
      degraded.push({
        launchId: launch.id,
        reason: "turn_boundary_changed",
      });
      continue;
    }
    if (
      typeof snapshot.historyFile !== "string"
      || !path.isAbsolute(snapshot.historyFile)
    ) {
      degraded.push({
        launchId: launch.id,
        reason: "history_unavailable",
      });
      continue;
    }
    if (
      snapshot.turnState === "ended"
      || snapshot.turnState === "in_progress"
      || snapshot.turnState === "aborted"
    ) {
      promotions.push({
        launchId: launch.id,
        childTaskId: launch.childTaskId,
        assignmentTurnId: launch.assignmentTurnId,
        historyFile: snapshot.historyFile,
      });
      continue;
    }

    degraded.push({
      launchId: launch.id,
      reason: unavailableReason(snapshot),
    });
  }

  promotions.sort(compareLaunches);
  deferredForks.sort(compareLaunches);
  roleContinuations.sort(compareLaunches);
  waitingForkLaunchIds.sort();
  runningLaunchIds.sort();
  repairRequired.sort(compareLaunches);
  degraded.sort(compareLaunches);

  return {
    deferredForks,
    roleContinuations,
    waitingForkLaunchIds,
    promotions,
    runningLaunchIds,
    repairRequired,
    degraded,
  };
}

function requireReconciliationOptions(options) {
  if (
    !options
    || typeof options !== "object"
    || typeof options.now !== "string"
    || Number.isNaN(Date.parse(options.now))
    || new Date(options.now).toISOString() !== options.now
  ) {
    throw new TypeError(
      "Pending-launch reconciliation requires an ISO now timestamp.",
    );
  }
}

function promotionFailureReason(error) {
  if (error?.code === "PARENT_TASK_NOT_OPEN") {
    return "parent_not_open";
  }
  return "promotion_rejected";
}

export function applyPendingLaunchReconciliation(
  state,
  plan,
  options,
) {
  requireReconciliationOptions(options);
  if (!plan || !Array.isArray(plan.promotions)) {
    throw new TypeError(
      "Pending-launch reconciliation requires a promotion plan.",
    );
  }

  let nextState = state;
  const promotedLaunchIds = [];
  const discarded = [];

  for (const promotion of [...plan.promotions].sort(compareLaunches)) {
    const current = nextState.pendingLaunches.find(
      ({ id }) => id === promotion.launchId,
    );

    if (
      !current
      || (
        current.phase !== "assignment_started"
        && current.phase !== "fork_assignment_started"
      )
      || current.childTaskId !== promotion.childTaskId
      || current.assignmentTurnId !== promotion.assignmentTurnId
    ) {
      discarded.push({
        launchId: promotion.launchId,
        reason: "launch_changed",
      });
      continue;
    }

    try {
      const promoted = promotePendingLaunch(nextState, {
        launchId: promotion.launchId,
        now: options.now,
        historyFile: promotion.historyFile,
      });
      nextState = promoted.state;
      promotedLaunchIds.push(promotion.launchId);
    } catch (error) {
      discarded.push({
        launchId: promotion.launchId,
        reason: promotionFailureReason(error),
      });
    }
  }

  return {
    state: nextState,
    result: {
      promotedLaunchIds: promotedLaunchIds.sort(),
      discarded: discarded.sort(compareLaunches),
    },
  };
}

export async function reconcilePendingLaunches(
  ledger,
  plan,
  options,
) {
  if (
    !ledger
    || typeof ledger !== "object"
    || !("store" in ledger)
    || !("project" in ledger)
  ) {
    throw new TypeError(
      "Pending-launch reconciliation requires a ledger context.",
    );
  }
  requireReconciliationOptions(options);
  const transact = options.transactTaskLedger ?? transactTaskLedger;
  const transaction = await transact(
    ledger.store,
    ledger.project,
    (state) =>
      applyPendingLaunchReconciliation(state, plan, {
        now: options.now,
      }),
    { now: options.now },
  );

  return {
    state: transaction.state,
    ...transaction.result,
  };
}

export async function runDeferredForks(ledger, plan, options = {}) {
  const queued = [...(plan.deferredForks ?? [])].sort(compareLaunches);
  const roleReady = [...(plan.roleContinuations ?? [])].sort(compareLaunches);
  if (queued.length === 0 && roleReady.length === 0) {
    return {
      state: options.state,
      completedLaunchIds: [],
      failed: [],
    };
  }

  const continueFork = options.continueDeferredFork
    ?? continueDeferredFork;
  const continueRole = options.continuePendingRoleLaunch
    ?? continuePendingRoleLaunch;
  const continuationOptions = {
    store: ledger.store,
    codexCommand: options.codexCommand,
    codexArgs: options.codexArgs,
    env: options.env,
    timeoutMs: options.timeoutMs,
    roots: options.roots,
    sessionFileSystem: options.sessionFileSystem,
    sessionOpenHistory: options.sessionOpenHistory,
  };
  const continuations = [
    ...queued.map(({ launchId }) => ({
      launchId,
      run: continueFork,
      failureReason: "deferred_fork_failed",
    })),
    ...roleReady.map(({ launchId }) => ({
      launchId,
      run: continueRole,
      failureReason: "role_continuation_failed",
    })),
  ].sort(compareLaunches);
  const outcomes = await Promise.all(continuations.map(async ({
    launchId,
    run,
    failureReason,
  }) => {
    try {
      await run({
        projectRoot: ledger.project.root,
        launchId,
      }, continuationOptions);
      return { launchId, completed: true };
    } catch (error) {
      return {
        launchId,
        completed: false,
        reason: error?.code ?? failureReason,
      };
    }
  }));
  const completedLaunchIds = outcomes
    .filter(({ completed }) => completed)
    .map(({ launchId }) => launchId);
  const failed = outcomes
    .filter(({ completed }) => !completed)
    .map(({ launchId, reason }) => ({ launchId, reason }));

  const readLedger = options.readTaskLedger ?? readTaskLedger;
  return {
    state: await readLedger(ledger.store, ledger.project),
    completedLaunchIds,
    failed,
  };
}

export function buildHeartbeatObservationRequests(state) {
  if (
    !state
    || typeof state !== "object"
    || !Array.isArray(state.links)
    || !Array.isArray(state.conversations)
    || !Array.isArray(state.pendingLaunches)
  ) {
    throw new TypeError(
      "Heartbeat observation requires links, conversations, and pending launches.",
    );
  }

  const representedTaskIds = new Set();
  for (const link of state.links.filter(
    ({ lifecycle }) => lifecycle !== "accepted",
  )) {
    representedTaskIds.add(link.parentTaskId);
    representedTaskIds.add(link.childTaskId);
  }
  for (const conversation of state.conversations.filter(
    ({ state: conversationState }) =>
      conversationState === "awaiting_reply",
  )) {
    representedTaskIds.add(conversation.initiatorTaskId);
    representedTaskIds.add(conversation.responderTaskId);
  }
  for (const launch of state.pendingLaunches.filter(
    ({ phase }) => phase === "fork_queued",
  )) {
    representedTaskIds.add(launch.parentTaskId);
    if (launch.sourceTaskId !== undefined) {
      representedTaskIds.add(launch.sourceTaskId);
    }
  }
  const latestRequests = [...representedTaskIds]
    .sort()
    .map((taskId) => ({
      taskId,
      mode: "latest",
    }));
  const exactRequests = state.pendingLaunches
    .filter(({ phase }) =>
      phase === "role_started"
      || phase === "fork_role_started"
      || phase === "assignment_started"
      || phase === "fork_assignment_started"
    )
    .map((launch) => {
      const rolePhase = launch.phase === "role_started"
        || launch.phase === "fork_role_started";
      return {
        taskId: launch.childTaskId,
        mode: "exact",
        turnId: rolePhase ? launch.roleTurnId : launch.assignmentTurnId,
      };
    })
    .sort((left, right) =>
      left.taskId.localeCompare(right.taskId)
      || left.turnId.localeCompare(right.turnId)
    );

  return [...latestRequests, ...exactRequests];
}

export async function observeHeartbeatTasks(state, options = {}) {
  const requests = buildHeartbeatObservationRequests(state);
  if (requests.length === 0) {
    return {
      latestSnapshots: [],
      pendingLaunchSnapshots: [],
    };
  }

  const observe = options.observeTasks ?? observeTasks;
  const snapshots = await observe(requests, {
    roots: options.roots,
    cachedPaths: options.cachedPaths,
    fileSystem: options.fileSystem,
    openHistory: options.openHistory,
  });
  const pendingLaunchByBoundary = new Map(
    state.pendingLaunches
      .filter(({ phase }) =>
        phase === "role_started"
        || phase === "fork_role_started"
        || phase === "assignment_started"
        || phase === "fork_assignment_started"
      )
      .map((launch) => [
        `${launch.childTaskId}\0${
          launch.phase === "role_started"
          || launch.phase === "fork_role_started"
            ? launch.roleTurnId
            : launch.assignmentTurnId
        }`,
        launch.id,
      ]),
  );
  const latestSnapshots = [];
  const pendingLaunchSnapshots = [];

  for (const [index, request] of requests.entries()) {
    const snapshot = snapshots[index];
    if (request.mode === "latest") {
      latestSnapshots.push(snapshot);
      continue;
    }

    pendingLaunchSnapshots.push({
      launchId: pendingLaunchByBoundary.get(
        `${request.taskId}\0${request.turnId}`,
      ),
      snapshot,
    });
  }

  return {
    latestSnapshots,
    pendingLaunchSnapshots,
  };
}

function hasSelectedAncestor(forest, taskId, selectedTaskIds) {
  let currentTaskId = taskId;

  while (forest.linkByChildTaskId.has(currentTaskId)) {
    currentTaskId = forest.linkByChildTaskId.get(
      currentTaskId,
    ).parentTaskId;
    if (selectedTaskIds.has(currentTaskId)) {
      return true;
    }
  }

  return false;
}

function archiveOperationId(taskId, snapshot) {
  const digest = createHash("sha256")
    .update("archive")
    .update("\0")
    .update(taskId)
    .update("\0")
    .update(snapshot.latestTurnId ?? "no-turn")
    .digest("hex");
  return `archive:${digest}`;
}

export function planArchiveTerminations(
  forest,
  latestSnapshots,
  options,
) {
  requireReconciliationOptions(options);
  if (!Array.isArray(latestSnapshots)) {
    throw new TypeError(
      "Archive termination requires latest snapshots.",
    );
  }

  const representedTaskIds = new Set([
    ...forest.rootTaskIds,
    ...forest.linkByChildTaskId.keys(),
  ]);
  const snapshotByTaskId = new Map(
    latestSnapshots.map((snapshot) => [
      snapshot.taskId,
      snapshot,
    ]),
  );
  const archivedTaskIds = new Set(
    latestSnapshots
      .filter((snapshot) =>
        snapshot.location === "archived"
        && representedTaskIds.has(snapshot.taskId)
      )
      .map(({ taskId }) => taskId),
  );
  const anchors = [...archivedTaskIds]
    .filter((taskId) =>
      !hasSelectedAncestor(forest, taskId, archivedTaskIds)
    )
    .sort();

  return anchors.map((taskId) => {
    const snapshot = snapshotByTaskId.get(taskId);
    return planArchiveTermination(forest, taskId, {
      now: options.now,
      operationId: archiveOperationId(taskId, snapshot),
    });
  });
}

export function applyArchiveTerminations(state, plans) {
  if (!Array.isArray(plans)) {
    throw new TypeError("Archive termination plans must be an array.");
  }

  let nextState = state;
  const archivedTaskIds = [];

  for (const plan of [...plans].sort((left, right) =>
    left.taskId.localeCompare(right.taskId)
  )) {
    const applied = applyLifecyclePlan(nextState, plan);
    nextState = applied.state;
    if (applied.result.changedLinks > 0) {
      archivedTaskIds.push(plan.taskId);
    }
  }

  return {
    state: nextState,
    result: {
      archivedTaskIds,
    },
  };
}

export async function reconcileArchiveTerminations(
  ledger,
  latestSnapshots,
  options,
) {
  if (
    !ledger
    || typeof ledger !== "object"
    || !("store" in ledger)
    || !("project" in ledger)
  ) {
    throw new TypeError(
      "Archive termination requires a ledger context.",
    );
  }
  requireReconciliationOptions(options);
  const transact = options.transactTaskLedger ?? transactTaskLedger;
  const transaction = await transact(
    ledger.store,
    ledger.project,
    (state) => {
      const plans = planArchiveTerminations(
        buildTaskForest(state.links),
        latestSnapshots,
        { now: options.now },
      );
      return applyArchiveTerminations(state, plans);
    },
    { now: options.now },
  );

  return {
    state: transaction.state,
    ...transaction.result,
  };
}

export async function runHeartbeatRecovery(
  ledger,
  state,
  latestSnapshots,
  options,
) {
  requireReconciliationOptions(options);
  if (
    typeof options.leaseOwner !== "string"
    || options.leaseOwner.length === 0
  ) {
    throw new TypeError(
      "Heartbeat recovery requires a lease owner.",
    );
  }

  const plan = planRecoveryCandidates(
    state.conversations,
    latestSnapshots,
    state.deliveries,
    {
      appMessages: state.appMessages,
      stoppedTaskIds: state.links
        .filter(({ lifecycle }) => lifecycle === "stopped")
        .map(({ childTaskId }) => childTaskId),
    },
  );
  const observe = options.observeTasks ?? observeTasks;
  const observationOptions = {
    roots: options.roots,
    cachedPaths: options.cachedPaths,
    fileSystem: options.fileSystem,
    openHistory: options.openHistory,
  };
  const queued = await queueRecoveryCandidates(
    ledger,
    plan,
    (requests) => observe(requests, observationOptions),
    {
      now: options.now,
      transactTaskLedger: options.transactTaskLedger,
    },
  );
  const delivered = await runRecoveryDeliveries(ledger, {
    now: options.now,
    leaseOwner: options.leaseOwner,
    leaseDurationMs: options.leaseDurationMs,
    limit: options.limit,
    transactTaskLedger: options.transactTaskLedger,
    observeTasks: observe,
    deliverMechanicalActions: options.deliverMechanicalActions,
    appServer: options.appServer,
    ...observationOptions,
  });

  return {
    state: delivered.state,
    recoveryCandidates: plan.candidates.map(
      ({ targetTaskId }) => targetTaskId,
    ),
    healthyTaskIds: plan.healthyTaskIds,
    waitingTaskIds: plan.waitingTaskIds,
    unresolvedRecoveryTaskIds: plan.unresolvedRecoveryTaskIds,
    degraded: plan.degraded,
    queuedTaskIds: queued.queuedTaskIds,
    protectedTaskIds: queued.protectedTaskIds,
    deliveredTaskIds: delivered.deliveredTaskIds,
    pendingTaskIds: delivered.pendingTaskIds,
    discarded: [...queued.discarded, ...delivered.discarded]
      .sort((left, right) =>
        left.taskId.localeCompare(right.taskId)
        || left.reason.localeCompare(right.reason)
      ),
  };
}

function requireLifecycleDeliveryOptions(options) {
  requireReconciliationOptions(options);
  if (
    typeof options.leaseOwner !== "string"
    || options.leaseOwner.length === 0
  ) {
    throw new TypeError(
      "Lifecycle delivery requires a lease owner.",
    );
  }
  const leaseDurationMs = options.leaseDurationMs ?? 5 * 60 * 1_000;
  const limit = options.limit ?? 8;
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new TypeError(
      "Lifecycle lease duration must be a positive integer.",
    );
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
    throw new TypeError(
      "Lifecycle delivery limit must be from 1 to 32.",
    );
  }
  return {
    leaseDurationMs,
    limit,
  };
}

function lifecycleDeliveryReason(forest, delivery, openLeaves) {
  const incomingLink = parentLink(forest, delivery.targetTaskId);
  if (
    !incomingLink
    || incomingLink.parentTaskId !== delivery.parentTaskId
  ) {
    return "relationship_changed";
  }
  if (delivery.kind === "interrupt") {
    return incomingLink.lifecycle === "open"
      ? "lifecycle_changed"
      : null;
  }
  if (incomingLink.lifecycle !== "open") {
    return "lifecycle_changed";
  }
  return openLeaves.has(delivery.targetTaskId)
    ? null
    : "position_changed";
}

function failedLifecycleOutcomes(deliveries, error) {
  return deliveries.map(({ id }) => ({
    deliveryId: id,
    status: "failed",
    error: {
      code: typeof error?.code === "string"
        ? error.code
        : "DELIVERY_FAILED",
      message: typeof error?.message === "string"
        ? error.message
        : "Lifecycle delivery failed.",
    },
  }));
}

export async function runLifecycleDeliveries(ledger, options) {
  if (
    !ledger
    || typeof ledger !== "object"
    || !("store" in ledger)
    || typeof ledger.project?.root !== "string"
  ) {
    throw new TypeError(
      "Lifecycle delivery requires a project ledger context.",
    );
  }
  const {
    leaseDurationMs,
    limit,
  } = requireLifecycleDeliveryOptions(options);
  const transact = options.transactTaskLedger ?? transactTaskLedger;
  const leaseExpiresAt = new Date(
    Date.parse(options.now) + leaseDurationMs,
  ).toISOString();
  const leaseTransaction = await transact(
    ledger.store,
    ledger.project,
    (state) => {
      const deliveryIds = state.deliveries
        .filter(({ kind }) => kind === "interrupt" || kind === "resume")
        .map(({ id }) => id);
      const leased = leaseDeliveries(state, {
        deliveryIds,
        leaseOwner: options.leaseOwner,
        leaseExpiresAt,
        limit,
        now: options.now,
      });
      return {
        state: leased.state,
        result: leased.leased,
      };
    },
    { now: options.now },
  );
  const leased = leaseTransaction.result;
  if (leased.length === 0) {
    return {
      state: leaseTransaction.state,
      deliveredTaskIds: [],
      pendingTaskIds: [],
      discarded: [],
    };
  }

  const revalidationTransaction = await transact(
    ledger.store,
    ledger.project,
    (state) => {
      const forest = buildTaskForest(state.links);
      const openLeaves = new Set(leafTaskIds(forest, {
        lifecycles: ["open"],
      }));
      const valid = [];
      const discarded = [];
      let nextState = state;

      for (const delivery of leased) {
        const reason = lifecycleDeliveryReason(
          forest,
          delivery,
          openLeaves,
        );
        if (reason !== null) {
          nextState = discardDelivery(
            nextState,
            delivery.id,
            options.leaseOwner,
            options.now,
          );
          discarded.push({
            taskId: delivery.targetTaskId,
            reason,
          });
          continue;
        }
        valid.push(
          nextState.deliveries.find(({ id }) => id === delivery.id),
        );
      }

      return {
        state: nextState,
        result: {
          valid,
          discarded: discarded.sort((left, right) =>
            left.taskId.localeCompare(right.taskId)
            || left.reason.localeCompare(right.reason)
          ),
        },
      };
    },
    { now: options.now },
  );
  const { valid, discarded } = revalidationTransaction.result;
  if (valid.length === 0) {
    return {
      state: revalidationTransaction.state,
      deliveredTaskIds: [],
      pendingTaskIds: [],
      discarded,
    };
  }

  const deliver = options.deliverMechanicalActions
    ?? deliverMechanicalActions;
  let outcomes;
  try {
    outcomes = await deliver(valid, {
      projectRoot: ledger.project.root,
      appServer: options.appServer,
      observeTasks: options.observeTasks,
      roots: options.roots,
      cachedPaths: options.cachedPaths,
      fileSystem: options.fileSystem,
      openHistory: options.openHistory,
    });
  } catch (error) {
    outcomes = failedLifecycleOutcomes(valid, error);
  }
  const outcomeByDeliveryId = new Map(
    outcomes.map((outcome) => [outcome.deliveryId, outcome]),
  );
  const outcomeTransaction = await transact(
    ledger.store,
    ledger.project,
    (state) => {
      let nextState = state;
      for (const delivery of valid) {
        const outcome = outcomeByDeliveryId.get(delivery.id)
          ?? failedLifecycleOutcomes(
            [delivery],
            new Error("Lifecycle delivery returned no outcome."),
          )[0];
        nextState = outcome.status === "delivered"
          ? acknowledgeDelivery(
              nextState,
              delivery.id,
              options.leaseOwner,
              options.now,
            )
          : releaseDelivery(
              nextState,
              delivery.id,
              options.leaseOwner,
              outcome.error,
              options.now,
            );
      }
      return {
        state: nextState,
        result: null,
      };
    },
    { now: options.now },
  );
  const deliveredTaskIds = [];
  const pendingTaskIds = [];
  for (const delivery of valid) {
    const current = outcomeTransaction.state.deliveries.find(
      ({ id }) => id === delivery.id,
    );
    if (current?.status === "delivered") {
      deliveredTaskIds.push(delivery.targetTaskId);
    } else {
      pendingTaskIds.push(delivery.targetTaskId);
    }
  }

  return {
    state: outcomeTransaction.state,
    deliveredTaskIds: deliveredTaskIds.sort(),
    pendingTaskIds: pendingTaskIds.sort(),
    discarded,
  };
}

function groupEvents(type, items, options = {}) {
  const idKey = options.idKey ?? "taskId";
  const idsKey = options.idsKey ?? "taskIds";
  const groups = new Map();

  for (const item of items) {
    const normalized = typeof item === "string"
      ? { [idKey]: item }
      : item;
    const reason = normalized.reason ?? null;
    const key = reason ?? "";
    const ids = groups.get(key) ?? new Set();
    ids.add(normalized[idKey]);
    groups.set(key, ids);
  }

  return [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, ids]) => {
      const allIds = [...ids].sort();
      const event = {
        type,
        [idsKey]: allIds.slice(0, 20),
      };
      if (reason.length > 0) {
        event.reason = reason;
      }
      if (allIds.length > 20) {
        event.omitted = allIds.length - 20;
      }
      return event;
    });
}

function requireHeartbeatReportInput(input) {
  if (
    !input
    || typeof input !== "object"
    || !input.state
    || !input.pendingLaunchPlan
    || !input.pendingLaunchResult
    || !input.archiveResult
    || !input.recoveryResult
    || !input.lifecycleResult
  ) {
    throw new TypeError(
      "Heartbeat report requires every pipeline phase result.",
    );
  }
}

export function buildHeartbeatReport(input) {
  requireHeartbeatReportInput(input);
  const {
    state,
    pendingLaunchPlan,
    pendingLaunchResult,
    archiveResult,
    recoveryResult,
    lifecycleResult,
    appMessageResult = { failedMessageIds: [] },
    deferredForkResult = {
      completedLaunchIds: [],
      failed: [],
    },
  } = input;
  const pendingDeliveryCount = state.deliveries.filter(
    ({ status }) => status !== "delivered",
  ).length;
  const stoppedTaskIds = new Set(
    state.links
      .filter(({ lifecycle }) => lifecycle === "stopped")
      .map(({ childTaskId }) => childTaskId),
  );
  const hasProblems = (
    pendingLaunchPlan.repairRequired.length > 0
    || pendingLaunchPlan.degraded.length > 0
    || pendingLaunchResult.discarded.length > 0
    || recoveryResult.degraded.length > 0
    || recoveryResult.unresolvedRecoveryTaskIds.length > 0
    || recoveryResult.pendingTaskIds.length > 0
    || lifecycleResult.pendingTaskIds.length > 0
    || appMessageResult.failedMessageIds.length > 0
    || deferredForkResult.failed.length > 0
  );
  const events = [
    ...groupEvents(
      "app_message_failed",
      appMessageResult.failedMessageIds,
      { idKey: "messageId", idsKey: "messageIds" },
    ),
    ...groupEvents(
      "archive_accepted",
      archiveResult.archivedTaskIds,
    ),
    ...groupEvents(
      "delivery_failed",
      [
        ...recoveryResult.pendingTaskIds,
        ...lifecycleResult.pendingTaskIds,
      ].map((taskId) => ({
        taskId,
        reason: "task_message_failed",
      })),
    ),
    ...groupEvents(
      "fork_failed",
      deferredForkResult.failed,
      { idKey: "launchId", idsKey: "launchIds" },
    ),
    ...groupEvents(
      "fork_ready",
      deferredForkResult.completedLaunchIds,
      { idKey: "launchId", idsKey: "launchIds" },
    ),
    ...groupEvents(
      "launch_promoted",
      pendingLaunchResult.promotedLaunchIds,
      { idKey: "launchId", idsKey: "launchIds" },
    ),
    ...groupEvents(
      "launch_repair_required",
      [
        ...pendingLaunchPlan.repairRequired,
        ...pendingLaunchPlan.degraded,
        ...pendingLaunchResult.discarded,
      ],
      { idKey: "launchId", idsKey: "launchIds" },
    ),
    ...groupEvents(
      "lifecycle_discarded",
      lifecycleResult.discarded,
    ),
    ...groupEvents(
      "lifecycle_sent",
      lifecycleResult.deliveredTaskIds,
    ),
    ...groupEvents(
      "recovery_degraded",
      recoveryResult.degraded,
    ),
    ...groupEvents(
      "recovery_discarded",
      recoveryResult.discarded,
    ),
    ...groupEvents(
      "recovery_queued",
      recoveryResult.queuedTaskIds,
    ),
    ...groupEvents(
      "recovery_sent",
      recoveryResult.deliveredTaskIds,
    ),
    ...groupEvents(
      "recovery_unresolved",
      recoveryResult.unresolvedRecoveryTaskIds,
    ),
  ];

  events.sort((left, right) =>
    left.type.localeCompare(right.type)
    || (left.reason ?? "").localeCompare(right.reason ?? "")
  );

  return {
    run: hasProblems ? "partial" : "ok",
    project: hasProblems
      ? "degraded"
      : hasPendingWork(state)
      ? "active"
      : "idle",
    summary: {
      pendingLaunches: state.pendingLaunches.length,
      activeConversations: state.conversations.filter(
        ({ responderTaskId, state: conversationState }) =>
          conversationState === "awaiting_reply"
          && !stoppedTaskIds.has(responderTaskId),
      ).length,
      openLinks: state.links.filter(
        ({ lifecycle }) => lifecycle === "open",
      ).length,
      stoppedLinks: state.links.filter(
        ({ lifecycle }) => lifecycle === "stopped",
      ).length,
      runningTasks: recoveryResult.healthyTaskIds.length,
      waitingTasks: recoveryResult.waitingTaskIds.length,
      recoveryCandidates:
        recoveryResult.recoveryCandidates.length,
      unresolvedRecoveries:
        recoveryResult.unresolvedRecoveryTaskIds.length,
      pendingDeliveries: pendingDeliveryCount,
      pendingAppMessages: state.appMessages.filter(
        ({ status }) =>
          status === "ready"
          || status === "leased"
          || status === "scheduled",
      ).length,
    },
    events,
  };
}

function requireHeartbeatInput(input) {
  if (
    !input
    || typeof input !== "object"
    || Array.isArray(input)
    || Object.keys(input).join(",") !== "projectRoot"
    || typeof input.projectRoot !== "string"
    || !path.isAbsolute(input.projectRoot)
  ) {
    throw new TypeError(
      "Heartbeat requires only an absolute projectRoot.",
    );
  }
  return {
    projectRoot: path.normalize(input.projectRoot),
  };
}

function requireNow(now) {
  const value = now();
  if (
    typeof value !== "string"
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new TypeError("Heartbeat now must return an ISO timestamp.");
  }
  return value;
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

function heartbeatDependencies(options) {
  return {
    resolveProject: options.resolveProject ?? resolveProject,
    assertRuntimeAvailable:
      options.assertRuntimeAvailable ?? assertRuntimeAvailable,
    observeHeartbeatTasks:
      options.observeHeartbeatTasks ?? observeHeartbeatTasks,
    planPendingLaunchReconciliation:
      options.planPendingLaunchReconciliation
      ?? planPendingLaunchReconciliation,
    reconcilePendingLaunches:
      options.reconcilePendingLaunches ?? reconcilePendingLaunches,
    runDeferredForks:
      options.runDeferredForks ?? runDeferredForks,
    reconcileArchiveTerminations:
      options.reconcileArchiveTerminations
      ?? reconcileArchiveTerminations,
    runHeartbeatRecovery:
      options.runHeartbeatRecovery ?? runHeartbeatRecovery,
    runLifecycleDeliveries:
      options.runLifecycleDeliveries ?? runLifecycleDeliveries,
    buildHeartbeatReport:
      options.buildHeartbeatReport ?? buildHeartbeatReport,
    reconcileAppMessageSchedules:
      options.reconcileAppMessageSchedules ?? reconcileAppMessageSchedules,
    now: options.now ?? (() => new Date().toISOString()),
    createLeaseOwner: options.createLeaseOwner ?? randomUUID,
  };
}

function defaultHeartbeatAppServer(project, options) {
  return new CodexAppServerClient({
    command: options.codexCommand,
    args: options.codexArgs,
    cwd: project.root,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
}

function defaultAppMessageAutomationRoot(options) {
  const codexHome = options.env?.CODEX_HOME
    ?? process.env.CODEX_HOME
    ?? path.join(os.homedir(), ".codex");
  return path.join(codexHome, "automations");
}

export async function runHeartbeat(input, options = {}) {
  const { projectRoot } = requireHeartbeatInput(input);
  const dependencies = heartbeatDependencies(options);
  const project = await dependencies.resolveProject(projectRoot);
  const store = options.store ?? new AtomicJsonStore(project.stateFile);
  const runtime = await dependencies.assertRuntimeAvailable(project, {
    store,
    roots: options.roots,
    sessionFileSystem: options.sessionFileSystem,
    openHistory: options.openHistory,
    heartbeatScript: options.heartbeatScript,
  });
  const ledger = {
    store,
    project,
  };
  const appServer = options.appServer
    ?? defaultHeartbeatAppServer(project, options);
  const leaseOwner = dependencies.createLeaseOwner();
  const observationOptions = {
    observeTasks: options.observeTasks,
    roots: options.roots,
    fileSystem: options.sessionFileSystem,
    openHistory: options.openHistory,
  };

  try {
    const appMessageResult = options.processAppMessages !== false
      && hasPendingAppMessages(runtime.ledger)
      ? await dependencies.reconcileAppMessageSchedules(
          ledger,
          {
            now: requireNow(dependencies.now),
            leaseOwner,
            leaseDurationMs: options.leaseDurationMs,
            limit: options.appMessageLimit,
            automationRoot: options.automationRoot
              ?? defaultAppMessageAutomationRoot(options),
            createAppMessageSchedule:
              options.createAppMessageSchedule,
            inspectAppMessageSchedule:
              options.inspectAppMessageSchedule,
            transactTaskLedger: options.transactTaskLedger,
          },
        )
      : {
          state: runtime.ledger,
          deliveredMessageIds: [],
          failedMessageIds: [],
          pendingMessageIds: [],
        };
    const initialObservation = await (
      dependencies.observeHeartbeatTasks(
        appMessageResult.state,
        {
          ...observationOptions,
          cachedPaths: cachedHistoryPaths(appMessageResult.state),
        },
      )
    );
    const pendingLaunchPlan = (
      dependencies.planPendingLaunchReconciliation(
        appMessageResult.state.pendingLaunches,
        [
          ...initialObservation.latestSnapshots,
          ...initialObservation.pendingLaunchSnapshots.map(
            ({ snapshot }) => snapshot,
          ),
        ],
      )
    );
    const deferredForkResult = await dependencies.runDeferredForks(
      ledger,
      pendingLaunchPlan,
      {
        state: appMessageResult.state,
        codexCommand: options.codexCommand,
        codexArgs: options.codexArgs,
        env: options.env,
        timeoutMs: options.timeoutMs,
        roots: options.roots,
        sessionFileSystem: options.sessionFileSystem,
        sessionOpenHistory: options.sessionOpenHistory,
        continueDeferredFork: options.continueDeferredFork,
        continuePendingRoleLaunch: options.continuePendingRoleLaunch,
        readTaskLedger: options.readTaskLedger,
      },
    );
    const pendingLaunchResult = await (
      dependencies.reconcilePendingLaunches(
        ledger,
        pendingLaunchPlan,
        {
          now: requireNow(dependencies.now),
          transactTaskLedger: options.transactTaskLedger,
        },
      )
    );
    const currentObservation = await (
      dependencies.observeHeartbeatTasks(
        pendingLaunchResult.state,
        {
          ...observationOptions,
          cachedPaths: cachedHistoryPaths(
            pendingLaunchResult.state,
          ),
        },
      )
    );
    const archiveResult = await (
      dependencies.reconcileArchiveTerminations(
        ledger,
        currentObservation.latestSnapshots,
        {
          now: requireNow(dependencies.now),
          transactTaskLedger: options.transactTaskLedger,
        },
      )
    );
    const lifecycleResult = await dependencies.runLifecycleDeliveries(
      ledger,
      {
        now: requireNow(dependencies.now),
        leaseOwner,
        leaseDurationMs: options.leaseDurationMs,
        limit: options.deliveryLimit,
        transactTaskLedger: options.transactTaskLedger,
        deliverMechanicalActions: options.deliverMechanicalActions,
        appServer,
        ...observationOptions,
        cachedPaths: cachedHistoryPaths(archiveResult.state),
      },
    );
    const postLifecycleObservation = await (
      dependencies.observeHeartbeatTasks(
        lifecycleResult.state,
        {
          ...observationOptions,
          cachedPaths: cachedHistoryPaths(lifecycleResult.state),
        },
      )
    );
    const recoveryResult = await dependencies.runHeartbeatRecovery(
      ledger,
      lifecycleResult.state,
      postLifecycleObservation.latestSnapshots,
      {
        now: requireNow(dependencies.now),
        leaseOwner,
        leaseDurationMs: options.leaseDurationMs,
        limit: options.deliveryLimit,
        transactTaskLedger: options.transactTaskLedger,
        deliverMechanicalActions: options.deliverMechanicalActions,
        appServer,
        ...observationOptions,
        cachedPaths: cachedHistoryPaths(lifecycleResult.state),
      },
    );
    const compacted = typeof store.transact === "function"
      ? await transactTaskLedger(
          store,
          project,
          (state) => ({
            state: compactTaskLedger(state),
            result: null,
          }),
          { now: requireNow(dependencies.now) },
        )
      : { state: recoveryResult.state };

    return dependencies.buildHeartbeatReport({
      state: compacted.state,
      pendingLaunchPlan,
      pendingLaunchResult,
      archiveResult,
      recoveryResult,
      lifecycleResult,
      appMessageResult,
      deferredForkResult,
    });
  } finally {
    if (typeof appServer.close === "function") {
      await Promise.resolve(appServer.close()).catch(() => {});
    }
  }
}
