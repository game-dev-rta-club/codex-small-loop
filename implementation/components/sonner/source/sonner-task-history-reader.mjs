import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { scanCodexTaskEvents, createTaskEventReducer } from "../../runtime/source/codex-jsonl.mjs";
import { resolveCodexSessionRoots } from "../../runtime/source/codex-session-locator.mjs";
import {
  inspectSonnerUniversalMachOBytes,
  isSonnerOperationAbort,
  sonnerOperationError,
} from "./sonner-project-reader.mjs";
import { observePortableSonnerTasks } from "./sonner-portable-io.mjs";

export const SONNER_HISTORY_PROTOCOL_VERSION = 2;
export const SONNER_HISTORY_MAX_TASKS = 512;
export const SONNER_HISTORY_MAX_OUTPUT_BYTES = 256 * 1024 * 1024 + 1024 * 1024;
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
const FRAME_HELLO = 1;
const FRAME_BEGIN = 2;
const FRAME_CHUNK = 3;
const FRAME_END = 4;
const FRAME_FINAL = 5;
const STATUS_ACTIVE = 1;
const STATUS_ARCHIVED = 2;
const STATUS_MISSING = 3;
const STATUS_UNKNOWN = 4;
const componentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PACKAGED_SONNER_HISTORY_READER = path.join(componentRoot, "native", "sonner-task-history-reader");
const execFileAsync = promisify(execFile);

function historyError() {
  const error = new Error("Sonner Task history reader unavailable.");
  error.code = "SONNER_HISTORY_READER_UNAVAILABLE";
  return error;
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validRelativeHint(hint) {
  if (hint === null) return true;
  if (typeof hint !== "string" || !hint || hint.includes("\0") || hint.includes("\\") || path.isAbsolute(hint)
      || Buffer.byteLength(hint) > 4096) return false;
  return hint.split("/").every((part) => part && part !== "." && part !== ".." && Buffer.byteLength(part) <= 512);
}

async function verifyHelper(helperPath, validateArchitecture, operation) {
  operation.throwIfAborted();
  const status = await stat(helperPath);
  operation.throwIfAborted();
  if (!status.isFile()) throw historyError();
  await access(helperPath, constants.X_OK);
  operation.throwIfAborted();
  if (validateArchitecture) {
    inspectSonnerUniversalMachOBytes(await readFile(helperPath));
    operation.throwIfAborted();
    const remaining = operation.remainingMs();
    if (remaining <= 0) throw sonnerOperationError();
    await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", helperPath], {
      env: {}, timeout: Math.min(2_000, remaining),
    });
    operation.throwIfAborted();
  }
}

function standaloneOperation(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw historyError();
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  let reason = null;
  const abort = (value = sonnerOperationError()) => {
    if (controller.signal.aborted) return false;
    reason = value instanceof Error ? value : sonnerOperationError();
    controller.abort(reason);
    return true;
  };
  const timer = setTimeout(() => abort(), timeoutMs);
  return {
    deadline,
    signal: controller.signal,
    remainingMs: () => Math.max(0, deadline - Date.now()),
    abort,
    throwIfAborted() {
      if (controller.signal.aborted || Date.now() >= deadline) {
        if (!controller.signal.aborted) abort();
        throw reason ?? sonnerOperationError();
      }
    },
    close() { clearTimeout(timer); },
  };
}

async function openRoot(directory, openImpl, operation) {
  let handle = null;
  let closed = false;
  const close = async () => {
    if (closed || !handle) return;
    closed = true;
    await handle.close();
  };
  try {
    operation.throwIfAborted();
    handle = await openImpl(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_CLOEXEC | DARWIN_O_NOFOLLOW_ANY);
    operation.throwIfAborted();
    const status = await handle.stat({ bigint: true });
    operation.throwIfAborted();
    if (!status.isDirectory()) throw historyError();
    return { handle, identity: { dev: status.dev, ino: status.ino }, close };
  } catch (error) {
    await close().catch(() => {});
    if (!handle && error?.code === "ENOENT") return null;
    throw error;
  }
}

