import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { readPortableActivitySignals } from "./activity-signal-reader-portable.mjs";

export const ACTIVITY_SIGNAL_PROTOCOL_VERSION = 2;
export const ACTIVITY_SIGNAL_READER_TIMEOUT_MS = 5_000;
export const ACTIVITY_SIGNAL_READER_MAX_FRAME_BYTES = (256 * 1024) + 4096;
export const ACTIVITY_SIGNAL_READER_MAX_OUTPUT_BYTES = 6 * 1024 * 1024;
export const ACTIVITY_SIGNAL_READER_MAX_STDERR_BYTES = 4096;

const FRAME_HELLO = 1;
const FRAME_SIGNAL = 2;
const FRAME_OMISSION = 3;
const FRAME_FINAL = 4;
const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
const SNAPSHOT_PATTERN = /^[0-9a-f]{40,64}$/;
const SIGNAL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const OMISSION_CODES = new Set([
  "ACTIVITY_SIGNAL_DIRECTORY_UNSAFE",
  "ACTIVITY_SIGNAL_NON_REGULAR",
  "ACTIVITY_SIGNAL_OVERSIZED",
  "ACTIVITY_SIGNAL_CHANGED",
  "ACTIVITY_SIGNAL_UNREADABLE",
  "ACTIVITY_SIGNAL_DISCOVERY_BOUNDED",
]);
const componentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PACKAGED_ACTIVITY_SIGNAL_READER = path.join(componentRoot, "native", "activity-signal-reader");
const execFileAsync = promisify(execFile);

function unavailable() {
  return {
    entries: [],
    omissions: [{ code: "ACTIVITY_SIGNAL_READER_UNAVAILABLE", primaryTaskId: null, container: true }],
    diagnostics: [],
    partial: true,
  };
}

function safeComponent(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\0");
}

export function isValidActivitySignalName(value) {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= 512
    && SIGNAL_PATTERN.test(value);
}

export function isValidActivitySnapshotName(value) {
  return typeof value === "string" && SNAPSHOT_PATTERN.test(value);
}

export function encodeActivitySignalRequest({ rootIdentity, authorizedPrimaryIds, maxSignals, maxSignalBytes, maxOutputBytes }) {
  const ids = [...authorizedPrimaryIds].sort();
  if (typeof rootIdentity?.dev !== "bigint" || typeof rootIdentity?.ino !== "bigint"
      || rootIdentity.dev < 0n || rootIdentity.ino < 0n || ids.length > 256
      || ids.some((id, index) => !safeComponent(id) || (index > 0 && id === ids[index - 1]))) {
    throw new Error("invalid request");
  }
  const idBuffers = ids.map((id) => Buffer.from(id, "utf8"));
  if (idBuffers.some((value) => value.length > 0xffff)) throw new Error("invalid request");
  const length = 1 + 16 + 2
    + idBuffers.reduce((sum, value) => sum + 2 + value.length, 0) + 12;
  if (length > 64 * 1024) throw new Error("invalid request");
  const payload = Buffer.alloc(length);
  let offset = 0;
  payload[offset++] = ACTIVITY_SIGNAL_PROTOCOL_VERSION;
  payload.writeBigUInt64BE(BigInt.asUintN(64, rootIdentity.dev), offset); offset += 8;
  payload.writeBigUInt64BE(BigInt.asUintN(64, rootIdentity.ino), offset); offset += 8;
  payload.writeUInt16BE(idBuffers.length, offset); offset += 2;
  for (const value of idBuffers) {
    payload.writeUInt16BE(value.length, offset); offset += 2; value.copy(payload, offset); offset += value.length;
  }
  payload.writeUInt32BE(maxSignals, offset); offset += 4;
  payload.writeUInt32BE(maxSignalBytes, offset); offset += 4;
  payload.writeUInt32BE(maxOutputBytes, offset);
  const framed = Buffer.alloc(4 + payload.length);
  framed.writeUInt32BE(payload.length, 0);
  payload.copy(framed, 4);
  return framed;
}

