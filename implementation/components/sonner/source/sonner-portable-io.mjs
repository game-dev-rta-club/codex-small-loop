import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import { createTaskEventReducer, scanCodexTaskEvents } from "../../runtime/source/codex-jsonl.mjs";
import { locateTaskHistories, resolveCodexSessionRoots } from "../../runtime/source/codex-session-locator.mjs";
import { classifyPortablePathMetadata } from "../../runtime/source/portable-path-type.mjs";

const execFileAsync = promisify(execFile);
const MAX_GIT_BYTES = 32 * 1024 * 1024;
const MAX_PATHS = 10_000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_WORK_DISCOVERY_ENTRIES = 100_000;
const MAX_HISTORY_BYTES = 256 * 1024 * 1024;
const MAX_HISTORY_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_DISCOVERY_ENTRIES = 100_000;
const EXCLUDED_PROJECT_DIRECTORY_NAMES = new Set([
  ".git", ".codex-small-loop", ".cache", ".next", ".parcel-cache",
  ".pytest_cache", ".turbo", "__pycache__", "build", "cache",
  "coverage", "dist", "node_modules", "out", "target",
]);

function portableError(message = "Portable Sonner reader unavailable.") {
  const error = new Error(message);
  error.code = "SONNER_PROJECT_READER_UNAVAILABLE";
  return error;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFile(left, right) {
  return sameIdentity(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function validProjectPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/")
      || value.includes("\0") || Buffer.byteLength(value, "utf8") > 4096) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".."
    && !part.includes("\\") && Buffer.byteLength(part, "utf8") <= 512);
}

async function assertRoot(session) {
  session.throwIfAborted();
  const status = await lstat(session.project.root, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink()
      || !sameIdentity(status, session.project.rootIdentity)) throw portableError("Sonner project Root identity changed.");
  return status;
}

async function inspectAncestors(root, projectPath) {
  const components = projectPath.split("/");
  let current = root;
  const retained = [];
  for (let index = 0; index < components.length - 1; index += 1) {
    current = path.join(current, components[index]);
    const status = await lstat(current, { bigint: true });
    if (!status.isDirectory() || status.isSymbolicLink()) throw portableError("Sonner path ancestor is unsafe.");
    retained.push({ file: current, status });
  }
  return retained;
}

async function revalidateAncestors(retained) {
  for (const item of retained) {
    const status = await lstat(item.file, { bigint: true });
    if (!status.isDirectory() || status.isSymbolicLink() || !sameIdentity(status, item.status)) return false;
  }
  return true;
}

async function inspectPortableSonnerPath(session, projectPath, {
  lstatPath = lstat,
} = {}) {
  if (!validProjectPath(projectPath)) throw portableError("Invalid Sonner project path.");
  await assertRoot(session);
  const ancestors = await inspectAncestors(session.project.root, projectPath);
  const filename = path.join(session.project.root, ...projectPath.split("/"));
  const pathname = await lstatPath(filename, { bigint: true });
  if (!(await revalidateAncestors(ancestors))) {
    throw portableError("Sonner path ancestor changed.");
  }
  await assertRoot(session);
  return {
    type: classifyPortablePathMetadata(pathname),
    filename,
    pathname,
    ancestors,
  };
}

function isExcludedProjectPath(projectPath) {
  return projectPath.split("/").some((part) => (
    EXCLUDED_PROJECT_DIRECTORY_NAMES.has(part)
  ));
}

export async function detectPortableSonnerPath(session, projectPath, options = {}) {
  return (await inspectPortableSonnerPath(session, projectPath, options)).type;
}

