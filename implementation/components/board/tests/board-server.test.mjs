import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { BOARD_SERVER_BUILD_VERSION, createLeaseTracker, listenBoard, openSonnerFile } from "../server.mjs";
import { buildSonner, buildSonnerProject, serializeSonner } from "../../sonner/source/sonner.mjs";
import { resolveProject } from "../../runtime/source/project.mjs";

const execFileAsync = promisify(execFile);

function request({ port, requestPath = "/api/health", method = "GET", host, body = "", headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: requestPath, method, headers: { Host: host ?? `127.0.0.1:${port}`, ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8"); res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject); req.end(body);
  });
}

function abortableRequest({ port, requestPath = "/api/activities" }) {
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const req = http.request({ hostname: "127.0.0.1", port, path: requestPath, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    res.resume();
    res.on("end", () => settle({ status: res.statusCode }));
  });
  req.on("error", (error) => settle({ error }));
  req.end();
  return { req, done };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

test("server uses an OS-assigned loopback port, enforces Host, and rejects mutations", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-server-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  let loadCount = 0;
  const { server, url } = await listenBoard({ projectRoot, port: 0, activityLoader: async () => { loadCount += 1; return { project: {}, activities: [], detail: () => null }; } });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = new URL(url).port;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(loadCount, 0, "idle startup performs no history work");
  const health = await request({ port: Number(port) });
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).buildVersion, BOARD_SERVER_BUILD_VERSION);
  assert.equal(health.headers["cache-control"], "no-store");
  assert.equal((await request({ port: Number(port), requestPath: "/activity-selection.js" })).status, 200);
  assert.equal((await request({ port: Number(port), requestPath: "/selection.js" })).status, 404);
  assert.equal((await request({ port: Number(port), requestPath: "/api/roots" })).status, 404);
  assert.equal((await request({ port: Number(port), requestPath: "/api/root?id=legacy" })).status, 404);
  const elkAsset = await request({ port: Number(port), requestPath: "/vendor/elk.bundled.js" });
  assert.equal(elkAsset.status, 200);
  assert.match(elkAsset.headers["content-type"], /^text\/javascript/);
  assert.equal((await request({ port: Number(port), host: `localhost:${port}` })).status, 421);
  assert.equal((await request({ port: Number(port), method: "POST" })).status, 405);
  assert.equal((await request({ port: Number(port), body: "unexpected" })).status, 400);
  assert.equal(loadCount, 0, "health and rejected requests do not load history");
});

