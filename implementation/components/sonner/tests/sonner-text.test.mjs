import assert from "node:assert/strict";
import test from "node:test";

import { formatSonnerText, unsafeTextCodePoint } from "../source/sonner-text.mjs";

function projection(overrides = {}) {
  return {
    version: 13,
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
    "Sonner v13",
    "Work Graph: missing",
    "Files: empty",
    "Runtime: missing",
    "",
  ].join("\n"));

  assert.equal(formatSonnerText(projection({
    workGraph: { status: "invalid" },
    runtime: { status: "invalid" },
  })), [
    "Sonner v13",
    "Work Graph: invalid",
    "Files: empty",
    "Runtime: invalid",
    "",
  ].join("\n"));

  assert.equal(formatSonnerText(projection({
    workGraph: { status: "valid", works: [] },
    runtime: { status: "available", health: "ok", reasons: [], tasks: [] },
  })), [
    "Sonner v13",
    "Work Graph: valid",
    "  Works: empty",
    "Files: empty",
    "Runtime: available health=ok reasons=[]",
    "  Tasks: empty",
    "",
  ].join("\n"));
});

test("formats Works, files with key points, compact counts, and active Runtime Tasks without ambiguity", () => {
  const value = projection({
    workGraph: {
      status: "valid",
      works: [{
        id: "overview",
        type: "Overview",
        keyPoints: "Project overview.",
        nodePath: "overview/.WORK_NODE.xml",
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
          { path: "docs", name: "docs", type: "directory", children: [
            { path: "docs/WORK_NODE.xml", name: "WORK_NODE.xml", type: "warning",
              code: "legacy-work-node", renameTo: "docs/.WORK_NODE.xml" },
          ] },
          {
            path: "src",
            name: "src",
            type: "directory",
            children: [
              { type: "file-counts", counts: [
                { extension: "meta", count: 53 },
                { extension: "png", count: 53 },
              ] },
            ],
          },
          { path: "README.md", name: "README.md", type: "file", keyPoints: "Project keyPoints." },
          { type: "file-counts", counts: [{ extension: null, count: 1 }] },
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
    "Sonner v13",
    "Work Graph: valid",
    "  overview",
    "    Project overview.",
    "    nodeDir: overview/",
    "    input: none",
    "    output: implementation",
    "Files:",
    "  ./ 1 extensionless",
    "    docs/",
    "      Warning code=legacy-work-node path=\"docs/WORK_NODE.xml\" renameTo=\"docs/.WORK_NODE.xml\"",
    "    src/ 53 meta, 53 png",
    "    README.md keyPoints=\"Project keyPoints.\"",
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
        keyPoints: unsafe,
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
          { path: unsafe, name: unsafe, type: "directory", children: [] },
          { path: `${unsafe}/file`, name: unsafe, type: "file", keyPoints: unsafe },
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
  assert.equal(text.split("\n").length, 14, "embedded separators never create records");
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
          keyPoints: "keyPoints",
          nodePath: ".WORK_NODE.xml",
          inputs: [],
          outputs: [],
        }],
      },
    }));
    const literal = text.match(/^  ("(?:\\.|[^"\\])*")$/m)[1];
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
        works: [{ id: source, type: "Overview", keyPoints: "keyPoints", nodePath: "node", inputs: [], outputs: [] }],
      },
    }));
    const literal = text.match(/^  ("(?:\\.|[^"\\])*")$/m)[1];
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
        keyPoints: hostile,
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
          { path: hostile, name: hostile, type: "directory", children: [] },
          { path: `${hostile}/file`, name: hostile, type: "file", keyPoints: hostile },
          { type: "file-counts", counts: [{ extension: hostile, count: 2 }] },
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
  assert.equal(lines.length, 15, "hostile values cannot create physical records");
  assert.deepEqual(lines.filter((line) => /^(Sonner|Work Graph:|Files:|Runtime:)/.test(line)).map((line) => line.split(" ")[0]), [
    "Sonner", "Work", "Files:", "Runtime:",
  ]);
  for (const line of lines) {
    for (const character of line) {
      assert.equal(unsafeTextCodePoint(character.codePointAt(0)), false, `raw U+${character.codePointAt(0).toString(16)}`);
    }
  }
  const literals = [...text.matchAll(/"(?:\\.|[^"\\])*"/g)].map((match) => match[0]);
  assert.equal(literals.length, 14);
  for (const literal of literals) assert.doesNotThrow(() => JSON.parse(literal));
  const decoded = literals.map((literal) => JSON.parse(literal));
  assert.equal(decoded.filter((value) => value === hostile).length, 12);
  for (const value of [`${hostile}-null`]) {
    assert.ok(decoded.includes(value));
  }
  assert.match(text, /\\u202eLEAD\\u2066nested\\u2069\\u200d\\ufe0f\\udb40\\udd00\\udbff\\udfff\\ud800X\\udfff\\nWork id=\\"fake\\"\\\\TAIL\\u061c/);
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
        keyPoints: "👩‍💻 ❤️",
        nodePath: "보통/😀",
        inputs: [],
        outputs: [],
      }],
    },
  }));
  assert.match(text, /^  한국어 Hangul 눈 😀 עברית é$/m);
  assert.match(text, /"👩\\u200d💻 ❤\\ufe0f"/);
  assert.match(text, /nodeDir: 보통\//);
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
    files: { root: { path: ".", name: ".", type: "directory", children: [{ path: "x", name: "x", type: "file\nRuntime:", keyPoints: null }] } },
  })), /Unknown Files node type token/);
  assert.throws(() => formatSonnerText(projection({
    files: { root: { path: ".", name: ".", type: "file", children: [] } },
  })), /Files root must be a directory/);
});

test("marks the exact Work directory before counts without marking namesakes or descendants", () => {
  const directory = (path, children = []) => ({ type: "directory", path, children });
  const files = { root: directory(".", [
    directory("Combat", [{ type: "file-counts", counts: [{ extension: "meta", count: 1 }, { extension: "cs", count: 3 }] }, directory("Combat/Effects")]),
    directory("Other", [directory("Other/Combat")]),
  ]) };
  const value = projection({ files, workGraph: { status: "valid", works: [{
    id: "combat", type: "Implementation", keyPoints: "Combat logic", nodePath: "Combat/.WORK_NODE.xml", inputs: [], outputs: [],
  }] } });
  assert.equal(formatSonnerText(value).split("Files:\n")[1].split("Runtime:")[0],
    "  ./\n    Combat/ [WORK_NODE: combat] 1 meta, 3 cs\n      Effects/\n    Other/\n      Combat/\n");
  assert.doesNotMatch(formatSonnerText(projection({ files })), /WORK_NODE:/);
});

test("shows a root Work node even when no visible files remain", () => {
  const value = projection({ workGraph: { status: "valid", works: [{
    id: "root", type: "Overview", keyPoints: "Purpose", nodePath: ".WORK_NODE.xml", inputs: [], outputs: [],
  }] } });
  assert.match(formatSonnerText(value), /Files:\n  \.\/ \[WORK_NODE: root\]\n/);
});
