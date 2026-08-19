import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { buildSonner, parseMarkdownSummary, SONNER_SCHEMA_VERSION } from "../source/sonner.mjs";

const execFileAsync = promisify(execFile);
const componentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = path.resolve(componentRoot, "../commands/sonner.mjs");

async function write(root, relative, value) {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, value);
}

async function git(root, ...arguments_) {
  return execFileAsync("git", ["-C", root, ...arguments_], { encoding: "utf8" });
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-sonner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Sonner Test");
  await git(root, "config", "user.email", "sonner@example.invalid");
  return root;
}

function work(id, type, summary, inputs = []) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<work-node id="${id}" type="${type}">\n  <summary>${summary}</summary>\n  <inputs>${inputs.map((input) => `\n    <input ref="${input}" />`).join("")}\n  </inputs>\n</work-node>\n`;
}

function find(node, projectPath) {
  if (node.path === projectPath) return node;
  for (const child of node.children ?? []) {
    const result = child.type === "directory" ? find(child, projectPath) : child.path === projectPath ? child : null;
    if (result) return result;
  }
  return null;
}

test("Markdown summaries come only from leading Atomic Documentation frontmatter", () => {
  assert.equal(parseMarkdownSummary("# body\nsummary: body value"), null);
  assert.equal(parseMarkdownSummary("---\ntitle: no summary\n---\nsummary: body"), null);
  assert.equal(parseMarkdownSummary("---\nsummary: concise\n---\nbody"), "concise");
  assert.equal(parseMarkdownSummary("---\nsummary: >-\n  First line\n  second line.\n---\nbody"), "First line second line.");
  assert.equal(parseMarkdownSummary("---\nsummary: 'quoted value'\n---\n"), "quoted value");
  assert.equal(parseMarkdownSummary("---\nsummary: incomplete\n---not-a-delimiter\n"), null);
});

test("valid graph expands Work routes and explains opaque directories", async (t) => {
  const root = await repository(t);
  await write(root, ".gitignore", "ignored/\nnode_modules/\n");
  await write(root, "README.md", "---\nsummary: Project summary.\n---\n# Project\nsecret body\n");
  await write(root, "overview/WORK_NODE.xml", work("overview", "Overview", "Project overview."));
  await write(root, "overview/index.md", "---\nsummary: >-\n  Overview\n  document.\n---\n# Overview\n");
  await write(root, "spec/work/WORK_NODE.xml", work("work", "Specification", "Maintained specification.", ["overview"]));
  await write(root, "spec/work/detail.md", "---\nsummary: Detailed contract.\n---\n# Detail\nDO NOT RETURN THIS BODY\n");
  await write(root, "spec/unrelated/private.md", "---\nsummary: Must stay behind opaque directory.\n---\n");
  await write(root, "misc/note.md", "No frontmatter.\nsummary: body only\n");
  await write(root, "ignored/ignored.md", "---\nsummary: ignored\n---\n");
  await write(root, "node_modules/dependency.js", "dependency");
  await write(root, "dist/tracked-generated.js", "generated");
  await write(root, "link-target/inside.md", "---\nsummary: target\n---\n");
  await symlink("link-target", path.join(root, "linked-directory"));
  await git(root, "add", ".gitignore", "README.md", "overview", "spec", "dist", "linked-directory");

  const first = await buildSonner(root);
  const second = await buildSonner(root);
  assert.deepEqual(first, second, "projection ordering is deterministic");
  assert.deepEqual(Object.keys(first), ["version", "workGraph", "files", "runtime"]);
  assert.equal(first.version, SONNER_SCHEMA_VERSION);
  assert.equal(first.version, 8);
  assert.deepEqual(Object.keys(first.workGraph), ["status", "works"]);
  assert.deepEqual(first.workGraph.works, [
    {
      id: "overview",
      type: "Overview",
      summary: "Project overview.",
      nodePath: "overview/WORK_NODE.xml",
      inputs: [],
      outputs: ["work"],
    },
    {
      id: "work",
      type: "Specification",
      summary: "Maintained specification.",
      nodePath: "spec/work/WORK_NODE.xml",
      inputs: ["overview"],
      outputs: [],
    },
  ]);
  assert.deepEqual(Object.keys(first.workGraph.works[0]), ["id", "type", "summary", "nodePath", "inputs", "outputs"]);
  assert.doesNotMatch(JSON.stringify(first.workGraph), /relativePath|consumers/);
  assert.deepEqual(Object.keys(first.files), ["root"]);
  assert.deepEqual(first.runtime, { status: "missing" });

  const projected = first.files.root;
  assert.equal(find(projected, "README.md").summary, "Project summary.");
  assert.equal(find(projected, "misc/note.md"), null, "file beneath opaque directory is not projected");
  assert.deepEqual(find(projected, "misc"), { path: "misc", name: "misc", type: "directory", summary: "Not in Work Graph" });
  assert.ok(Array.isArray(find(projected, "spec").children), "Work ancestor remains visible");
  assert.equal(find(projected, "spec/work").summary, undefined, "directory summaries are not projected");
  assert.equal(find(projected, "spec/work").work, undefined, "Work metadata stays internal");
  assert.equal(find(projected, "spec/work/detail.md").summary, "Detailed contract.");
  assert.equal(find(projected, "spec/unrelated").children, undefined);
  assert.equal(find(projected, "spec/unrelated").summary, "Not in Work Graph");
  assert.equal(find(projected, "linked-directory").type, "symlink");
  assert.equal(find(projected, "linked-directory").children, undefined, "symlink target is never followed");
  assert.equal(find(projected, "ignored"), null);
  assert.equal(find(projected, "node_modules"), null);
  assert.equal(find(projected, "dist"), null, "tracked generated output is explicitly excluded");
  assert.doesNotMatch(JSON.stringify(first), /DO NOT RETURN THIS BODY/);
});

test("missing and invalid graphs expose distinct stable opaque-directory summaries", async (t) => {
  for (const graph of ["missing", "invalid"]) {
    await t.test(graph, async (t) => {
      const root = await repository(t);
      await write(root, "README.md", "---\nsummary: Root file.\n---\n# Root\n");
      await write(root, "docs/guide.md", "---\nsummary: Nested file.\n---\n");
      if (graph === "invalid") {
        await write(
          root,
          "broken/WORK_NODE.xml",
          work("different-id", "Overview", "Broken.", ["missing-input"]),
        );
      }
      await git(root, "add", ".");
      const result = await buildSonner(root);
      assert.deepEqual(result.workGraph, { status: graph });
      assert.equal(find(result.files.root, "README.md").summary, "Root file.");
      const directory = find(result.files.root, graph === "invalid" ? "broken" : "docs");
      assert.deepEqual(directory, {
        path: directory.path,
        name: directory.name,
        type: "directory",
        summary: graph === "invalid" ? "Work Graph invalid" : "Work Graph missing",
      });
    });
  }
});

test("the public CLI defaults to deterministic Agent text and --json remains canonical", async (t) => {
  const root = await repository(t);
  const hostileSummary = "CLI project ‮TXT ‍ ️";
  await write(root, "README.md", `---\nsummary: ${hostileSummary}\n---\n`);
  await write(root, "docs/guide.md", "Guide.\n");
  await git(root, "add", "README.md", "docs");
  const firstText = await execFileAsync(process.execPath, [command, "--project-root", root], { encoding: "utf8" });
  const secondText = await execFileAsync(process.execPath, [command, "--project-root", root], { encoding: "utf8" });
  assert.equal(firstText.stderr, "");
  assert.equal(firstText.stdout, secondText.stdout);
  assert.match(firstText.stdout, /^Sonner v8\nWork Graph: missing\nFiles:\n/);
  assert.match(firstText.stdout, /Omitted Directory path="docs" reason="Work Graph missing"/);
  assert.match(firstText.stdout, /File path="README\.md" summary="CLI project \\u202eTXT \\u200d \\ufe0f"/);
  assert.equal(firstText.stdout.includes("\u202e"), false);
  assert.equal(firstText.stdout.includes("\u200d"), false);
  assert.equal(firstText.stdout.includes("\ufe0f"), false);
  assert.match(firstText.stdout, /Runtime: missing\n$/);

  const firstJson = await execFileAsync(process.execPath, [command, "--project-root", root, "--json"], { encoding: "utf8" });
  const secondJson = await execFileAsync(process.execPath, [command, "--json", "--project-root", root], { encoding: "utf8" });
  assert.equal(firstJson.stderr, "");
  assert.equal(firstJson.stdout, secondJson.stdout);
  assert.equal(firstJson.stdout.trim().split("\n").length, 1);
  const result = JSON.parse(firstJson.stdout);
  assert.deepEqual(Object.keys(result), ["version", "workGraph", "files", "runtime"]);
  assert.equal(result.version, 8);
  assert.deepEqual(result.workGraph, { status: "missing" });
  assert.deepEqual(result.runtime, { status: "missing" });
  assert.deepEqual(result.files.root.children.map((node) => node.path), ["docs", "README.md"], "directories sort before files");
  assert.equal(result.files.root.children.find((node) => node.path === "README.md").summary, hostileSummary);
});

test("the CLI rejects duplicate, missing, positional, and unknown options in the requested format", () => {
  const invalid = [
    [],
    ["--project-root"],
    ["--project-root", "--json"],
    ["--project-root", ".", "--project-root", "."],
    ["--project-root", ".", "--json", "--json"],
    ["--project-root", ".", "--unknown"],
    ["project", "--project-root", "."],
  ];
  for (const arguments_ of invalid) {
    const result = spawnSync(process.execPath, [command, ...arguments_], { encoding: "utf8" });
    assert.equal(result.status, 1, arguments_.join(" "));
    assert.equal(result.stdout, "");
    if (arguments_.includes("--json")) {
      assert.equal(JSON.parse(result.stderr).error.code, "SONNER_CLI_USAGE");
    } else {
      assert.match(result.stderr, /^Sonner error code="SONNER_CLI_USAGE" message="Usage: /);
    }
    assert.equal(result.stderr.endsWith("\n"), true);
  }

  const json = spawnSync(process.execPath, [command, "--json", "--json", "--project-root", "."], { encoding: "utf8" });
  assert.equal(json.status, 1);
  assert.equal(json.stdout, "");
  assert.deepEqual(JSON.parse(json.stderr), {
    error: {
      code: "SONNER_CLI_USAGE",
      message: "Usage: node sonner.mjs --project-root <path> [--json]",
    },
  });
});

test("the CLI keeps inspection failures bounded and mode-matched", () => {
  const missing = path.join(os.tmpdir(), `sonner-missing-${process.pid}-${Date.now()}`);
  const text = spawnSync(process.execPath, [command, "--project-root", missing], { encoding: "utf8" });
  assert.equal(text.status, 1);
  assert.equal(text.stdout, "");
  assert.match(text.stderr, /^Sonner error code="[A-Z0-9_]+" message="Sonner could not inspect this project safely\."\n$/);

  const json = spawnSync(process.execPath, [command, "--json", "--project-root", missing], { encoding: "utf8" });
  assert.equal(json.status, 1);
  assert.equal(json.stdout, "");
  const payload = JSON.parse(json.stderr);
  assert.match(payload.error.code, /^[A-Z0-9_]{1,64}$/);
  assert.equal(payload.error.message, "Sonner could not inspect this project safely.");
  assert.deepEqual(Object.keys(payload), ["error"]);
  assert.equal(json.stderr.endsWith("\n"), true);
});

test("command source remains packaged", async () => {
  assert.match(await readFile(command, "utf8"), /runSonnerCli/);
});
