// Unicode 16.0 unsafe-display union, generated from:
// - https://www.unicode.org/Public/16.0.0/ucd/extracted/DerivedGeneralCategory.txt
//   General_Category Cc, Cf, Zl, and Zp
// - https://www.unicode.org/Public/16.0.0/ucd/DerivedCoreProperties.txt
//   Default_Ignorable_Code_Point
// - https://www.unicode.org/Public/16.0.0/ucd/PropList.txt
//   Noncharacter_Code_Point
// plus U+13440 and UTF-16 surrogate code points. Keep sorted and non-overlapping.
const UNSAFE_TEXT_RANGES = Object.freeze([
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x0600, 0x0605],
  [0x061c, 0x061c],
  [0x06dd, 0x06dd],
  [0x070f, 0x070f],
  [0x0890, 0x0891],
  [0x08e2, 0x08e2],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xd800, 0xdfff],
  [0xfdd0, 0xfdef],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0xfffe, 0xffff],
  [0x110bd, 0x110bd],
  [0x110cd, 0x110cd],
  [0x13430, 0x13440],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0x1fffe, 0x1ffff],
  [0x2fffe, 0x2ffff],
  [0x3fffe, 0x3ffff],
  [0x4fffe, 0x4ffff],
  [0x5fffe, 0x5ffff],
  [0x6fffe, 0x6ffff],
  [0x7fffe, 0x7ffff],
  [0x8fffe, 0x8ffff],
  [0x9fffe, 0x9ffff],
  [0xafffe, 0xaffff],
  [0xbfffe, 0xbffff],
  [0xcfffe, 0xcffff],
  [0xdfffe, 0xe0fff],
  [0xefffe, 0xeffff],
  [0xffffe, 0xfffff],
  [0x10fffe, 0x10ffff],
]);

for (let index = 1; index < UNSAFE_TEXT_RANGES.length; index += 1) {
  if (UNSAFE_TEXT_RANGES[index - 1][1] >= UNSAFE_TEXT_RANGES[index][0]) {
    throw new Error("Unicode unsafe-display ranges must stay sorted and non-overlapping");
  }
}

export function unsafeTextCodePoint(codePoint) {
  let low = 0;
  let high = UNSAFE_TEXT_RANGES.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const [start, end] = UNSAFE_TEXT_RANGES[middle];
    if (codePoint < start) high = middle - 1;
    else if (codePoint > end) low = middle + 1;
    else return true;
  }
  return false;
}

function visibleEscape(codePoint) {
  if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  const scalar = codePoint - 0x10000;
  const high = 0xd800 + (scalar >> 10);
  const low = 0xdc00 + (scalar & 0x3ff);
  return `\\u${high.toString(16)}\\u${low.toString(16)}`;
}

// Every present or future free-form field must route through quoted(),
// nullable(), or stringList(). Fixed grammar tokens use fixedToken() instead.
function quoted(value) {
  const serialized = JSON.stringify(value);
  let result = "";
  for (const character of serialized) {
    const codePoint = character.codePointAt(0);
    result += unsafeTextCodePoint(codePoint) ? visibleEscape(codePoint) : character;
  }
  return result;
}

function fixedToken(value, allowed, owner) {
  if (!allowed.includes(value)) throw new TypeError(`Unknown ${owner} token`);
  return value;
}

function nullable(value) {
  return value === null ? "null" : quoted(value);
}

function stringList(values) {
  return `[${values.map((value) => quoted(value)).join(",")}]`;
}

function compactExtension(value) {
  return /^[a-z0-9][a-z0-9+_-]*$/.test(value) ? value : quoted(value);
}

function formatWorkGraph(workGraph, lines) {
  const status = fixedToken(workGraph.status, ["valid", "missing", "invalid"], "Work Graph status");
  lines.push(`Work Graph: ${status}`);
  if (workGraph.status !== "valid") return;
  if (workGraph.works.length === 0) {
    lines.push("  Works: empty");
    return;
  }
  for (const work of workGraph.works) {
    lines.push(
      `  Work id=${quoted(work.id)} type=${quoted(work.type)} node=${quoted(work.nodePath)}`
      + ` inputs=${stringList(work.inputs)} outputs=${stringList(work.outputs)}`
      + ` keyPoints=${quoted(work.keyPoints)}`,
    );
  }
}

function formatFileNode(node, lines, depth) {
  const indentation = "  ".repeat(depth);
  const type = fixedToken(node.type, ["directory", "file", "file-counts", "warning"], "Files node type");
  if (type === "directory") {
    lines.push(`${indentation}Directory path=${quoted(node.path)}`);
    for (const child of node.children) formatFileNode(child, lines, depth + 1);
    return;
  }
  if (type === "file") {
    if (typeof node.keyPoints !== "string" || node.keyPoints.length === 0) throw new TypeError("Invalid file keyPoints");
    lines.push(`${indentation}File path=${quoted(node.path)} keyPoints=${quoted(node.keyPoints)}`);
    return;
  }
  if (type === "warning") {
    const code = fixedToken(node.code, ["legacy-work-node"], "Files warning code");
    if (typeof node.path !== "string" || node.path.length === 0
        || typeof node.renameTo !== "string" || node.renameTo.length === 0) {
      throw new TypeError("Invalid Files warning");
    }
    lines.push(`${indentation}Warning code=${code} path=${quoted(node.path)} renameTo=${quoted(node.renameTo)}`);
    return;
  }
  if (type === "file-counts") {
    if (!Array.isArray(node.counts) || node.counts.length === 0) throw new TypeError("Invalid file counts");
    const values = node.counts.map(({ extension, count }) => {
      if ((extension !== null && (typeof extension !== "string" || extension.length === 0))
          || !Number.isInteger(count) || count <= 0) throw new TypeError("Invalid file count");
      return `${count} ${extension === null ? "extensionless" : compactExtension(extension)}`;
    });
    lines.push(`${indentation}${values.join(", ")}`);
    return;
  }
}

function formatFiles(files, lines) {
  const root = files.root;
  if (root.type !== "directory") throw new TypeError("Files root must be a directory");
  if (root.children.length === 0) {
    lines.push("Files: empty");
    return;
  }
  lines.push("Files:");
  formatFileNode(root, lines, 1);
}

function formatRuntime(runtime, lines) {
  const status = fixedToken(runtime.status, ["available", "missing", "invalid"], "Runtime status");
  if (status !== "available") {
    lines.push(`Runtime: ${status}`);
    return;
  }
  const health = fixedToken(runtime.health, ["ok", "attention", "unknown"], "Runtime health");
  lines.push(
    `Runtime: available health=${health} reasons=${stringList(runtime.reasons)}`,
  );
  if (runtime.tasks.length === 0) {
    lines.push("  Tasks: empty");
    return;
  }
  for (const task of runtime.tasks) {
    const turnState = fixedToken(
      task.turnState,
      ["not_started", "running", "aborted", "unknown"],
      "Runtime Task state",
    );
    lines.push(
      `  Task id=${quoted(task.id)} name=${nullable(task.name)}`
      + ` role=${quoted(task.role)} state=${turnState}`,
    );
  }
}

export function formatSonnerText(value) {
  const lines = [`Sonner v${value.version}`];
  formatWorkGraph(value.workGraph, lines);
  formatFiles(value.files, lines);
  formatRuntime(value.runtime, lines);
  return `${lines.join("\n")}\n`;
}
