import path from "node:path";

import { resolveProject } from "../../runtime/source/project.mjs";
import {
  openSonnerProjectReadSession,
  readSonnerProject,
  SONNER_READER_TEXT_DETECTION_BYTES,
} from "./sonner-project-reader.mjs";
import { buildRuntimeProjection } from "./runtime.mjs";
import { formatSonnerText } from "./sonner-text.mjs";

export const SONNER_SCHEMA_VERSION = 10;
export const MAX_MARKDOWN_FRONTMATTER_BYTES = 64 * 1024;
export const SONNER_TEXT_DETECTION_BYTES = SONNER_READER_TEXT_DETECTION_BYTES;

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function scalar(value) {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim() || null;
  }
  return trimmed;
}

export function parseMarkdownSummary(source) {
  const normalized = source.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return null;
  const closing = normalized.slice(4).match(/\n---(?:\n|$)/);
  const end = closing ? closing.index + 4 : -1;
  if (end < 0) return null;
  const frontmatter = normalized.slice(4, end).split("\n");

  for (let index = 0; index < frontmatter.length; index += 1) {
    const match = frontmatter[index].match(/^summary\s*:\s*(.*)$/);
    if (!match) continue;
    const value = match[1].trim();
    if (![">", ">-", ">+", "|", "|-", "|+"].includes(value)) return scalar(value);

    const lines = [];
    for (index += 1; index < frontmatter.length; index += 1) {
      const line = frontmatter[index];
      if (line.trim() === "") {
        lines.push("");
        continue;
      }
      if (!/^\s+/.test(line)) break;
      lines.push(line.trim());
    }
    const joined = value.startsWith(">") ? lines.join(" ").replace(/\s+/g, " ") : lines.join("\n");
    return joined.trim() || null;
  }
  return null;
}

export class SonnerWorkGraphError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function graphFail(message, code = "INVALID_GRAPH", details) {
  throw new SonnerWorkGraphError(code, message, details);
}

function displayPath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function decodeXml(value, relativePath) {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|apos|gt|lt|quot);/gi,
    (entity, name) => {
      const normalized = name.toLowerCase();
      const named = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };
      if (normalized in named) return named[normalized];
      const codePoint = normalized.startsWith("#x")
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        graphFail(`${displayPath(relativePath)}: invalid XML entity ${entity}`);
      }
    },
  );
}

function readAttribute(attributes, name, relativePath, owner) {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  const value = match?.[1] ?? match?.[2];
  if (!value || value.trim() === "") {
    graphFail(`${displayPath(relativePath)}: ${owner} requires a non-empty ${name} attribute`);
  }
  return decodeXml(value, relativePath).trim();
}

export function parseWorkNode(xml, relativePath) {
  const normalized = xml.replace(/^\uFEFF/, "").replace(/^\s*<\?xml[^?]*\?>\s*/i, "");
  const root = normalized.match(/^\s*<work-node\b([^>]*)>([\s\S]*?)<\/work-node>\s*$/i);
  if (!root) graphFail(`${displayPath(relativePath)}: expected one <work-node> root element`);
  const id = readAttribute(root[1], "id", relativePath, "work-node");
  const type = readAttribute(root[1], "type", relativePath, "work-node");
  const summaryMatch = root[2].match(/<summary>([\s\S]*?)<\/summary>/i);
  if (!summaryMatch || summaryMatch[1].trim() === "") {
    graphFail(`${displayPath(relativePath)}: summary must be a non-empty element`);
  }
  const inputsMatch = root[2].match(/<inputs\b[^>]*>([\s\S]*?)<\/inputs>|<inputs\s*\/>/i);
  if (!inputsMatch) graphFail(`${displayPath(relativePath)}: inputs element is required`);
  const inputs = [...(inputsMatch[1] ?? "").matchAll(/<input\b([^>]*)\/>/gi)]
    .map((match) => readAttribute(match[1], "ref", relativePath, "input"));
  return {
    id,
    type,
    summary: decodeXml(summaryMatch[1], relativePath).replace(/\s+/g, " ").trim(),
    nodePath: displayPath(relativePath),
    inputs,
    relativePath: displayPath(relativePath),
  };
}

