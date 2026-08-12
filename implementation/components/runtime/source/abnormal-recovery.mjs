import { createHash } from "node:crypto";

import { deliverMechanicalActions } from "./task-messaging.mjs";
import {
  acknowledgeDelivery,
  discardDelivery,
  enqueueDeliveries,
  leaseDeliveries,
  releaseDelivery,
  transactTaskLedger,
} from "./task-ledger.mjs";
import { observeTasks } from "./task-state-observer.mjs";

const TERMINAL_TURN_STATES = new Set(["ended", "aborted"]);

function compareCandidates(left, right) {
  return left.targetTaskId.localeCompare(right.targetTaskId);
}

function compareDegraded(left, right) {
  return left.taskId.localeCompare(right.taskId);
}

function snapshotIndex(snapshots) {
  if (!Array.isArray(snapshots)) {
    throw new TypeError("Recovery snapshots must be an array.");
  }

  return new Map(
    snapshots.map((snapshot) => [snapshot.taskId, snapshot]),
  );
}

function deliveriesByDedupeKey(deliveries) {
  if (!Array.isArray(deliveries)) {
    throw new TypeError("Recovery deliveries must be an array.");
  }

  return new Map(
    deliveries
      .filter(({ dedupeKey }) => typeof dedupeKey === "string")
      .map((delivery) => [delivery.dedupeKey, delivery]),
  );
}

function recoveryOptions(options = {}) {
  if (!Array.isArray(options.appMessages ?? [])) {
    throw new TypeError("Recovery appMessages must be an array.");
  }
  if (!Array.isArray(options.stoppedTaskIds ?? [])) {
    throw new TypeError("Recovery stoppedTaskIds must be an array.");
  }
  return {
    appMessages: options.appMessages ?? [],
    stoppedTaskIds: options.stoppedTaskIds ?? [],
  };
}

function sourceMessages(appMessages, taskId, parentTaskId) {
  return appMessages.filter((message) =>
    message?.sourceTaskId === taskId
    && message.targetTaskId === parentTaskId
  );
}

function shouldDeferRecovery(
  parentSnapshot,
  messages,
) {
  if (messages.some(({ status }) =>
    status === "ready"
    || status === "leased"
    || status === "scheduled"
  )) {
    return true;
  }
  if (
    parentSnapshot?.location === "active"
    && parentSnapshot.turnState === "in_progress"
  ) {
    return true;
  }
  return false;
}

function hasPendingResume(deliveries, taskId) {
  return deliveries.some((delivery) =>
    delivery?.kind === "resume"
    && delivery.targetTaskId === taskId
    && (delivery.status === "ready" || delivery.status === "leased")
  );
}

function degradedReason(snapshot) {
  if (!snapshot || snapshot.location === "missing") {
    return "observation_missing";
  }

  if (snapshot.location !== "active") {
    return "observation_unavailable";
  }

  if (snapshot.turnState === "not_started") {
    return "turn_not_started";
  }

  if (snapshot.turnState === "unknown") {
    return "turn_unknown";
  }

  if (
    (snapshot.turnState === "in_progress"
      || TERMINAL_TURN_STATES.has(snapshot.turnState))
    && (
      typeof snapshot.latestTurnId !== "string"
      || snapshot.latestTurnId.length === 0
    )
  ) {
    return "turn_id_missing";
  }

  return "turn_state_unsupported";
}

function activeConversationView(conversations, stoppedTaskIds = []) {
  if (!Array.isArray(conversations)) {
    throw new TypeError("Recovery conversations must be an array.");
  }
  const stopped = new Set(stoppedTaskIds);
  const active = conversations.filter(
    ({ state, responderTaskId }) =>
      state === "awaiting_reply" && !stopped.has(responderTaskId),
  );
  const initiatorTaskIds = new Set(
    active.map(({ initiatorTaskId }) => initiatorTaskId),
  );
  return {
    active,
    leafConversations: active.filter(
      ({ responderTaskId }) => !initiatorTaskIds.has(responderTaskId),
    ),
    waitingTaskIds: [
      ...new Set(
        active
          .filter(
            ({ responderTaskId }) => initiatorTaskIds.has(responderTaskId),
          )
          .map(({ responderTaskId }) => responderTaskId),
      ),
    ].sort(),
  };
}

