import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { readPortableSonnerProject } from "./sonner-portable-io.mjs";

export const SONNER_READER_PROTOCOL_VERSION = 2;
export const SONNER_READER_TIMEOUT_MS = 5_000;
export const SONNER_READER_MAX_PATHS = 10_000;
export const SONNER_READER_MAX_PATH_BYTES = 4096;
export const SONNER_READER_MAX_WORKS = 1024;
export const SONNER_READER_MAX_WORK_BYTES = 256 * 1024;
export const SONNER_READER_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const SONNER_READER_MAX_STDERR_BYTES = 4096;
export const SONNER_GIT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const FRAME_HELLO = 1;
const FRAME_PATH = 2;
const FRAME_WORK = 3;
const FRAME_WORK_UNSAFE = 4;
const FRAME_FINAL = 5;
const TYPE_FILE = 1;
const TYPE_SYMLINK = 2;
const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git", ".codex-small-loop", ".cache", ".next", ".parcel-cache",
  ".pytest_cache", ".turbo", "__pycache__", "build", "cache",
  "coverage", "dist", "node_modules", "out", "target",
]);
const componentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PACKAGED_SONNER_PROJECT_READER = path.join(componentRoot, "native", "sonner-project-reader");
const execFileAsync = promisify(execFile);

function readerError(message) {
  const error = new Error(message);
  error.code = "SONNER_PROJECT_READER_UNAVAILABLE";
  return error;
}

export function sonnerOperationError() {
  const error = new Error("Sonner project operation expired or was cancelled.");
  error.code = "SONNER_OPERATION_ABORTED";
  return error;
}

export function isSonnerOperationAbort(error) {
  return error?.code === "SONNER_OPERATION_ABORTED";
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isExcluded(projectPath) {
  return projectPath.split("/").some((part) => EXCLUDED_DIRECTORY_NAMES.has(part));
}

export function isValidSonnerProjectPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/")
      || Buffer.byteLength(value, "utf8") > SONNER_READER_MAX_PATH_BYTES || value.includes("\0")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && Buffer.byteLength(part, "utf8") <= 512);
}

