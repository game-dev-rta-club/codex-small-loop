import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import { createTaskEventReducer, scanCodexTaskEvents } from "../../runtime/source/codex-jsonl.mjs";
import { locateTaskHistories, resolveCodexSessionRoots } from "../../runtime/source/codex-session-locator.mjs";
import { isExcludedSonnerProjectPath } from "./sonner-path-policy.mjs";

const execFileAsync = promisify(execFile);
const MAX_GIT_BYTES = 32 * 1024 * 1024;
const MAX_PATHS = 10_000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_HISTORY_BYTES = 256 * 1024 * 1024;
const MAX_HISTORY_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_DISCOVERY_ENTRIES = 100_000;

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

async function readPortableFile(session, projectPath, maximum, { allowSymlink = false } = {}) {
  if (!validProjectPath(projectPath)) throw portableError("Invalid Sonner project path.");
  await assertRoot(session);
  const ancestors = await inspectAncestors(session.project.root, projectPath);
  const filename = path.join(session.project.root, ...projectPath.split("/"));
  const pathname = await lstat(filename, { bigint: true });
  if (pathname.isSymbolicLink()) {
    if (!allowSymlink || !(await revalidateAncestors(ancestors))) throw portableError("Sonner path is unsafe.");
    return { type: "symlink", raw: Buffer.alloc(0) };
  }
  if (!pathname.isFile() || pathname.size > BigInt(maximum)) throw portableError("Sonner file is unavailable or oversized.");
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
    .filter((entry) => !isExcludedSonnerProjectPath(entry))
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

async function readPortableDirectory(session, projectPath) {
  await assertRoot(session);
  const directory = projectPath.length === 0
    ? session.project.root
    : path.join(session.project.root, ...projectPath.split("/"));
  let retained = [];
  let before;
  if (projectPath.length > 0) {
    if (!validProjectPath(projectPath)) throw portableError("Invalid Sonner project path.");
    retained = await inspectAncestors(session.project.root, `${projectPath}/_`);
    before = await lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw portableError("Sonner directory is unsafe.");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (projectPath.length > 0) {
    const after = await lstat(directory, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after)
        || !(await revalidateAncestors(retained))) throw portableError("Sonner directory changed while reading.");
  }
  await assertRoot(session);
  return entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
}

async function discoverPortableWorkPaths(session) {
  const directories = [""];
  const works = [];
  let discovered = 0;
  while (directories.length > 0) {
    session.throwIfAborted();
    const directory = directories.shift();
    const entries = await readPortableDirectory(session, directory);
    discovered += entries.length;
    if (discovered > MAX_PATHS) throw portableError("Sonner project path count is bounded.");
    for (const entry of entries) {
      const projectPath = directory.length > 0 ? `${directory}/${entry.name}` : entry.name;
      if (!validProjectPath(projectPath) || isExcludedSonnerProjectPath(projectPath)) continue;
      if (entry.isDirectory()) directories.push(projectPath);
      else if (entry.isFile() && entry.name === "WORK_NODE.xml") works.push(projectPath);
    }
  }
  return works.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
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

export async function readPortableSonnerProject({ project, session, includeFiles = true,
  maxWorks = 1024, maxWorkBytes = 256 * 1024, maxOutputBytes = 16 * 1024 * 1024,
  environment = process.env } = {}) {
  if (!session || session.project !== project || session.closed || session.platform !== "win32") throw portableError();
  const paths = includeFiles
    ? await admittedPaths(session, environment)
    : await discoverPortableWorkPaths(session);
  const entries = [];
  const works = [];
  let outputBytes = 0;
  let workUnsafe = false;
  for (const projectPath of paths) {
    session.throwIfAborted();
    if (projectPath.endsWith("/WORK_NODE.xml") || projectPath === "WORK_NODE.xml") {
      if (works.length >= maxWorks) { workUnsafe = true; continue; }
      try {
        const record = await readPortableFile(session, projectPath, maxWorkBytes);
        if (record.type !== "file") { workUnsafe = true; continue; }
        outputBytes += record.raw.length;
        if (outputBytes > maxOutputBytes) throw portableError("Sonner output is bounded.");
        works.push({ relativePath: projectPath, xml: new TextDecoder("utf-8", { fatal: true }).decode(record.raw) });
      } catch { workUnsafe = true; }
    }
    if (!includeFiles) continue;
    try {
      const maximum = /\.md$/i.test(projectPath) ? MAX_FILE_BYTES : 0;
      const record = maximum > 0
        ? await readPortableFile(session, projectPath, maximum, { allowSymlink: true })
        : await readPortableFile(session, projectPath, 0, { allowSymlink: true });
      outputBytes += record.raw.length;
      if (outputBytes > maxOutputBytes) throw portableError("Sonner output is bounded.");
      entries.push({ path: projectPath, type: record.type, raw: record.raw });
    } catch (error) {
      try {
        const status = await lstat(path.join(project.root, ...projectPath.split("/")), { bigint: true });
        if (status.isFile()) entries.push({ path: projectPath, type: "file", raw: Buffer.alloc(0) });
        else if (status.isSymbolicLink()) entries.push({ path: projectPath, type: "symlink", raw: Buffer.alloc(0) });
      } catch { /* A vanished or unsafe admitted path is omitted. */ }
    }
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
    const record = await readPortableFile(session, projectPath, maximum);
    return record.type === "file" ? { status: "present", bytes: record.raw } : { status: "unsafe" };
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