function recoveryActionId(candidate) {
  const digest = createHash("sha256")
    .update(candidate.dedupeKey)
    .digest("hex");
  return `recovery:${digest}`;
}

function sameRecoveryBoundary(candidate, snapshot) {
  return snapshot?.taskId === candidate.targetTaskId
    && snapshot.location === "active"
    && snapshot.latestTurnId === candidate.observedTurnId
    && snapshot.turnState === candidate.observedTurnState
    && TERMINAL_TURN_STATES.has(snapshot.turnState);
}

function compareDiscarded(left, right) {
  return left.taskId.localeCompare(right.taskId)
    || left.reason.localeCompare(right.reason);
}

function requireQueueInputs(ledger, initialPlan, observations, options) {
  if (
    !ledger
    || typeof ledger !== "object"
    || !("store" in ledger)
    || !("project" in ledger)
  ) {
    throw new TypeError(
      "Recovery queueing requires store and project.",
    );
  }

  if (!initialPlan || !Array.isArray(initialPlan.candidates)) {
    throw new TypeError("Recovery queueing requires a candidate plan.");
  }

  if (typeof observations !== "function") {
    throw new TypeError("Recovery observations must be a function.");
  }

  if (
    !options
    || typeof options !== "object"
    || typeof options.now !== "string"
    || Number.isNaN(Date.parse(options.now))
    || new Date(options.now).toISOString() !== options.now
  ) {
    throw new TypeError("Recovery queueing requires an ISO now timestamp.");
  }
}

function requireDeliveryRunInputs(ledger, options) {
  if (
    !ledger
    || typeof ledger !== "object"
    || !("store" in ledger)
    || !("project" in ledger)
    || typeof ledger.project?.root !== "string"
  ) {
    throw new TypeError(
      "Recovery delivery requires a project ledger context.",
    );
  }

  if (
    !options
    || typeof options !== "object"
    || typeof options.now !== "string"
    || Number.isNaN(Date.parse(options.now))
    || new Date(options.now).toISOString() !== options.now
    || typeof options.leaseOwner !== "string"
    || options.leaseOwner.length === 0
  ) {
    throw new TypeError(
      "Recovery delivery requires now and leaseOwner.",
    );
  }

  const leaseDurationMs = options.leaseDurationMs ?? 5 * 60 * 1_000;
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new TypeError("leaseDurationMs must be a positive integer.");
  }

  const limit = options.limit ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
    throw new TypeError("Recovery delivery limit must be from 1 to 32.");
  }

  return {
    leaseDurationMs,
    limit,
  };
}

function currentRecoveryPosition(state, delivery) {
  const stoppedTaskIds = state.links
    .filter(({ lifecycle }) => lifecycle === "stopped")
    .map(({ childTaskId }) => childTaskId);
  const view = activeConversationView(
    state.conversations,
    stoppedTaskIds,
  );
  const conversation = view.active.find((candidate) =>
    candidate.id === delivery.conversationId
    &&
    candidate.initiatorTaskId === delivery.parentTaskId
    && candidate.responderTaskId === delivery.targetTaskId
  );
  if (!conversation) {
    return "relationship_changed";
  }
  if (
    !view.leafConversations.some(
      ({ id }) => id === conversation.id,
    )
  ) {
    return "position_changed";
  }

  return null;
}

function failedOutcomes(deliveries, error) {
  return deliveries.map(({ id }) => ({
    deliveryId: id,
    status: "failed",
    error: {
      code: typeof error?.code === "string"
        ? error.code
        : "DELIVERY_FAILED",
      message: typeof error?.message === "string"
        ? error.message
        : "Recovery delivery failed.",
    },
  }));
}

function validTurnId(value) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 1_024;
}