async function verifyHelper(helperPath, validateArchitecture) {
  const executable = await stat(helperPath);
  if (!executable.isFile()) throw new Error("invalid helper");
  await access(helperPath, constants.X_OK);
  if (validateArchitecture) {
    await inspectUniversalMachO(helperPath);
    await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", helperPath], {
      env: {},
      timeout: 2_000,
      windowsHide: true,
    });
  }
}

export async function openVerifiedProjectRoot(project, { platform = process.platform, openImpl = open } = {}) {
  if (platform !== "darwin" || !path.isAbsolute(project?.root)
      || typeof project?.rootIdentity?.dev !== "bigint"
      || typeof project?.rootIdentity?.ino !== "bigint") throw new Error("invalid project root");
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_CLOEXEC | DARWIN_O_NOFOLLOW_ANY;
  const handle = await openImpl(project.root, flags);
  try {
    const status = await handle.stat({ bigint: true });
    if (!status.isDirectory() || status.dev !== project.rootIdentity.dev || status.ino !== project.rootIdentity.ino) {
      throw new Error("project root identity changed");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function inspectUniversalMachO(file) {
  return inspectUniversalMachOBytes(await readFile(file));
}

export function inspectUniversalMachOBytes(bytes) {
  if (bytes.length < 8) throw new Error("invalid helper");
  const magic = bytes.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) throw new Error("helper is not universal");
  const count = bytes.readUInt32BE(4);
  const stride = magic === FAT_MAGIC_64 ? 32 : 20;
  if (count === 0 || count > 16 || bytes.length < 8 + (count * stride)) throw new Error("invalid helper");
  const architectures = new Set();
  for (let index = 0; index < count; index += 1) {
    architectures.add(bytes.readUInt32BE(8 + (index * stride)));
  }
  if (!architectures.has(ARM64) || !architectures.has(X86_64)) throw new Error("required architectures are absent");
  return { arm64: true, x86_64: true };
}

function readString(frame, state, size = 2) {
  if (state.offset + size > frame.length) throw new Error("malformed frame");
  const length = size === 2 ? frame.readUInt16BE(state.offset) : frame.readUInt32BE(state.offset);
  state.offset += size;
  if (state.offset + length > frame.length) throw new Error("malformed frame");
  const value = frame.subarray(state.offset, state.offset + length).toString("utf8");
  state.offset += length;
  return value;
}

function parseSignalFrame(frame, authorized) {
  const state = { offset: 1 };
  const primaryTaskId = readString(frame, state);
  const snapshot = readString(frame, state);
  const name = readString(frame, state);
  if (state.offset + 28 > frame.length) throw new Error("malformed frame");
  const sourceBytes = Number(frame.readBigUInt64BE(state.offset)); state.offset += 8;
  const seconds = frame.readBigInt64BE(state.offset); state.offset += 8;
  const nanoseconds = frame.readBigInt64BE(state.offset); state.offset += 8;
  const rawLength = frame.readUInt32BE(state.offset); state.offset += 4;
  if (!authorized.has(primaryTaskId) || !isValidActivitySnapshotName(snapshot) || !isValidActivitySignalName(name)
      || !Number.isSafeInteger(sourceBytes) || sourceBytes !== rawLength
      || rawLength > 256 * 1024 || state.offset + rawLength !== frame.length
      || nanoseconds < 0n || nanoseconds >= 1_000_000_000n) throw new Error("invalid signal frame");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const raw = decoder.decode(frame.subarray(state.offset));
  const milliseconds = Number(seconds * 1000n) + (Number(nanoseconds) / 1_000_000);
  const timestamp = new Date(milliseconds);
  if (Number.isNaN(timestamp.valueOf())) throw new Error("invalid timestamp");
  return { primaryTaskId, snapshot, name, raw, sourceBytes, timestamp: timestamp.toISOString() };
}

function parseOmissionFrame(frame, authorized) {
  const state = { offset: 1 };
  const primaryTaskId = readString(frame, state);
  const code = readString(frame, state);
  if (state.offset !== frame.length || (primaryTaskId && !authorized.has(primaryTaskId)) || !OMISSION_CODES.has(code)) {
    throw new Error("invalid omission frame");
  }
  return { code, primaryTaskId: primaryTaskId || null, container: code === "ACTIVITY_SIGNAL_DIRECTORY_UNSAFE" };
}

function parseFrame(frame, state, authorized) {
  if (frame.length === 0 || state.final) throw new Error("unexpected frame");
  const type = frame[0];
  if (type === FRAME_HELLO) {
    if (state.hello || frame.length !== 2 || frame[1] !== ACTIVITY_SIGNAL_PROTOCOL_VERSION) throw new Error("invalid protocol");
    state.hello = true;
    return;
  }
  if (!state.hello) throw new Error("missing protocol frame");
  if (type === FRAME_SIGNAL) {
    state.entries.push(parseSignalFrame(frame, authorized));
    return;
  }
  if (type === FRAME_OMISSION) {
    state.omissions.push(parseOmissionFrame(frame, authorized));
    return;
  }
  if (type === FRAME_FINAL) {
    if (frame.length !== 9
        || frame.readUInt32BE(1) !== state.entries.length
        || frame.readUInt32BE(5) !== state.omissions.length) throw new Error("invalid final counts");
    state.final = true;
    return;
  }
  throw new Error("unknown frame");
}

export async function readActivitySignals({
  project,
  authorizedPrimaryIds,
  maxSignals = 1_000,
  maxSignalBytes = 256 * 1024,
  maxOutputBytes = ACTIVITY_SIGNAL_READER_MAX_OUTPUT_BYTES,
  helperPath = PACKAGED_ACTIVITY_SIGNAL_READER,
  timeoutMs = ACTIVITY_SIGNAL_READER_TIMEOUT_MS,
  platform = process.platform,
  validateArchitecture = true,
  spawnImpl = spawn,
  openImpl = open,
  onTransition = null,
} = {}) {
  if (platform === "win32") {
    return readPortableActivitySignals({
      project,
      authorizedPrimaryIds,
      maxSignals,
      maxSignalBytes,
      maxOutputBytes,
      onTransition,
    });
  }
  let rootHandle = null;
  let rootClosed = false;
  const closeRoot = async () => {
    if (!rootHandle || rootClosed) return;
    rootClosed = true;
    await rootHandle.close();
  };
  try {
    if (platform !== "darwin" || !path.isAbsolute(project?.root)
        || typeof project?.rootIdentity?.dev !== "bigint" || typeof project?.rootIdentity?.ino !== "bigint"
        || !Number.isInteger(maxSignals) || maxSignals < 0 || maxSignals > 1_000
        || !Number.isInteger(maxSignalBytes) || maxSignalBytes < 0 || maxSignalBytes > 256 * 1024
        || !Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 8 * 1024 * 1024) return unavailable();
    await verifyHelper(helperPath, validateArchitecture);
    const authorized = new Set([...authorizedPrimaryIds]);
    const request = encodeActivitySignalRequest({ rootIdentity: project.rootIdentity, authorizedPrimaryIds: authorized, maxSignals, maxSignalBytes, maxOutputBytes });
    rootHandle = await openVerifiedProjectRoot(project, { platform, openImpl });
    const child = spawnImpl(helperPath, [], {
      shell: false,
      stdio: onTransition ? ["pipe", "pipe", "pipe", rootHandle.fd, "pipe"] : ["pipe", "pipe", "pipe", rootHandle.fd, "ignore"],
      env: onTransition ? { ACTIVITY_SIGNAL_READER_CONTROL_FD: "4" } : {},
    });
    const state = { hello: false, final: false, entries: [], omissions: [] };
    let buffered = Buffer.alloc(0);
    let outputBytes = 0;
    let stderrBytes = 0;
    let firstFailure = null;
    let terminal = false;
    let killSent = false;
    let requestFinished = false;
    let controlBuffered = "";
    let controlActive = false;
    let timer;
    const killOnce = () => {
      if (killSent || terminal) return;
      killSent = true;
      try { child.kill("SIGKILL"); } catch { /* close remains authoritative */ }
    };
    const fail = (kind, { kill = true } = {}) => {
      if (!firstFailure) firstFailure = kind;
      if (kill) killOnce();
    };
    const canAcceptOutput = () => !firstFailure && !terminal;
    const control = onTransition ? child.stdio[4] : null;
    const canWriteControl = () => !firstFailure && !terminal && control && !control.destroyed && control.writable;
    const closed = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        if (terminal) return;
        terminal = true;
        if (timer) clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    child.on("error", () => fail("child-error", { kill: false }));
    child.stdin.on("error", (error) => fail(error?.code === "ECONNRESET" ? "stdin-reset" : "stdin-error"));
    child.stdout.on("error", () => fail("stdout-error"));
    child.stderr.on("error", () => fail("stderr-error"));
    child.stdin.on("finish", () => { if (!terminal) requestFinished = true; });
    child.stdin.on("close", () => { if (!requestFinished && !terminal) fail("stdin-premature-close"); });
    child.stdout.on("data", (chunk) => {
      if (!canAcceptOutput()) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) { fail("output-overflow"); return; }
      buffered = Buffer.concat([buffered, chunk]);
      try {
        while (buffered.length >= 4) {
          const length = buffered.readUInt32BE(0);
          if (length === 0 || length > ACTIVITY_SIGNAL_READER_MAX_FRAME_BYTES) throw new Error("frame overflow");
          if (buffered.length < 4 + length) break;
          parseFrame(buffered.subarray(4, 4 + length), state, authorized);
          buffered = buffered.subarray(4 + length);
        }
      } catch {
        fail("protocol");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > ACTIVITY_SIGNAL_READER_MAX_STDERR_BYTES) fail("stderr-overflow");
    });
    if (onTransition) {
      control.on("error", () => fail("control-error"));
      control.setEncoding("utf8");
      control.on("data", (chunk) => {
        if (!canAcceptOutput()) return;
        controlBuffered += chunk;
        let newline = controlBuffered.indexOf("\n");
        while (newline >= 0) {
          const transition = controlBuffered.slice(0, newline);
          controlBuffered = controlBuffered.slice(newline + 1);
          if (controlActive) { fail("control-overlap"); break; }
          controlActive = true;
          Promise.resolve().then(() => onTransition(transition)).then(() => {
            if (!canWriteControl()) return;
            control.write(Buffer.from([1]), (error) => {
              controlActive = false;
              if (error && !terminal) fail("control-write");
            });
          }, () => {
            controlActive = false;
            if (!terminal) fail("control-callback");
          });
          newline = controlBuffered.indexOf("\n");
        }
      });
    }
    timer = setTimeout(() => fail("timeout"), timeoutMs);
    try {
      await closeRoot();
    } catch {
      fail("root-close");
    }
    if (!firstFailure && !terminal) {
      child.stdin.end(request, (error) => {
        if (error && !terminal) fail(error.code === "ECONNRESET" ? "stdin-reset" : "stdin-error");
      });
    }
    const result = await closed;
    if (firstFailure || result.code !== 0 || result.signal || !requestFinished || buffered.length !== 0
        || controlBuffered.length !== 0 || controlActive
        || !state.hello || !state.final) return unavailable();
    return { entries: state.entries, omissions: state.omissions, diagnostics: [], partial: state.omissions.length > 0 };
  } catch {
    return unavailable();
  } finally {
    await closeRoot().catch(() => {});
  }
}
