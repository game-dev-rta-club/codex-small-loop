import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadWorkGraph, SonnerWorkGraphError } from "../source/sonner.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-sonner-graph-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeWork(root, folder, { id = folder, type, keyPoints, inputs = [] }) {
  const directory = path.join(root, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, ".WORK_NODE.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<work-node id="${id}" type="${type}">
  <keyPoints>${keyPoints}</keyPoints>
  <inputs>
${inputs.map((input) => `    <input ref="${input}" />\n`).join("")}  </inputs>
</work-node>
`);
}

async function rejection(root, pattern) {
  await assert.rejects(
    loadWorkGraph(root),
    (error) => error instanceof SonnerWorkGraphError
      && error.code === "INVALID_GRAPH"
      && pattern.test(error.message),
  );
}

test("orders an Overview-rooted graph deterministically across branches and merges", async (t) => {
  const root = await fixture(t);
  await writeWork(root, "distribution", { type: "Distribution", keyPoints: "Ships the verified result.", inputs: ["verification", "guide"] });
  await writeWork(root, "overview", { type: "Overview", keyPoints: "Defines the outcome." });
  await writeWork(root, "verification", { type: "Verification", keyPoints: "Proves the result.", inputs: ["implementation"] });
  await writeWork(root, "guide", { type: "Guide", keyPoints: "Explains the result.", inputs: ["overview", "implementation"] });
  await writeWork(root, "implementation", { type: "Implementation", keyPoints: "Realizes the result.", inputs: ["overview"] });

  const first = await loadWorkGraph(root);
  const second = await loadWorkGraph(root);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(({ id, nodePath }) => ({ id, nodePath })), [
    { id: "overview", nodePath: "overview/.WORK_NODE.xml" },
    { id: "implementation", nodePath: "implementation/.WORK_NODE.xml" },
    { id: "guide", nodePath: "guide/.WORK_NODE.xml" },
    { id: "verification", nodePath: "verification/.WORK_NODE.xml" },
    { id: "distribution", nodePath: "distribution/.WORK_NODE.xml" },
  ]);
});

test("discovers nested Works, ignores generated roots, and decodes XML entities", async (t) => {
  const root = await fixture(t);
  await writeWork(root, ".git/stale", { id: "stale", type: "Overview", keyPoints: "Ignored." });
  await writeWork(root, "overview", { type: "Overview", keyPoints: "Defines &amp; constrains." });
  await writeWork(root, "components/implementation", { id: "implementation", type: "Implementation", keyPoints: "Realizes &#x41;.", inputs: ["overview"] });
  const works = await loadWorkGraph(root);
  assert.deepEqual(works.map(({ id, keyPoints, nodePath }) => ({ id, keyPoints, nodePath })), [
    { id: "overview", keyPoints: "Defines & constrains.", nodePath: "overview/.WORK_NODE.xml" },
    { id: "implementation", keyPoints: "Realizes A.", nodePath: "components/implementation/.WORK_NODE.xml" },
  ]);
});

test("rejects malformed metadata and allows Work IDs independent of directory names", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "overview"));
  await writeFile(path.join(root, "overview", ".WORK_NODE.xml"), "<work-node><keyPoints>Broken</keyPoints></work-node>\n");
  await rejection(root, /overview\/\.WORK_NODE\.xml.*id.*attribute/i);

  await rm(path.join(root, "overview"), { recursive: true });
  await writeWork(root, "system", {
    id: "system-specification",
    type: "SystemSpecification",
    keyPoints: "Defines the system.",
    inputs: ["overview"],
  });
  await writeWork(root, "overview", { type: "Overview", keyPoints: "Root." });
  const works = await loadWorkGraph(root);
  assert.deepEqual(
    works.map(({ id, nodePath }) => ({ id, nodePath })),
    [
      { id: "overview", nodePath: "overview/.WORK_NODE.xml" },
      { id: "system-specification", nodePath: "system/.WORK_NODE.xml" },
    ],
  );
});

test("requires Work keyPoints without interpreting summary as an alias", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "overview"));
  await writeFile(path.join(root, "overview", ".WORK_NODE.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<work-node id="overview" type="Overview">
  <summary>Legacy metadata.</summary>
  <inputs />
</work-node>
`);
  await rejection(root, /keyPoints must be a non-empty element/i);
});

test("rejects duplicate IDs and duplicate inputs", async (t) => {
  const root = await fixture(t);
  await writeWork(root, "overview", { type: "Overview", keyPoints: "Root." });
  await writeWork(root, "copy/overview", { id: "overview", type: "Concept", keyPoints: "Duplicate.", inputs: ["overview"] });
  await rejection(root, /duplicate Work ID.*overview/i);

  await rm(path.join(root, "copy"), { recursive: true });
  await writeWork(root, "concept", { type: "Concept", keyPoints: "Concept.", inputs: ["overview", "overview"] });
  await rejection(root, /duplicate input.*overview/i);
});

test("rejects missing inputs, invalid Overview roots, cycles, and unreachable Works", async (t) => {
  const root = await fixture(t);
  await writeWork(root, "overview", { type: "Overview", keyPoints: "Root." });
  await writeWork(root, "concept", { type: "Concept", keyPoints: "Concept.", inputs: ["missing"] });
  await rejection(root, /concept.*missing input Work.*missing/i);

  await rm(path.join(root, "concept"), { recursive: true });
  await writeWork(root, "second", { type: "Overview", keyPoints: "Second root." });
  await rejection(root, /exactly one Overview Work.*found 2/i);

  await rm(path.join(root, "second"), { recursive: true });
  await writeWork(root, "overview", { type: "Overview", keyPoints: "Root.", inputs: ["alpha"] });
  await writeWork(root, "alpha", { type: "Design", keyPoints: "Alpha.", inputs: ["overview"] });
  await rejection(root, /Overview Work must not declare inputs|cycle/i);

  await rm(path.join(root, "alpha"), { recursive: true });
  await writeWork(root, "overview", { type: "Overview", keyPoints: "Root." });
  await writeWork(root, "orphan", { type: "Concept", keyPoints: "Orphan." });
  await rejection(root, /unreachable from Overview.*orphan/i);
});

test("reports missing graphs and accepts marker-only future Works", async (t) => {
  const root = await fixture(t);
  await assert.rejects(loadWorkGraph(root), (error) => error.code === "NO_GRAPH");
  await writeWork(root, "overview", { type: "Overview", keyPoints: "Defines the outcome." });
  await writeWork(root, "future-release", { type: "Distribution", keyPoints: "Will package the result.", inputs: ["overview"] });
  assert.deepEqual((await loadWorkGraph(root)).map(({ id }) => id), ["overview", "future-release"]);
});

test("Work-only metadata does not bypass unavailable Git selection", async (t) => {
  const root = await fixture(t);
  await writeWork(root, "overview", {
    type: "Overview",
    keyPoints: "Defines the outcome.",
  });

  await assert.rejects(loadWorkGraph(root, {
    readerOptions: { platform: "win32", environment: { PATH: "" } },
  }), { code: "SONNER_PROJECT_READER_UNAVAILABLE" });
});
