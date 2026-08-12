import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskForest,
  childLinks,
  leafTaskIds,
  parentLink,
  rootTaskIds,
  subtreeLinks,
} from "../source/task-forest.mjs";

function link(parentTaskId, childTaskId, lifecycle = "open", extra = {}) {
  return {
    parentTaskId,
    childTaskId,
    lifecycle,
    ...extra,
  };
}

function pairs(links) {
  return links.map(({ parentTaskId, childTaskId, lifecycle }) =>
    `${parentTaskId}->${childTaskId}:${lifecycle}`
  );
}

function expectTaskForestError(run, code, taskIds = []) {
  assert.throws(run, (error) => {
    assert.equal(error.code, code);

    for (const taskId of taskIds) {
      assert.ok(
        error.taskIds?.includes(taskId),
        `${code} should identify ${taskId}`,
      );
    }

    return true;
  });
}

test("builds an empty forest", () => {
  const forest = buildTaskForest([]);

  assert.deepEqual(forest.links, []);
  assert.deepEqual(rootTaskIds(forest), []);
  assert.equal(parentLink(forest, "missing"), null);
  assert.deepEqual(childLinks(forest, "missing"), []);
  assert.deepEqual(leafTaskIds(forest, { lifecycles: ["open"] }), []);
});

test("builds deterministic indexes for multiple roots and parallel children", () => {
  const input = [
    link("B", "B2"),
    link("A", "A2", "stopped"),
    link("B", "B1", "accepted"),
    link("A", "A1", "open", { createdAt: "retained" }),
  ];
  const original = structuredClone(input);

  const forest = buildTaskForest(input);

  assert.deepEqual(pairs(forest.links), [
    "A->A1:open",
    "A->A2:stopped",
    "B->B1:accepted",
    "B->B2:open",
  ]);
  assert.deepEqual(rootTaskIds(forest), ["A", "B"]);
  assert.deepEqual(
    childLinks(forest, "A").map(({ childTaskId }) => childTaskId),
    ["A1", "A2"],
  );
  assert.equal(parentLink(forest, "A1")?.parentTaskId, "A");
  assert.equal(parentLink(forest, "A1")?.createdAt, "retained");
  assert.equal(parentLink(forest, "A"), null);
  assert.deepEqual(input, original);
});

test("filters direct children by lifecycle without mutating indexes", () => {
  const forest = buildTaskForest([
    link("A", "A1", "open"),
    link("A", "A2", "stopped"),
    link("A", "A3", "accepted"),
  ]);

  assert.deepEqual(
    childLinks(forest, "A", { lifecycles: ["stopped", "open"] })
      .map(({ childTaskId }) => childTaskId),
    ["A1", "A2"],
  );
  assert.deepEqual(
    childLinks(forest, "A", { lifecycles: [] }),
    [],
  );
  assert.deepEqual(
    childLinks(forest, "A").map(({ childTaskId }) => childTaskId),
    ["A1", "A2", "A3"],
  );
});

test("selects root and managed-child subtrees without crossing boundaries", () => {
  const forest = buildTaskForest([
    link("A", "A1"),
    link("A", "A2"),
    link("A1", "A1a"),
    link("A1", "A1b", "stopped"),
    link("B", "B1"),
  ]);

  assert.deepEqual(pairs(subtreeLinks(forest, "A")), [
    "A->A1:open",
    "A->A2:open",
    "A1->A1a:open",
    "A1->A1b:stopped",
  ]);
  assert.deepEqual(pairs(subtreeLinks(forest, "A1")), [
    "A->A1:open",
    "A1->A1a:open",
    "A1->A1b:stopped",
  ]);
  assert.deepEqual(pairs(subtreeLinks(forest, "A2")), [
    "A->A2:open",
  ]);
  assert.deepEqual(pairs(subtreeLinks(forest, "B")), [
    "B->B1:open",
  ]);
});

test("traverses excluded historical links when filtering a subtree", () => {
  const forest = buildTaskForest([
    link("A", "A1", "accepted"),
    link("A1", "A1a", "open"),
    link("A1", "A1b", "stopped"),
  ]);

  assert.deepEqual(
    pairs(subtreeLinks(forest, "A", { lifecycles: ["open"] })),
    ["A1->A1a:open"],
  );
});