test("shared host resolves a project key and holds a browser lease", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-shared-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const project = await resolveProject(projectRoot);
  const projectKey = project.key;
  let leased = 0;
  const { server, url } = await listenBoard({
    projectResolver: async (key) => key === projectKey ? project : null,
    leaseTracker: {
      open() { leased += 1; return () => { leased -= 1; }; },
    },
    activityLoader: async (root) => ({ project: { root }, activities: [], partial: false, detail: () => null }),
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = Number(new URL(url).port);
  assert.equal((await request({ port, requestPath: `/api/activities?project=${projectKey}` })).status, 200);
  assert.equal((await request({ port, requestPath: `/api/activities?project=${"b".repeat(64)}` })).status, 404);

  const lease = http.request({ hostname: "127.0.0.1", port, path: `/api/lease?project=${projectKey}`,
    headers: { Host: `127.0.0.1:${port}` } });
  lease.end();
  let leaseResponse;
  await new Promise((resolve, reject) => {
    lease.on("response", (response) => { leaseResponse = response; response.once("data", resolve); });
    lease.on("error", reject);
  });
  assert.equal(leased, 1);
  const leaseClosed = new Promise((resolve) => leaseResponse.once("close", resolve));
  leaseResponse.destroy();
  lease.destroy();
  await leaseClosed;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(leased, 0);
});

test("Sonner API authorizes the canonical project and returns the CLI projection with security headers", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-sonner-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await execFileAsync("git", ["-C", projectRoot, "init", "-q"]);
  await writeFile(path.join(projectRoot, "README.md"), "---\nsummary: Shared projection.\n---\n# Project\n", "utf8");
  await execFileAsync("git", ["-C", projectRoot, "add", "README.md"]);
  const expected = await buildSonner(projectRoot);
  const project = await resolveProject(projectRoot);
  const projectKey = project.key;
  const { server, url } = await listenBoard({
    projectResolver: async (key) => key === projectKey ? project : null,
    sonnerLoader: async (selected) => {
      assert.equal(selected, project, "Host hands the exact authorized Project object to Sonner");
      return buildSonnerProject(selected);
    },
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = Number(new URL(url).port);

  const result = await request({ port, requestPath: `/api/sonner?project=${projectKey}` });
  assert.equal(result.status, 200);
  assert.equal(result.body, serializeSonner(expected), "API bytes equal the one-command CLI serialization");
  assert.deepEqual(JSON.parse(result.body), expected);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.match(result.headers["content-security-policy"], /default-src 'self'/);
  assert.equal(result.headers["x-frame-options"], "DENY");
  assert.equal((await request({ port, requestPath: "/api/sonner" })).status, 404);
  assert.equal((await request({ port, requestPath: `/api/sonner?project=${"d".repeat(64)}` })).status, 404);
  assert.equal((await request({ port, requestPath: `/api/sonner?project=${projectKey}`, method: "POST" })).status, 405);
  assert.equal((await request({ port, requestPath: `/api/sonner?project=${projectKey}`, body: "unexpected" })).status, 400);
});

test("Sonner file open requires same-origin JSON and the canonical project", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-open-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const project = await resolveProject(projectRoot);
  const opened = [];
  const { server, url } = await listenBoard({
    projectResolver: async (key) => key === project.key ? project : null,
    fileOpener: async (selected, projectPath) => { opened.push([selected, projectPath]); },
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = Number(new URL(url).port);
  const requestPath = `/api/sonner/open?project=${project.key}`;
  const body = JSON.stringify({ path: "README.md" });
  const headers = { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" };
  assert.equal((await request({ port, requestPath, method: "POST", body, headers })).status, 200);
  assert.deepEqual(opened, [[project, "README.md"]]);
  assert.equal((await request({ port, requestPath, method: "POST", body,
    headers: { ...headers, Origin: "https://example.com" } })).status, 403);
  assert.equal((await request({ port, requestPath, method: "POST", body,
    headers: { ...headers, "Content-Type": "text/plain" } })).status, 400);
  assert.equal((await request({ port, requestPath: `/api/sonner/open?project=${"d".repeat(64)}`, method: "POST", body, headers })).status, 404);
  assert.equal(opened.length, 1);
});

test("Sonner opens indexed files and Work directories and propagates opener revalidation failures", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-open-file-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await execFileAsync("git", ["-C", projectRoot, "init", "-q"]);
  await writeFile(path.join(projectRoot, "README.md"), "---\nsummary: Open me.\n---\n", "utf8");
  await mkdir(path.join(projectRoot, "overview"));
  await writeFile(path.join(projectRoot, "overview/WORK_NODE.xml"),
    '<work-node id="overview" type="Overview"><summary>Overview.</summary><inputs /></work-node>\n', "utf8");
  await execFileAsync("git", ["-C", projectRoot, "add", "README.md", "overview/WORK_NODE.xml"]);
  const project = await resolveProject(projectRoot);
  const calls = [];
  const nativeOpener = async (...args) => { calls.push(args); };
  await openSonnerFile(project, "README.md", { nativeOpener });
  assert.deepEqual(calls[0], [project, "README.md"]);
  await openSonnerFile(project, "overview/WORK_NODE.xml", { nativeOpener });
  assert.deepEqual(calls[1], [project, "overview/WORK_NODE.xml"]);
  await openSonnerFile(project, "overview", { nativeOpener });
  assert.deepEqual(calls[2], [project, "overview"]);
  await assert.rejects(openSonnerFile(project, "../outside", { nativeOpener }),
    (error) => error.code === "SONNER_FILE_INVALID");
  await assert.rejects(openSonnerFile(project, "missing.md", { nativeOpener }),
    (error) => error.code === "SONNER_FILE_NOT_INDEXED");

  const indexedProjection = { version: 9, workGraph: { status: "missing" }, files: { root: { path: ".", name: ".", type: "directory",
    children: [{ path: "README.md", name: "README.md", type: "file", summary: "Open me." }] } }, runtime: { status: "missing" } };
  await assert.rejects(openSonnerFile(project, "README.md", {
    sonnerLoader: async () => indexedProjection,
    nativeOpener: async () => { const error = new Error("changed"); error.code = "SONNER_FILE_INVALID"; throw error; },
  }), (error) => error.code === "SONNER_FILE_INVALID");
});

test("Sonner Open maps typed failures and single-flights identical project files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-open-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await resolveProject(root); const gate = deferred(); const started = deferred(); let calls = 0;
  const errors = new Map([
    ["invalid", "SONNER_FILE_INVALID"], ["missing", "SONNER_FILE_NOT_INDEXED"],
    ["changed", "SONNER_FILE_CHANGED"], ["unavailable", "SONNER_FILE_OPEN_UNAVAILABLE"],
  ]);
  const { server, url } = await listenBoard({ projectResolver: async () => project, fileOpener: async (_project, projectPath) => {
    calls += 1;
    if (projectPath === "README.md" && calls === 1) { started.resolve(); await gate.promise; return; }
    const code = errors.get(projectPath); if (code) { const error = new Error(code); error.code = code; throw error; }
  } });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = Number(new URL(url).port); const requestPath = `/api/sonner/open?project=${project.key}`;
  const headers = { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" };
  const post = (file) => request({ port, requestPath, method: "POST", body: JSON.stringify({ path: file }), headers });
  const first = post("README.md"); await started.promise;
  assert.equal((await post("README.md")).status, 409); assert.equal(calls, 1, "duplicate did not dispatch");
  gate.resolve(); assert.equal((await first).status, 200);
  assert.equal((await post("invalid")).status, 400);
  assert.equal((await post("missing")).status, 404);
  assert.equal((await post("changed")).status, 409);
  assert.equal((await post("unavailable")).status, 503);
});

test("Host verification followed by permanent Root replacement returns bounded Sonner unavailable", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-sonner-identity-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = path.join(parent, "project"); const moved = path.join(parent, "authorized"); const replacement = path.join(parent, "replacement");
  for (const directory of [projectRoot, replacement]) { await mkdir(directory); await execFileAsync("git", ["-C", directory, "init", "-q"]); }
  await writeFile(path.join(projectRoot, "README.md"), "---\nsummary: Authorized.\n---\n"); await execFileAsync("git", ["-C", projectRoot, "add", "README.md"]);
  await writeFile(path.join(replacement, "README.md"), "---\nsummary: REPLACEMENT_CROSSED_AUTH\n---\n"); await execFileAsync("git", ["-C", replacement, "add", "README.md"]);
  const project = await resolveProject(projectRoot); let replaced = false;
  const { server, url } = await listenBoard({ projectResolver: async (key) => {
    if (key !== project.key) return null;
    if (!replaced) { replaced = true; await rename(projectRoot, moved); await rename(replacement, projectRoot); }
    return project;
  } });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await request({ port: Number(new URL(url).port), requestPath: `/api/sonner?project=${project.key}` });
  assert.equal(result.status, 503);
  assert.match(result.body, /SONNER_DATA_UNAVAILABLE/);
  assert.doesNotMatch(result.body, /REPLACEMENT_CROSSED_AUTH/);
});

test("resolver key mismatch and downgraded pathname authority never reach loaders", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-project-handoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await resolveProject(root); let calls = 0;
  const { server, url } = await listenBoard({
    projectResolver: async () => project.root,
    activityLoader: async () => { calls += 1; },
    sonnerLoader: async () => { calls += 1; },
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = Number(new URL(url).port);
  assert.equal((await request({ port, requestPath: `/api/sonner?project=${project.key}` })).status, 404);
  assert.equal(calls, 0);

  const other = "f".repeat(64);
  const mismatch = await listenBoard({ projectResolver: async () => project,
    sonnerLoader: async () => { calls += 1; } });
  t.after(() => new Promise((resolve) => mismatch.server.close(resolve)));
  assert.equal((await request({ port: Number(new URL(mismatch.url).port), requestPath: `/api/sonner?project=${other}` })).status, 404);
  assert.equal(calls, 0);
});

test("Sonner shares project single-flight and the exact response-byte bound", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-sonner-bound-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const projection = { version: 9, workGraph: { status: "missing" }, files: { root: { path: ".", name: ".", type: "directory", children: [] } }, runtime: { status: "missing" } };
  const exactBytes = Buffer.byteLength(serializeSonner(projection));
  const gate = deferred();
  const started = deferred();
  let calls = 0;
  const exact = await listenBoard({
    projectRoot,
    maxResponseBytes: exactBytes,
    sonnerLoader: async () => {
      calls += 1;
      if (calls === 1) { started.resolve(); await gate.promise; }
      return projection;
    },
    activityLoader: async () => ({ project: {}, activities: [], partial: false, detail: () => null }),
  });
  t.after(() => new Promise((resolve) => exact.server.close(resolve)));
  const port = Number(new URL(exact.url).port);
  const first = request({ port, requestPath: "/api/sonner" });
  await started.promise;
  const overlap = await request({ port, requestPath: "/api/activities" });
  assert.equal(overlap.status, 429);
  assert.equal(overlap.headers["retry-after"], "1");
  gate.resolve();
  assert.equal((await first).status, 200);

  const over = await listenBoard({ projectRoot, maxResponseBytes: exactBytes - 1, sonnerLoader: async () => projection });
  t.after(() => new Promise((resolve) => over.server.close(resolve)));
  const overPort = Number(new URL(over.url).port);
  const bounded = await request({ port: overPort, requestPath: "/api/sonner" });
  assert.equal(bounded.status, 503);
  assert.match(bounded.body, /BOARD_RESPONSE_BOUNDED/);
});

test("failed Sonner response keeps 429 admission until loader cleanup settles", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-sonner-cleanup-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const failure = deferred();
  const cleanupStarted = deferred();
  const cleanup = deferred();
  let calls = 0;
  const projection = { version: 9, workGraph: { status: "missing" }, files: { root: { path: ".", name: ".", type: "directory", children: [] } }, runtime: { status: "missing" } };
  const { server, url } = await listenBoard({
    projectRoot,
    sonnerLoader: async () => {
      calls += 1;
      if (calls === 1) {
        await failure.promise;
        cleanupStarted.resolve();
        await cleanup.promise;
        throw new Error("injected Sonner failure");
      }
      return projection;
    },
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = Number(new URL(url).port);
  const first = request({ port, requestPath: "/api/sonner" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await request({ port, requestPath: "/api/sonner" })).status, 429);
  failure.resolve();
  await cleanupStarted.promise;
  assert.equal((await request({ port, requestPath: "/api/sonner" })).status, 429);
  assert.equal(calls, 1);
  cleanup.resolve();
  assert.equal((await first).status, 503);
  assert.equal((await request({ port, requestPath: "/api/sonner" })).status, 200);
  assert.equal(calls, 2);
});

test("lease tracker exits only after the final lease and idle grace", async () => {
  let idle = 0;
  const tracker = createLeaseTracker({ idleTimeoutMs: 20, onIdle: () => { idle += 1; } });
  const first = tracker.open();
  const second = tracker.open();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(idle, 0);
  first();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(idle, 0);
  second();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(idle, 1);
  tracker.close();
});

test("data APIs allow one in-flight load, return 429 for overlap, and recover", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-busy-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  let loadCount = 0;
  const loader = async () => {
    loadCount += 1;
    if (loadCount === 1) await new Promise((resolve) => { release = resolve; started(); });
    return { project: {}, activities: [], partial: false, detail: () => null };
  };
  const { server, url } = await listenBoard({ projectRoot, activityLoader: loader });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = Number(new URL(url).port);
  const first = request({ port, requestPath: "/api/activities" });
  await startedPromise;
  const overlap = await request({ port, requestPath: "/api/activities" });
  assert.equal(overlap.status, 429);
  assert.equal(overlap.headers["retry-after"], "1");
  assert.equal(loadCount, 1);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await request({ port, requestPath: "/api/activities" })).status, 200);
  assert.equal(loadCount, 2);
});