export function planRecoveryCandidates(
  conversations,
  snapshots,
  deliveries,
  options = {},
) {
  const normalizedOptions = recoveryOptions(options);
  const snapshotsByTaskId = snapshotIndex(snapshots);
  const deliveryByDedupeKey = deliveriesByDedupeKey(deliveries);
  const view = activeConversationView(
    conversations,
    normalizedOptions.stoppedTaskIds,
  );
  const candidates = [];
  const healthyTaskIds = [];
  const degraded = [];
  const deferredTaskIds = new Set();
  const unresolvedRecoveryTaskIds = [];

  for (const conversation of view.leafConversations) {
    const taskId = conversation.responderTaskId;
    const snapshot = snapshotsByTaskId.get(taskId);

    if (snapshot?.location === "archived") {
      continue;
    }

    if (
      snapshot?.location === "active"
      && snapshot.turnState === "in_progress"
      && typeof snapshot.latestTurnId === "string"
      && snapshot.latestTurnId.length > 0
    ) {
      healthyTaskIds.push(taskId);
      continue;
    }

    if (
      snapshot?.location === "active"
      && TERMINAL_TURN_STATES.has(snapshot.turnState)
      && typeof snapshot.latestTurnId === "string"
      && snapshot.latestTurnId.length > 0
    ) {
      if (hasPendingResume(deliveries, taskId)) {
        deferredTaskIds.add(taskId);
        continue;
      }
      const messages = sourceMessages(
        normalizedOptions.appMessages,
        taskId,
        conversation.initiatorTaskId,
      );
      if (shouldDeferRecovery(
        snapshotsByTaskId.get(conversation.initiatorTaskId),
        messages,
      )) {
        deferredTaskIds.add(taskId);
        continue;
      }
      const dedupeKey =
        `recovery:${taskId}:${snapshot.latestTurnId}`;
      const existingDelivery = deliveryByDedupeKey.get(dedupeKey);

      if (!existingDelivery) {
        candidates.push({
          targetTaskId: taskId,
          parentTaskId: conversation.initiatorTaskId,
          conversationId: conversation.id,
          observedTurnId: snapshot.latestTurnId,
          observedTurnState: snapshot.turnState,
          dedupeKey,
        });
      } else if (existingDelivery.status === "delivered") {
        unresolvedRecoveryTaskIds.push(taskId);
      } else {
        deferredTaskIds.add(taskId);
      }

      continue;
    }

    degraded.push({
      taskId,
      reason: degradedReason(snapshot),
    });
  }

  candidates.sort(compareCandidates);
  healthyTaskIds.sort();
  unresolvedRecoveryTaskIds.sort();
  degraded.sort(compareDegraded);

  return {
    candidates,
    healthyTaskIds,
    waitingTaskIds: [
      ...new Set([...view.waitingTaskIds, ...deferredTaskIds]),
    ].sort(),
    unresolvedRecoveryTaskIds,
    degraded,
  };
}

export async function queueRecoveryCandidates(
  ledger,
  initialPlan,
  observations,
  options,
) {
  requireQueueInputs(ledger, initialPlan, observations, options);
  recoveryOptions();
  const candidates = [...initialPlan.candidates]
    .sort(compareCandidates);
  const requests = [
    ...new Set(candidates.flatMap((candidate) => [
      candidate.targetTaskId,
      candidate.parentTaskId,
    ])),
  ].map((taskId) => ({
    taskId,
    mode: "latest",
  }));
  const snapshots = requests.length === 0
    ? []
    : await observations(requests);
  const snapshotsByTaskId = snapshotIndex(snapshots);
  const queueable = [];
  const discardedBeforeLock = [];

  for (const candidate of candidates) {
    if (
      sameRecoveryBoundary(
        candidate,
        snapshotsByTaskId.get(candidate.targetTaskId),
      )
    ) {
      queueable.push(candidate);
    } else {
      discardedBeforeLock.push({
        taskId: candidate.targetTaskId,
        reason: "turn_changed",
      });
    }
  }

  const transact = options.transactTaskLedger ?? transactTaskLedger;
  const transaction = await transact(
    ledger.store,
    ledger.project,
    (state) => {
      const existingKeys = new Set(
        state.deliveries.map(({ dedupeKey }) => dedupeKey),
      );
      const actions = [];
      const queuedTaskIds = [];
      const protectedTaskIds = [];
      const discarded = [...discardedBeforeLock];

      for (const candidate of queueable) {
        if (existingKeys.has(candidate.dedupeKey)) {
          protectedTaskIds.push(candidate.targetTaskId);
          continue;
        }

        const position = currentRecoveryPosition(
          state,
          candidate,
        );
        if (position === "relationship_changed") {
          discarded.push({
            taskId: candidate.targetTaskId,
            reason: "relationship_changed",
          });
          continue;
        }
        if (position === "position_changed") {
          discarded.push({
            taskId: candidate.targetTaskId,
            reason: "position_changed",
          });
          continue;
        }

        const currentMessages = sourceMessages(
          state.appMessages,
          candidate.targetTaskId,
          candidate.parentTaskId,
        );
        if (
          hasPendingResume(state.deliveries, candidate.targetTaskId)
          || shouldDeferRecovery(
            snapshotsByTaskId.get(candidate.parentTaskId),
            currentMessages,
          )
        ) {
          discarded.push({
            taskId: candidate.targetTaskId,
            reason: "activity_changed",
          });
          continue;
        }

        actions.push({
          id: recoveryActionId(candidate),
          kind: "recovery",
          targetTaskId: candidate.targetTaskId,
          parentTaskId: candidate.parentTaskId,
          operationId: null,
          observedTurnId: candidate.observedTurnId,
          conversationId: candidate.conversationId,
        });
        queuedTaskIds.push(candidate.targetTaskId);
      }

      const enqueued = enqueueDeliveries(state, actions, {
        now: options.now,
      });

      return {
        state: enqueued.state,
        result: {
          queuedTaskIds: queuedTaskIds.sort(),
          protectedTaskIds: protectedTaskIds.sort(),
          discarded: discarded.sort(compareDiscarded),
        },
      };
    },
    { now: options.now },
  );

  return {
    state: transaction.state,
    ...transaction.result,
  };
}

