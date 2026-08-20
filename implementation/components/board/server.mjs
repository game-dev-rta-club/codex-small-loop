import { createServer } from "node:http";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveProject } from "../runtime/source/project.mjs";
import { buildSonnerProject, serializeSonner } from "../sonner/source/sonner.mjs";
import { isValidSonnerProjectPath } from "../sonner/source/sonner-project-reader.mjs";
import { createActivityLiveSession, loadActivity, updateActivityLiveSession } from "./source/activity-data.mjs";
import { openSonnerFileReference } from "./source/sonner-open-file.mjs";

export const BOARD_SERVER_BUILD_VERSION = "board-host-v11";
export const MAX_BOARD_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_SONNER_OPEN_REQUEST_BYTES = 8 * 1024;

const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const STATIC = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/activity-selection.js", ["activity-selection.js", "text/javascript; charset=utf-8"]],
  ["/sonner-view.js", ["sonner-view.js", "text/javascript; charset=utf-8"]],
  ["/vendor/elk.bundled.js", ["vendor/elk.bundled.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { ...HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}
function boundedJson(response, value, maximum, serialize = JSON.stringify) {
  const body = serialize(value);
  if (Buffer.byteLength(body) > maximum) {
    json(response, 503, { error: "BOARD_RESPONSE_BOUNDED", message: "The Board response exceeded its safety bound." });
    return;
  }
  response.writeHead(200, { ...HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}
function canWrite(response) { return !response.destroyed && !response.writableEnded; }
function authorizedProject(value, key = value?.key) {
  return value && Object.isFrozen(value) && Object.isFrozen(value.rootIdentity)
    && typeof value.root === "string" && path.isAbsolute(value.root)
    && value.key === key && /^[0-9a-f]{64}$/.test(value.key)
    && typeof value.rootIdentity.dev === "bigint" && typeof value.rootIdentity.ino === "bigint";
}

function findIndexedFile(node, projectPath) {
  if (node?.path === projectPath) return node.type === "file" ? node : null;
  for (const child of node?.children ?? []) {
    const found = findIndexedFile(child, projectPath);
    if (found) return found;
  }
  return null;
}

function isIndexedWorkDirectory(workGraph, projectPath) {
  return workGraph?.status === "valid"
    && workGraph.works.some((work) => path.posix.dirname(work.nodePath) === projectPath);
}

function sonnerOpenError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function openSonnerFile(project, projectPath, {
  sonnerLoader = buildSonnerProject,
  nativeOpener = openSonnerFileReference,
} = {}) {
  if (!authorizedProject(project) || !isValidSonnerProjectPath(projectPath)) {
    throw sonnerOpenError("SONNER_FILE_INVALID", "Invalid Sonner file path.");
  }
  const projection = await sonnerLoader(project);
  if (!findIndexedFile(projection?.files?.root, projectPath)
      && !isIndexedWorkDirectory(projection?.workGraph, projectPath)) {
    throw sonnerOpenError("SONNER_FILE_NOT_INDEXED", "The path is not present in the Sonner index.");
  }

  await nativeOpener(project, projectPath);
}

async function readOpenRequest(request) {
  const contentLength = Number(request.headers["content-length"] ?? -1);
  if (request.headers["transfer-encoding"] !== undefined || !Number.isSafeInteger(contentLength)
      || contentLength < 1 || contentLength > MAX_SONNER_OPEN_REQUEST_BYTES
      || request.headers["content-type"] !== "application/json") {
    throw sonnerOpenError("SONNER_OPEN_REQUEST_INVALID", "Invalid Sonner open request.");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_SONNER_OPEN_REQUEST_BYTES) throw sonnerOpenError("SONNER_OPEN_REQUEST_INVALID", "Invalid Sonner open request.");
    chunks.push(chunk);
  }
  if (length !== contentLength) throw sonnerOpenError("SONNER_OPEN_REQUEST_INVALID", "Invalid Sonner open request.");
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw sonnerOpenError("SONNER_OPEN_REQUEST_INVALID", "Invalid Sonner open request."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.path !== "string") {
    throw sonnerOpenError("SONNER_OPEN_REQUEST_INVALID", "Invalid Sonner open request.");
  }
  return value.path;
}

export function createLeaseTracker({ idleTimeoutMs = 5 * 60_000, onIdle = () => {} } = {}) {
  let leases = 0;
  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(onIdle, idleTimeoutMs);
    timer.unref?.();
  };
  schedule();
  return {
    open() {
      clearTimeout(timer);
      leases += 1;
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        leases -= 1;
        if (leases === 0) schedule();
      };
    },
    close() { clearTimeout(timer); },
    get size() { return leases; },
  };
}

export function createBoardServer({ projectRoot, project = null, projectResolver, activityLoader = loadActivity, sonnerLoader = buildSonnerProject,
  activityLiveSessionFactory = createActivityLiveSession, activityLiveUpdater = updateActivityLiveSession,
  fileOpener = openSonnerFile,
  maxResponseBytes = MAX_BOARD_RESPONSE_BYTES, runtimeIdentity = null, leaseTracker = null,
  stopToken = null, onStop = null } = {}) {
  if (!projectResolver && (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot))) {
    throw new TypeError("projectRoot must be absolute unless projectResolver is supplied");
  }
  const busy = new Set();
  const openBusy = new Set();
  const liveActivities = new Map();
  const server = createServer(async (request, response) => {
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : null;
    if (request.headers.host !== `127.0.0.1:${port}`) return json(response, 421, { error: "BOARD_HOST_REJECTED" });
    let url;
    try { url = new URL(request.url ?? "/", "http://127.0.0.1"); }
    catch { return json(response, 400, { error: "BOARD_URL_INVALID" }); }

    if (request.method === "POST" && url.pathname === "/api/control/stop") {
      if (!stopToken || request.headers.authorization !== `Bearer ${stopToken}`) {
        return json(response, 403, { error: "BOARD_CONTROL_REJECTED" });
      }
      json(response, 200, { ok: true });
      setImmediate(() => onStop?.());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/sonner/open") {
      if (request.headers.origin !== `http://127.0.0.1:${port}`) {
        return json(response, 403, { error: "SONNER_OPEN_ORIGIN_REJECTED" });
      }
      const projectKey = url.searchParams.get("project");
      let selectedProject = project;
      if (projectResolver) {
        selectedProject = /^[0-9a-f]{64}$/.test(projectKey ?? "") ? await projectResolver(projectKey) : null;
        if (!authorizedProject(selectedProject, projectKey)) return json(response, 404, { error: "BOARD_PROJECT_NOT_FOUND" });
      }
      try {
        const projectPath = await readOpenRequest(request);
        const openKey = `${selectedProject.key}\0${projectPath}`;
        if (openBusy.has(openKey)) return json(response, 409, { error: "SONNER_FILE_OPEN_IN_PROGRESS" });
        openBusy.add(openKey);
        try {
          await fileOpener(selectedProject, projectPath);
          return json(response, 200, { ok: true });
        } finally { openBusy.delete(openKey); }
      } catch (error) {
        if (error?.code === "SONNER_OPEN_REQUEST_INVALID" || error?.code === "SONNER_FILE_INVALID") {
          return json(response, 400, { error: error.code });
        }
        if (error?.code === "SONNER_FILE_NOT_INDEXED") return json(response, 404, { error: error.code });
        if (error?.code === "SONNER_FILE_CHANGED") return json(response, 409, { error: error.code });
        return json(response, 503, { error: "SONNER_FILE_OPEN_UNAVAILABLE" });
      }
    }
    if (request.method !== "GET") return json(response, 405, { error: "BOARD_READ_ONLY" });
    if (request.headers["transfer-encoding"] !== undefined || Number(request.headers["content-length"] ?? 0) > 0) {
      return json(response, 400, { error: "BOARD_REQUEST_BODY_REJECTED" });
    }
    if (url.pathname === "/api/health") {
      return json(response, 200, { ok: true, service: "codex-small-loop-board", buildVersion: BOARD_SERVER_BUILD_VERSION,
        localOnly: true, ...(runtimeIdentity ?? {}) });
    }

    let selectedProject = project;
    let selectedRoot = project?.root ?? projectRoot;
    const projectKey = url.searchParams.get("project");
    if (projectResolver && ["/api/activities", "/api/activity", "/api/activity/updates", "/api/sonner", "/api/lease"].includes(url.pathname)) {
      selectedProject = /^[0-9a-f]{64}$/.test(projectKey ?? "") ? await projectResolver(projectKey) : null;
      if (!authorizedProject(selectedProject, projectKey)) return json(response, 404, { error: "BOARD_PROJECT_NOT_FOUND" });
      selectedRoot = selectedProject.root;
    }
    if (url.pathname === "/api/lease") {
      if (!leaseTracker) return json(response, 404, { error: "BOARD_LEASE_UNAVAILABLE" });
      const release = leaseTracker.open(projectKey);
      response.writeHead(200, { ...HEADERS, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
      response.write("event: ready\ndata: {}\n\n");
      const keepalive = setInterval(() => response.write(": keepalive\n\n"), 30_000);
      keepalive.unref?.();
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        release();
      };
      request.once("close", close);
      response.once("close", close);
      return;
    }
    if (["/api/activities", "/api/activity", "/api/activity/updates", "/api/sonner"].includes(url.pathname)) {
      const busyKey = projectKey ?? selectedRoot;
      if (busy.has(busyKey)) {
        response.setHeader("Retry-After", "1");
        return json(response, 429, { error: "BOARD_BUSY", message: "Another Board data request is in progress. Retry or Refresh." });
      }
      busy.add(busyKey);
      try {
        if (url.pathname === "/api/sonner") {
          boundedJson(response, await sonnerLoader(selectedProject), maxResponseBytes, serializeSonner);
          return;
        }
        if (url.pathname === "/api/activity/updates") {
          const activityId = url.searchParams.get("id");
          const revision = Number(url.searchParams.get("revision"));
          const cached = liveActivities.get(busyKey);
          if (!cached || cached.activityId !== activityId) {
            return json(response, 409, { error: "ACTIVITY_REFRESH_REQUIRED", reason: "cache_miss" });
          }
          try {
            const update = await activityLiveUpdater(cached.session, { revision });
            boundedJson(response, update, maxResponseBytes);
          } catch (error) {
            if (error?.code === "ACTIVITY_LIVE_REFRESH_REQUIRED") {
              liveActivities.delete(busyKey);
              return json(response, 409, { error: "ACTIVITY_REFRESH_REQUIRED", reason: error.reason ?? "changed" });
            }
            throw error;
          }
          return;
        }
        if (url.pathname === "/api/activities" || url.pathname === "/api/activity") {
          liveActivities.delete(busyKey);
        }
        const activity = await activityLoader(selectedRoot);
        if (!canWrite(response)) return;
        if (url.pathname === "/api/activities") {
          boundedJson(response, { project: activity.project, activities: activity.activities, partial: activity.partial }, maxResponseBytes);
          return;
        }
        const detail = activity.detail(url.searchParams.get("id"));
        if (!detail) return json(response, 404, { error: "ACTIVITY_NOT_FOUND" });
        const activityId = url.searchParams.get("id");
        const session = activityLiveSessionFactory(activity, activityId);
        if (session) liveActivities.set(busyKey, { activityId, session });
        else liveActivities.delete(busyKey);
        boundedJson(response, { ...detail, live: session
          ? { status: "ready", revision: session.revision }
          : { status: "refresh-required", reason: "continuation_unavailable" } }, maxResponseBytes);
      } catch (error) {
        if (canWrite(response)) json(response, 503, {
          error: error?.code === "ACTIVITY_LEDGER_UNAVAILABLE"
            ? "ACTIVITY_LEDGER_UNAVAILABLE"
            : url.pathname === "/api/sonner" ? "SONNER_DATA_UNAVAILABLE" : "ACTIVITY_DATA_UNAVAILABLE",
          message: `${url.pathname === "/api/sonner" ? "Sonner" : "Activity"} data could not be inspected safely. A later request can retry.`,
        });
      } finally { busy.delete(busyKey); }
      return;
    }

    const entry = STATIC.get(url.pathname);
    if (!entry) return json(response, 404, { error: "BOARD_NOT_FOUND" });
    try {
      const body = await readFile(path.join(publicRoot, entry[0]));
      response.writeHead(200, { ...HEADERS, "Content-Type": entry[1], "Content-Length": body.length });
      response.end(body);
    } catch { json(response, 500, { error: "BOARD_ASSET_UNAVAILABLE" }); }
  });
  return server;
}

export async function listenBoard({ projectRoot = process.cwd(), projectResolver, port = 0, activityLoader, sonnerLoader, fileOpener,
  activityLiveSessionFactory, activityLiveUpdater,
  maxResponseBytes, runtimeIdentity = null, leaseTracker = null, stopToken = null, onStop = null } = {}) {
  const project = projectResolver ? null : await resolveProject(path.resolve(projectRoot));
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError("port must be an integer from 0 to 65535");
  const server = createBoardServer({ projectRoot: project?.root, project, projectResolver, activityLoader, sonnerLoader, fileOpener,
    activityLiveSessionFactory, activityLiveUpdater, maxResponseBytes,
    runtimeIdentity, leaseTracker, stopToken, onStop });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}/`, project };
}

export async function publishBoardRuntimeState(stateFile, state) {
  if (typeof stateFile !== "string" || !path.isAbsolute(stateFile)) throw new TypeError("stateFile must be absolute");
  await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, stateFile);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}

function parseArguments(argv) {
  let projectRoot = process.cwd();
  let port = 0;
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] === "--project-root") projectRoot = argv[index + 1];
    else if (argv[index] === "--port") port = Number(argv[index + 1]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return { projectRoot: path.resolve(projectRoot), port };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { server, url } = await listenBoard(parseArguments(process.argv.slice(2)));
    process.stdout.write(`Codex Small Loop Board: ${url}\n`);
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
  } catch (error) {
    process.stderr.write(`Codex Small Loop Board could not start: ${error.message}\n`);
    process.exitCode = 1;
  }
}
