import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  inspectSonnerUniversalMachOBytes,
  isSonnerOperationAbort,
  sonnerOperationError,
} from "./sonner-project-reader.mjs";
import { readPortableRuntimeRecord } from "./sonner-portable-io.mjs";

export const SONNER_RUNTIME_READER_PROTOCOL_VERSION = 1;
export const SONNER_RUNTIME_LEDGER_MAX_BYTES = 32 * 1024 * 1024;
export const SONNER_RUNTIME_DIAGNOSTIC_MAX_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 4096;
const FRAME_HELLO = 1;
const FRAME_PRESENT = 2;
const FRAME_MISSING = 3;
const FRAME_UNSAFE = 4;
const FRAME_FINAL = 5;
const componentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PACKAGED_SONNER_RUNTIME_READER = path.join(componentRoot, "native", "sonner-runtime-reader");
const execFileAsync = promisify(execFile);

function runtimeReaderError() {
  const error = new Error("Sonner Runtime record reader unavailable.");
  error.code = "SONNER_RUNTIME_READER_UNAVAILABLE";
  return error;
}

export function encodeSonnerRuntimeRequest({ mode, rootIdentity }) {
  const modeByte = mode === "ledger" ? 1 : mode === "diagnostic" ? 2 : 0;
  const maximum = mode === "ledger" ? SONNER_RUNTIME_LEDGER_MAX_BYTES
    : mode === "diagnostic" ? SONNER_RUNTIME_DIAGNOSTIC_MAX_BYTES : 0;
  if (!modeByte || typeof rootIdentity?.dev !== "bigint" || typeof rootIdentity?.ino !== "bigint") {
    throw runtimeReaderError();
  }
  const payload = Buffer.alloc(22);
  payload[0] = SONNER_RUNTIME_READER_PROTOCOL_VERSION;
  payload[1] = modeByte;
  payload.writeBigUInt64BE(BigInt.asUintN(64, rootIdentity.dev), 2);
  payload.writeBigUInt64BE(BigInt.asUintN(64, rootIdentity.ino), 10);
  payload.writeUInt32BE(maximum, 18);
  const request = Buffer.alloc(26);
  request.writeUInt32BE(payload.length, 0);
  payload.copy(request, 4);
  return request;
}

async function verifyHelper(helperPath, validateArchitecture, operation) {
  operation.throwIfAborted();
  const status = await stat(helperPath);
  operation.throwIfAborted();
  if (!status.isFile()) throw runtimeReaderError();
  await access(helperPath, constants.X_OK);
  operation.throwIfAborted();
  if (validateArchitecture) {
    inspectSonnerUniversalMachOBytes(await readFile(helperPath));
    operation.throwIfAborted();
    const remaining = operation.remainingMs();
    if (remaining <= 0) throw sonnerOperationError();
    await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", helperPath], {
      env: {}, timeout: Math.min(2_000, remaining), windowsHide: true,
    });
    operation.throwIfAborted();
  }
}

function parseFrames(output, maximum) {
  let offset = 0;
  let hello = false;
  let outcome = null;
  let final = false;
  while (offset < output.length) {
    if (offset + 4 > output.length) throw runtimeReaderError();
    const length = output.readUInt32BE(offset); offset += 4;
    if (length === 0 || length > maximum + 5 || offset + length > output.length) throw runtimeReaderError();
    const frame = output.subarray(offset, offset + length); offset += length;
    const type = frame[0];
    if (final) throw runtimeReaderError();
    if (type === FRAME_HELLO) {
      if (hello || frame.length !== 2 || frame[1] !== SONNER_RUNTIME_READER_PROTOCOL_VERSION) throw runtimeReaderError();
      hello = true;
    } else if (type === FRAME_FINAL) {
      if (!hello || frame.length !== 2 || outcome === null) throw runtimeReaderError();
      const expected = outcome.status === "present" ? FRAME_PRESENT : outcome.status === "missing" ? FRAME_MISSING : FRAME_UNSAFE;
      if (frame[1] !== expected) throw runtimeReaderError();
      final = true;
    } else if (!hello || outcome !== null) {
      throw runtimeReaderError();
    } else if (type === FRAME_PRESENT) {
      if (frame.length < 5 || frame.readUInt32BE(1) > maximum || frame.readUInt32BE(1) !== frame.length - 5) throw runtimeReaderError();
      outcome = { status: "present", bytes: Buffer.from(frame.subarray(5)) };
    } else if ((type === FRAME_MISSING || type === FRAME_UNSAFE) && frame.length === 1) {
      outcome = { status: type === FRAME_MISSING ? "missing" : "unsafe" };
    } else throw runtimeReaderError();
  }
  if (!hello || !outcome || !final) throw runtimeReaderError();
  return outcome;
}

export async function readSonnerRuntimeRecord({
  session,
  mode,
  helperPath = PACKAGED_SONNER_RUNTIME_READER,
  validateArchitecture = true,
  spawnImpl = spawn,
} = {}) {
  if (session?.platform === "win32") return readPortableRuntimeRecord({ session, mode });
  const maximum = mode === "ledger" ? SONNER_RUNTIME_LEDGER_MAX_BYTES : SONNER_RUNTIME_DIAGNOSTIC_MAX_BYTES;
  try {
    if (!session?.rootHandle || session.closed) throw runtimeReaderError();
    session.throwIfAborted();
    await verifyHelper(helperPath, validateArchitecture, session);
    session.throwIfAborted();
    const request = encodeSonnerRuntimeRequest({ mode, rootIdentity: session.project.rootIdentity });
    const child = spawnImpl(helperPath, [], { shell: false, stdio: ["pipe", "pipe", "pipe", session.rootHandle.fd], env: {} });
    let stdout = Buffer.alloc(0); let stderrBytes = 0; let failure = null; let terminal = false;
    let killed = false; let requestFinished = false;
    const fail = (error = runtimeReaderError()) => {
      if (failure) return;
      failure = error instanceof Error ? error : runtimeReaderError();
      if (!terminal && !killed) { killed = true; try { child.kill("SIGKILL"); } catch {} }
    };
    child.on("error", fail); child.stdin.on("error", fail); child.stdout.on("error", fail); child.stderr.on("error", fail);
    child.stdin.on("finish", () => { requestFinished = true; });
    child.stdout.on("data", (chunk) => {
      if (stdout.length > maximum + 64 - chunk.length) return fail();
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes > MAX_STDERR_BYTES) fail(); });
    const closed = new Promise((resolve) => child.once("close", (code, signal) => {
      terminal = true; resolve({ code, signal });
    }));
    const abort = () => fail(session.signal.reason ?? sonnerOperationError());
    session.signal.addEventListener("abort", abort, { once: true });
    if (session.signal.aborted) abort();
    child.stdin.end(request);
    const result = await closed;
    session.signal.removeEventListener("abort", abort);
    if (failure) throw failure;
    if (result.code !== 0 || result.signal || !requestFinished) throw runtimeReaderError();
    session.throwIfAborted();
    return parseFrames(stdout, maximum);
  } catch (error) {
    if (error?.code === "SONNER_RUNTIME_READER_UNAVAILABLE" || isSonnerOperationAbort(error)) throw error;
    throw runtimeReaderError();
  }
}