async function readInspectedPortableSonnerRegularFile(session, inspected, maximum) {
  if (inspected.type !== "regular-file"
      || inspected.pathname.size > BigInt(maximum)) {
    throw portableError("Sonner file is unavailable or oversized.");
  }
  const { ancestors, filename, pathname } = inspected;
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(pathname, opened)) throw portableError("Sonner file identity changed.");
    const raw = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < raw.length) {
      session.throwIfAborted();
      const { bytesRead } = await handle.read(raw, offset, raw.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const final = await handle.stat({ bigint: true });
    const current = await lstat(filename, { bigint: true });
    if (offset !== raw.length || !sameFile(opened, final) || !sameFile(opened, current)
        || !(await revalidateAncestors(ancestors))) throw portableError("Sonner file changed while reading.");
    await assertRoot(session);
    return { type: "file", raw };
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readPortableSonnerRegularFile(session, projectPath, maximum) {
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > MAX_GIT_BYTES) {
    throw portableError("Invalid Sonner regular file bound.");
  }
  return (await readInspectedPortableSonnerRegularFile(
    session,
    await inspectPortableSonnerPath(session, projectPath),
    maximum,
  )).raw;
}

function parseGitPaths(output, maximum = MAX_GIT_BYTES) {
  if (!Buffer.isBuffer(output) || output.length > maximum || (output.length > 0 && output.at(-1) !== 0)) {
    throw portableError("Sonner Git output is invalid.");
  }
  if (output.length === 0) return [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths = output.subarray(0, -1).toString("binary").split("\0")
    .map((raw) => decoder.decode(Buffer.from(raw, "binary")));
  if (paths.length > MAX_PATHS || paths.some((entry) => !validProjectPath(entry))) {
    throw portableError("Sonner Git paths are invalid or bounded.");
  }
  return [...new Set(paths)]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .filter((projectPath) => !isExcludedProjectPath(projectPath));
}

async function admittedPaths(session, environment = process.env) {
  await assertRoot(session);
  session.throwIfAborted();
  const remaining = session.remainingMs();
  if (remaining <= 0) throw session.signal.reason ?? portableError();
  const { stdout } = await execFileAsync("git", [
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=NUL",
    "-c", "core.untrackedCache=false",
    "-c", "core.pager=cat",
    "-C", session.project.root,
    "ls-files", "-z", "--cached", "--others", "--exclude-standard",
  ], {
    shell: false,
    encoding: "buffer",
    maxBuffer: MAX_GIT_BYTES,
    timeout: remaining,
    windowsHide: true,
    env: {
      PATH: environment.PATH ?? environment.Path ?? "",
      PATHEXT: environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      SystemRoot: environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows",
      HOME: environment.HOME ?? environment.USERPROFILE ?? "",
      USERPROFILE: environment.USERPROFILE ?? environment.HOME ?? "",
      XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME ?? "",
      LC_ALL: "C",
      LANG: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
    },
  });
  await assertRoot(session);
  return parseGitPaths(stdout);
}

async function readPortableDirectory(session, projectDirectory) {
  await assertRoot(session);
  const directory = projectDirectory === "."
    ? session.project.root
    : path.join(session.project.root, ...projectDirectory.split("/"));
  const before = await lstat(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw portableError("Sonner Work directory is unsafe.");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const after = await lstat(directory, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || !sameFile(before, after)) {
    throw portableError("Sonner Work directory changed during discovery.");
  }
  await assertRoot(session);
  return entries.sort((left, right) => Buffer.compare(
    Buffer.from(left.name, "utf8"),
    Buffer.from(right.name, "utf8"),
  ));
}

async function discoverPortableWorks(session, {
  maxWorks,
  maxWorkBytes,
  maxOutputBytes,
}) {
  const directories = ["."];
  let directoryIndex = 0;
  const works = [];
  let discoveredEntries = 0;
  let outputBytes = 0;
  let workUnsafe = false;
  while (directoryIndex < directories.length) {
    session.throwIfAborted();
    const directory = directories[directoryIndex];
    directoryIndex += 1;
    let entries;
    try {
      entries = await readPortableDirectory(session, directory);
    } catch {
      if (directory === ".") throw portableError("Sonner Work discovery failed.");
      workUnsafe = true;
      continue;
    }
    discoveredEntries += entries.length;
    if (discoveredEntries > MAX_WORK_DISCOVERY_ENTRIES) {
      workUnsafe = true;
      break;
    }
    for (const entry of entries) {
      const projectPath = directory === "."
        ? entry.name
        : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!EXCLUDED_PROJECT_DIRECTORY_NAMES.has(entry.name)) {
          directories.push(projectPath);
        }
        continue;
      }
      if (entry.name !== "WORK_NODE.xml") continue;
      if (works.length >= maxWorks) {
        workUnsafe = true;
        continue;
      }
      try {
        const raw = await readPortableSonnerRegularFile(
          session,
          projectPath,
          maxWorkBytes,
        );
        outputBytes += raw.length;
        if (outputBytes > maxOutputBytes) {
          throw portableError("Sonner Work output is bounded.");
        }
        works.push({
          relativePath: projectPath,
          xml: new TextDecoder("utf-8", { fatal: true }).decode(raw),
        });
      } catch {
        workUnsafe = true;
      }
    }
  }
  works.sort((left, right) => Buffer.compare(
    Buffer.from(left.relativePath, "utf8"),
    Buffer.from(right.relativePath, "utf8"),
  ));
  return { works, workUnsafe, outputBytes };
}

async function readPortableIndexEntry(session, projectPath, maximum) {
  let inspected = await inspectPortableSonnerPath(session, projectPath);
  if (inspected.type === "symlink") {
    return { path: projectPath, type: "symlink", raw: Buffer.alloc(0) };
  }
  if (inspected.type !== "regular-file") return null;
  if (maximum === 0 || inspected.pathname.size > BigInt(maximum)) {
    return { path: projectPath, type: "file", raw: Buffer.alloc(0) };
  }
  try {
    const record = await readInspectedPortableSonnerRegularFile(
      session,
      inspected,
      maximum,
    );
    return { path: projectPath, type: "file", raw: record.raw };
  } catch {
    inspected = await inspectPortableSonnerPath(session, projectPath);
    if (inspected.type === "symlink") {
      return { path: projectPath, type: "symlink", raw: Buffer.alloc(0) };
    }
    return inspected.type === "regular-file"
      ? { path: projectPath, type: "file", raw: Buffer.alloc(0) }
      : null;
  }
}

export async function readPortableSonnerProject({ project, session, includeFiles = true,
  maxWorks = 1024, maxWorkBytes = 256 * 1024, maxOutputBytes = 16 * 1024 * 1024,
  environment = process.env } = {}) {
  if (!session || session.project !== project || session.closed || session.platform !== "win32") throw portableError();
  const discovered = await discoverPortableWorks(session, {
    maxWorks,
    maxWorkBytes,
    maxOutputBytes,
  });
  const paths = includeFiles ? await admittedPaths(session, environment) : [];
  const entries = [];
  const { works, workUnsafe } = discovered;
  let { outputBytes } = discovered;
  for (const projectPath of paths) {
    session.throwIfAborted();
    try {
      const maximum = /\.md$/i.test(projectPath) ? MAX_FILE_BYTES : 0;
      const record = await readPortableIndexEntry(session, projectPath, maximum);
      if (record === null) continue;
      outputBytes += record.raw.length;
      if (outputBytes > maxOutputBytes) throw portableError("Sonner output is bounded.");
      entries.push(record);
    } catch { /* A vanished or unsafe admitted path is omitted. */ }
  }
  await assertRoot(session);
  return { entries, works, workUnsafe };
}

export async function readPortableRuntimeRecord({ session, mode } = {}) {
  if (!session || session.closed || session.platform !== "win32") throw portableError();
  const projectPath = mode === "ledger" ? ".codex-small-loop/state.json"
    : mode === "diagnostic" ? ".codex-small-loop/recovery-supervisor-error.json" : null;
  const maximum = mode === "ledger" ? 32 * 1024 * 1024 : mode === "diagnostic" ? 64 * 1024 : 0;
  if (!projectPath) throw portableError();
  try {
    const bytes = await readPortableSonnerRegularFile(session, projectPath, maximum);
    return { status: "present", bytes };
  } catch (error) {
    const filename = path.join(session.project.root, ...projectPath.split("/"));
    try { await lstat(filename); } catch (cause) { if (cause?.code === "ENOENT") return { status: "missing" }; }
    return { status: "unsafe" };
  }
}

function unknown(taskId, location = "missing") {
  return { taskId, location, historyFile: null, latestTurnId: null, turnState: "unknown",
    diagnostics: [{ code: "TASK_HISTORY_UNAVAILABLE" }] };
}

export async function observePortableSonnerTasks(requests, options = {}) {
  const taskIds = requests.map(({ taskId }) => taskId);
  if (taskIds.length === 0) return [];
  try {
    const operation = options.session ?? null;
    operation?.throwIfAborted();
    const roots = options.roots ?? resolveCodexSessionRoots();
    let discovered = 0;
    const fileSystem = {
      async readdir(directory, settings) {
        operation?.throwIfAborted();
        const entries = await readdir(directory, settings);
        discovered += entries.length;
        if (discovered > MAX_HISTORY_DISCOVERY_ENTRIES) throw portableError("Sonner history discovery is bounded.");
        return entries;
      },
      async realpath(filename) { operation?.throwIfAborted(); return realpath(filename); },
      async stat(filename, settings) { operation?.throwIfAborted(); return stat(filename, settings); },
    };
    const located = await locateTaskHistories(taskIds, { roots, cachedPaths: options.cachedPaths, fileSystem });
    const results = [];
    for (const taskId of taskIds) {
      operation?.throwIfAborted();
      const location = located.get(taskId);
      if (!location?.historyFile || location.diagnostics?.length) { results.push(unknown(taskId, location?.location)); continue; }
      let handle;
      try {
        const pathname = await lstat(location.historyFile, { bigint: true });
        if (!pathname.isFile() || pathname.isSymbolicLink() || pathname.size <= 0n
            || pathname.size > BigInt(MAX_HISTORY_BYTES)) { results.push(unknown(taskId, location.location)); continue; }
        handle = await open(location.historyFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = await handle.stat({ bigint: true });
        if (!sameFile(pathname, opened)) { results.push(unknown(taskId, location.location)); continue; }
        const size = Number(opened.size);
        const start = Math.max(0, size - MAX_HISTORY_TAIL_BYTES);
        const bytes = Buffer.alloc(size - start);
        let offset = 0;
        while (offset < bytes.length) {
          operation?.throwIfAborted();
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, start + offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset !== bytes.length) { results.push(unknown(taskId, location.location)); continue; }
        const firstComplete = start === 0 ? 0 : bytes.indexOf(0x0a) + 1;
        if (start > 0 && (firstComplete <= 0 || firstComplete >= bytes.length)) {
          results.push(unknown(taskId, location.location)); continue;
        }
        const reducer = createTaskEventReducer({ mode: "latest" });
        await scanCodexTaskEvents(Readable.from(bytes.subarray(firstComplete)), (event) => reducer.accept(event));
        const final = await handle.stat({ bigint: true });
        const current = await lstat(location.historyFile, { bigint: true });
        if (!sameFile(opened, final) || !sameFile(opened, current)) { results.push(unknown(taskId, location.location)); continue; }
        const reduced = reducer.result();
        results.push({
          taskId,
          location: location.location,
          historyFile: null,
          latestTurnId: reduced.turnId,
          turnState: reduced.turnState,
          diagnostics: reduced.diagnostics,
        });
      } catch { results.push(unknown(taskId, location.location)); }
      finally { await handle?.close().catch(() => {}); }
    }
    return results;
  } catch {
    return requests.map(({ taskId }) => unknown(taskId));
  }
}