export function encodeSonnerReaderRequest({ rootIdentity, paths, maxWorks, maxWorkBytes, maxOutputBytes }) {
  if (typeof rootIdentity?.dev !== "bigint" || typeof rootIdentity?.ino !== "bigint"
      || rootIdentity.dev < 0n || rootIdentity.ino < 0n || paths.length > SONNER_READER_MAX_PATHS
      || !Number.isInteger(maxWorks) || maxWorks < 0 || maxWorks > SONNER_READER_MAX_WORKS
      || !Number.isInteger(maxWorkBytes) || maxWorkBytes < 0 || maxWorkBytes > SONNER_READER_MAX_WORK_BYTES
      || !Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > SONNER_READER_MAX_OUTPUT_BYTES) {
    throw readerError("Invalid Sonner project reader request.");
  }
  const normalized = paths.map((entry) => ({ path: entry.path, maxBytes: entry.maxBytes ?? 0 }));
  for (let index = 0; index < normalized.length; index += 1) {
    const entry = normalized[index];
    if (!isValidSonnerProjectPath(entry.path) || !Number.isInteger(entry.maxBytes) || entry.maxBytes < 0 || entry.maxBytes > 64 * 1024
        || (index > 0 && compareText(normalized[index - 1].path, entry.path) >= 0)) {
      throw readerError("Invalid Sonner project reader path.");
    }
  }
  const buffers = normalized.map((entry) => Buffer.from(entry.path, "utf8"));
  const length = 1 + 16 + 4 + buffers.reduce((sum, value) => sum + 2 + value.length + 4, 0) + 12;
  if (length > 8 * 1024 * 1024) throw readerError("Sonner project reader request is too large.");
  const payload = Buffer.alloc(length);
  let offset = 0;
  payload[offset++] = SONNER_READER_PROTOCOL_VERSION;
  payload.writeBigUInt64BE(BigInt.asUintN(64, rootIdentity.dev), offset); offset += 8;
  payload.writeBigUInt64BE(BigInt.asUintN(64, rootIdentity.ino), offset); offset += 8;
  payload.writeUInt32BE(buffers.length, offset); offset += 4;
  buffers.forEach((value, index) => {
    payload.writeUInt16BE(value.length, offset); offset += 2;
    value.copy(payload, offset); offset += value.length;
    payload.writeUInt32BE(normalized[index].maxBytes, offset); offset += 4;
  });
  payload.writeUInt32BE(maxWorks, offset); offset += 4;
  payload.writeUInt32BE(maxWorkBytes, offset); offset += 4;
  payload.writeUInt32BE(maxOutputBytes, offset);
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function encodeSonnerGitRequest({ rootIdentity, maxOutputBytes = SONNER_GIT_MAX_OUTPUT_BYTES,
  maxPaths = SONNER_READER_MAX_PATHS }) {
  if (typeof rootIdentity?.dev !== "bigint" || typeof rootIdentity?.ino !== "bigint"
      || rootIdentity.dev < 0n || rootIdentity.ino < 0n
      || !Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > SONNER_GIT_MAX_OUTPUT_BYTES
      || !Number.isInteger(maxPaths) || maxPaths < 0 || maxPaths > SONNER_READER_MAX_PATHS) {
    throw readerError("Invalid Sonner Git request.");
  }
  const payload = Buffer.alloc(25);
  payload[0] = SONNER_READER_PROTOCOL_VERSION;
  payload.writeBigUInt64BE(BigInt.asUintN(64, rootIdentity.dev), 1);
  payload.writeBigUInt64BE(BigInt.asUintN(64, rootIdentity.ino), 9);
  payload.writeUInt32BE(maxOutputBytes, 17);
  payload.writeUInt32BE(maxPaths, 21);
  const frame = Buffer.alloc(29);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function parseSonnerGitOutput(output, { maxOutputBytes = SONNER_GIT_MAX_OUTPUT_BYTES,
  maxPaths = SONNER_READER_MAX_PATHS } = {}) {
  if (!Buffer.isBuffer(output) || output.length > maxOutputBytes) throw readerError("Sonner Git output is invalid.");
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) throw readerError("Sonner Git output is incomplete.");
  if (output.length === 1) throw readerError("Sonner Git output contains an empty path.");
  const rawPaths = output.subarray(0, -1).toString("binary").split("\0")
    .map((value) => Buffer.from(value, "binary"));
  if (rawPaths.length > maxPaths) throw readerError("Sonner Git path count is bounded.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decoded = [];
  const seen = new Set();
  let descendingBoundaries = 0;
  for (let index = 0; index < rawPaths.length; index += 1) {
    const raw = rawPaths[index];
    let value;
    try { value = decoder.decode(raw); } catch { throw readerError("Sonner Git path encoding is invalid."); }
    const key = raw.toString("hex");
    if (!isValidSonnerProjectPath(value) || seen.has(key)) {
      throw readerError("Sonner Git paths are malformed or unordered.");
    }
    if (index > 0 && Buffer.compare(rawPaths[index - 1], raw) > 0) descendingBoundaries += 1;
    if (descendingBoundaries > 1) throw readerError("Sonner Git path categories are unordered.");
    seen.add(key);
    decoded.push({ raw, value });
  }
  decoded.sort((left, right) => Buffer.compare(left.raw, right.raw));
  return decoded.map((entry) => entry.value).filter((value) => !isExcluded(value));
}

function gitEnvironment(environment = process.env) {
  const absolute = (value) => typeof value === "string" && value.length > 0 && path.isAbsolute(value) ? value : "/var/empty";
  return {
    LC_ALL: "C",
    LANG: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    HOME: absolute(environment.HOME),
    XDG_CONFIG_HOME: absolute(environment.XDG_CONFIG_HOME),
  };
}

async function runGitAdmission({ project, rootHandle, helperPath, spawnImpl, session,
  maxOutputBytes = SONNER_GIT_MAX_OUTPUT_BYTES, maxPaths = SONNER_READER_MAX_PATHS, environment,
  onTransition = null }) {
  session.throwIfAborted();
  const request = encodeSonnerGitRequest({ rootIdentity: project.rootIdentity, maxOutputBytes, maxPaths });
  const child = spawnImpl(helperPath, ["git-ls-files"], {
    shell: false,
    stdio: onTransition ? ["pipe", "pipe", "pipe", rootHandle.fd, "pipe"] : ["pipe", "pipe", "pipe", rootHandle.fd],
    env: { ...gitEnvironment(environment), ...(onTransition ? { SONNER_PROJECT_READER_CONTROL_FD: "4" } : {}) },
  });
  let stdout = Buffer.alloc(0);
  let stderrBytes = 0;
  let failure = false;
  let terminal = false;
  let requestFinished = false;
  let controlBuffered = "";
  let controlActive = false;
  let killed = false;
  const fail = () => {
    if (failure) return;
    failure = true;
    if (!terminal && !killed) { killed = true; try { child.kill("SIGKILL"); } catch { /* close is authoritative */ } }
  };
  const closed = new Promise((resolve) => child.once("close", (code, signal) => {
    terminal = true; resolve({ code, signal });
  }));
  child.on("error", fail); child.stdin.on("error", fail); child.stdout.on("error", fail); child.stderr.on("error", fail);
  child.stdin.on("finish", () => { requestFinished = true; });
  child.stdout.on("data", (chunk) => {
    if (failure) return;
    if (stdout.length > maxOutputBytes - chunk.length) { fail(); return; }
    stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes > SONNER_READER_MAX_STDERR_BYTES) fail(); });
  const control = onTransition ? child.stdio[4] : null;
  if (control) {
    control.setEncoding("utf8"); control.on("error", fail);
    control.on("data", (chunk) => {
      if (failure) return;
      controlBuffered += chunk;
      const newline = controlBuffered.indexOf("\n");
      if (newline < 0 || controlActive) return;
      const transition = controlBuffered.slice(0, newline); controlBuffered = controlBuffered.slice(newline + 1);
      controlActive = true;
      Promise.resolve().then(() => onTransition(transition)).then(() => {
        if (failure || terminal || control.destroyed) return;
        control.write(Buffer.from([1]), (error) => { controlActive = false; if (error && !terminal) fail(); });
      }, () => { controlActive = false; fail(); });
    });
  }
  const abort = () => fail();
  session.signal.addEventListener("abort", abort, { once: true });
  if (session.signal.aborted) fail();
  child.stdin.end(request);
  const result = await closed;
  session.signal.removeEventListener("abort", abort);
  if (failure || result.code !== 0 || result.signal || !requestFinished || controlBuffered.length !== 0 || controlActive) {
    throw readerError("Sonner Git admission failed.");
  }
  return parseSonnerGitOutput(stdout, { maxOutputBytes, maxPaths });
}

export function inspectSonnerUniversalMachOBytes(bytes) {
  if (bytes.length < 8) throw readerError("Invalid Sonner project reader helper.");
  const magic = bytes.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) throw readerError("Sonner project reader is not universal.");
  const count = bytes.readUInt32BE(4);
  const stride = magic === FAT_MAGIC_64 ? 32 : 20;
  if (count === 0 || count > 16 || bytes.length < 8 + count * stride) throw readerError("Invalid Sonner project reader helper.");
  const architectures = new Set();
  for (let index = 0; index < count; index += 1) architectures.add(bytes.readUInt32BE(8 + index * stride));
  if (!architectures.has(ARM64) || !architectures.has(X86_64)) throw readerError("Required Sonner helper architectures are absent.");
  return { arm64: true, x86_64: true };
}