test("selected Activity update endpoint uses one Host-memory revision and fails closed", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-live-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const detail = { activity: { id: "primary", name: "Primary" }, agents: [], cycles: [], signals: [] };
  const board = { project: {}, activities: [{ id: "primary", name: "Primary" }], partial: false,
    detail: (id) => id === "primary" ? detail : null };
  const session = { revision: 1 };
  const { server, url } = await listenBoard({
    projectRoot,
    activityLoader: async () => board,
    activityLiveSessionFactory: () => session,
    activityLiveUpdater: async (current, { revision }) => {
      if (revision !== current.revision) {
        const error = new Error("stale"); error.code = "ACTIVITY_LIVE_REFRESH_REQUIRED"; error.reason = "stale_revision"; throw error;
      }
      return { status: "unchanged", revision: current.revision, appendedBytes: 0 };
    },
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = Number(new URL(url).port);
  const beforeSelection = await request({ port, requestPath: "/api/activity/updates?id=primary&revision=1" });
  assert.equal(beforeSelection.status, 409);
  assert.match(beforeSelection.body, /cache_miss/);
  const initial = await request({ port, requestPath: "/api/activity?id=primary" });
  assert.equal(initial.status, 200);
  assert.deepEqual(JSON.parse(initial.body).live, { status: "ready", revision: 1 });
  const unchanged = await request({ port, requestPath: "/api/activity/updates?id=primary&revision=1" });
  assert.equal(unchanged.status, 200);
  assert.deepEqual(JSON.parse(unchanged.body), { status: "unchanged", revision: 1, appendedBytes: 0 });
  const stale = await request({ port, requestPath: "/api/activity/updates?id=primary&revision=0" });
  assert.equal(stale.status, 409);
  assert.match(stale.body, /stale_revision/);
  assert.equal((await request({ port, requestPath: "/api/activity/updates?id=primary&revision=1" })).status, 409);
});

test("client disconnect keeps single-flight held until loader resolve or reject", async (t) => {
  for (const outcome of ["resolve", "reject"]) {
    await t.test(outcome, async (t) => {
      const projectRoot = await mkdtemp(path.join(os.tmpdir(), `codex-small-loop-board-abort-${outcome}-`));
      t.after(() => rm(projectRoot, { recursive: true, force: true }));
      const gate = deferred();
      const started = deferred();
      const settled = deferred();
      let loadCount = 0;
      const board = { project: {}, activities: [], partial: false, detail: () => null };
      const loader = async () => {
        loadCount += 1;
        if (loadCount === 1) {
          started.resolve();
          try {
            await gate.promise;
          } finally {
            settled.resolve();
          }
          if (outcome === "reject") throw new Error("injected rejection");
        }
        return board;
      };
      const { server, url } = await listenBoard({ projectRoot, activityLoader: loader });
      t.after(() => new Promise((resolve) => server.close(resolve)));
      const port = Number(new URL(url).port);
      const first = abortableRequest({ port });
      await started.promise;
      first.req.destroy();
      await first.done;
      const overlap = await request({ port, requestPath: "/api/activities" });
      assert.equal(overlap.status, 429);
      assert.equal(overlap.headers["retry-after"], "1");
      assert.equal(loadCount, 1);
      outcome === "resolve" ? gate.resolve() : gate.resolve();
      await settled.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await request({ port, requestPath: "/api/activities" })).status, 200);
      assert.equal(loadCount, 2);
    });
  }
});

