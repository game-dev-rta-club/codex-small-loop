import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  acquireProjectSupervisorLock,
  runRecoverySupervisor,
  startRecoverySupervisor,
  supervisorHasWork,
  waitForSupervisorStart,
} from "../source/recovery-supervisor.mjs";

const NORMALIZED_PROJECT_ROOT = await mkdtemp(path.join(os.tmpdir(), "supervisor-admission-tests-"));
after(() => rm(NORMALIZED_PROJECT_ROOT, { recursive: true, force: true }));
import {
  runRecoverySupervisorCli,
} from "../internal/recovery-supervisor.mjs";

function report(overrides = {}) {
  return {
    run: "ok",
    project: "active",
    summary: {
      pendingLaunches: 0,
      activeConversations: 1,
      openLinks: 1,
      stoppedLinks: 0,
      runningTasks: 1,
      waitingTasks: 0,
      recoveryCandidates: 0,
      unresolvedRecoveries: 0,
      pendingDeliveries: 0,
      pendingAppMessages: 0,
      ...overrides,
    },
    events: [],
    appMessages: [],
  };
}

test("keeps the supervisor alive only for mechanical work", () => {
  assert.equal(supervisorHasWork(report()), true);
  assert.equal(supervisorHasWork(report({
    activeConversations: 0,
    runningTasks: 0,
  })), false);
  assert.equal(supervisorHasWork(report({
    activeConversations: 0,
    pendingLaunches: 1,
  })), true);
  assert.equal(supervisorHasWork(report({
    activeConversations: 0,
    pendingDeliveries: 1,
  })), true);
  assert.equal(supervisorHasWork(report({
    runningTasks: 0,
    recoveryCandidates: 1,
  })), true);
  assert.equal(supervisorHasWork(report({
    activeConversations: 0,
    runningTasks: 0,
    pendingAppMessages: 1,
  })), true);
  assert.equal(supervisorHasWork(report({
    activeConversations: 0,
    runningTasks: 0,
    waitingTasks: 1,
    unresolvedRecoveries: 1,
  })), true);
});

test("runs mechanical heartbeats until project work becomes idle", async () => {
  const calls = [];
  const waits = [];
  const reports = [
    report(),
    report({ activeConversations: 0, runningTasks: 0 }),
  ];

  const result = await runRecoverySupervisor({
    projectRoot: NORMALIZED_PROJECT_ROOT,
  }, {
    intervalMs: 250,
    acquireLock: async () => ({
      state: "acquired",
      release: async () => calls.push("release"),
    }),
    async heartbeat(input, options) {
      calls.push({ input, options });
      return reports.shift();
    },
    async wait(intervalMs) {
      waits.push(intervalMs);
    },
  });

  assert.deepEqual(waits, [250]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.slice(0, 2), [
    {
      input: { projectRoot: NORMALIZED_PROJECT_ROOT },
      options: undefined,
    },
    {
      input: { projectRoot: NORMALIZED_PROJECT_ROOT },
      options: undefined,
    },
  ]);
  assert.equal(result.run, "ok");
  assert.equal(result.state, "idle");
  assert.equal(result.iterations, 2);
});

test("returns without scanning when another project supervisor owns the lock", async () => {
  let heartbeatCalled = false;
  const result = await runRecoverySupervisor({
    projectRoot: NORMALIZED_PROJECT_ROOT,
  }, {
    acquireLock: async () => ({ state: "already_running" }),
    async heartbeat() {
      heartbeatCalled = true;
    },
  });

  assert.equal(heartbeatCalled, false);
  assert.deepEqual(result, {
    run: "ok",
    state: "already_running",
    iterations: 0,
  });
});

