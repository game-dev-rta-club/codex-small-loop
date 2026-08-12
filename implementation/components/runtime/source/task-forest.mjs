const LIFECYCLES = new Set(["open", "stopped", "accepted"]);

export class TaskForestError extends Error {
  constructor(code, message, taskIds = []) {
    super(message);
    this.name = "TaskForestError";
    this.code = code;
    this.taskIds = [...new Set(taskIds)].sort(compareTaskIds);
  }
}

function compareTaskIds(left, right) {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function compareLinks(left, right) {
  return (
    compareTaskIds(left.parentTaskId, right.parentTaskId)
    || compareTaskIds(left.childTaskId, right.childTaskId)
  );
}

function requireTaskId(taskId) {
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new TaskForestError(
      "TASK_ID_INVALID",
      "Task IDs must be non-empty strings.",
    );
  }

  return taskId;
}

function requireLifecycle(lifecycle, taskIds = []) {
  if (!LIFECYCLES.has(lifecycle)) {
    throw new TaskForestError(
      "TASK_LIFECYCLE_INVALID",
      "Task lifecycle must be open, stopped, or accepted.",
      taskIds,
    );
  }

  return lifecycle;
}

function lifecycleFilter(options, required = false) {
  const values = options?.lifecycles;

  if (values === undefined && !required) {
    return null;
  }

  if (!Array.isArray(values) && !(values instanceof Set)) {
    throw new TaskForestError(
      "TASK_LIFECYCLE_INVALID",
      "Lifecycle filters must be an array or set.",
    );
  }

  const filter = new Set();

  for (const lifecycle of values) {
    filter.add(requireLifecycle(lifecycle));
  }

  return filter;
}

function sortedLinks(links) {
  return [...links].sort(compareLinks);
}

function findCycleTaskIds(taskIds, childTaskIdsByParentTaskId) {
  const stateByTaskId = new Map();

  for (const startTaskId of taskIds) {
    if (stateByTaskId.get(startTaskId) === "visited") {
      continue;
    }

    const stack = [{
      taskId: startTaskId,
      nextChildIndex: 0,
    }];
    const stackIndexByTaskId = new Map();

    while (stack.length > 0) {
      const frame = stack.at(-1);

      if (!stateByTaskId.has(frame.taskId)) {
        stateByTaskId.set(frame.taskId, "visiting");
        stackIndexByTaskId.set(frame.taskId, stack.length - 1);
      }

      const children = childTaskIdsByParentTaskId.get(frame.taskId) ?? [];

      if (frame.nextChildIndex < children.length) {
        const childTaskId = children[frame.nextChildIndex];
        frame.nextChildIndex += 1;
        const childState = stateByTaskId.get(childTaskId);

        if (childState === "visiting") {
          const cycleStart = stackIndexByTaskId.get(childTaskId);
          return stack
            .slice(cycleStart)
            .map(({ taskId }) => taskId)
            .sort(compareTaskIds);
        }

        if (childState !== "visited") {
          stack.push({
            taskId: childTaskId,
            nextChildIndex: 0,
          });
        }

        continue;
      }

      stateByTaskId.set(frame.taskId, "visited");
      stackIndexByTaskId.delete(frame.taskId);
      stack.pop();
    }
  }

  return null;
}

