import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  buildSonner,
  isSonnerTextBytes,
  parseMarkdownKeyPoints,
  SONNER_SCHEMA_VERSION,
} from "../source/sonner.mjs";

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

function work(id, type, keyPoints, inputs = []) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<work-node id="${id}" type="${type}">\n  <keyPoints>${keyPoints}</keyPoints>\n  <inputs>${inputs.map((input) => `\n    <input ref="${input}" />`).join("")}\n  </inputs>\n</work-node>\n`;
}

function find(node, projectPath) {
  if (node.path === projectPath) return node;
  for (const child of node.children ?? []) {
    const result = child.type === "directory" ? find(child, projectPath) : child.path === projectPath ? child : null;
    if (result) return result;
  }
  return null;
}

test("Markdown key points come only from leading Atomic Documentation frontmatter", () => {
  assert.equal(parseMarkdownKeyPoints("# body\nkeyPoints: body value"), null);
  assert.equal(parseMarkdownKeyPoints("---\nsummary: legacy metadata\n---\nbody"), null);
  assert.equal(parseMarkdownKeyPoints("---\ntitle: no keyPoints\n---\nkeyPoints: body"), null);
  assert.equal(parseMarkdownKeyPoints("---\nkeyPoints: concise\n---\nbody"), "concise");
  assert.equal(parseMarkdownKeyPoints("---\nkeyPoints: >-\n  First line\n  second line.\n---\nbody"), "First line second line.");
  assert.equal(parseMarkdownKeyPoints("---\nkeyPoints: 'quoted value'\n---\n"), "quoted value");
  assert.equal(parseMarkdownKeyPoints("---\nkeyPoints: incomplete\n---not-a-delimiter\n"), null);
});

test("VS Code-compatible content detection recognizes text without relying on extensions", () => {
  assert.equal(isSonnerTextBytes(Buffer.from("unknown extension text\n")), true);
  assert.equal(isSonnerTextBytes(Buffer.alloc(0)), true);
  assert.equal(isSonnerTextBytes(Buffer.from([0xef, 0xbb, 0xbf, 0])), true, "UTF-8 BOM is text");
  assert.equal(isSonnerTextBytes(Buffer.from([0xff, 0xfe, 0x41, 0])), true, "UTF-16 LE BOM is text");
  assert.equal(isSonnerTextBytes(Buffer.from([0xfe, 0xff, 0, 0x41])), true, "UTF-16 BE BOM is text");
  assert.equal(isSonnerTextBytes(Buffer.from([0x41, 0, 0x42, 0])), true, "BOM-less UTF-16 LE is text");
  assert.equal(isSonnerTextBytes(Buffer.from([0, 0x41, 0, 0x42])), true, "BOM-less UTF-16 BE is text");
  assert.equal(isSonnerTextBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1])), false);
  assert.equal(isSonnerTextBytes(Buffer.concat([Buffer.alloc(512, 0x41), Buffer.from([0])])), true,
    "only the first 512 bytes participate");
});

test("valid graph preserves every directory, lists files with key points, and groups everything else", async (t) => {
  const root = await repository(t);
  await write(root, ".gitignore", "ignored/\nnode_modules/\n");
  await write(root, "README.md", "---\nkeyPoints: Project keyPoints.\n---\n# Project\nsecret body\n");
  await write(root, "overview/.WORK_NODE.xml", work("overview", "Overview", "Project overview."));
  await write(root, "overview/index.md", "---\nkeyPoints: >-\n  Overview\n  document.\n---\n# Overview\n");
  await write(root, "spec/work/.WORK_NODE.xml", work("work", "Specification", "Maintained specification.", ["overview"]));
  await write(root, "spec/work/detail.md", "---\nkeyPoints: Detailed contract.\n---\n# Detail\nDO NOT RETURN THIS BODY\n");
  await write(root, "spec/unrelated/private.md", "---\nkeyPoints: Visible outside the Work Graph.\n---\n");
  await write(root, "misc/note.md", "No frontmatter.\nkeyPoints: body only\n");
  await write(root, "assets/icon.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
  await write(root, "assets/photo.PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 2]));
  await write(root, "assets/blob", Buffer.from([1, 2, 0, 3]));
  await write(root, "assets/nested/config.unknown", "plain text\n");
  await write(root, "ignored/ignored.md", "---\nkeyPoints: ignored\n---\n");
  await write(root, "node_modules/dependency.js", "dependency");
  await write(root, "dist/tracked-generated.js", "generated");
  await write(root, "link-target/inside.md", "---\nkeyPoints: target\n---\n");
  await symlink("link-target", path.join(root, "linked-directory"));
  await git(root, "add", ".gitignore", "README.md", "overview", "spec", "misc", "assets", "dist", "linked-directory");

  const first = await buildSonner(root);
  const second = await buildSonner(root);
  assert.deepEqual(first, second, "projection ordering is deterministic");
  assert.deepEqual(Object.keys(first), ["version", "workGraph", "files", "runtime"]);
  assert.equal(first.version, SONNER_SCHEMA_VERSION);
  assert.equal(first.version, 12);
  assert.deepEqual(Object.keys(first.workGraph), ["status", "works"]);
  assert.deepEqual(first.workGraph.works, [
    {
      id: "overview",
      type: "Overview",
      keyPoints: "Project overview.",
      nodePath: "overview/.WORK_NODE.xml",
      inputs: [],
      outputs: ["work"],
    },
    {
      id: "work",
      type: "Specification",
      keyPoints: "Maintained specification.",
      nodePath: "spec/work/.WORK_NODE.xml",
      inputs: ["overview"],
      outputs: [],
    },
  ]);
  assert.deepEqual(Object.keys(first.workGraph.works[0]), ["id", "type", "keyPoints", "nodePath", "inputs", "outputs"]);
  assert.doesNotMatch(JSON.stringify(first.workGraph), /relativePath|consumers/);
  assert.deepEqual(Object.keys(first.files), ["root"]);
  assert.deepEqual(first.runtime, { status: "missing" });

  const projected = first.files.root;
  assert.equal(find(projected, "README.md").keyPoints, "Project keyPoints.");
  assert.equal(find(projected, "misc/note.md"), null);
  assert.ok(Array.isArray(find(projected, "misc").children));
  assert.deepEqual(find(projected, "misc").children.find(({ type }) => type === "file-counts"), {
    type: "file-counts",
    counts: [{ extension: "md", count: 1 }],
  });
  assert.ok(Array.isArray(find(projected, "spec").children), "Work ancestor remains visible");
  assert.equal(find(projected, "spec/work").keyPoints, undefined, "directory key points are not projected");
  assert.equal(find(projected, "spec/work").work, undefined, "Work metadata stays internal");
  assert.equal(find(projected, "spec/work/detail.md").keyPoints, "Detailed contract.");
  assert.equal(find(projected, "spec/unrelated/private.md").keyPoints, "Visible outside the Work Graph.");
  assert.ok(Array.isArray(find(projected, "spec/unrelated").children));
  assert.equal(find(projected, "assets/nested/config.unknown"), null);
  assert.deepEqual(find(projected, "assets").children.find(({ type }) => type === "file-counts"), {
    type: "file-counts",
    counts: [
      { extension: null, count: 1 },
      { extension: "png", count: 2 },
    ],
  });
  assert.deepEqual(find(projected, "assets/nested").children, [
    { type: "file-counts", counts: [{ extension: "unknown", count: 1 }] },
  ]);
  assert.equal(JSON.stringify(first.files).includes("icon.png"), false, "keyPoints-less filenames are not projected");
  assert.equal(JSON.stringify(first.files).includes("photo.PNG"), false, "keyPoints-less filename case is not leaked");
  assert.equal(JSON.stringify(first.files).includes("linked-directory"), false, "symlink filenames are not projected");
  assert.equal(find(projected, "ignored"), null);
  assert.equal(find(projected, "node_modules"), null);
  assert.equal(find(projected, "dist"), null, "tracked generated output is explicitly excluded");
  assert.doesNotMatch(JSON.stringify(first), /DO NOT RETURN THIS BODY/);
});

test("missing and invalid graphs still expose complete directories and files with key points", async (t) => {
  for (const graph of ["missing", "invalid"]) {
    await t.test(graph, async (t) => {
      const root = await repository(t);
      await write(root, "README.md", "---\nkeyPoints: Root file.\n---\n# Root\n");
      await write(root, "docs/guide.md", "---\nkeyPoints: Nested file.\n---\n");
      if (graph === "invalid") {
        await write(
          root,
          "broken/.WORK_NODE.xml",
          work("different-id", "Overview", "Broken.", ["missing-input"]),
        );
      }
      await git(root, "add", ".");
      const result = await buildSonner(root);
      assert.deepEqual(result.workGraph, { status: graph });
      assert.equal(find(result.files.root, "README.md").keyPoints, "Root file.");
      assert.equal(find(result.files.root, "docs/guide.md").keyPoints, "Nested file.");
      if (graph === "invalid") {
        assert.deepEqual(find(result.files.root, "broken").children, [
          { type: "file-counts", counts: [{ extension: "xml", count: 1 }] },
        ]);
      }
    });
  }
});

test("legacy WORK_NODE.xml is not loaded and appears as an actionable Files warning", async (t) => {
  const root = await repository(t);
  await write(root, ".gitignore", "legacy/\n");
  await write(root, "legacy/WORK_NODE.xml", work("legacy", "Overview", "Old graph."));
  await git(root, "add", ".gitignore");

  const result = await buildSonner(root);

  assert.deepEqual(result.workGraph, { status: "missing" });
  assert.deepEqual(find(result.files.root, "legacy").children, [{
    path: "legacy/WORK_NODE.xml",
    name: "WORK_NODE.xml",
    type: "warning",
    code: "legacy-work-node",
    renameTo: "legacy/.WORK_NODE.xml",
  }]);
});

test("the public CLI defaults to deterministic Agent text and --json remains canonical", async (t) => {
  const root = await repository(t);
  const hostileKeyPoints = "CLI project ‮TXT ‍ ️";
  await write(root, "README.md", `---\nkeyPoints: ${hostileKeyPoints}\n---\n`);
  await write(root, "docs/guide.md", "Guide.\n");
  await git(root, "add", "README.md", "docs");
  const firstText = await execFileAsync(process.execPath, [command, "--project-root", root], { encoding: "utf8" });
  const secondText = await execFileAsync(process.execPath, [command, "--project-root", root], { encoding: "utf8" });
  assert.equal(firstText.stderr, "");
  assert.equal(firstText.stdout, secondText.stdout);
  assert.match(firstText.stdout, /^Sonner v12\nWork Graph: missing\nFiles:\n/);
  assert.match(firstText.stdout, /Directory path="docs"\n\s+1 md/);
  assert.match(firstText.stdout, /File path="README\.md" keyPoints="CLI project \\u202eTXT \\u200d \\ufe0f"/);
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
  assert.equal(result.version, 12);
  assert.deepEqual(result.workGraph, { status: "missing" });
  assert.deepEqual(result.runtime, { status: "missing" });
  assert.deepEqual(result.files.root.children.map((node) => node.path), ["docs", "README.md"], "directories sort before files");
  assert.equal(result.files.root.children.find((node) => node.path === "README.md").keyPoints, hostileKeyPoints);
  assert.deepEqual(result.files.root.children[0].children, [
    { type: "file-counts", counts: [{ extension: "md", count: 1 }] },
  ]);
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
