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

async function writeWork(root, folder, { id = folder, type, summary, inputs = [] }) {
  const directory = path.join(root, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "WORK_NODE.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<work-node id="${id}" type="${type}">
  <summary>${summary}</summary>
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
  await writeWork(root, "distribution", { type: "Distribution", summary: "Ships the verified result.", inputs: ["verification", "guide"] });
  await writeWork(root, "overview", { type: "Overview", summary: "Defines the outcome." });
  await writeWork(root, "verification", { type: "Verification", summary: "Proves the result.", inputs: ["implementation"] });
  await writeWork(root, "guide", { type: "Guide", summary: "Explains the result.", inputs: ["overview", "implementation"] });
  await writeWork(root, "implementation", { type: "Implementation", summary: "Realizes the result.", inputs: ["overview"] });

  const first = await loadWorkGraph(root);
  const second = await loadWorkGraph(root);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(({ id, nodePath }) => ({ id, nodePath })), [
    { id: "overview", nodePath: "overview/WORK_NODE.xml" },
    { id: "implementation", nodePath: "implementation/WORK_NODE.xml" },
    { id: "guide", nodePath: "guide/WORK_NODE.xml" },
    { id: "verification", nodePath: "verification/WORK_NODE.xml" },
    { id: "distribution", nodePath: "distribution/WORK_NODE.xml" },
  ]);
});

test("discovers nested Works, ignores generated roots, and decodes XML entities", async (t) => {
  const root = await fixture(t);
  await writeWork(root, ".git/stale", { id: "stale", type: "Overview", summary: "Ignored." });
  await writeWork(root, "overview", { type: "Overview", summary: "Defines &amp; constrains." });
  await writeWork(root, "components/implementation", { id: "implementation", type: "Implementation", summary: "Realizes &#x41;.", inputs: ["overview"] });
  const works = await loadWorkGraph(root);
  assert.deepEqual(works.map(({ id, summary, nodePath }) => ({ id, summary, nodePath })), [
    { id: "overview", summary: "Defines & constrains.", nodePath: "overview/WORK_NODE.xml" },
    { id: "implementation", summary: "Realizes A.", nodePath: "components/implementation/WORK_NODE.xml" },
  ]);
});

test("rejects malformed metadata and directory/id mismatch with relative paths", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "overview"));
  await writeFile(path.join(root, "overview", "WORK_NODE.xml"), "<work-node><summary>Broken</summary></work-node>\n");
  await rejection(root, /overview\/WORK_NODE\.xml.*id.*attribute/i);

  await rm(path.join(root, "overview"), { recursive: true });
  await writeWork(root, "system", { id: "system-specification", type: "SystemSpecification", summary: "Defines the system." });
  await rejection(root, /directory name "system" must match Work ID "system-specification"/);
});

test("rejects duplicate IDs and duplicate inputs", async (t) => {
  const root = await fixture(t);
  await writeWork(root, "overview", { type: "Overview", summary: "Root." });
  await writeWork(root, "copy/overview", { id: "overview", type: "Concept", summary: "Duplicate.", inputs: ["overview"] });
  await rejection(root, /duplicate Work ID.*overview/i);

  await rm(path.join(root, "copy"), { recursive: true });
  await writeWork(root, "concept", { type: "Concept", summary: "Concept.", inputs: ["overview", "overview"] });
  await rejection(root, /duplicate input.*overview/i);
});

test("rejects missing inputs, invalid Overview roots, cycles, and unreachable Works", async (t) => {
  const root = await fixture(t);
  await writeWork(root, "overview", { type: "Overview", summary: "Root." });
  await writeWork(root, "concept", { type: "Concept", summary: "Concept.", inputs: ["missing"] });
  await rejection(root, /concept.*missing input Work.*missing/i);

  await rm(path.join(root, "concept"), { recursive: true });
  await writeWork(root, "second", { type: "Overview", summary: "Second root." });
  await rejection(root, /exactly one Overview Work.*found 2/i);

  await rm(path.join(root, "second"), { recursive: true });
  await writeWork(root, "overview", { type: "Overview", summary: "Root.", inputs: ["alpha"] });
  await writeWork(root, "alpha", { type: "Design", summary: "Alpha.", inputs: ["overview"] });
  await rejection(root, /Overview Work must not declare inputs|cycle/i);

  await rm(path.join(root, "alpha"), { recursive: true });
  await writeWork(root, "overview", { type: "Overview", summary: "Root." });
  await writeWork(root, "orphan", { type: "Concept", summary: "Orphan." });
  await rejection(root, /unreachable from Overview.*orphan/i);
});

test("reports missing graphs and accepts marker-only future Works", async (t) => {
  const root = await fixture(t);
  await assert.rejects(loadWorkGraph(root), (error) => error.code === "NO_GRAPH");
  await writeWork(root, "overview", { type: "Overview", summary: "Defines the outcome." });
  await writeWork(root, "future-release", { type: "Distribution", summary: "Will package the result.", inputs: ["overview"] });
  assert.deepEqual((await loadWorkGraph(root)).map(({ id }) => id), ["overview", "future-release"]);
});
