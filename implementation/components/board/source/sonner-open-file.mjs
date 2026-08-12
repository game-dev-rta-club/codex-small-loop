import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isValidSonnerProjectPath } from "../../sonner/source/sonner-project-reader.mjs";
import { inspectUniversalMachO, openVerifiedProjectRoot } from "./activity-signal-reader.mjs";

export const SONNER_OPEN_PROTOCOL_VERSION = 1;
export const SONNER_OPEN_TIMEOUT_MS = 5_000;
export const SONNER_OPEN_MAX_PATH_BYTES = 4_096;
export const SONNER_OPEN_MAX_STDERR_BYTES = 4_096;

const componentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PACKAGED_SONNER_OPEN_FILE = path.join(componentRoot, "native", "sonner-open-file");

function openError(code) {
  const error = new Error("Sonner could not open this file safely.");
  error.code = code;
  return error;
}

export function encodeSonnerOpenRequest(project, projectPath) {
  const encoded = Buffer.from(projectPath, "utf8");
  if (typeof project?.rootIdentity?.dev !== "bigint" || typeof project?.rootIdentity?.ino !== "bigint"
      || !isValidSonnerProjectPath(projectPath) || encoded.length === 0 || encoded.length > SONNER_OPEN_MAX_PATH_BYTES) {
    throw openError("SONNER_FILE_INVALID");
  }
  const payload = Buffer.alloc(1 + 16 + 2 + encoded.length);
  payload[0] = SONNER_OPEN_PROTOCOL_VERSION;
  payload.writeBigUInt64BE(BigInt.asUintN(64, project.rootIdentity.dev), 1);
  payload.writeBigUInt64BE(BigInt.asUintN(64, project.rootIdentity.ino), 9);
  payload.writeUInt16BE(encoded.length, 17);
  encoded.copy(payload, 19);
  const request = Buffer.alloc(4 + payload.length);
  request.writeUInt32BE(payload.length, 0);
  payload.copy(request, 4);
  return request;
}

async function verifyHelper(helperPath, validateArchitecture) {
  const info = await stat(helperPath);
  if (!info.isFile()) throw new Error("invalid helper");
  await access(helperPath, constants.X_OK);
  if (validateArchitecture) {
    await inspectUniversalMachO(helperPath);
    const { execFile } = await import("node:child_process");
    await new Promise((resolve, reject) => execFile("/usr/bin/codesign", ["--verify", "--strict", helperPath],
      { env: {}, timeout: 2_000, windowsHide: true }, (error) => error ? reject(error) : resolve()));
  }
}

function parseOutput(output) {
  if (output.length !== 12 || output.readUInt32BE(0) !== 2 || output[4] !== 1
      || output[5] !== SONNER_OPEN_PROTOCOL_VERSION || output.readUInt32BE(6) !== 2 || output[10] !== 2
      || output[11] > 3) throw new Error("invalid protocol");
  return output[11];
}

export async function openSonnerFileReference(project, projectPath, {
  helperPath = PACKAGED_SONNER_OPEN_FILE,
  timeoutMs = SONNER_OPEN_TIMEOUT_MS,
  platform = process.platform,
  validateArchitecture = helperPath === PACKAGED_SONNER_OPEN_FILE,
  spawnImpl = spawn,
  openRootImpl,
  onTransition,
} = {}) {
  let rootHandle;
  try {
    if (platform !== "darwin" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw openError("SONNER_FILE_OPEN_UNAVAILABLE");
    }
    const request = encodeSonnerOpenRequest(project, projectPath);
    await verifyHelper(helperPath, validateArchitecture);
    rootHandle = await openVerifiedProjectRoot(project, { platform, ...(openRootImpl ? { openImpl: openRootImpl } : {}) });
    const child = spawnImpl(helperPath, [], {
      shell: false,
      stdio: onTransition ? ["pipe", "pipe", "pipe", rootHandle.fd, "pipe"] : ["pipe", "pipe", "pipe", rootHandle.fd, "ignore"],
      env: onTransition ? { SONNER_OPEN_CONTROL_FD: "4" } : {},
    });
    let output = Buffer.alloc(0);
    let stderrBytes = 0;
    let failure = false;
    let terminal = false;
    let controlBuffered = "";
    let controlActive = false;
    const kill = () => { if (!terminal) { try { child.kill("SIGKILL"); } catch { /* close is authoritative */ } } };
    const fail = () => { if (!failure) { failure = true; kill(); } };
    const closed = new Promise((resolve) => child.once("close", (code, signal) => { terminal = true; resolve({ code, signal }); }));
    child.once("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      output = Buffer.concat([output, chunk]);
      if (output.length > 64) fail();
    });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes > SONNER_OPEN_MAX_STDERR_BYTES) fail(); });
    const control = onTransition ? child.stdio[4] : null;
    if (control) {
      control.setEncoding("utf8");
      control.on("error", fail);
      control.on("data", (chunk) => {
        if (failure) return;
        controlBuffered += chunk;
        let newline = controlBuffered.indexOf("\n");
        while (newline >= 0) {
          const event = controlBuffered.slice(0, newline);
          controlBuffered = controlBuffered.slice(newline + 1);
          if (controlActive) { fail(); return; }
          controlActive = true;
          Promise.resolve(onTransition(event)).then(() => {
            if (!failure && !terminal) control.write(Buffer.from([1]), (error) => { controlActive = false; if (error) fail(); });
          }, () => { controlActive = false; fail(); });
          newline = controlBuffered.indexOf("\n");
        }
      });
    }
    await rootHandle.close(); rootHandle = null;
    child.stdin.end(request);
    const timer = setTimeout(fail, timeoutMs);
    const result = await closed;
    clearTimeout(timer);
    if (failure || result.code !== 0 || result.signal || controlBuffered || controlActive) throw openError("SONNER_FILE_OPEN_UNAVAILABLE");
    const status = parseOutput(output);
    if (status === 0) return;
    if (status === 1) throw openError("SONNER_FILE_INVALID");
    if (status === 2) throw openError("SONNER_FILE_CHANGED");
    throw openError("SONNER_FILE_OPEN_UNAVAILABLE");
  } catch (error) {
    if (error?.code?.startsWith?.("SONNER_FILE_")) throw error;
    throw openError("SONNER_FILE_OPEN_UNAVAILABLE");
  } finally {
    await rootHandle?.close().catch(() => {});
  }
}
