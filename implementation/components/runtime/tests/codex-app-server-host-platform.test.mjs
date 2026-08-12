import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createCodexAppServerHostPlatform,
} from "../source/codex-app-server-host-platform.mjs";

function fakeChild(pid = 42_101) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unrefCalls = 0;
  child.killCalls = 0;
  child.unref = () => { child.unrefCalls += 1; };
  child.kill = () => {
    child.killCalls += 1;
    child.exitCode = 0;
    return true;
  };
  return child;
}

test("macOS adapter preserves the private Unix WebSocket host", async () => {
  const directory = path.posix.resolve("/private/app-server");
  const runtime = {
    executablePath: path.posix.resolve("/fixtures/codex"),
    version: "0.147.0",
  };
  const child = fakeChild();
  const spawnCalls = [];
  const chmodCalls = [];
  const probes = [];
  const adapter = createCodexAppServerHostPlatform({
    platform: "darwin",
    spawnProcess: (...args) => {
      spawnCalls.push(args);
      return child;
    },
    chmodSocket: async (...args) => { chmodCalls.push(args); },
    probeEndpoint: async (endpoint) => {
      probes.push(endpoint);
      return true;
    },
  });

  const launched = await adapter.launch({
    runtime,
    directory,
    timeoutMs: 100,
    retryIntervalMs: 1,
  });
  const endpoint = {
    type: "unix",
    socketPath: path.posix.join(directory, "server.sock"),
  };

  assert.deepEqual(launched, { pid: child.pid, endpoint });
  assert.deepEqual(spawnCalls, [[
    runtime.executablePath,
    ["app-server", "--listen", `unix://${endpoint.socketPath}`],
    { cwd: directory, detached: true, shell: false, stdio: "ignore" },
  ]]);
  assert.deepEqual(chmodCalls, [[endpoint.socketPath, 0o600]]);
  assert.deepEqual(probes, [endpoint]);
  assert.equal(child.unrefCalls, 1);
});

function validAclResult(current = "S-1-5-21-1001") {
  return {
    protected: true,
    owner: current,
    current,
    rules: [
      { sid: current, rights: 2_032_127, type: 0 },
      { sid: "S-1-5-18", rights: 2_032_127, type: 0 },
      { sid: "S-1-5-32-544", rights: 2_032_127, type: 0 },
    ],
  };
}