test("serializes one live supervisor per project and releases ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "recovery-supervisor-"));

  try {
    const first = await acquireProjectSupervisorLock(root);
    const second = await acquireProjectSupervisorLock(root);
    assert.equal(first.state, "acquired");
    assert.equal(second.state, "already_running");

    await first.release();
    const third = await acquireProjectSupervisorLock(root);
    assert.equal(third.state, "acquired");
    await third.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains a malformed supervisor lock and fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "recovery-supervisor-"));
  const lockFile = path.join(
    root,
    ".codex-small-loop",
    "recovery-supervisor.lock",
  );

  try {
    await mkdir(path.dirname(lockFile), { recursive: true });
    await writeFile(lockFile, "not-json", "utf8");

    await assert.rejects(
      acquireProjectSupervisorLock(root),
      (error) => error.code === "RECOVERY_SUPERVISOR_LOCK_INVALID",
    );
    assert.equal(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(lockFile, "utf8")
      ),
      "not-json",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not remove a stale lock whose owner changes during revalidation", async () => {
  const reads = [
    JSON.stringify({ pid: 11, token: "old" }),
    JSON.stringify({ pid: 22, token: "new" }),
  ];
  let removed = false;

  await assert.rejects(
    acquireProjectSupervisorLock("/project", {
      async mkdir() {},
      async open() {
        const error = new Error("exists");
        error.code = "EEXIST";
        throw error;
      },
      async readFile() {
        return reads.shift();
      },
      processIsAlive() {
        return false;
      },
      async rm() {
        removed = true;
      },
    }),
    (error) => error.code === "RECOVERY_SUPERVISOR_LOCK_CHANGED",
  );
  assert.equal(removed, false);
});

test("retries a failed heartbeat and releases ownership when stopped", async () => {
  let released = false;
  const controller = new AbortController();
  const waits = [];

  const result = await runRecoverySupervisor({
    projectRoot: NORMALIZED_PROJECT_ROOT,
  }, {
    signal: controller.signal,
    intervalMs: 250,
    acquireLock: async () => ({
      state: "acquired",
      async release() {
        released = true;
      },
    }),
    async heartbeat() {
      throw Object.assign(new Error("failed"), {
        code: "HEARTBEAT_FAILED",
      });
    },
    async writeDiagnostic() {},
    async wait(intervalMs) {
      waits.push(intervalMs);
      if (waits.length === 2) {
        controller.abort();
      }
    },
  });

  assert.deepEqual(waits, [250, 500]);
  assert.equal(result.state, "stopped");
  assert.equal(result.iterations, 2);
  assert.equal(released, true);
});