export async function runRecoveryDeliveries(ledger, options) {
  const {
    leaseDurationMs,
    limit,
  } = requireDeliveryRunInputs(ledger, options);
  const transact = options.transactTaskLedger ?? transactTaskLedger;
  const observe = options.observeTasks ?? observeTasks;
  const deliver = options.deliverMechanicalActions
    ?? deliverMechanicalActions;
  const leaseExpiresAt = new Date(
    Date.parse(options.now) + leaseDurationMs,
  ).toISOString();
  const leaseTransaction = await transact(
    ledger.store,
    ledger.project,
    (state) => {
      const recoveryDeliveryIds = state.deliveries
        .filter(({ kind }) => kind === "recovery")
        .map(({ id }) => id);
      const leased = leaseDeliveries(state, {
        deliveryIds: recoveryDeliveryIds,
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

  const snapshots = await observe(
    leased.map(({ targetTaskId }) => ({
      taskId: targetTaskId,
      mode: "latest",
    })),
    {
      roots: options.roots,
      cachedPaths: options.cachedPaths,
      fileSystem: options.fileSystem,
      openHistory: options.openHistory,
    },
  );
  const snapshotsByTaskId = snapshotIndex(snapshots);
  const revalidationTransaction = await transact(
    ledger.store,
    ledger.project,
    (state) => {
      const valid = [];
      const discarded = [];
      let nextState = state;

      for (const delivery of leased) {
        const candidate = {
          targetTaskId: delivery.targetTaskId,
          observedTurnId: delivery.observedTurnId,
          observedTurnState:
            snapshotsByTaskId.get(delivery.targetTaskId)?.turnState,
        };
        const snapshot = snapshotsByTaskId.get(delivery.targetTaskId);
        let reason = sameRecoveryBoundary(candidate, snapshot)
          ? null
          : "turn_changed";

        if (reason === null) {
          reason = currentRecoveryPosition(state, delivery);
        }

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
          discarded: discarded.sort(compareDiscarded),
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

  let outcomes;
  try {
    outcomes = await deliver(valid, {
      projectRoot: ledger.project.root,
      appServer: options.appServer,
      observeTasks: observe,
      roots: options.roots,
      cachedPaths: options.cachedPaths,
      fileSystem: options.fileSystem,
      openHistory: options.openHistory,
    });
  } catch (error) {
    outcomes = failedOutcomes(valid, error);
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
          ?? failedOutcomes(
            [delivery],
            new Error("Recovery delivery returned no outcome."),
          )[0];
        nextState = outcome.status === "delivered"
          && validTurnId(outcome.turnId)
          ? acknowledgeDelivery(
              nextState,
              delivery.id,
              options.leaseOwner,
              options.now,
              { resultTurnId: outcome.turnId },
            )
          : releaseDelivery(
              nextState,
              delivery.id,
              options.leaseOwner,
              outcome.error ?? {
                code: "DELIVERY_RESPONSE_INVALID",
                message: "Recovery delivery returned no valid Turn ID.",
              },
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
