import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

import { classifyPortablePathMetadata } from "../../runtime/source/portable-path-type.mjs";

const MAX_AUTHORIZED_PRIMARY_IDS = 256;
const SNAPSHOT_PATTERN = /^[0-9a-f]{40,64}$/;
const SIGNAL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

function omission(code, primaryTaskId = null) {
  return { code, primaryTaskId, container: code === "ACTIVITY_SIGNAL_DIRECTORY_UNSAFE" };
}

function unavailable() {
  return {
    entries: [],
    omissions: [omission("ACTIVITY_SIGNAL_READER_UNAVAILABLE")],
    diagnostics: [],
    partial: true,
  };
}

function safeComponent(value) {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 512
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0");
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

export function isPortableActivitySignalMetadata(metadata) {
  return classifyPortablePathMetadata(metadata) === "regular-file"
    && metadata.nlink === 1n;
}

async function transition(callback, name) {
  if (callback) await callback(name);
}

async function inspectDirectory(directory, expectedIdentity = null) {
  const status = await lstat(directory, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink()
      || (expectedIdentity && !sameIdentity(status, expectedIdentity))) {
    const error = new Error("unsafe directory");
    error.code = "ACTIVITY_SIGNAL_DIRECTORY_UNSAFE";
    throw error;
  }
  return status;
}

async function revalidateDirectories(directories) {
  for (const { directory, identity } of directories) {
    try {
      if (!sameIdentity(await inspectDirectory(directory), identity)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function listNames(directory, predicate, maximum, onTransition, retainedTransition) {
  const names = (await readdir(directory)).filter(predicate).sort();
  const retained = names.slice(0, maximum);
  for (const name of retained) await transition(onTransition, retainedTransition);
  return { names: retained, bounded: names.length > maximum };
}

async function inspectSignalFile({ file, primaryTaskId, snapshot, name, directories,
  maxSignalBytes, onTransition }) {
  let handle;
  try {
    await transition(onTransition, "before-file-open");
    const pathname = await lstat(file, { bigint: true });
    if (!isPortableActivitySignalMetadata(pathname)) {
      return { omission: omission("ACTIVITY_SIGNAL_NON_REGULAR", primaryTaskId) };
    }
    if (pathname.size > BigInt(maxSignalBytes)) {
      return { omission: omission("ACTIVITY_SIGNAL_OVERSIZED", primaryTaskId) };
    }
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFile(pathname, opened)) {
      return { omission: omission("ACTIVITY_SIGNAL_CHANGED", primaryTaskId) };
    }
    await transition(onTransition, "after-file-open");
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    await transition(onTransition, "after-file-read");
    const final = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    if (offset !== bytes.length || !sameFile(opened, final) || !sameFile(opened, current)
        || !(await revalidateDirectories(directories))) {
      return { omission: omission("ACTIVITY_SIGNAL_CHANGED", primaryTaskId) };
    }
    return {
      entry: {
        primaryTaskId,
        snapshot,
        name,
        raw: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        sourceBytes: bytes.length,
        timestamp: new Date(Number(opened.mtimeNs / 1_000_000n)).toISOString(),
      },
    };
  } catch (error) {
    if (error?.code === "ACTIVITY_SIGNAL_DIRECTORY_UNSAFE") {
      return { omission: omission(error.code, primaryTaskId) };
    }
    return { omission: omission(error?.code === "ELOOP"
      ? "ACTIVITY_SIGNAL_NON_REGULAR" : "ACTIVITY_SIGNAL_UNREADABLE", primaryTaskId) };
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readPortableActivitySignals({ project, authorizedPrimaryIds,
  maxSignals = 1_000, maxSignalBytes = 256 * 1024,
  maxOutputBytes = 6 * 1024 * 1024, onTransition = null } = {}) {
  try {
    if (!path.isAbsolute(project?.root)
        || typeof project?.rootIdentity?.dev !== "bigint"
        || typeof project?.rootIdentity?.ino !== "bigint"
        || !(authorizedPrimaryIds && Symbol.iterator in Object(authorizedPrimaryIds))
        || !Number.isInteger(maxSignals) || maxSignals < 0 || maxSignals > 1_000
        || !Number.isInteger(maxSignalBytes) || maxSignalBytes < 0 || maxSignalBytes > 256 * 1024
        || !Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 8 * 1024 * 1024) {
      return unavailable();
    }
    const authorized = [...new Set(authorizedPrimaryIds)].sort();
    if (authorized.length > MAX_AUTHORIZED_PRIMARY_IDS || authorized.some((id) => !safeComponent(id))) {
      return unavailable();
    }
    const rootIdentity = await inspectDirectory(project.root, project.rootIdentity);
    const runtimeDirectory = path.join(project.root, ".codex-small-loop");
    let runtimeIdentity;
    try {
      runtimeIdentity = await inspectDirectory(runtimeDirectory);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ACTIVITY_SIGNAL_DIRECTORY_UNSAFE") {
        return { entries: [], omissions: [omission("ACTIVITY_SIGNAL_DIRECTORY_UNSAFE")], diagnostics: [], partial: true };
      }
      throw error;
    }
    await transition(onTransition, "after-private-open");
    const signalsDirectory = path.join(runtimeDirectory, "signals");
    let signalsIdentity;
    try {
      signalsIdentity = await inspectDirectory(signalsDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") return { entries: [], omissions: [], diagnostics: [], partial: false };
      return { entries: [], omissions: [omission("ACTIVITY_SIGNAL_DIRECTORY_UNSAFE")], diagnostics: [], partial: true };
    }
    const entries = [];
    const omissions = [];
    let encountered = 0;
    let outputBytes = 0;
    let bounded = false;
    const baseDirectories = [
      { directory: project.root, identity: rootIdentity },
      { directory: runtimeDirectory, identity: runtimeIdentity },
      { directory: signalsDirectory, identity: signalsIdentity },
    ];
    for (const primaryTaskId of authorized) {
      if (bounded) break;
      const primaryDirectory = path.join(signalsDirectory, primaryTaskId);
      let primaryIdentity;
      await transition(onTransition, "before-primary-open");
      try { primaryIdentity = await inspectDirectory(primaryDirectory); }
      catch (error) {
        if (error?.code === "ENOENT") continue;
        omissions.push(omission("ACTIVITY_SIGNAL_DIRECTORY_UNSAFE", primaryTaskId));
        continue;
      }
      const primaryDirectories = [...baseDirectories, { directory: primaryDirectory, identity: primaryIdentity }];
      const snapshots = await listNames(primaryDirectory,
        (name) => SNAPSHOT_PATTERN.test(name), maxSignals, onTransition, "snapshot-name-retained");
      if (snapshots.bounded) { omissions.push(omission("ACTIVITY_SIGNAL_DISCOVERY_BOUNDED", primaryTaskId)); bounded = true; }
      for (const snapshot of snapshots.names) {
        const snapshotDirectory = path.join(primaryDirectory, snapshot);
        let snapshotIdentity;
        await transition(onTransition, "before-snapshot-open");
        try { snapshotIdentity = await inspectDirectory(snapshotDirectory); }
        catch { omissions.push(omission("ACTIVITY_SIGNAL_DIRECTORY_UNSAFE", primaryTaskId)); continue; }
        const directories = [...primaryDirectories, { directory: snapshotDirectory, identity: snapshotIdentity }];
        let signals;
        try {
          signals = await listNames(snapshotDirectory,
            (name) => SIGNAL_PATTERN.test(name) && Buffer.byteLength(name, "utf8") <= 512,
            maxSignals, onTransition, "signal-name-retained");
        } catch { omissions.push(omission("ACTIVITY_SIGNAL_DIRECTORY_UNSAFE", primaryTaskId)); continue; }
        if (signals.bounded && !bounded) { omissions.push(omission("ACTIVITY_SIGNAL_DISCOVERY_BOUNDED", primaryTaskId)); bounded = true; }
        for (const name of signals.names) {
          encountered += 1;
          if (encountered > maxSignals) { bounded = true; omissions.push(omission("ACTIVITY_SIGNAL_DISCOVERY_BOUNDED", primaryTaskId)); break; }
          const inspected = await inspectSignalFile({
            file: path.join(snapshotDirectory, name), primaryTaskId, snapshot, name,
            directories, maxSignalBytes, onTransition,
          });
          if (inspected.omission) { omissions.push(inspected.omission); continue; }
          const entryBytes = inspected.entry.sourceBytes
            + Buffer.byteLength(primaryTaskId + snapshot + name, "utf8") + 128;
          if (outputBytes + entryBytes > maxOutputBytes) {
            bounded = true; omissions.push(omission("ACTIVITY_SIGNAL_DISCOVERY_BOUNDED", primaryTaskId)); break;
          }
          outputBytes += entryBytes;
          entries.push(inspected.entry);
        }
      }
    }
    if (!(await revalidateDirectories(baseDirectories))) return unavailable();
    return { entries, omissions, diagnostics: [], partial: omissions.length > 0 };
  } catch {
    return unavailable();
  }
}
