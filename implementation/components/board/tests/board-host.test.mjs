import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  boardHostStatus,
  boardHostUrl,
  ensureBoardHost,
  stopBoardHost,
} from "../source/board-host.mjs";

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function openLease(boardUrl) {
  const url = new URL(boardUrl);
  url.pathname = "/api/lease";
  const request = http.request(url, {
    headers: { Host: `127.0.0.1:${url.port}` },
  });
  const response = await new Promise((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
    request.end();
  });
  await new Promise((resolve) => response.once("data", resolve));
  return {
    close: () => request.destroy(),
    closed: new Promise((resolve) => response.once("close", resolve)),
    statusCode: response.statusCode,
  };
}

test("one detached host serves multiple project-scoped URLs and stops after the final project", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-host-"));
  const stateDirectory = path.join(temporary, "state");
  const firstRoot = path.join(temporary, "first");
  const secondRoot = path.join(temporary, "second");
  await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
  t.after(async () => {
    await stopBoardHost(firstRoot, { stateDirectory }).catch(() => {});
    await stopBoardHost(secondRoot, { stateDirectory }).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  });

  const first = await ensureBoardHost(firstRoot, { stateDirectory, idleTimeoutMs: 60_000 });
  const second = await ensureBoardHost(secondRoot, { stateDirectory, idleTimeoutMs: 60_000 });
  assert.equal(first.run, "ok");
  assert.equal(second.pid, first.pid);
  assert.notEqual(second.projectKey, first.projectKey);
  assert.match(first.url, new RegExp(`\\?project=${first.projectKey}$`));
  assert.equal((await boardHostUrl(firstRoot, { stateDirectory })).url, first.url);
  assert.equal((await boardHostStatus(secondRoot, { stateDirectory })).status, "ready");

  const control = JSON.parse(await readFile(path.join(stateDirectory, "control.json"), "utf8"));
  assert.equal(Object.keys(control.projects).length, 2);
  const firstStop = await stopBoardHost(firstRoot, { stateDirectory });
  assert.equal(firstStop.hostStopped, false);
  assert.equal((await boardHostStatus(secondRoot, { stateDirectory })).status, "ready");
  const lease = await openLease(second.url);
  t.after(lease.close);
  assert.equal(lease.statusCode, 200);
  const finalStop = await stopBoardHost(secondRoot, { stateDirectory });
  assert.equal(finalStop.hostStopped, true);
  await lease.closed;
  assert.equal(await waitForProcessExit(first.pid), true);
});

test("detached startup is hidden on Windows and cleans its exact child on timeout", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-host-timeout-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, "project");
  const stateDirectory = path.join(temporary, "state");
  await mkdir(projectRoot);
  const calls = [];
  class FakeChild extends EventEmitter {
    exitCode = null;
    signalCode = null;
    kills = 0;
    unrefs = 0;
    kill() { this.kills += 1; this.exitCode = 1; return true; }
    unref() { this.unrefs += 1; }
  }
  const child = new FakeChild();
  await assert.rejects(
    ensureBoardHost(projectRoot, {
      stateDirectory,
      startTimeoutMs: 0,
      spawnImpl(file, args, options) {
        calls.push({ file, args, options });
        return child;
      },
    }),
    (error) => error?.code === "BOARD_HOST_START_TIMEOUT",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, process.execPath);
  assert.deepEqual(calls[0].options, {
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  assert.equal(child.unrefs, 1);
  assert.equal(child.kills, 1);
});

test("failed explicit stop keeps registration and runtime evidence", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-small-loop-board-host-stop-"));
  const stateDirectory = path.join(temporary, "state");
  const projectRoot = path.join(temporary, "project");
  await mkdir(projectRoot);
  t.after(async () => {
    await stopBoardHost(projectRoot, { stateDirectory }).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  });
  const started = await ensureBoardHost(projectRoot, { stateDirectory, idleTimeoutMs: 60_000 });
  const runtimeFile = path.join(stateDirectory, "runtime.json");
  const runtime = JSON.parse(await readFile(runtimeFile, "utf8"));
  await assert.rejects(
    stopBoardHost(projectRoot, {
      stateDirectory,
      stopTimeoutMs: 0,
      probeImpl: async (_runtime, options = {}) => options.method === "POST"
        ? null
        : {
            ok: true,
            instanceId: runtime.instanceId,
            buildVersion: runtime.buildVersion,
          },
    }),
    (error) => error?.code === "BOARD_HOST_STOP_FAILED",
  );
  const control = JSON.parse(await readFile(path.join(stateDirectory, "control.json"), "utf8"));
  assert.ok(control.projects[started.projectKey]);
  assert.equal(JSON.parse(await readFile(runtimeFile, "utf8")).instanceId, runtime.instanceId);
});