test("synchronous throw and connected rejection release single-flight", async (t) => {
  for (const mode of ["throw", "reject"]) {
    await t.test(mode, async (t) => {
      const projectRoot = await mkdtemp(path.join(os.tmpdir(), `codex-small-loop-board-failure-${mode}-`));
      t.after(() => rm(projectRoot, { recursive: true, force: true }));
      let calls = 0;
      const board = { project: {}, activities: [], partial: false, detail: () => null };
      const loader = mode === "throw"
        ? () => { calls += 1; if (calls === 1) throw new Error("sync"); return board; }
        : async () => { calls += 1; if (calls === 1) throw new Error("async"); return board; };
      const { server, url } = await listenBoard({ projectRoot, activityLoader: loader });
      t.after(() => new Promise((resolve) => server.close(resolve)));
      const port = Number(new URL(url).port);
      assert.equal((await request({ port, requestPath: "/api/activities" })).status, 503);
      assert.equal((await request({ port, requestPath: "/api/activities" })).status, 200);
      assert.equal(calls, 2);
    });
  }
});

test("server shutdown does not release a disconnected pending load early", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-shutdown-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const gate = deferred();
  const started = deferred();
  let loadCount = 0;
  const { server, url } = await listenBoard({
    projectRoot,
    activityLoader: async () => {
      loadCount += 1;
      started.resolve();
      await gate.promise;
      return { project: {}, activities: [], partial: false, detail: () => null };
    },
  });
  const port = Number(new URL(url).port);
  const first = abortableRequest({ port });
  await started.promise;
  first.req.destroy();
  await first.done;
  const closed = new Promise((resolve) => server.close(resolve));
  assert.equal(loadCount, 1);
  gate.resolve();
  await closed;
  assert.equal(loadCount, 1);
});