function waitForWritable(current, operation) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      current.stream.off("drain", onDrain);
      current.stream.off("error", onError);
      current.stream.off("close", onClose);
      operation.signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onDrain = () => finish(resolve);
    const onError = (error) => current.failed ? finish(resolve) : finish(reject, error);
    const onClose = () => current.failed ? finish(resolve) : finish(reject, historyError());
    const onAbort = () => finish(reject, operation.signal.reason ?? sonnerOperationError());
    current.stream.once("drain", onDrain);
    current.stream.once("error", onError);
    current.stream.once("close", onClose);
    operation.signal.addEventListener("abort", onAbort, { once: true });
    current.scanSettled.then(() => { if (current.failed) finish(resolve); });
    if (operation.signal.aborted) onAbort();
  });
}

export function encodeSonnerHistoryRequest(taskIds, roots, hints = new Map()) {
  if (!Array.isArray(taskIds) || taskIds.length > SONNER_HISTORY_MAX_TASKS || roots.length !== 2) throw historyError();
  const ids = taskIds.map((taskId) => Buffer.from(taskId, "utf8"));
  for (let index = 0; index < ids.length; index += 1) {
    if (!ids[index].length || ids[index].length > 512 || taskIds[index].includes("/") || taskIds[index].includes("\\")
        || (index > 0 && compareText(taskIds[index - 1], taskIds[index]) >= 0)) throw historyError();
  }
  const encodedHints = taskIds.map((taskId) => {
    const pair = hints.get(taskId) ?? [null, null];
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((hint) => !validRelativeHint(hint))) throw historyError();
    return pair.map((hint) => hint === null ? Buffer.alloc(0) : Buffer.from(hint, "utf8"));
  });
  for (const pair of encodedHints) for (const hint of pair) {
    if (hint.length > 4096) throw historyError();
  }
  const payload = Buffer.alloc(1 + 34 + 2 + ids.reduce((total, id, index) =>
    total + 2 + id.length + 2 + encodedHints[index][0].length + 2 + encodedHints[index][1].length, 0));
  let offset = 0; payload[offset++] = SONNER_HISTORY_PROTOCOL_VERSION;
  for (const root of roots) {
    payload[offset++] = root ? 1 : 0;
    payload.writeBigUInt64BE(root ? BigInt.asUintN(64, root.identity.dev) : 0n, offset); offset += 8;
    payload.writeBigUInt64BE(root ? BigInt.asUintN(64, root.identity.ino) : 0n, offset); offset += 8;
  }
  payload.writeUInt16BE(ids.length, offset); offset += 2;
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]; payload.writeUInt16BE(id.length, offset); offset += 2; id.copy(payload, offset); offset += id.length;
    for (const hint of encodedHints[index]) { payload.writeUInt16BE(hint.length, offset); offset += 2; hint.copy(payload, offset); offset += hint.length; }
  }
  const request = Buffer.alloc(payload.length + 4); request.writeUInt32BE(payload.length, 0); payload.copy(request, 4); return request;
}

function cachedHints(taskIds, cachedPaths, rootsConfig) {
  const result = new Map();
  if (!(cachedPaths instanceof Map)) return result;
  for (const taskId of taskIds) {
    const cached = cachedPaths.get(taskId);
    if (typeof cached !== "string" || !path.isAbsolute(cached)
        || !path.basename(cached).endsWith(`${taskId}.jsonl`)) continue;
    const hints = [null, null];
    for (let index = 0; index < rootsConfig.length; index += 1) {
      const relative = path.relative(path.normalize(rootsConfig[index].directory), path.normalize(cached));
      const components = relative.split(path.sep);
      if (!relative || path.isAbsolute(relative) || components.some((part) => !part || part === ".." || Buffer.byteLength(part) > 512)
          || Buffer.byteLength(relative) > 4096) continue;
      hints[index] = components.join("/");
    }
    if (hints.some(Boolean)) result.set(taskId, hints);
  }
  return result;
}

