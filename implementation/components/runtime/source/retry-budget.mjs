// Includes the first attempt; persisted counters survive runtime restarts.
export const MAX_OPERATION_ATTEMPTS = 50;
export function retryExhausted(operation) {
  return (operation.attemptCount ?? 0) >= MAX_OPERATION_ATTEMPTS;
}
export function exhaustedOperations(state) {
  return [
    ...state.pendingLaunches.filter(retryExhausted).map((x) => ({ kind: "launch", id: x.id, attemptCount: x.attemptCount })),
    ...state.deliveries.filter((x) => x.status !== "delivered" && retryExhausted(x)).map((x) => ({ kind: "delivery", id: x.id, attemptCount: x.attemptCount })),
    ...state.appMessages.filter((x) => ["ready", "leased"].includes(x.status) && retryExhausted(x)).map((x) => ({ kind: "appMessage", id: x.id, attemptCount: x.attemptCount })),
  ];
}