test("data responses enforce exact byte bounds and ledger failures stay closed", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-response-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const board = { project: { key: "k" }, activities: [{ id: "r", name: "root" }], partial: false, detail: () => null };
  const exactBytes = Buffer.byteLength(JSON.stringify({ project: board.project, activities: board.activities, partial: false }));
  const exact = await listenBoard({ projectRoot, activityLoader: async () => board, maxResponseBytes: exactBytes });
  t.after(() => new Promise((resolve) => exact.server.close(resolve)));
  const exactPort = Number(new URL(exact.url).port);
  assert.equal((await request({ port: exactPort, requestPath: "/api/activities" })).status, 200);

  const over = await listenBoard({ projectRoot, activityLoader: async () => board, maxResponseBytes: exactBytes - 1 });
  t.after(() => new Promise((resolve) => over.server.close(resolve)));
  const overPort = Number(new URL(over.url).port);
  const bounded = await request({ port: overPort, requestPath: "/api/activities" });
  assert.equal(bounded.status, 503);
  assert.match(bounded.body, /BOARD_RESPONSE_BOUNDED/);
  assert.equal((await request({ port: overPort, requestPath: "/api/activities" })).status, 503);

  const unavailable = await listenBoard({ projectRoot, activityLoader: async () => { const error = new Error("sentinel raw text"); error.code = "ACTIVITY_LEDGER_UNAVAILABLE"; throw error; } });
  t.after(() => new Promise((resolve) => unavailable.server.close(resolve)));
  const unavailablePort = Number(new URL(unavailable.url).port);
  const failed = await request({ port: unavailablePort, requestPath: "/api/activities" });
  assert.equal(failed.status, 503);
  assert.match(failed.body, /ACTIVITY_LEDGER_UNAVAILABLE/);
  assert.doesNotMatch(failed.body, /sentinel raw text/);

  const arbitrary = await request({ port: exactPort, requestPath: "/api/activity?id=arbitrary-sentinel" });
  assert.equal(arbitrary.status, 404);
  assert.doesNotMatch(arbitrary.body, /arbitrary-sentinel/);
  assert.equal((await request({ port: exactPort, requestPath: "/api/activities" })).status, 200);
});
