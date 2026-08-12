import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AtomicJsonStore } from "../source/atomic-json-store.mjs";
import {
  ensureCodexAppServerHost,
} from "../source/codex-app-server-host.mjs";

const RUNTIME = Object.freeze({
  executablePath: path.resolve("test-fixtures", "codex"),
  version: "0.147.0",
});

async function withHost(run) {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "csl-host-test-"));
  try {
    await run(codexHome);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

function createHostStore(codexHome) {
  return new AtomicJsonStore(
    path.join(codexHome, "codex-small-loop", "app-server", "host.json"),
    { syncHandle: async () => {} },
  );
}

function endpointFor(directory) {
  return Object.freeze({
    type: "unix",
    socketPath: path.join(directory, "server.sock"),
  });
}

function fakePlatform({
  pid = 42_001,
  executablePath = RUNTIME.executablePath,
  onLaunch = () => {},
  onPrepare = () => {},
  onCleanup = () => {},
  probe = async () => true,
} = {}) {
  return Object.freeze({
    platform: "test",
    async prepareDirectory(directory) {
      onPrepare(directory);
    },
    validateEndpoint(endpoint, directory) {
      assert.deepEqual(endpoint, endpointFor(directory));
      return endpointFor(directory);
    },
    migrateLegacyHost(host, directory) {
      if (host?.socketPath !== endpointFor(directory).socketPath) return null;
      const { socketPath, ...common } = host;
      return { ...common, endpoint: { type: "unix", socketPath } };
    },
    async launch({ runtime, directory }) {
      onLaunch({ runtime, directory });
      return { pid, endpoint: endpointFor(directory) };
    },
    probe,
    async inspectProcess() {
      return { executablePath };
    },
    sameExecutable(left, right) {
      return left === right;
    },
    async cleanup(endpoint, directory) {
      onCleanup({ endpoint, directory });
    },
  });
}

test("starts and persists one platform-neutral detached host", async () => {
  await withHost(async (codexHome) => {
    let prepared;
    let launch;
    const result = await ensureCodexAppServerHost({
      codexHome,
      store: createHostStore(codexHome),
      resolveRuntime: async () => RUNTIME,
      hostPlatform: fakePlatform({
        onPrepare: (directory) => { prepared = directory; },
        onLaunch: (value) => { launch = value; },
      }),
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    });

    const directory = path.join(codexHome, "codex-small-loop", "app-server");
    assert.equal(prepared, directory);
    assert.deepEqual(launch, { runtime: RUNTIME, directory });
    assert.deepEqual(result, {
      endpoint: endpointFor(directory),
      executablePath: RUNTIME.executablePath,
      executableVersion: RUNTIME.version,
      reused: false,
    });

    const state = JSON.parse(await readFile(
      path.join(directory, "host.json"),
      "utf8",
    ));
    assert.deepEqual(state, {
      version: 2,
      host: {
        pid: 42_001,
        executablePath: RUNTIME.executablePath,
        executableVersion: RUNTIME.version,
        endpoint: endpointFor(directory),
        startedAt: "2026-08-10T00:00:00.000Z",
      },
    });
  });
});

test("serializes concurrent callers and reuses one verified host", async () => {
  await withHost(async (codexHome) => {
    let launches = 0;
    const options = {
      codexHome,
      store: createHostStore(codexHome),
      resolveRuntime: async () => RUNTIME,
      hostPlatform: fakePlatform({ onLaunch: () => { launches += 1; } }),
      processProbe: () => true,
    };

    const [first, second] = await Promise.all([
      ensureCodexAppServerHost(options),
      ensureCodexAppServerHost(options),
    ]);

    assert.equal(launches, 1);
    assert.deepEqual(first.endpoint, second.endpoint);
    assert.deepEqual(
      new Set([first.reused, second.reused]),
      new Set([false, true]),
    );
  });
});

test("migrates and reuses a live version 1 macOS host", async () => {
  await withHost(async (codexHome) => {
    const directory = path.join(codexHome, "codex-small-loop", "app-server");
    const socketPath = endpointFor(directory).socketPath;
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "host.json"), `${JSON.stringify({
      version: 1,
      host: {
        pid: 42_004,
        executablePath: RUNTIME.executablePath,
        executableVersion: RUNTIME.version,
        socketPath,
        startedAt: "2026-07-30T00:00:00.000Z",
      },
    })}\n`);

    const result = await ensureCodexAppServerHost({
      codexHome,
      store: createHostStore(codexHome),
      resolveRuntime: async () => {
        throw new Error("runtime resolution must not run");
      },
      hostPlatform: fakePlatform(),
      processProbe: () => true,
    });

    assert.equal(result.reused, true);
    assert.deepEqual(result.endpoint, endpointFor(directory));
    const migrated = JSON.parse(await readFile(
      path.join(directory, "host.json"),
      "utf8",
    ));
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.host.endpoint, endpointFor(directory));
    assert.equal(Object.hasOwn(migrated.host, "socketPath"), false);
  });
});

test("replaces a dead recorded host after platform cleanup", async () => {
  await withHost(async (codexHome) => {
    const directory = path.join(codexHome, "codex-small-loop", "app-server");
    const endpoint = endpointFor(directory);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "host.json"), `${JSON.stringify({
      version: 2,
      host: {
        pid: 41_000,
        executablePath: RUNTIME.executablePath,
        executableVersion: RUNTIME.version,
        endpoint,
        startedAt: "2026-07-29T00:00:00.000Z",
      },
    })}\n`);

    const cleanups = [];
    let launches = 0;
    const result = await ensureCodexAppServerHost({
      codexHome,
      store: createHostStore(codexHome),
      resolveRuntime: async () => RUNTIME,
      processProbe: () => false,
      hostPlatform: fakePlatform({
        onCleanup: (value) => cleanups.push(value),
        onLaunch: () => { launches += 1; },
      }),
    });

    assert.equal(launches, 1);
    assert.equal(result.reused, false);
    assert.deepEqual(cleanups, [{ endpoint, directory }]);
  });
});

test("rejects a live host whose executable identity does not match", async () => {
  await withHost(async (codexHome) => {
    const directory = path.join(codexHome, "codex-small-loop", "app-server");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "host.json"), `${JSON.stringify({
      version: 2,
      host: {
        pid: 41_001,
        executablePath: RUNTIME.executablePath,
        executableVersion: RUNTIME.version,
        endpoint: endpointFor(directory),
        startedAt: "2026-07-29T00:00:00.000Z",
      },
    })}\n`);

    await assert.rejects(
      ensureCodexAppServerHost({
        codexHome,
        store: createHostStore(codexHome),
        resolveRuntime: async () => RUNTIME,
        processProbe: () => true,
        hostPlatform: fakePlatform({
          executablePath: path.resolve("another", "codex"),
        }),
      }),
      (error) => error.code === "APP_SERVER_HOST_IDENTITY_INVALID",
    );
  });
});