export async function inspectSonnerUniversalMachO(filename) {
  return inspectSonnerUniversalMachOBytes(await readFile(filename));
}

async function verifyHelper(helperPath, validateArchitecture, operation) {
  operation?.throwIfAborted();
  const status = await stat(helperPath);
  operation?.throwIfAborted();
  if (!status.isFile()) throw readerError("Invalid Sonner project reader helper.");
  await access(helperPath, constants.X_OK);
  operation?.throwIfAborted();
  if (validateArchitecture) {
    await inspectSonnerUniversalMachO(helperPath);
    operation?.throwIfAborted();
    const remaining = operation ? operation.remainingMs() : 2_000;
    if (remaining <= 0) throw sonnerOperationError();
    await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", helperPath], {
      env: {}, timeout: Math.min(2_000, remaining), windowsHide: true,
    });
    operation?.throwIfAborted();
  }
}

export async function openSonnerProjectRoot(project, { platform = process.platform, openImpl = open } = {}) {
  if (platform !== "darwin" || !path.isAbsolute(project?.root)
      || typeof project?.rootIdentity?.dev !== "bigint" || typeof project?.rootIdentity?.ino !== "bigint") {
    throw readerError("Invalid Sonner project Root.");
  }
  const handle = await openImpl(project.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_CLOEXEC | DARWIN_O_NOFOLLOW_ANY);
  try {
    const status = await handle.stat({ bigint: true });
    if (!status.isDirectory() || status.dev !== project.rootIdentity.dev || status.ino !== project.rootIdentity.ino) {
      throw readerError("Sonner project Root identity changed.");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function openSonnerProjectReadSession(project, {
  timeoutMs = SONNER_READER_TIMEOUT_MS,
  platform = process.platform,
  openImpl = open,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw readerError("Invalid Sonner project operation timeout.");
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  let rootHandle = null;
  let closed = false;
  let closePromise = null;
  let abortReason = null;
  const abort = (reason = sonnerOperationError()) => {
    if (controller.signal.aborted) return false;
    abortReason = reason instanceof Error ? reason : sonnerOperationError();
    controller.abort(abortReason);
    return true;
  };
  const timer = setTimeout(() => abort(), timeoutMs);
  const operation = {
    project,
    platform,
    get rootHandle() { return rootHandle; },
    deadline,
    signal: controller.signal,
    remainingMs() { return Math.max(0, deadline - Date.now()); },
    abort,
    throwIfAborted() {
      if (controller.signal.aborted || Date.now() >= deadline) {
        if (!controller.signal.aborted) abort();
        throw abortReason ?? sonnerOperationError();
      }
    },
    get closed() { return closed; },
    async close() {
      if (closePromise) return closePromise;
      closed = true;
      clearTimeout(timer);
      closePromise = rootHandle ? rootHandle.close() : Promise.resolve();
      return closePromise;
    },
  };
  try {
    if (platform === "win32") {
      const status = await stat(project.root, { bigint: true });
      if (!status.isDirectory() || status.dev !== project.rootIdentity.dev || status.ino !== project.rootIdentity.ino) {
        throw readerError("Sonner project Root identity changed.");
      }
      operation.throwIfAborted();
      return operation;
    }
    rootHandle = await openSonnerProjectRoot(project, { platform, openImpl });
    operation.throwIfAborted();
    return operation;
  } catch (error) {
    clearTimeout(timer);
    if (rootHandle) await rootHandle.close().catch(() => {});
    throw error;
  }
}

function readString(frame, state) {
  if (state.offset + 2 > frame.length) throw readerError("Malformed Sonner helper frame.");
  const length = frame.readUInt16BE(state.offset); state.offset += 2;
  if (state.offset + length > frame.length) throw readerError("Malformed Sonner helper frame.");
  const value = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(state.offset, state.offset + length));
  state.offset += length;
  return value;
}

function readBytes(frame, state, maximum) {
  if (state.offset + 4 > frame.length) throw readerError("Malformed Sonner helper frame.");
  const length = frame.readUInt32BE(state.offset); state.offset += 4;
  if (length > maximum || state.offset + length !== frame.length) throw readerError("Malformed Sonner helper bytes.");
  const value = Buffer.from(frame.subarray(state.offset, state.offset + length));
  state.offset += length;
  return value;
}

function parseFrame(frame, state, requested, maxWorkBytes) {
  if (frame.length === 0 || state.final) throw readerError("Unexpected Sonner helper frame.");
  const type = frame[0];
  if (type === FRAME_HELLO) {
    if (state.hello || frame.length !== 2 || frame[1] !== SONNER_READER_PROTOCOL_VERSION) throw readerError("Invalid Sonner helper protocol.");
    state.hello = true;
    return;
  }
  if (!state.hello) throw readerError("Missing Sonner helper greeting.");
  if (type === FRAME_PATH) {
    const cursor = { offset: 1 };
    if (cursor.offset >= frame.length) throw readerError("Malformed Sonner path frame.");
    const entryType = frame[cursor.offset++];
    const projectPath = readString(frame, cursor);
    const maximum = requested.get(projectPath);
    if (maximum === undefined || state.seenPaths.has(projectPath)
        || (state.lastPath !== null && compareText(state.lastPath, projectPath) >= 0)
        || ![TYPE_FILE, TYPE_SYMLINK].includes(entryType)) throw readerError("Invalid Sonner path frame.");
    const raw = readBytes(frame, cursor, maximum);
    if (entryType === TYPE_SYMLINK && raw.length !== 0) throw readerError("Invalid Sonner symlink frame.");
    state.seenPaths.add(projectPath); state.lastPath = projectPath;
    state.entries.push({ path: projectPath, type: entryType === TYPE_FILE ? "file" : "symlink", raw });
    return;
  }
  if (type === FRAME_WORK) {
    const cursor = { offset: 1 };
    const relativePath = readString(frame, cursor);
    if (!isValidSonnerProjectPath(relativePath) || !relativePath.endsWith("/WORK_NODE.xml")
        || state.seenWorks.has(relativePath)
        || (state.lastWork !== null && compareText(state.lastWork, relativePath) >= 0)) throw readerError("Invalid Sonner Work frame.");
    const raw = readBytes(frame, cursor, maxWorkBytes);
    state.seenWorks.add(relativePath); state.lastWork = relativePath;
    state.works.push({ relativePath, xml: new TextDecoder("utf-8", { fatal: true }).decode(raw) });
    return;
  }
  if (type === FRAME_WORK_UNSAFE) {
    if (frame.length !== 1 || state.workUnsafe) throw readerError("Invalid Sonner Work safety frame.");
    state.workUnsafe = true;
    return;
  }
  if (type === FRAME_FINAL) {
    if (frame.length !== 10 || frame.readUInt32BE(1) !== state.entries.length
        || frame.readUInt32BE(5) !== state.works.length || Boolean(frame[9]) !== state.workUnsafe) {
      throw readerError("Invalid Sonner helper final counts.");
    }
    state.final = true;
    return;
  }
  throw readerError("Unknown Sonner helper frame.");
}

export async function readSonnerProject({
  project,
  session = null,
  includeFiles = true,
  maxWorks = SONNER_READER_MAX_WORKS,
  maxWorkBytes = SONNER_READER_MAX_WORK_BYTES,
  maxOutputBytes = SONNER_READER_MAX_OUTPUT_BYTES,
  helperPath = PACKAGED_SONNER_PROJECT_READER,
  timeoutMs = SONNER_READER_TIMEOUT_MS,
  platform = process.platform,
  validateArchitecture = true,
  spawnImpl = spawn,
  openImpl = open,
  onTransition = null,
  onPhase = null,
  environment = process.env,
  maxGitOutputBytes = SONNER_GIT_MAX_OUTPUT_BYTES,
  maxGitPaths = SONNER_READER_MAX_PATHS,
} = {}) {
  let activeSession = session;
  let ownsSession = false;
  let rootHandle;
  const closeRoot = async () => {
    if (!ownsSession || !activeSession) return;
    await activeSession.close();
  };
  try {
    if (typeof includeFiles !== "boolean") throw readerError("Invalid Sonner reader mode.");
    if (activeSession === null) {
      activeSession = await openSonnerProjectReadSession(project, { timeoutMs, platform, openImpl });
      ownsSession = true;
    }
    if (activeSession.closed || activeSession.project !== project) throw readerError("Invalid Sonner reader session.");
    if (platform === "win32" || activeSession.platform === "win32") {
      return await readPortableSonnerProject({
        project,
        session: activeSession,
        includeFiles,
        maxWorks,
        maxWorkBytes,
        maxOutputBytes,
        environment,
      });
    }
    activeSession.throwIfAborted();
    await verifyHelper(helperPath, validateArchitecture, activeSession);
    rootHandle = activeSession.rootHandle;
    await onPhase?.("after-root-open");
    activeSession.throwIfAborted();
    let admittedPaths = [];
    if (includeFiles) {
      await onPhase?.("before-git-spawn");
      admittedPaths = await runGitAdmission({ project, rootHandle, helperPath, spawnImpl, session: activeSession,
        maxOutputBytes: maxGitOutputBytes, maxPaths: maxGitPaths, environment, onTransition });
      await onPhase?.("after-git-output");
      activeSession.throwIfAborted();
    }
    const normalized = admittedPaths.map((projectPath) => ({
      path: projectPath,
      maxBytes: /\.md$/i.test(projectPath) ? 64 * 1024 : 0,
    }));
    const request = encodeSonnerReaderRequest({ rootIdentity: project.rootIdentity, paths: normalized, maxWorks, maxWorkBytes, maxOutputBytes });
    await onPhase?.("before-content-spawn");
    activeSession.throwIfAborted();
    const child = spawnImpl(helperPath, [], {
      shell: false,
      stdio: onTransition ? ["pipe", "pipe", "pipe", rootHandle.fd, "pipe"] : ["pipe", "pipe", "pipe", rootHandle.fd, "ignore"],
      env: onTransition ? { SONNER_PROJECT_READER_CONTROL_FD: "4" } : {},
    });
    const requested = new Map(normalized.map((entry) => [entry.path, entry.maxBytes]));
    const state = { hello: false, final: false, entries: [], works: [], workUnsafe: false,
      seenPaths: new Set(), seenWorks: new Set(), lastPath: null, lastWork: null };
    let buffered = Buffer.alloc(0);
    let outputBytes = 0;
    let stderrBytes = 0;
    let failure = null;
    let terminal = false;
    let controlBuffered = "";
    let controlActive = false;
    let requestFinished = false;
    let killed = false;
    const fail = () => {
      if (failure) return;
      failure = readerError("Sonner project reader failed.");
      if (!terminal && !killed) { killed = true; try { child.kill("SIGKILL"); } catch { /* close is authoritative */ } }
    };
    const closedChild = new Promise((resolve) => child.once("close", (code, signal) => {
      terminal = true;
      resolve({ code, signal });
    }));
    child.on("error", fail);
    child.stdin.on("error", fail); child.stdout.on("error", fail); child.stderr.on("error", fail);
    child.stdin.on("finish", () => { requestFinished = true; });
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) { fail(); return; }
      buffered = Buffer.concat([buffered, chunk]);
      try {
        while (buffered.length >= 4) {
          const length = buffered.readUInt32BE(0);
          if (length === 0 || length > Math.max(maxWorkBytes, 64 * 1024) + SONNER_READER_MAX_PATH_BYTES + 16) throw readerError("Sonner helper frame overflow.");
          if (buffered.length < 4 + length) break;
          parseFrame(buffered.subarray(4, 4 + length), state, requested, maxWorkBytes);
          buffered = buffered.subarray(4 + length);
        }
      } catch { fail(); }
    });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes > SONNER_READER_MAX_STDERR_BYTES) fail(); });
    const control = onTransition ? child.stdio[4] : null;
    if (control) {
      control.setEncoding("utf8"); control.on("error", fail);
      control.on("data", (chunk) => {
        if (failure) return;
        controlBuffered += chunk;
        let newline = controlBuffered.indexOf("\n");
        while (newline >= 0) {
          const transition = controlBuffered.slice(0, newline); controlBuffered = controlBuffered.slice(newline + 1);
          if (controlActive) { fail(); return; }
          controlActive = true;
          Promise.resolve().then(() => onTransition(transition)).then(() => {
            if (failure || terminal || control.destroyed) return;
            control.write(Buffer.from([1]), (error) => { controlActive = false; if (error && !terminal) fail(); });
          }, () => { controlActive = false; fail(); });
          newline = controlBuffered.indexOf("\n");
        }
      });
    }
    const abort = () => fail();
    activeSession.signal.addEventListener("abort", abort, { once: true });
    if (activeSession.signal.aborted) fail();
    child.stdin.end(request);
    const result = await closedChild;
    activeSession.signal.removeEventListener("abort", abort);
    if (failure || result.code !== 0 || result.signal || !requestFinished || buffered.length !== 0
        || controlBuffered.length !== 0 || controlActive || !state.hello || !state.final) throw readerError("Sonner project reader unavailable.");
    return { entries: state.entries, works: state.works, workUnsafe: state.workUnsafe, admittedPaths };
  } catch (error) {
    if (error?.code === "SONNER_PROJECT_READER_UNAVAILABLE" || isSonnerOperationAbort(error)) throw error;
    throw readerError("Sonner project reader unavailable.");
  } finally {
    await closeRoot();
  }
}