test("Windows adapter protects secrets and starts an authenticated dynamic loopback host", async () => {
  const directory = path.win32.resolve("C:\\private data\\app-server");
  const runtime = {
    executablePath: path.win32.resolve("C:\\OpenAI\\codex.exe"),
    version: "0.147.0",
  };
  const child = fakeChild(42_102);
  const executeCalls = [];
  const spawnCalls = [];
  const writes = [];
  const removes = [];
  const probes = [];
  const terminations = [];
  const adapter = createCodexAppServerHostPlatform({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    execute: async (...args) => {
      executeCalls.push(args);
      return { stdout: JSON.stringify(validAclResult()), stderr: "" };
    },
    spawnProcess: (...args) => {
      spawnCalls.push(args);
      setImmediate(() => {
        child.stdout.write("PID 50123\nENDPOINT ws://127.0.0.1:54321\n");
      });
      return child;
    },
    probeEndpoint: async (endpoint) => {
      probes.push(endpoint);
      return true;
    },
    remove: async (...args) => { removes.push(args); },
    terminateProcess: (pid) => { terminations.push(pid); },
    writeToken: async (...args) => { writes.push(args); },
    tokenBytes: () => Buffer.alloc(32),
  });

  await adapter.prepareDirectory(directory);
  const launched = await adapter.launch({
    runtime,
    directory,
    timeoutMs: 500,
    retryIntervalMs: 1,
  });
  const tokenPath = path.win32.join(directory, "capability-token");
  const endpoint = {
    type: "loopback-websocket",
    url: "ws://127.0.0.1:54321",
    tokenPath,
  };

  assert.deepEqual(launched, { pid: 50_123, endpoint });
  assert.equal(executeCalls.length, 1);
  assert.equal(
    executeCalls[0][2].env.CODEX_SMALL_LOOP_PRIVATE_DIRECTORY,
    directory,
  );
  assert.deepEqual(removes, [[tokenPath, { force: true }]]);
  assert.deepEqual(writes, [[
    tokenPath,
    Buffer.alloc(32).toString("base64url"),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  ]]);
  assert.equal(spawnCalls.length, 1);
  const [launcherPath, launcherArgs, launcherOptions] = spawnCalls[0];
  assert.equal(
    launcherPath,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.deepEqual(launcherArgs.slice(0, 4), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
  ]);
  assert.equal(typeof launcherArgs[4], "string");
  assert.deepEqual(
    {
      cwd: launcherOptions.cwd,
      detached: launcherOptions.detached,
      shell: launcherOptions.shell,
      windowsHide: launcherOptions.windowsHide,
      stdio: launcherOptions.stdio,
    },
    {
      cwd: directory,
      detached: false,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(
    launcherOptions.env.CODEX_SMALL_LOOP_CODEX_EXECUTABLE,
    runtime.executablePath,
  );
  assert.equal(
    launcherOptions.env.CODEX_SMALL_LOOP_CODEX_DIRECTORY,
    directory,
  );
  assert.equal(launcherOptions.env.CODEX_SMALL_LOOP_CODEX_DIAGNOSTICS, undefined);
  assert.match(
    launcherOptions.env.CODEX_SMALL_LOOP_CODEX_ARGUMENTS,
    /^app-server --listen ws:\/\/127\.0\.0\.1:0 --ws-auth capability-token --ws-token-file /u,
  );
  assert.match(
    launcherOptions.env.CODEX_SMALL_LOOP_CODEX_ARGUMENTS,
    /"C:\\private data\\app-server\\capability-token"$/u,
  );
  assert.deepEqual(probes, [endpoint]);
  assert.deepEqual(terminations, []);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(child.unrefCalls, 1);
});

test("Windows adapter terminates both processes when hidden-host startup fails", async () => {
  const directory = path.win32.resolve("C:\\private\\app-server");
  const runtime = {
    executablePath: path.win32.resolve("C:\\OpenAI\\codex.exe"),
    version: "0.147.0",
  };
  const launcher = fakeChild(42_103);
  const removes = [];
  const terminations = [];
  const adapter = createCodexAppServerHostPlatform({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawnProcess: () => {
      setImmediate(() => {
        launcher.stdout.write("PID 50124\n");
        setImmediate(() => launcher.stdout.write("x".repeat((16 * 1_024) + 1)));
      });
      return launcher;
    },
    remove: async (...args) => { removes.push(args); },
    terminateProcess: (pid) => { terminations.push(pid); },
    writeToken: async () => {},
    tokenBytes: () => Buffer.alloc(32),
  });

  await assert.rejects(
    adapter.launch({
      runtime,
      directory,
      timeoutMs: 500,
      retryIntervalMs: 1,
    }),
    (error) => error.code === "APP_SERVER_HOST_START_FAILED",
  );

  const tokenPath = path.win32.join(directory, "capability-token");
  assert.deepEqual(terminations, [50_124]);
  assert.equal(launcher.killCalls, 1);
  assert.deepEqual(removes, [
    [tokenPath, { force: true }],
    [tokenPath, { force: true }],
  ]);
});

test("Windows adapter fails closed when the private ACL contains another principal", async () => {
  const acl = validAclResult();
  acl.rules.push({
    sid: "S-1-5-21-1002",
    rights: 1,
    type: 0,
  });
  const adapter = createCodexAppServerHostPlatform({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    execute: async () => ({ stdout: JSON.stringify(acl), stderr: "" }),
  });

  await assert.rejects(
    adapter.prepareDirectory(path.win32.resolve("C:\\private\\app-server")),
    (error) => error.code === "APP_SERVER_HOST_ACL_INVALID",
  );
});

test("host platform factory rejects unsupported systems", () => {
  assert.throws(
    () => createCodexAppServerHostPlatform({ platform: "linux" }),
    (error) => error.code === "APP_SERVER_HOST_PLATFORM_UNSUPPORTED",
  );
});