function unknown(taskId, location = "missing") {
  return { taskId, location, historyFile: null, latestTurnId: null, turnState: "unknown", diagnostics: [{ code: "TASK_HISTORY_UNAVAILABLE" }] };
}

export async function observeSonnerTasks(requests, options = {}) {
  if (options.platform === "win32" || options.session?.platform === "win32") {
    return observePortableSonnerTasks(requests, options);
  }
  const taskIds = requests.map(({ taskId }) => taskId).sort(compareText);
  if (taskIds.length === 0) return [];
  const rootsConfig = options.roots ?? resolveCodexSessionRoots();
  if (!Array.isArray(rootsConfig) || rootsConfig.length !== 2
      || rootsConfig[0].location !== "active" || rootsConfig[1].location !== "archived") {
    return requests.map(({ taskId }) => unknown(taskId));
  }
  const suppliedOperation = options.session ?? options.operation ?? null;
  const operation = suppliedOperation ?? standaloneOperation(options.timeoutMs ?? 5_000);
  const ownsOperation = suppliedOperation === null;
  const roots = [null, null];
  const ownedRoots = [];
  let current = null;
  try {
    operation.throwIfAborted();
    await verifyHelper(options.helperPath ?? PACKAGED_SONNER_HISTORY_READER, options.validateArchitecture ?? true, operation);
    for (let index = 0; index < rootsConfig.length; index += 1) {
      operation.throwIfAborted();
      const root = await openRoot(rootsConfig[index].directory, options.openImpl ?? open, operation);
      roots[index] = root;
      if (root) ownedRoots.push(root);
    }
    const identities = new Set(roots.filter(Boolean).map(({ identity }) => `${identity.dev}:${identity.ino}`));
    if (identities.size !== roots.filter(Boolean).length) throw historyError();
    const request = encodeSonnerHistoryRequest(taskIds, roots, cachedHints(taskIds, options.cachedPaths, rootsConfig));
    operation.throwIfAborted();
    const child = (options.spawnImpl ?? spawn)(options.helperPath ?? PACKAGED_SONNER_HISTORY_READER, [], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe", roots[0]?.handle.fd ?? "ignore", roots[1]?.handle.fd ?? "ignore"],
      env: {},
    });
    let failure = null; let terminal = false; let killed = false; let stderrBytes = 0; let outputBytes = 0;
    let requestFinished = false;
    const destroyCurrent = () => {
      if (!current?.stream || current.stream.destroyed) return;
      current.failed = true;
      current.stream.destroy(historyError());
    };
    const fail = (error = historyError()) => {
      if (failure) return;
      failure = error instanceof Error ? error : historyError();
      destroyCurrent();
      if (!child.stdin.destroyed) child.stdin.destroy();
      if (!child.stdout.destroyed) child.stdout.destroy();
      if (!terminal && !killed) { killed = true; try { child.kill("SIGKILL"); } catch {} }
    };
    child.on("error", fail); child.stdin.on("error", fail); child.stdout.on("error", fail); child.stderr.on("error", fail);
    child.stdin.on("finish", () => { requestFinished = true; });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes > 4096) fail(); });
    const closed = new Promise((resolve) => child.once("close", (code, signal) => {
      terminal = true; resolve({ code, signal });
    }));
    const abort = () => fail(operation.signal.reason ?? sonnerOperationError());
    operation.signal.addEventListener("abort", abort, { once: true });
    if (operation.signal.aborted) abort();
    child.stdin.end(request);
    let buffered = Buffer.alloc(0); let hello = false; let final = false; let nextIndex = 0;
    const byTaskId = new Map();
    const consume = async (frame) => {
      const type = frame[0];
      if (final) throw historyError();
      if (type === FRAME_HELLO) {
        if (hello || frame.length !== 2 || frame[1] !== SONNER_HISTORY_PROTOCOL_VERSION) throw historyError();
        hello = true; return;
      }
      if (!hello) throw historyError();
      if (type === FRAME_BEGIN) {
        if (current || frame.length !== 5 || frame.readUInt16BE(1) !== nextIndex || ![STATUS_ACTIVE, STATUS_ARCHIVED, STATUS_MISSING, STATUS_UNKNOWN].includes(frame[3]) || ![0, 1].includes(frame[4])) throw historyError();
        const taskId = taskIds[nextIndex];
        current = { taskId, status: frame[3], truncated: frame[4] === 1, stream: null, reducer: null, scan: null, failed: false };
        if ([STATUS_ACTIVE, STATUS_ARCHIVED].includes(current.status)) {
          const record = current;
          record.stream = new PassThrough({ highWaterMark: 1024 * 1024 }); record.reducer = createTaskEventReducer({ mode: "latest" });
          record.stream.on("error", () => {});
          record.scan = scanCodexTaskEvents(record.stream, (event) => record.reducer.accept(event));
          record.scanSettled = record.scan.then(() => {}, () => {
            record.failed = true;
            if (!record.stream.destroyed) record.stream.destroy();
          });
        }
        return;
      }
      if (type === FRAME_CHUNK) {
        if (!current || !current.stream || frame.length < 7 || frame.readUInt16BE(1) !== nextIndex
            || frame.readUInt32BE(3) !== frame.length - 7 || frame.length - 7 > 65536) throw historyError();
        if (!current.failed && !current.stream.write(frame.subarray(7))) await waitForWritable(current, operation);
        operation.throwIfAborted();
        return;
      }
      if (type === FRAME_END) {
        if (!current || frame.length !== 3 || frame.readUInt16BE(1) !== nextIndex) throw historyError();
        const taskId = current.taskId;
        if (current.stream) { current.stream.end(); await current.scanSettled; }
        if (current.failed || current.status === STATUS_UNKNOWN) byTaskId.set(taskId, unknown(taskId));
        else if (current.status === STATUS_MISSING) byTaskId.set(taskId, unknown(taskId));
        else {
          const reduced = current.reducer.result();
          byTaskId.set(taskId, current.truncated && reduced.turnState === "not_started" ? unknown(taskId) : {
            taskId,
            location: current.status === STATUS_ACTIVE ? "active" : "archived",
            historyFile: null,
            latestTurnId: reduced.turnId,
            turnState: reduced.turnState,
            diagnostics: reduced.diagnostics,
          });
        }
        current = null; nextIndex += 1; return;
      }
      if (type === FRAME_FINAL) {
        if (current || frame.length !== 3 || frame.readUInt16BE(1) !== taskIds.length || nextIndex !== taskIds.length) throw historyError();
        final = true; return;
      }
      throw historyError();
    };
    const stdout = (async () => {
      for await (const chunk of child.stdout) {
        operation.throwIfAborted();
        outputBytes += chunk.length; if (outputBytes > SONNER_HISTORY_MAX_OUTPUT_BYTES) throw historyError();
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 4) {
          const length = buffered.readUInt32BE(0);
          if (!length || length > 65543) throw historyError();
          if (buffered.length < length + 4) break;
          await consume(buffered.subarray(4, length + 4)); buffered = buffered.subarray(length + 4);
        }
      }
    })().catch((error) => fail(error));
    const result = await closed;
    await stdout;
    operation.signal.removeEventListener("abort", abort);
    if (current?.stream) {
      destroyCurrent();
      await current.scanSettled;
    }
    if (failure) throw failure;
    if (result.code !== 0 || result.signal || !requestFinished || buffered.length || !hello || !final) throw historyError();
    operation.throwIfAborted();
    return requests.map(({ taskId }) => byTaskId.get(taskId) ?? unknown(taskId));
  } catch (error) {
    options.onError?.(error);
    if (suppliedOperation && (suppliedOperation.signal.aborted || isSonnerOperationAbort(error))) {
      throw suppliedOperation.signal.reason ?? error;
    }
    return requests.map(({ taskId }) => unknown(taskId));
  } finally {
    if (current?.stream && !current.stream.destroyed) current.stream.destroy();
    await current?.scanSettled;
    await Promise.allSettled([...ownedRoots].reverse().map((root) => root.close()));
    if (ownsOperation) operation.close();
  }
}