test("finds every unfinished leaf across parallel roots", () => {
  const forest = buildTaskForest([
    link("A", "A1", "open"),
    link("A1", "A1a", "stopped"),
    link("A1", "A1b", "accepted"),
    link("A", "A2", "open"),
    link("A2", "A2a", "accepted"),
    link("B", "B1", "open"),
    link("B", "B2", "open"),
  ]);

  assert.deepEqual(
    leafTaskIds(forest, { lifecycles: ["open", "stopped"] }),
    ["A1a", "A2", "B1", "B2"],
  );
  assert.deepEqual(
    leafTaskIds(forest, { lifecycles: ["open"] }),
    ["A1", "A2", "B1", "B2"],
  );
});

test("limits leaf selection to one root or managed child", () => {
  const forest = buildTaskForest([
    link("A", "A1"),
    link("A", "A2"),
    link("A1", "A1a"),
    link("A1", "A1b"),
    link("B", "B1"),
  ]);

  assert.deepEqual(
    leafTaskIds(forest, { withinTaskId: "A", lifecycles: ["open"] }),
    ["A1a", "A1b", "A2"],
  );
  assert.deepEqual(
    leafTaskIds(forest, { withinTaskId: "A1", lifecycles: ["open"] }),
    ["A1a", "A1b"],
  );
  assert.deepEqual(
    leafTaskIds(forest, { withinTaskId: "B1", lifecycles: ["open"] }),
    ["B1"],
  );
});

test("rejects malformed task identifiers", () => {
  for (const value of [null, undefined, "", "   ", 42]) {
    expectTaskForestError(
      () => buildTaskForest([link(value, "child")]),
      "TASK_ID_INVALID",
    );
    expectTaskForestError(
      () => buildTaskForest([link("parent", value)]),
      "TASK_ID_INVALID",
    );
  }
});

test("rejects self-links and duplicate child ownership", () => {
  expectTaskForestError(
    () => buildTaskForest([link("A", "A")]),
    "TASK_SELF_LINK",
    ["A"],
  );
  expectTaskForestError(
    () => buildTaskForest([
      link("A", "child"),
      link("B", "child"),
    ]),
    "TASK_MULTIPLE_PARENTS",
    ["A", "B", "child"],
  );
});

test("rejects unknown lifecycle values in links and filters", () => {
  expectTaskForestError(
    () => buildTaskForest([link("A", "A1", "running")]),
    "TASK_LIFECYCLE_INVALID",
    ["A", "A1"],
  );

  const forest = buildTaskForest([link("A", "A1")]);

  expectTaskForestError(
    () => childLinks(forest, "A", { lifecycles: ["running"] }),
    "TASK_LIFECYCLE_INVALID",
  );
  expectTaskForestError(
    () => leafTaskIds(forest, { lifecycles: ["running"] }),
    "TASK_LIFECYCLE_INVALID",
  );
});

test("detects cycles in every connected component", () => {
  expectTaskForestError(
    () => buildTaskForest([
      link("A", "A1"),
      link("X", "Y"),
      link("Y", "Z"),
      link("Z", "X"),
    ]),
    "TASK_FOREST_CYCLE",
    ["X", "Y", "Z"],
  );
});

test("rejects an unmanaged subtree or leaf boundary", () => {
  const forest = buildTaskForest([link("A", "A1")]);

  expectTaskForestError(
    () => subtreeLinks(forest, "missing"),
    "TASK_NOT_MANAGED",
    ["missing"],
  );
  expectTaskForestError(
    () => leafTaskIds(forest, {
      withinTaskId: "missing",
      lifecycles: ["open"],
    }),
    "TASK_NOT_MANAGED",
    ["missing"],
  );
});

test("uses iterative traversal for deeply nested tasks", () => {
  const links = [];

  for (let index = 0; index < 5_000; index += 1) {
    links.push(link(`task-${index}`, `task-${index + 1}`));
  }

  const forest = buildTaskForest(links);

  assert.deepEqual(rootTaskIds(forest), ["task-0"]);
  assert.equal(subtreeLinks(forest, "task-0").length, 5_000);
  assert.deepEqual(
    leafTaskIds(forest, { lifecycles: ["open"] }),
    ["task-5000"],
  );
});

test("does not mutate frozen caller input while building or querying", () => {
  const input = [
    Object.freeze(link("A", "A1", "open", { marker: "one" })),
    Object.freeze(link("A1", "A1a", "stopped", { marker: "two" })),
  ];
  Object.freeze(input);

  const forest = buildTaskForest(input);

  rootTaskIds(forest);
  parentLink(forest, "A1");
  childLinks(forest, "A", { lifecycles: ["open"] });
  subtreeLinks(forest, "A");
  leafTaskIds(forest, { lifecycles: ["open", "stopped"] });

  assert.deepEqual(input, [
    link("A", "A1", "open", { marker: "one" }),
    link("A1", "A1a", "stopped", { marker: "two" }),
  ]);
});
