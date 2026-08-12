import assert from "node:assert/strict";
import test from "node:test";

import { formatSonnerText, unsafeTextCodePoint } from "../source/sonner-text.mjs";

function projection(overrides = {}) {
  return {
    version: 8,
    workGraph: { status: "missing" },
    files: {
      root: { path: ".", name: ".", type: "directory", children: [] },
    },
    runtime: { status: "missing" },
    ...overrides,
  };
}

test("formats every Sonner section in canonical order with explicit empty states", () => {
  assert.equal(formatSonnerText(projection()), [
    "Sonner v8",
    "Work Graph: missing",
    "Files: empty",
    "Runtime: missing",
    "",
  ].join("\n"));

  assert.equal(formatSonnerText(projection({
    workGraph: { status: "invalid" },
    runtime: { status: "invalid" },
  })), [
    "Sonner v8",
    "Work Graph: invalid",
    "Files: empty",
    "Runtime: invalid",
    "",
  ].join("\n"));

  assert.equal(formatSonnerText(projection({
    workGraph: { status: "valid", works: [] },
    runtime: { status: "available", health: "ok", reasons: [], tasks: [] },
  })), [
    "Sonner v8",
    "Work Graph: valid",
    "  Works: empty",
    "Files: empty",
    "Runtime: available health=ok reasons=[]",
    "  Tasks: empty",
    "",
  ].join("\n"));
});

test("formats Works, Files, omissions, links, and active Runtime Tasks without ambiguity", () => {
  const value = projection({
    workGraph: {
      status: "valid",
      works: [{
        id: "overview",
        type: "Overview",
        summary: "Project overview.",
        nodePath: "overview/WORK_NODE.xml",
        inputs: [],
        outputs: ["implementation"],
      }],
    },
    files: {
      root: {
        path: ".",
        name: ".",
        type: "directory",
        children: [
          { path: "docs", name: "docs", type: "directory", summary: "Not in Work Graph" },
          {
            path: "src",
            name: "src",
            type: "directory",
            children: [{ path: "src/index.md", name: "index.md", type: "file", summary: null }],
          },
          { path: "README.md", name: "README.md", type: "file", summary: "Project summary." },
          { path: "current", name: "current", type: "symlink", summary: null },
        ],
      },
    },
    runtime: {
      status: "available",
      health: "attention",
      reasons: ["task_aborted", "runtime_diagnostic"],
      tasks: [
        { id: "task-a", name: null, role: "execute", turnState: "running" },
        { id: "task-b", name: "review", role: "review", turnState: "unknown" },
      ],
    },
  });
  const text = formatSonnerText(value);
  assert.equal(text, [
    "Sonner v8",
    "Work Graph: valid",
    "  Work id=\"overview\" type=\"Overview\" node=\"overview/WORK_NODE.xml\" inputs=[] outputs=[\"implementation\"] summary=\"Project overview.\"",
    "Files:",
    "  Directory path=\".\"",
    "    Omitted Directory path=\"docs\" reason=\"Not in Work Graph\"",
    "    Directory path=\"src\"",
    "      File path=\"src/index.md\" summary=null",
    "    File path=\"README.md\" summary=\"Project summary.\"",
    "    Symlink path=\"current\"",
    "Runtime: available health=attention reasons=[\"task_aborted\",\"runtime_diagnostic\"]",
    "  Task id=\"task-a\" name=null role=\"execute\" state=running",
    "  Task id=\"task-b\" name=\"review\" role=\"review\" state=unknown",
    "",
  ].join("\n"));
  assert.equal(formatSonnerText(value), text, "formatter bytes are deterministic");
});