function findCycle(workById) {
  const visited = new Set();
  const active = new Set();
  const stack = [];
  function visit(id) {
    if (active.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return null;
    active.add(id);
    stack.push(id);
    for (const input of [...workById.get(id).inputs].sort(compareText)) {
      const cycle = visit(input);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(id);
    visited.add(id);
    return null;
  }
  for (const id of [...workById.keys()].sort(compareText)) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

export function validateAndOrderWorks(works) {
  const workById = new Map();
  for (const work of works) {
    if (workById.has(work.id)) {
      graphFail(`Duplicate Work ID "${work.id}" in ${workById.get(work.id).relativePath} and ${work.relativePath}`);
    }
    workById.set(work.id, work);
    const seenInputs = new Set();
    for (const input of work.inputs) {
      if (seenInputs.has(input)) graphFail(`${work.relativePath}: duplicate input Work "${input}"`);
      seenInputs.add(input);
    }
  }
  const overviews = works.filter((work) => work.type === "Overview");
  if (overviews.length !== 1) graphFail(`Work Graph must contain exactly one Overview Work; found ${overviews.length}`);
  if (overviews[0].inputs.length !== 0) graphFail(`${overviews[0].relativePath}: Overview Work must not declare inputs`);
  for (const work of works) {
    for (const input of work.inputs) {
      if (!workById.has(input)) graphFail(`${work.id}: missing input Work "${input}"`);
    }
  }
  const cycle = findCycle(workById);
  if (cycle) graphFail(`Work Graph contains a cycle: ${cycle.join(" -> ")}`);
  const reachable = new Set([overviews[0].id]);
  const queue = [overviews[0].id];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const work of works) {
      if (!reachable.has(work.id) && work.inputs.includes(current)) {
        reachable.add(work.id);
        queue.push(work.id);
      }
    }
  }
  const unreachable = works.map((work) => work.id).filter((id) => !reachable.has(id)).sort(compareText);
  if (unreachable.length > 0) graphFail(`Works unreachable from Overview: ${unreachable.join(", ")}`);
  const ordered = [];
  const emitted = new Set();
  while (ordered.length < works.length) {
    const ready = works.filter((work) => !emitted.has(work.id)
      && work.inputs.every((input) => emitted.has(input)))
      .sort((left, right) => compareText(left.id, right.id));
    for (const work of ready) {
      ordered.push(work);
      emitted.add(work.id);
    }
  }
  return ordered;
}

export function loadWorkGraphRecords(records, { workUnsafe = false, directory = "project" } = {}) {
  if (workUnsafe) graphFail(`Unsafe or changed WORK_NODE.xml metadata: ${directory}`);
  if (records.length === 0) graphFail(`No WORK_NODE.xml files found: ${directory}`, "NO_GRAPH");
  return validateAndOrderWorks(records.map(({ relativePath, xml }) => parseWorkNode(xml, relativePath)));
}

export async function loadWorkGraph(directory, { project = null, readerOptions = {} } = {}) {
  const resolved = project ?? await resolveProject(path.resolve(directory));
  const result = await readSonnerProject({ project: resolved, includeFiles: false, ...readerOptions });
  return loadWorkGraphRecords(result.works, { workUnsafe: result.workUnsafe, directory: resolved.root });
}

function hasPrefix(bytes, prefix) {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

export function isSonnerTextBytes(raw) {
  const bytes = raw.subarray(0, SONNER_TEXT_DETECTION_BYTES);
  if (hasPrefix(bytes, [0xef, 0xbb, 0xbf])
      || hasPrefix(bytes, [0xfe, 0xff])
      || hasPrefix(bytes, [0xff, 0xfe])) return true;

  let couldBeUtf16Le = true;
  let couldBeUtf16Be = true;
  let containsZero = false;
  for (let index = 0; index < bytes.length; index += 1) {
    const odd = index % 2 === 1;
    const zero = bytes[index] === 0;
    if (zero) containsZero = true;
    if (couldBeUtf16Le && ((odd && !zero) || (!odd && zero))) couldBeUtf16Le = false;
    if (couldBeUtf16Be && ((odd && zero) || (!odd && !zero))) couldBeUtf16Be = false;
    if (zero && !couldBeUtf16Le && !couldBeUtf16Be) return false;
  }
  return !containsZero || couldBeUtf16Le || couldBeUtf16Be;
}

function collectFiles(entries) {
  return entries.map((entry) => {
    const name = path.posix.basename(entry.path);
    if (entry.type !== "file") return { path: entry.path, name, type: entry.type };
    const text = isSonnerTextBytes(entry.raw);
    return {
      path: entry.path,
      name,
      type: "file",
      text,
      summary: text && /\.md$/i.test(entry.path)
        ? parseMarkdownSummary(entry.raw.toString("utf8"))
        : null,
    };
  });
}

function graphState(reader, root) {
  try {
    const works = loadWorkGraphRecords(reader.works, { workUnsafe: reader.workUnsafe, directory: root });
    return { status: "valid", works };
  } catch (error) {
    return error?.code === "NO_GRAPH"
      ? { status: "missing", works: [] }
      : { status: "invalid", works: [] };
  }
}

function publicWorkGraph(graph) {
  if (graph.status !== "valid") return { status: graph.status };
  const outputsById = new Map(graph.works.map((work) => [work.id, []]));
  for (const work of graph.works) {
    for (const input of work.inputs) outputsById.get(input).push(work.id);
  }
  return {
    status: "valid",
    works: graph.works.map(({ id, type, summary, nodePath, inputs }) => ({
      id,
      type,
      summary,
      nodePath,
      inputs,
      outputs: outputsById.get(id).sort(compareText),
    })),
  };
}

function directoryIndex(files) {
  const directories = new Set(["."]);
  for (const file of files) {
    const parts = file.path.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      directories.add(parts.slice(0, length).join("/"));
    }
  }
  return [...directories].sort(compareText);
}

function parentOf(projectPath) {
  if (projectPath === ".") return null;
  const parent = path.posix.dirname(projectPath);
  return parent === "." ? "." : parent;
}

function fileExtension(name) {
  const extension = path.posix.extname(name);
  return extension.length > 1 ? extension.slice(1).toLowerCase() : null;
}

function tree(files) {
  const directories = directoryIndex(files);
  const childDirectories = new Map(directories.map((directory) => [directory, []]));
  const childFiles = new Map(directories.map((directory) => [directory, []]));
  for (const directory of directories) {
    const parent = parentOf(directory);
    if (parent) childDirectories.get(parent)?.push(directory);
  }
  for (const file of files) childFiles.get(parentOf(file.path) ?? ".")?.push(file);

  function directoryNode(directory, root = false) {
    const node = {
      path: directory,
      name: root ? "." : path.posix.basename(directory),
      type: "directory",
    };

    const filesHere = childFiles.get(directory) ?? [];
    const fileCounts = new Map();
    for (const file of filesHere) {
      if (file.type === "file" && file.summary !== null) continue;
      const extension = fileExtension(file.name);
      fileCounts.set(extension, (fileCounts.get(extension) ?? 0) + 1);
    }

    const counts = [...fileCounts.entries()]
      .sort(([left], [right]) => compareText(left ?? "", right ?? ""))
      .map(([extension, count]) => ({ extension, count }));

    const children = [
      ...(childDirectories.get(directory) ?? [])
        .map((child) => directoryNode(child))
        .sort((left, right) => compareText(left.path, right.path)),
      ...filesHere
        .filter((file) => file.type === "file" && file.summary !== null)
        .map(({ text: _text, ...file }) => file)
        .sort((left, right) => compareText(left.path, right.path)),
      ...(counts.length === 0 ? [] : [{ type: "file-counts", counts }]),
    ];
    return { ...node, children };
  }
  return directoryNode(".", true);
}

function validProject(project) {
  return project && Object.isFrozen(project) && Object.isFrozen(project.rootIdentity)
    && typeof project.root === "string" && path.isAbsolute(project.root)
    && /^[0-9a-f]{64}$/.test(project.key)
    && typeof project.rootIdentity.dev === "bigint" && typeof project.rootIdentity.ino === "bigint";
}

export async function buildSonnerProject(project, {
  readerOptions = {},
  runtimeOptions = {},
  openSession = openSonnerProjectReadSession,
  readProject = readSonnerProject,
  runtimeBuilder = buildRuntimeProjection,
} = {}) {
  if (!validProject(project)) {
    const error = new Error("Sonner requires an authorized immutable Project.");
    error.code = "SONNER_PROJECT_READER_UNAVAILABLE";
    throw error;
  }
  const session = await openSession(project, readerOptions);
  try {
    const branches = [
      Promise.resolve().then(() => readProject({
        project,
        session,
        includeFiles: true,
        ...readerOptions,
      })),
      Promise.resolve().then(() => runtimeBuilder(project, { ...runtimeOptions, projectSession: session })),
    ].map((branch) => branch.catch((error) => {
      session.abort(error);
      throw error;
    }));
    const settled = await Promise.allSettled(branches);
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    session.throwIfAborted();
    const [reader, runtime] = settled.map((result) => result.value);
    const files = collectFiles(reader.entries);
    const graph = graphState(reader, project.root);
    const projection = {
      version: SONNER_SCHEMA_VERSION,
      workGraph: publicWorkGraph(graph),
      files: {
        root: tree(files),
      },
      runtime,
    };
    session.throwIfAborted();
    return projection;
  } finally {
    await session.close();
  }
}

export async function buildSonner(projectRoot, options = {}) {
  return buildSonnerProject(await resolveProject(path.resolve(projectRoot)), options);
}

export function serializeSonner(value) {
  return `${JSON.stringify(value)}\n`;
}

function parseArguments(argv) {
  let projectRoot = null;
  let json = false;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (seen.has(option)) return null;
    seen.add(option);
    if (option === "--project-root") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) return null;
      projectRoot = argv[index + 1];
      index += 1;
    } else if (option === "--json") json = true;
    else return null;
  }
  return projectRoot ? { projectRoot, json } : null;
}

function publicError(error, message) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : "SONNER_UNAVAILABLE";
  return { error: { code, message } };
}

function renderError(value, json) {
  return json
    ? serializeSonner(value)
    : `Sonner error code=${JSON.stringify(value.error.code)} message=${JSON.stringify(value.error.message)}\n`;
}

export async function runSonnerCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    const json = argv.includes("--json");
    process.stderr.write(renderError(
      publicError({ code: "SONNER_CLI_USAGE" }, "Usage: node sonner.mjs --project-root <path> [--json]"),
      json,
    ));
    process.exitCode = 1;
    return;
  }
  try {
    const projection = await buildSonner(options.projectRoot);
    process.stdout.write(options.json ? serializeSonner(projection) : formatSonnerText(projection));
  } catch (error) {
    process.stderr.write(renderError(
      publicError(error, "Sonner could not inspect this project safely."),
      options.json,
    ));
    process.exitCode = 1;
  }
}