test("persists a bounded diagnostic for heartbeat failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "recovery-supervisor-"));
  const controller = new AbortController();

  try {
    await runRecoverySupervisor({ projectRoot: root }, {
      signal: controller.signal,
      intervalMs: 250,
      now: () => "2026-07-27T00:00:00.000Z",
      acquireLock: async () => ({
        state: "acquired",
        async release() {},
      }),
      async heartbeat() {
        throw Object.assign(new Error("x".repeat(2_000)), {
          code: "HEARTBEAT_BROKEN",
        });
      },
      async wait() {
        controller.abort();
      },
    });

    const diagnostic = JSON.parse(await readFile(path.join(
      root,
      ".codex-small-loop",
      "recovery-supervisor-error.json",
    ), "utf8"));
    assert.equal(diagnostic.version, 1);
    assert.equal(diagnostic.code, "HEARTBEAT_BROKEN");
    assert.equal(diagnostic.consecutiveFailures, 1);
    assert.equal(diagnostic.updatedAt, "2026-07-27T00:00:00.000Z");
    assert.ok(diagnostic.message.length <= 512);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains bounded Heartbeat partial events without changing retry delay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "recovery-supervisor-"));
  const controller = new AbortController();

  try {
    await runRecoverySupervisor({ projectRoot: root }, {
      signal: controller.signal,
      intervalMs: 250,
      now: () => "2026-07-27T00:00:00.000Z",
      acquireLock: async () => ({
        state: "acquired",
        async release() {},
      }),
      async heartbeat() {
        return {
          ...report(),
          run: "partial",
          events: [{
            type: "recovery_degraded",
            taskIds: ["task-1"],
            reason: "conversation-state-missing",
            secret: "must not escape",
          }],
        };
      },
      async wait(intervalMs) {
        assert.equal(intervalMs, 250);
        controller.abort();
      },
    });

    const diagnostic = JSON.parse(await readFile(path.join(
      root,
      ".codex-small-loop",
      "recovery-supervisor-error.json",
    ), "utf8"));
    assert.deepEqual(diagnostic, {
      version: 1,
      code: "HEARTBEAT_PARTIAL",
      message: "Heartbeat completed with unresolved events.",
      consecutiveFailures: 1,
      updatedAt: "2026-07-27T00:00:00.000Z",
      events: [{
        type: "recovery_degraded",
        taskIds: ["task-1"],
        reason: "conversation-state-missing",
      }],
    });
    assert.equal(JSON.stringify(diagnostic).includes("must not escape"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clears the previous diagnostic after a successful heartbeat", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "recovery-supervisor-"));
  let attempts = 0;

  try {
    const result = await runRecoverySupervisor({ projectRoot: root }, {
      intervalMs: 250,
      now: () => "2026-07-27T00:00:00.000Z",
      acquireLock: async () => ({
        state: "acquired",
        async release() {},
      }),
      async heartbeat() {
        attempts += 1;
        if (attempts === 1) {
          return {
            ...report(),
            run: "partial",
            events: [{ type: "recovery_unresolved", taskIds: ["task-1"] }],
          };
        }
        return report({ activeConversations: 0, runningTasks: 0 });
      },
      async wait() {},
    });

    assert.equal(result.state, "idle");
    await assert.rejects(readFile(path.join(
      root,
      ".codex-small-loop",
      "recovery-supervisor-error.json",
    ), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("starts one detached supervisor process and confirms project ownership", async () => {
  const calls = [];
  const child = {
    pid: 123,
    unref() {
      calls.push("unref");
    },
  };

  const result = await startRecoverySupervisor(NORMALIZED_PROJECT_ROOT, {
    executable: "/node",
    script: "/plugin/recovery-supervisor.mjs",
    async readOwner() {
      return null;
    },
    processIsAlive() {
      return false;
    },
    async waitForStart(projectRoot, currentChild) {
      calls.push(["ready", projectRoot, currentChild.pid]);
      return {
        state: "started",
        pid: currentChild.pid,
      };
    },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });

  assert.deepEqual(result, {
    state: "started",
    pid: 123,
  });
  assert.deepEqual(calls, [
    {
      command: "/node",
      args: [
        "/plugin/recovery-supervisor.mjs",
        "--project-root",
        NORMALIZED_PROJECT_ROOT,
      ],
      options: {
        cwd: NORMALIZED_PROJECT_ROOT,
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: true,
      },
    },
    "unref",
    ["ready", NORMALIZED_PROJECT_ROOT, 123],
  ]);
});

test("cleans the exact detached child when startup confirmation fails", async () => {
  const calls = [];
  const child = {
    pid: 123,
    exitCode: null,
    signalCode: null,
    unref() {
      calls.push("unref");
    },
    kill() {
      calls.push("kill");
      this.exitCode = 1;
      return true;
    },
  };

  await assert.rejects(
    startRecoverySupervisor(NORMALIZED_PROJECT_ROOT, {
      async readOwner() {
        return null;
      },
      processIsAlive() {
        return false;
      },
      spawn() {
        return child;
      },
      async waitForStart() {
        const error = new Error("startup timed out");
        error.code = "RECOVERY_SUPERVISOR_START_FAILED";
        throw error;
      },
    }),
    { code: "RECOVERY_SUPERVISOR_START_FAILED" },
  );

  assert.deepEqual(calls, ["unref", "kill"]);
});

test("terminates a real detached child that never acquires the lock", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "recovery-supervisor-start-"));
  const script = path.join(root, "never-ready.mjs");
  await writeFile(script, "setInterval(() => {}, 1_000);\n", "utf8");
  let child = null;
  t.after(async () => {
    try {
      child?.kill();
    } catch {
      // The test expects this exact child to be gone already.
    }
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    startRecoverySupervisor(root, {
      script,
      timeoutMs: 100,
      pollIntervalMs: 10,
      spawn(command, args, options) {
        child = spawnProcess(command, args, options);
        return child;
      },
    }),
    { code: "RECOVERY_SUPERVISOR_START_FAILED" },
  );

  assert.ok(Number.isSafeInteger(child?.pid));
  const deadline = Date.now() + 2_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("cleans the losing child when another supervisor wins startup", async () => {
  let killed = 0;
  const child = {
    pid: 123,
    exitCode: null,
    signalCode: null,
    unref() {},
    kill() {
      killed += 1;
      this.exitCode = 0;
      return true;
    },
  };

  const result = await startRecoverySupervisor(NORMALIZED_PROJECT_ROOT, {
    async readOwner() {
      return null;
    },
    processIsAlive() {
      return false;
    },
    spawn() {
      return child;
    },
    async waitForStart() {
      return { state: "already_running", pid: 456 };
    },
  });

  assert.deepEqual(result, { state: "already_running", pid: 456 });
  assert.equal(killed, 1);
});

test("waits until the detached process owns the project lock", async () => {
  const owners = [
    null,
    { pid: 123 },
  ];
  const waits = [];
  const result = await waitForSupervisorStart(
    "/project",
    { pid: 123 },
    {
      timeoutMs: 100,
      pollIntervalMs: 25,
      async readOwner() {
        return owners.shift() ?? null;
      },
      processIsAlive(pid) {
        return pid === 123;
      },
      async wait(intervalMs) {
        waits.push(intervalMs);
      },
    },
  );

  assert.deepEqual(result, {
    state: "started",
    pid: 123,
  });
  assert.deepEqual(waits, [25]);
});

test("does not spawn when a live project supervisor already owns the lock", async () => {
  let spawned = false;
  const result = await startRecoverySupervisor(NORMALIZED_PROJECT_ROOT, {
    async readOwner() {
      return { pid: 456 };
    },
    processIsAlive(pid) {
      return pid === 456;
    },
    spawn() {
      spawned = true;
    },
  });

  assert.equal(spawned, false);
  assert.deepEqual(result, {
    state: "already_running",
    pid: 456,
  });
});

test("supervisor CLI accepts only an explicit project root", async () => {
  const projectRoot = path.resolve("/workspace", "./project");
  const output = [];
  const exitCode = await runRecoverySupervisorCli([
    "--project-root",
    "./project",
  ], {
    cwd: "/workspace",
    stdout: {
      write(value) {
        output.push(value);
      },
    },
    async supervisor(input) {
      assert.deepEqual(input, {
        projectRoot,
      });
      return {
        run: "ok",
        state: "idle",
        iterations: 1,
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output.join("")), {
    run: "ok",
    state: "idle",
    iterations: 1,
  });

  const invalidOutput = [];
  const invalidExitCode = await runRecoverySupervisorCli([], {
    cwd: "/workspace",
    stdout: {
      write(value) {
        invalidOutput.push(value);
      },
    },
  });

  assert.equal(invalidExitCode, 1);
  assert.equal(
    JSON.parse(invalidOutput.join("")).code,
    "RECOVERY_SUPERVISOR_CLI_USAGE",
  );
});

test("a wake arriving after the last heartbeat makes the live supervisor drain again", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-wake-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let beats = 0;
  let pendingDeletion = false;
  let deleted = false;
  const result = await runRecoverySupervisor({ projectRoot: root }, {
    async heartbeat() {
      beats++;
      if (beats === 1) {
        pendingDeletion = true; // Arrives after this heartbeat's queue snapshot.
        const started = await startRecoverySupervisor(root, {
          verifyCaller: async () => {},
          spawn() { assert.fail("live owner must be reused"); },
        });
        assert.equal(started.state, "already_running");
      } else if (pendingDeletion) {
        pendingDeletion = false;
        deleted = true;
      }
      return report({ activeConversations: 0 });
    },
  });
  assert.equal(result.state, "idle");
  assert.equal(beats, 2);
  assert.equal(deleted, true);
});

test("a wake during ownership release starts a replacement instead of accepting the exiting owner", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-exit-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let releaseEntered, allowRelease;
  const entered = new Promise(resolve => { releaseEntered = resolve; });
  const allowed = new Promise(resolve => { allowRelease = resolve; });
  const running = runRecoverySupervisor({ projectRoot: root }, {
    async acquireLock(project) {
      const ownership = await acquireProjectSupervisorLock(project);
      return { state: "acquired", async release() {
        releaseEntered();
        await allowed;
        await ownership.release();
      } };
    },
    async heartbeat() { return report({ activeConversations: 0 }); },
  });
  await entered;
  let spawns = 0;
  const starting = startRecoverySupervisor(root, {
    verifyCaller: async () => {},
    spawn() { spawns++; return { pid: 987654, unref() {} }; },
    async waitForStart() { return { state: "started", pid: 987654 }; },
  });
  allowRelease();
  assert.equal((await running).state, "idle");
  assert.equal((await starting).state, "started");
  assert.equal(spawns, 1);
});

test("restricted caller cannot start a supervisor", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-denied-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(startRecoverySupervisor(root, {
    env: { CODEX_SANDBOX: "seatbelt" },
    spawn() { assert.fail("must not spawn"); },
  }), { code: "DAEMON_FULL_ACCESS_REQUIRED" });
});