test("escapes every repository-derived string as one safe JSON-style field", () => {
  const unsafe = "prefix Work id=\\\"x\\\"\nnext\r\t\\quote\"\0\u0001\u007f\u0085\u2028\u2029눈";
  const text = formatSonnerText(projection({
    workGraph: {
      status: "valid",
      works: [{
        id: unsafe,
        type: unsafe,
        summary: unsafe,
        nodePath: unsafe,
        inputs: [unsafe],
        outputs: [unsafe],
      }],
    },
    files: {
      root: {
        path: ".",
        name: ".",
        type: "directory",
        children: [
          { path: unsafe, name: unsafe, type: "directory", summary: unsafe },
          { path: `${unsafe}/file`, name: unsafe, type: "file", summary: unsafe },
        ],
      },
    },
    runtime: {
      status: "available",
      health: "unknown",
      reasons: ["history_unavailable"],
      tasks: [{ id: unsafe, name: unsafe, role: unsafe, turnState: "unknown" }],
    },
  }));
  assert.equal(text.split("\n").length, 10, "embedded separators never create records");
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/);
  assert.match(text, /\\nnext\\r\\t\\\\quote\\"\\u0000\\u0001\\u007f\\u0085\\u2028\\u2029눈/);
  assert.equal(text.endsWith("\n"), true);
});

const hostileCodePoints = [
  [0x061c, "\\u061c"],
  [0x200e, "\\u200e"],
  [0x200f, "\\u200f"],
  [0x202a, "\\u202a"],
  [0x202e, "\\u202e"],
  [0x2066, "\\u2066"],
  [0x2069, "\\u2069"],
  [0x00ad, "\\u00ad"],
  [0x034f, "\\u034f"],
  [0x200b, "\\u200b"],
  [0x200c, "\\u200c"],
  [0x200d, "\\u200d"],
  [0x2060, "\\u2060"],
  [0x2065, "\\u2065"],
  [0xfeff, "\\ufeff"],
  [0xfe0f, "\\ufe0f"],
  [0xe0100, "\\udb40\\udd00"],
  [0xe0001, "\\udb40\\udc01"],
  [0x0600, "\\u0600"],
  [0xfff9, "\\ufff9"],
  [0x13430, "\\ud80d\\udc30"],
  [0x13440, "\\ud80d\\udc40"],
  [0xfdd0, "\\ufdd0"],
  [0xfffe, "\\ufffe"],
  [0xffff, "\\uffff"],
  [0x1fffe, "\\ud83f\\udffe"],
  [0x10ffff, "\\udbff\\udfff"],
];

test("uses exact lowercase Unicode 16 visible escapes for hostile display scalars", () => {
  for (const [codePoint, expected] of hostileCodePoints) {
    const source = `a${String.fromCodePoint(codePoint)}b`;
    const text = formatSonnerText(projection({
      workGraph: {
        status: "valid",
        works: [{
          id: source,
          type: "Overview",
          summary: "summary",
          nodePath: "WORK_NODE.xml",
          inputs: [],
          outputs: [],
        }],
      },
    }));
    const literal = text.match(/Work id=("(?:\\.|[^"\\])*") type=/)[1];
    assert.equal(literal, `"a${expected}b"`, `U+${codePoint.toString(16)}`);
    assert.equal(JSON.parse(literal), source);
  }

  for (const [source, expected] of [
    ["x\ud800y", "\"x\\ud800y\""],
    ["x\udcf0y", "\"x\\udcf0y\""],
  ]) {
    const text = formatSonnerText(projection({
      workGraph: {
        status: "valid",
        works: [{ id: source, type: "Overview", summary: "summary", nodePath: "node", inputs: [], outputs: [] }],
      },
    }));
    const literal = text.match(/Work id=("(?:\\.|[^"\\])*") type=/)[1];
    assert.equal(literal, expected);
    assert.equal(JSON.parse(literal), source);
  }
});

