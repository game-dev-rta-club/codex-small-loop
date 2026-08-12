import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AtomicJsonStore } from "../../runtime/source/atomic-json-store.mjs";
import { resolveProject } from "../../runtime/source/project.mjs";
import { BOARD_SERVER_BUILD_VERSION } from "../server.mjs";

const hostServerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "board-host-server.mjs");
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const HOST_POLL_INTERVAL_MS = 50;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function paths(options = {}) {
  const stateDirectory = options.stateDirectory ?? path.join(os.homedir(), ".codex", "codex-small-loop", "board-host");
  return {
    stateDirectory,
    control: path.join(stateDirectory, "control.json"),
    lifecycle: path.join(stateDirectory, "lifecycle.json"),
    runtime: path.join(stateDirectory, "runtime.json"),
  };
}
async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function probe(runtime, { method = "GET", requestPath = "/api/health", token = null } = {}) {
  if (!runtime || !Number.isSafeInteger(runtime.port) || runtime.port < 1 || runtime.port > 65_535) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = http.request({ hostname: "127.0.0.1", port: runtime.port, path: requestPath, method,
      headers: { Host: `127.0.0.1:${runtime.port}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve(response.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); }
      });
    });
    request.setTimeout(1_000, () => request.destroy());
    request.on("error", () => resolve(null));
    request.end();
  });
}
function projectUrl(runtime, key) { return `${runtime.baseUrl}?project=${key}`; }
async function registered(project, statePaths) {
  const control = await readJson(statePaths.control);
  return control?.version === 1 && control.projects?.[project.key]?.root === project.root;
}
async function liveRuntime(statePaths, probeImpl = probe) {
  const runtime = await readJson(statePaths.runtime);
  const health = await probeImpl(runtime);
  return health?.ok && health.instanceId === runtime.instanceId && health.buildVersion === BOARD_SERVER_BUILD_VERSION
    && runtime.serverPath === hostServerPath
    ? runtime : null;
}

function stopOwnedChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill(); } catch { /* the exact owned child may already have exited */ }
}

async function stopRuntime(runtime, {
  probeImpl = probe,
  sleepImpl = sleep,
  timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
} = {}) {
  if (!runtime) return true;
  const health = await probeImpl(runtime);
  if (!health || health.instanceId !== runtime.instanceId) return true;
  const accepted = await probeImpl(runtime, {
    method: "POST",
    requestPath: "/api/control/stop",
    token: runtime.stopToken,
  });
  if (!accepted?.ok) return false;
  const deadline = Date.now() + timeoutMs;
  do {
    const current = await probeImpl(runtime);
    if (!current || current.instanceId !== runtime.instanceId) return true;
    await sleepImpl(HOST_POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  return false;
}

export async function ensureBoardHost(projectRoot, options = {}) {
  const project = await resolveProject(path.resolve(projectRoot));
  const statePaths = paths(options);
  const control = new AtomicJsonStore(statePaths.control);
  await control.initialize({ version: 1, projects: {} });
  await control.transact((state) => ({ state: { version: 1, projects: { ...state.projects,
    [project.key]: { key: project.key, root: project.root, dev: project.rootIdentity.dev.toString(), ino: project.rootIdentity.ino.toString() } } },
    result: null }));

  const lifecycle = new AtomicJsonStore(statePaths.lifecycle);
  await lifecycle.initialize({ version: 1, generation: 0 });
  const transaction = await lifecycle.transact(async (state) => {
    const probeImpl = options.probeImpl ?? probe;
    const sleepImpl = options.sleepImpl ?? sleep;
    const prior = await readJson(statePaths.runtime);
    const current = await liveRuntime(statePaths, probeImpl);
    if (current) return { state, result: { runtime: current, reused: true }, commit: false };

    const instanceId = randomUUID();
    const stopToken = randomUUID();
    const candidate = path.join(statePaths.stateDirectory, `runtime.${instanceId}.json`);
    const child = (options.spawnImpl ?? spawn)(process.execPath, [hostServerPath,
      "--control-state", statePaths.control,
      "--runtime-state", candidate,
      "--instance-id", instanceId,
      "--stop-token", stopToken,
      "--idle-timeout-ms", String(options.idleTimeoutMs ?? 300_000),
    ], { detached: true, stdio: "ignore", shell: false, windowsHide: true });
    let spawnError = null;
    child.once("error", (error) => { spawnError = error; });
    child.unref();
    const deadline = Date.now() + (options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    let runtime = null;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
      runtime = await readJson(candidate);
      const health = await probeImpl(runtime);
      if (health?.ok && health.instanceId === instanceId && health.buildVersion === BOARD_SERVER_BUILD_VERSION) break;
      runtime = null;
      await sleepImpl(HOST_POLL_INTERVAL_MS);
    }
    if (!runtime) {
      stopOwnedChild(child);
      await rm(candidate, { force: true });
      const error = new Error(spawnError
        ? "Board Host process could not be started"
        : "Board Host did not become ready in time");
      error.code = spawnError ? "BOARD_HOST_START_FAILED" : "BOARD_HOST_START_TIMEOUT";
      throw error;
    }
    if (prior?.instanceId !== runtime.instanceId) {
      const priorStopped = await stopRuntime(prior, {
        probeImpl,
        sleepImpl,
        timeoutMs: options.stopTimeoutMs,
      });
      if (!priorStopped) {
        await stopRuntime(runtime, {
          probeImpl,
          sleepImpl,
          timeoutMs: options.stopTimeoutMs,
        });
        stopOwnedChild(child);
        await rm(candidate, { force: true });
        const error = new Error("Previous Board Host did not stop safely");
        error.code = "BOARD_HOST_REPLACEMENT_STOP_FAILED";
        throw error;
      }
    }
    await rename(candidate, statePaths.runtime);
    return { state: { version: 1, generation: (state.generation ?? 0) + 1 }, result: { runtime, reused: false } };
  });
  const { runtime, reused } = transaction.result;
  return { run: "ok", status: "ready", url: projectUrl(runtime, project.key), pid: runtime.pid,
    projectKey: project.key, reused };
}

export async function boardHostStatus(projectRoot, options = {}) {
  const project = await resolveProject(path.resolve(projectRoot));
  const statePaths = paths(options);
  if (!await registered(project, statePaths)) return { run: "ok", status: "absent", projectKey: project.key };
  const runtime = await liveRuntime(statePaths, options.probeImpl ?? probe);
  return runtime
    ? { run: "ok", status: "ready", url: projectUrl(runtime, project.key), pid: runtime.pid, projectKey: project.key }
    : { run: "ok", status: "absent", projectKey: project.key };
}

export async function boardHostUrl(projectRoot, options = {}) {
  const status = await boardHostStatus(projectRoot, options);
  if (status.status !== "ready") { const error = new Error("Board Host is not ready"); error.code = "BOARD_NOT_READY"; throw error; }
  return status;
}

export async function stopBoardHost(projectRoot, options = {}) {
  const project = await resolveProject(path.resolve(projectRoot));
  const statePaths = paths(options);
  const control = new AtomicJsonStore(statePaths.control);
  await control.initialize({ version: 1, projects: {} });
  const changed = await control.transact((state) => {
    const projects = { ...state.projects };
    const removed = projects[project.key] ?? null;
    const existed = Boolean(removed);
    delete projects[project.key];
    return { state: { version: 1, projects }, result: { existed, removed, remaining: Object.keys(projects).length } };
  });
  let hostStopped = false;
  if (changed.result.remaining === 0) {
    const runtime = await readJson(statePaths.runtime);
    const stopped = await stopRuntime(runtime, {
      probeImpl: options.probeImpl ?? probe,
      sleepImpl: options.sleepImpl ?? sleep,
      timeoutMs: options.stopTimeoutMs,
    });
    if (!stopped) {
      if (changed.result.removed) {
        await control.transact((state) => ({
          state: {
            version: 1,
            projects: state.projects[project.key]
              ? state.projects
              : { ...state.projects, [project.key]: changed.result.removed },
          },
          result: null,
        }));
      }
      const error = new Error("Board Host did not stop safely");
      error.code = "BOARD_HOST_STOP_FAILED";
      throw error;
    }
    await rm(statePaths.runtime, { force: true });
    hostStopped = true;
  }
  return { run: "ok", status: changed.result.existed ? "stopped" : "absent", projectKey: project.key, hostStopped };
}