export function buildTaskForest(links) {
  if (!Array.isArray(links)) {
    throw new TypeError("Task Forest links must be an array.");
  }

  const copiedLinks = links.map((sourceLink) => {
    const copiedLink = { ...sourceLink };
    const parentTaskId = requireTaskId(copiedLink.parentTaskId);
    const childTaskId = requireTaskId(copiedLink.childTaskId);

    if (parentTaskId === childTaskId) {
      throw new TaskForestError(
        "TASK_SELF_LINK",
        "A task cannot be its own child.",
        [parentTaskId],
      );
    }

    requireLifecycle(copiedLink.lifecycle, [parentTaskId, childTaskId]);
    return copiedLink;
  });

  copiedLinks.sort(compareLinks);

  const linkByChildTaskId = new Map();
  const childLinksByParentTaskId = new Map();
  const parentTaskIds = new Set();
  const childTaskIds = new Set();
  const allTaskIds = new Set();

  for (const currentLink of copiedLinks) {
    const existingLink = linkByChildTaskId.get(currentLink.childTaskId);

    if (existingLink) {
      throw new TaskForestError(
        "TASK_MULTIPLE_PARENTS",
        "A managed Child Task must have exactly one direct parent.",
        [
          existingLink.parentTaskId,
          currentLink.parentTaskId,
          currentLink.childTaskId,
        ],
      );
    }

    linkByChildTaskId.set(currentLink.childTaskId, currentLink);

    const children = childLinksByParentTaskId.get(currentLink.parentTaskId)
      ?? [];
    children.push(currentLink);
    childLinksByParentTaskId.set(currentLink.parentTaskId, children);

    parentTaskIds.add(currentLink.parentTaskId);
    childTaskIds.add(currentLink.childTaskId);
    allTaskIds.add(currentLink.parentTaskId);
    allTaskIds.add(currentLink.childTaskId);
  }

  for (const children of childLinksByParentTaskId.values()) {
    children.sort(compareLinks);
  }

  const childTaskIdsByParentTaskId = new Map(
    [...childLinksByParentTaskId].map(([parentTaskId, children]) => [
      parentTaskId,
      children.map(({ childTaskId }) => childTaskId),
    ]),
  );
  const orderedTaskIds = [...allTaskIds].sort(compareTaskIds);
  const cycleTaskIds = findCycleTaskIds(
    orderedTaskIds,
    childTaskIdsByParentTaskId,
  );

  if (cycleTaskIds) {
    throw new TaskForestError(
      "TASK_FOREST_CYCLE",
      "Task relationships must not contain a cycle.",
      cycleTaskIds,
    );
  }

  const roots = [...parentTaskIds]
    .filter((taskId) => !childTaskIds.has(taskId))
    .sort(compareTaskIds);

  return {
    links: copiedLinks,
    linkByChildTaskId,
    childLinksByParentTaskId,
    rootTaskIds: roots,
  };
}

export function rootTaskIds(forest) {
  return [...forest.rootTaskIds];
}

export function parentLink(forest, childTaskId) {
  requireTaskId(childTaskId);
  return forest.linkByChildTaskId.get(childTaskId) ?? null;
}

export function childLinks(forest, parentTaskId, options) {
  requireTaskId(parentTaskId);
  const filter = lifecycleFilter(options);
  const children = forest.childLinksByParentTaskId.get(parentTaskId) ?? [];

  if (filter === null) {
    return [...children];
  }

  return children.filter(({ lifecycle }) => filter.has(lifecycle));
}

function requireManagedBoundary(forest, taskId) {
  requireTaskId(taskId);

  if (
    !forest.linkByChildTaskId.has(taskId)
    && !forest.rootTaskIds.includes(taskId)
  ) {
    throw new TaskForestError(
      "TASK_NOT_MANAGED",
      "Task is not a managed child or represented root.",
      [taskId],
    );
  }
}

function collectSubtreeLinks(forest, taskId) {
  requireManagedBoundary(forest, taskId);

  const selectedLinks = [];
  const incomingLink = forest.linkByChildTaskId.get(taskId);

  if (incomingLink) {
    selectedLinks.push(incomingLink);
  }

  const stack = [taskId];
  const visitedTaskIds = new Set();

  while (stack.length > 0) {
    const currentTaskId = stack.pop();

    if (visitedTaskIds.has(currentTaskId)) {
      continue;
    }

    visitedTaskIds.add(currentTaskId);
    const children = forest.childLinksByParentTaskId.get(currentTaskId) ?? [];

    for (const currentLink of children) {
      selectedLinks.push(currentLink);
      stack.push(currentLink.childTaskId);
    }
  }

  return sortedLinks(selectedLinks);
}

export function subtreeLinks(forest, taskId, options) {
  const filter = lifecycleFilter(options);
  const selectedLinks = collectSubtreeLinks(forest, taskId);

  if (filter === null) {
    return selectedLinks;
  }

  return selectedLinks.filter(({ lifecycle }) => filter.has(lifecycle));
}

export function leafTaskIds(forest, options) {
  const filter = lifecycleFilter(options, true);
  const selectedLinks = options?.withinTaskId === undefined
    ? forest.links
    : collectSubtreeLinks(forest, options.withinTaskId);
  const includedLinks = selectedLinks.filter(
    ({ lifecycle }) => filter.has(lifecycle),
  );
  const candidateTaskIds = new Set(
    includedLinks.map(({ childTaskId }) => childTaskId),
  );
  const parentTaskIds = new Set(
    includedLinks.map(({ parentTaskId }) => parentTaskId),
  );

  return [...candidateTaskIds]
    .filter((taskId) => !parentTaskIds.has(taskId))
    .sort(compareTaskIds);
}
