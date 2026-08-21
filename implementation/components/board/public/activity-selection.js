export function createActivitySelection({ loadDetail, begin, commit, fail }) {
  let generation = 0;

  const isCurrent = (request) => request.generation === generation;

  return {
    invalidate() {
      generation += 1;
    },

    async select(activityId) {
      const request = { activityId, generation: generation + 1 };
      generation = request.generation;
      begin(activityId);
      try {
        const detail = await loadDetail(activityId);
        if (!isCurrent(request)) return { status: "stale" };
        commit(activityId, detail);
        return { status: "committed" };
      } catch (error) {
        if (!isCurrent(request)) return { status: "stale" };
        fail(activityId, error);
        return { status: "failed", error };
      }
    },
  };
}

export function emptyActivityMessage(data) {
  return data.partial
    ? "Partial · no verified Activity history is currently available. Available records may be incomplete; use Refresh to retry."
    : "No verified Codex Small Loop Primary Activities were found for this project.";
}

export function conversationFocusMatches(dataset, activity) {
  return Boolean(activity?.conversationId && activity?.transition
    && dataset?.conversationId === activity.conversationId
    && dataset?.transition === activity.transition);
}

export function conversationNavigationTarget(agents, activity) {
  if (!activity?.counterpartyAvailable || !activity?.counterpartyTaskId || !Array.isArray(agents)) return null;
  const agent = agents.find((item) => item.id === activity.counterpartyTaskId);
  if (!agent || !Array.isArray(agent.activity)) return null;
  const target = agent.activity.find((candidate) => candidate.kind === "conversation"
    && candidate.conversationId === activity.conversationId
    && candidate.transition === activity.transition
    && candidate.counterpartyTaskId === activity.taskId
    && candidate.direction !== activity.direction);
  return target ? { agentId: agent.id, activity: target } : null;
}

export function conversationReadingKey(agentId, activity) {
  if (!agentId || !activity?.conversationId || !activity?.transition) return null;
  return JSON.stringify([agentId, activity.conversationId, activity.transition]);
}

export function readingFocusDescriptor(element) {
  if (element?.id === "agents-tab" || element?.id === "signals-tab") return { id: element.id };
  const kind = element?.dataset?.readingFocusKind;
  const key = element?.dataset?.readingFocusKey;
  return kind && key ? { kind, key } : null;
}

export function readingFocusCandidates(focus, selectedAgentId) {
  if (focus?.id) return [{ id: focus.id }];
  if (!focus?.kind || !focus?.key) return [];
  const exact = { kind: focus.kind, key: focus.key };
  if (focus.kind === "cycle") return [exact, { id: "timeline" }];
  if (focus.kind === "conversation-control") return [
    exact,
    { kind: "conversation-entry", key: focus.key },
    ...(selectedAgentId ? [{ kind: "agent", key: selectedAgentId }] : []),
    { id: "agents-tab" },
  ];
  if (focus.kind === "conversation-entry") return [
    exact,
    ...(selectedAgentId ? [{ kind: "agent", key: selectedAgentId }] : []),
    { id: "agents-tab" },
  ];
  if (focus.kind === "agent") return [exact, { id: "agents-tab" }];
  if (focus.kind === "signal") return [exact, { id: "signals-tab" }];
  return [];
}

export function restoreDeferredReadingFocus({ activityId, currentActivityId, hasDetail, restoreScroll,
  focusDisplaced, resolveTarget }) {
  if (!hasDetail || activityId !== currentActivityId) return "stale";
  restoreScroll();
  if (!focusDisplaced()) return "focus-preserved";
  const target = resolveTarget();
  if (!target) return "target-missing";
  target.focus({ preventScroll: true });
  return "restored";
}

export function createActivityListLoader({ loadActivities, begin, commitActivities, selectActivity, showEmpty, fail, preferredActivityId }) {
  let generation = 0;
  return async function load() {
    const current = ++generation;
    begin();
    try {
      const data = await loadActivities();
      if (current !== generation) return { status: "stale" };
      commitActivities(data);
      if (data.activities.length > 0) {
        const preferred = preferredActivityId();
        const selected = preferred && data.activities.some((activity) => activity.id === preferred)
          ? preferred : data.activities[0].id;
        await selectActivity(selected);
      } else {
        showEmpty(data, emptyActivityMessage(data));
      }
      return { status: "committed" };
    } catch (error) {
      if (current !== generation) return { status: "stale" };
      fail(error);
      return { status: "failed", error };
    }
  };
}