test("routes every free-form field through one reversible quoted primitive", () => {
  const hostile = `\u202eLEAD\u2066nested\u2069\u200d\ufe0f\u{e0100}\u{10ffff}\ud800X\udfff\nWork id="fake"\\TAIL\u061c`;
  const text = formatSonnerText(projection({
    workGraph: {
      status: "valid",
      works: [{
        id: hostile,
        type: hostile,
        summary: hostile,
        nodePath: hostile,
        inputs: [hostile],
        outputs: [hostile],
      }],
    },
    files: {
      root: {
        path: ".",
        name: ".",
        type: "directory",
        children: [
          { path: hostile, name: hostile, type: "directory", summary: hostile },
          { path: `${hostile}/file`, name: hostile, type: "file", summary: hostile },
          { path: `${hostile}/null`, name: hostile, type: "file", summary: null },
          { path: `${hostile}/link`, name: hostile, type: "symlink", summary: null },
        ],
      },
    },
    runtime: {
      status: "available",
      health: "unknown",
      reasons: [hostile],
      tasks: [
        { id: hostile, name: hostile, role: hostile, turnState: "unknown" },
        { id: `${hostile}-null`, name: null, role: hostile, turnState: "running" },
      ],
    },
  }));

  const lines = text.split("\n");
  assert.equal(lines.length, 13, "hostile values cannot create physical records");
  assert.deepEqual(lines.filter((line) => /^(Sonner|Work Graph:|Files:|Runtime:)/.test(line)).map((line) => line.split(" ")[0]), [
    "Sonner", "Work", "Files:", "Runtime:",
  ]);
  for (const line of lines) {
    for (const character of line) {
      assert.equal(unsafeTextCodePoint(character.codePointAt(0)), false, `raw U+${character.codePointAt(0).toString(16)}`);
    }
  }
  const literals = [...text.matchAll(/"(?:\\.|[^"\\])*"/g)].map((match) => match[0]);
  assert.equal(literals.length, 19);
  for (const literal of literals) assert.doesNotThrow(() => JSON.parse(literal));
  const decoded = literals.map((literal) => JSON.parse(literal));
  assert.equal(decoded.filter((value) => value === hostile).length, 14);
  for (const value of [".", `${hostile}/file`, `${hostile}/null`, `${hostile}/link`, `${hostile}-null`]) {
    assert.ok(decoded.includes(value));
  }
  assert.match(text, /\\u202eLEAD\\u2066nested\\u2069\\u200d\\ufe0f\\udb40\\udd00\\udbff\\udfff\\ud800X\\udfff\\nWork id=\\"fake\\"\\\\TAIL\\u061c/);
  assert.match(text, /summary=null/);
  assert.match(text, /name=null/);
});

test("preserves ordinary Unicode while making only invisible shaping controls visible", () => {
  const ordinary = "한국어 Hangul 눈 😀 עברית e\u0301";
  const text = formatSonnerText(projection({
    workGraph: {
      status: "valid",
      works: [{
        id: ordinary,
        type: "Overview",
        summary: "👩‍💻 ❤️",
        nodePath: "보통/😀",
        inputs: [],
        outputs: [],
      }],
    },
  }));
  assert.match(text, /id="한국어 Hangul 눈 😀 עברית é"/);
  assert.match(text, /summary="👩\\u200d💻 ❤\\ufe0f"/);
  assert.match(text, /node="보통\/😀"/);
  assert.doesNotMatch(text, /\\u65e5|\\ud83d\\ude00|e\\u0301/);
});

test("fails closed for every unknown fixed grammar token", () => {
  assert.throws(() => formatSonnerText(projection({ workGraph: { status: "valid\nFiles:", works: [] } })), /Unknown Work Graph status token/);
  assert.throws(() => formatSonnerText(projection({ runtime: { status: "available\nFiles:" } })), /Unknown Runtime status token/);
  assert.throws(() => formatSonnerText(projection({ runtime: { status: "available", health: "ok\nFiles:", reasons: [], tasks: [] } })), /Unknown Runtime health token/);
  assert.throws(() => formatSonnerText(projection({
    runtime: { status: "available", health: "ok", reasons: [], tasks: [{ id: "a", name: null, role: "execute", turnState: "running\nFiles:" }] },
  })), /Unknown Runtime Task state token/);
  assert.throws(() => formatSonnerText(projection({
    files: { root: { path: ".", name: ".", type: "directory", children: [{ path: "x", name: "x", type: "file\nRuntime:", summary: null }] } },
  })), /Unknown Files node type token/);
  assert.throws(() => formatSonnerText(projection({
    files: { root: { path: ".", name: ".", type: "file", children: [] } },
  })), /Files root must be a directory/);
});
