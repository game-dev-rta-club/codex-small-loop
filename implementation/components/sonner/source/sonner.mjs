import { runSonnerExtensions } from "./sonner-extensions.mjs";
import { normalizeSonnerPath, below, validateSonnerQuery } from "./sonner-options.mjs";
import path from "node:path";

import { resolveProject } from "../../runtime/source/project.mjs";
import {
  openSonnerProjectReadSession,
  readSonnerProject,
  SONNER_READER_TEXT_DETECTION_BYTES,
} from "./sonner-project-reader.mjs";
import { buildRuntimeProjection } from "./runtime.mjs";
import { formatSonnerText } from "./sonner-text.mjs";

export const SONNER_SCHEMA_VERSION = 13;
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

export function parseMarkdownKeyPoints(source) {
  const normalized = source.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return null;
  const closing = normalized.slice(4).match(/\n---(?:\n|$)/);
  const end = closing ? closing.index + 4 : -1;
  if (end < 0) return null;
  const frontmatter = normalized.slice(4, end).split("\n");

  for (let index = 0; index < frontmatter.length; index += 1) {
    const match = frontmatter[index].match(/^keyPoints\s*:\s*(.*)$/);
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
  const keyPointsMatch = root[2].match(/<keyPoints>([\s\S]*?)<\/keyPoints>/i);
  if (!keyPointsMatch || keyPointsMatch[1].trim() === "") {
    graphFail(`${displayPath(relativePath)}: keyPoints must be a non-empty element`);
  }
  const inputsMatch = root[2].match(/<inputs\b[^>]*>([\s\S]*?)<\/inputs>|<inputs\s*\/>/i);
  if (!inputsMatch) graphFail(`${displayPath(relativePath)}: inputs element is required`);
  const inputs = [...(inputsMatch[1] ?? "").matchAll(/<input\b([^>]*)\/>/gi)]
    .map((match) => readAttribute(match[1], "ref", relativePath, "input"));
  return {
    id,
    type,
    keyPoints: decodeXml(keyPointsMatch[1], relativePath).replace(/\s+/g, " ").trim(),
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
  if (workUnsafe) graphFail(`Unsafe or changed .WORK_NODE.xml metadata: ${directory}`);
  if (records.length === 0) graphFail(`No .WORK_NODE.xml files found: ${directory}`, "NO_GRAPH");
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

function collectFiles(entries, metadata = new Map()) {
  return entries.map((entry) => {
    const name = path.posix.basename(entry.path);
    if (entry.type !== "file") return { path: entry.path, name, type: entry.type };
    const text = isSonnerTextBytes(entry.raw);
    return {
      path: entry.path,
      name,
      type: "file",
      text,
      keyPoints: text && /\.md$/i.test(entry.path)
        ? parseMarkdownKeyPoints(entry.raw.toString("utf8"))
        : null,
      ...(metadata.get(entry.path) ?? {}),
    };
  });
}

function graphState(reader, root) {
  try {
    if (reader.selection?.partial) {
      if (reader.workUnsafe) throw new Error("Unsafe partial graph");
      const works = reader.works.map(({ xml, relativePath }) => parseWorkNode(xml, relativePath));
      if (new Set(works.map(({ id }) => id)).size !== works.length) throw new Error("Duplicate Work IDs");
      return { status: "partial", works: works.sort((a, b) => compareText(a.id, b.id)) };
    }
    const works = loadWorkGraphRecords(reader.works, { workUnsafe: reader.workUnsafe, directory: root });
    return { status: "valid", works };
  } catch (error) {
    return error?.code === "NO_GRAPH"
      ? { status: "missing", works: [] }
      : { status: "invalid", works: [] };
  }
}

function publicWorkGraph(graph) {
  if (!["valid", "partial"].includes(graph.status)) return { status: graph.status };
  const outputsById = new Map(graph.works.map((work) => [work.id, []]));
  for (const work of graph.works) {
    for (const input of work.inputs) outputsById.get(input)?.push(work.id);
  }
  return {
    status: graph.status,
    works: graph.works.map(({ id, type, keyPoints, nodePath, inputs }) => ({
      id,
      type,
      keyPoints,
      nodePath,
      inputs,
      outputs: outputsById.get(id).sort(compareText),
    })),
  };
}

function directoryIndex(entries) {
  const directories = new Set(["."]);
  for (const entry of entries) {
    const parts = entry.path.split("/");
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

function legacyWarning(projectPath) {
  const parent = parentOf(projectPath);
  return {
    path: projectPath,
    name: "WORK_NODE.xml",
    type: "warning",
    code: "legacy-work-node",
    renameTo: parent === null || parent === "." ? ".WORK_NODE.xml" : `${parent}/.WORK_NODE.xml`,
  };
}

function tree(files, legacyWorkNodes = [], rootPath = ".", countMetadata = false) {
  const warnings = legacyWorkNodes.map(legacyWarning);
  const directories = [...new Set([rootPath, ...directoryIndex([...files, ...warnings]).filter((directory) => below(directory, rootPath))])].sort(compareText);
  const childDirectories = new Map(directories.map((directory) => [directory, []]));
  const childFiles = new Map(directories.map((directory) => [directory, []]));
  const childWarnings = new Map(directories.map((directory) => [directory, []]));
  for (const directory of directories) {
    const parent = parentOf(directory);
    if (parent) childDirectories.get(parent)?.push(directory);
  }
  for (const file of files) childFiles.get(parentOf(file.path) ?? ".")?.push(file);
  for (const warning of warnings) childWarnings.get(parentOf(warning.path) ?? ".")?.push(warning);

  function directoryNode(directory, root = false) {
    const node = {
      path: directory,
      name: root && directory === "." ? "." : path.posix.basename(directory),
      type: "directory",
    };

    const filesHere = childFiles.get(directory) ?? [];
    const fileCounts = new Map();
    for (const file of filesHere) {
      if (!countMetadata && file.type === "file" && (file.keyPoints != null || file.summary != null)) continue;
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
      ...(childWarnings.get(directory) ?? [])
        .sort((left, right) => compareText(left.path, right.path)),
      ...filesHere
        .filter((file) => file.type === "file" && (file.keyPoints != null || file.summary != null))
        .map(({ text: _text, ...file }) => file)
        .sort((left, right) => compareText(left.path, right.path)),
      ...(counts.length === 0 ? [] : [{ type: "file-counts", counts }]),
    ];
    return { ...node, children };
  }
  return directoryNode(rootPath, true);
}

function validProject(project) {
  return project && Object.isFrozen(project) && Object.isFrozen(project.rootIdentity)
    && typeof project.root === "string" && path.isAbsolute(project.root)
    && /^[0-9a-f]{64}$/.test(project.key)
    && typeof project.rootIdentity.dev === "bigint" && typeof project.rootIdentity.ino === "bigint";
}

export async function buildSonnerProject(project, {
  includeRuntime = true,
  query = {},
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
  query = validateSonnerQuery(query);
  const session = await openSession(project, readerOptions);
  try {
    const branches = [
      Promise.resolve().then(() => readProject({
        project,
        session,
        includeFiles: true,
        query,
        ...readerOptions,
      })),
      Promise.resolve().then(() => includeRuntime
        ? runtimeBuilder(project, { ...runtimeOptions, projectSession: session })
        : undefined),
    ].map((branch) => branch.catch((error) => {
      session.abort(error);
      throw error;
    }));
    const settled = await Promise.allSettled(branches);
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    session.throwIfAborted();
    const [reader, runtime] = settled.map((result) => result.value);
    const legacyWorkNodes = reader.legacyWorkNodes ?? [];
    const legacyPaths = new Set(legacyWorkNodes);
    const metadata = query.extensions
      ? await runSonnerExtensions(project, reader.entries, reader.extensions ?? [], session)
      : new Map();
    const files = collectFiles(reader.entries, metadata).filter((entry) => !legacyPaths.has(entry.path));
    const graph = graphState(reader, project.root);
    const projection = {
      version: SONNER_SCHEMA_VERSION,
      workGraph: publicWorkGraph(graph),
      files: {
        root: tree(
          query.metadataOnly ? files.filter((file) => file.type === "file" && (file.keyPoints != null || file.summary != null)) : files,
          query.metadataOnly ? [] : legacyWorkNodes,
          reader.selection?.path ?? ".",
          query.metadataOnly === true,
        ),
      },
      runtime,
    };
    if (!includeRuntime) delete projection.runtime;
    if (query.metadataOnly) projection.metadataOnly = true;
    if (reader.selection?.partial) projection.selection = reader.selection;
    if (query.noKeyPoints) {
      for (const work of projection.workGraph.works ?? []) delete work.keyPoints;
      const hide = (node) => { delete node.keyPoints; for (const child of node.children ?? []) hide(child); };
      hide(projection.files.root);
    }
    if (query.depth !== undefined) {
      const trim = (node, depth) => {
        if (node.type !== "directory") return;
        if (depth === query.depth) {
          const directories = node.children.filter((child) => child.type === "directory");
          if (directories.length) node.truncated = true;
          node.children = node.children.filter((child) => child.type !== "directory");
        } else for (const child of node.children) trim(child, depth + 1);
      };
      trim(projection.files.root, 0);
      projection.maxDepth = query.depth;
    }
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

function parseArguments(argv, defaults) {
  let projectRoot = defaults.projectRoot ?? null;
  let json = false;
  let includeRuntime = defaults.includeRuntime ?? true;
  let timeoutMs = 5_000;
  const query = {};
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
    else if (option === "--runtime") includeRuntime = true;
    else if (option === "--extensions") query.extensions = true;
    else if (option === "--metadata-only") query.metadataOnly = true;
    else if (option === "--no-key-points") query.noKeyPoints = true;
    else if (option === "--path") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) return null;
      try { query.path = normalizeSonnerPath(argv[++index]); } catch { return null; }
    } else if (option === "--depth") {
      const value = argv[++index];
      if (!/^(?:0|[1-9][0-9]*)$/.test(value ?? "")) return null;
      query.depth = Number(value);
      if (!Number.isSafeInteger(query.depth) || query.depth > 128) return null;
    }
    else if (option === "--timeout-ms") {
      const value = argv[++index];
      if (!/^[1-9][0-9]*$/.test(value ?? "")) return null;
      timeoutMs = Number(value);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 300_000) return null;
    }
    else return null;
  }
  return projectRoot ? { projectRoot, json, includeRuntime, timeoutMs, query } : null;
}

function publicError(error, message) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : "SONNER_UNAVAILABLE";
  return { error: { code, message, ...(code === "SONNER_EXTENSION_FAILED" && typeof error.details === "string" ? { details: error.details.slice(0, 4096) } : {}) } };
}

function renderError(value, json) {
  return json
    ? serializeSonner(value)
    : `Sonner error code=${JSON.stringify(value.error.code)} message=${JSON.stringify(value.error.message)}${value.error.details ? ` details=${JSON.stringify(value.error.details)}` : ""}\n`;
}

export const SONNER_CLI_USAGE = "Usage: small-loop sonner [--project-root <path>] [--json] [--runtime] [--extensions] [--no-key-points] [--metadata-only] [--depth <0..128>] [--path <directory>] [--timeout-ms <1..300000>]";

export async function runSonnerCli(argv = process.argv.slice(2), defaults = {}) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    process.stdout.write(`${SONNER_CLI_USAGE}\n`);
    return;
  }
  const options = parseArguments(argv, defaults);
  if (!options) {
    const json = argv.includes("--json");
    process.stderr.write(renderError(
      publicError({ code: "SONNER_CLI_USAGE" }, SONNER_CLI_USAGE),
      json,
    ));
    process.exitCode = 1;
    return;
  }
  try {
    const projection = await buildSonner(options.projectRoot, {
      includeRuntime: options.includeRuntime,
      query: options.query,
      readerOptions: { timeoutMs: options.timeoutMs },
    });
    process.stdout.write(options.json ? serializeSonner(projection) : formatSonnerText(projection));
  } catch (error) {
    process.stderr.write(renderError(
      publicError(error, "Sonner could not inspect this project safely."),
      options.json,
    ));
    process.exitCode = 1;
  }
}
