import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AtomicJsonStore,
} from "../source/atomic-json-store.mjs";

async function withStore(run, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whole-job-store-"));
  const stateFile = path.join(directory, "state.json");
  const store = new AtomicJsonStore(stateFile, {
    lockTimeoutMs: 1_000,
    lockRetryMs: 5,
    ...options,
  });

  try {
    await run({ directory, stateFile, store });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitForFile(file) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await readFile(file);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Timed out waiting for ${file}`);
}

function expectStoreError(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.equal(typeof error.stateFile, "string");
    assert.equal(typeof error.operation, "string");
    return true;
  });
}

test("initializes and transacts with private atomic JSON files", async () => {
  await withStore(async ({ stateFile, store }) => {
    const initialized = await store.initialize({ version: 1, count: 0 });
    const repeated = await store.initialize({ version: 1, count: 99 });
    const transaction = await store.transact((state) => ({
      state: { ...state, count: state.count + 1 },
      result: "incremented",
    }));

    assert.deepEqual(initialized, { version: 1, count: 0 });
    assert.deepEqual(repeated, { version: 1, count: 0 });
    assert.deepEqual(transaction, {
      state: { version: 1, count: 1 },
      result: "incremented",
    });
    assert.deepEqual(await store.read(), { version: 1, count: 1 });
    const metadata = await stat(stateFile);
    assert.equal(metadata.isFile(), true);
    if (process.platform !== "win32") {
      assert.equal(metadata.mode & 0o777, 0o600);
    }
    assert.equal(
      await readFile(stateFile, "utf8"),
      '{\n  "version": 1,\n  "count": 1\n}\n',
    );
  });
});

test("returns a transform result without writing when commit is false", async () => {
  await withStore(async ({ store }) => {
    await store.initialize({ version: 1, count: 0 });
    let hooksCalled = 0;

    const transaction = await store.transact(
      () => ({
        state: { version: 1, count: 99 },
        result: "unchanged",
        commit: false,
      }),
      {
        beforeCommit() {
          hooksCalled += 1;
        },
        afterCommit() {
          hooksCalled += 1;
        },
      },
    );

    assert.deepEqual(transaction, {
      state: { version: 1, count: 0 },
      result: "unchanged",
      committed: false,
    });
    assert.deepEqual(await store.read(), { version: 1, count: 0 });
    assert.equal(hooksCalled, 0);
  });
});

test("runs an explicit no-commit hook while the state lock is held", async () => {
  await withStore(async ({ stateFile, store }) => {
    await store.initialize({ version: 1, count: 0 });
    let observed;

    const transaction = await store.transact(
      (state) => ({
        state,
        result: "inspected",
        commit: false,
      }),
      {
        async onNoCommit(state) {
          observed = {
            state,
            lockExists: await access(`${stateFile}.lock`).then(
              () => true,
              () => false,
            ),
          };
        },
      },
    );

    assert.deepEqual(observed, {
      state: { version: 1, count: 0 },
      lockExists: true,
    });
    assert.equal(transaction.committed, false);
    await assert.rejects(
      access(`${stateFile}.lock`),
      (error) => error.code === "ENOENT",
    );
  });
});

test("serializes simultaneous process updates without losing data", async () => {
  await withStore(async ({ stateFile, store }) => {
    await store.initialize({ version: 1, count: 0 });

    const storeModule = new URL(
      "../source/atomic-json-store.mjs",
      import.meta.url,
    ).href;
    const script = `
      import { AtomicJsonStore } from ${JSON.stringify(storeModule)};
      const store = new AtomicJsonStore(${JSON.stringify(stateFile)}, {
        lockTimeoutMs: 10_000,
        lockRetryMs: 2,
      });
      for (let index = 0; index < 10; index += 1) {
        await store.transact((state) => ({
          state: { ...state, count: state.count + 1 },
          result: null,
        }));
      }
    `;
    const children = Array.from({ length: 4 }, () =>
      spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: "ignore",
      })
    );
    const exits = children.map((child) => once(child, "exit"));

    for (const [code] of await Promise.all(exits)) {
      assert.equal(code, 0);
    }

    assert.equal((await store.read()).count, 40);
  }, { lockTimeoutMs: 10_000, lockRetryMs: 2 });
});

test("times out on a live lock without removing it", async () => {
  await withStore(async ({ stateFile, store }) => {
    await store.initialize({ version: 1, count: 0 });
    const lockFile = `${stateFile}.lock`;
    const source = `${JSON.stringify({
      pid: process.pid,
      token: "live-owner",
      createdAt: new Date().toISOString(),
    })}\n`;
    await writeFile(lockFile, source, { mode: 0o600 });

    await expectStoreError(
      store.transact((state) => ({ state, result: null })),
      "LEDGER_LOCKED",
    );
    assert.equal(await readFile(lockFile, "utf8"), source);
  }, { lockTimeoutMs: 10, lockRetryMs: 1 });
});

test("recovers a lock left by a killed owner", async () => {
  await withStore(async ({ directory, stateFile, store }) => {
    await store.initialize({ version: 1, count: 0 });
    const readyFile = path.join(directory, "ready");
    const storeModule = new URL(
      "../source/atomic-json-store.mjs",
      import.meta.url,
    ).href;
    const script = `
      import { writeFile } from "node:fs/promises";
      import { AtomicJsonStore } from ${JSON.stringify(storeModule)};
      const store = new AtomicJsonStore(${JSON.stringify(stateFile)});
      await store.transact(async (state) => {
        await writeFile(${JSON.stringify(readyFile)}, "ready");
        await new Promise(() => {});
        return { state, result: null };
      });
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      { stdio: "ignore" },
    );
    const exited = once(child, "exit");

    await waitForFile(readyFile);
    child.kill("SIGKILL");
    await exited;

    await store.transact((state) => ({
      state: { ...state, count: state.count + 1 },
      result: null,
    }));

    assert.equal((await store.read()).count, 1);
  });
});

test("retains malformed and permission-uncertain locks", async () => {
  await withStore(async ({ stateFile, store }) => {
    await store.initialize({ version: 1, count: 0 });
    const lockFile = `${stateFile}.lock`;
    await writeFile(lockFile, "not-json\n", { mode: 0o600 });

    await expectStoreError(
      store.transact((state) => ({ state, result: null })),
      "LEDGER_LOCK_INVALID",
    );
    assert.equal(await readFile(lockFile, "utf8"), "not-json\n");
  });

  const permissionError = Object.assign(new Error("not permitted"), {
    code: "EPERM",
  });

  await withStore(async ({ stateFile, store }) => {
    await store.initialize({ version: 1, count: 0 });
    const lockFile = `${stateFile}.lock`;
    const source = `${JSON.stringify({
      pid: 999_999,
      token: "uncertain-owner",
      createdAt: new Date().toISOString(),
    })}\n`;
    await writeFile(lockFile, source, { mode: 0o600 });

    await expectStoreError(
      store.transact((state) => ({ state, result: null })),
      "LEDGER_LOCKED",
    );
    assert.equal(await readFile(lockFile, "utf8"), source);
  }, {
    lockTimeoutMs: 0,
    processProbe() {
      throw permissionError;
    },
  });
});

test("releases only a lock with the matching owner token", async () => {
  await withStore(async ({ stateFile, store }) => {
    await store.initialize({ version: 1, count: 0 });
    assert.equal((await store.inspectLock()).status, "absent");

    await store.transact(async (state) => {
      await writeFile(
        `${stateFile}.lock`,
        `${JSON.stringify({
          pid: process.pid,
          token: "replacement-owner",
          createdAt: new Date().toISOString(),
        })}\n`,
        { mode: 0o600 },
      );
      return {
        state: { ...state, count: 1 },
        result: null,
      };
    });

    const observation = await store.inspectLock();
    assert.equal(observation.status, "owned");
    assert.equal(observation.owner.token, "replacement-owner");
  });
});

test("preserves the old state before rename and the new state after rename", async () => {
  await withStore(async ({ store }) => {
    await store.initialize({ version: 1, value: "old" });

    await assert.rejects(
      store.transact(
        () => ({
          state: { version: 1, value: "before-failure" },
          result: null,
        }),
        {
          beforeCommit() {
            throw new Error("before failed");
          },
        },
      ),
      /before failed/,
    );
    assert.equal((await store.read()).value, "old");

    await assert.rejects(
      store.transact(
        () => ({
          state: { version: 1, value: "after-failure" },
          result: null,
        }),
        {
          afterCommit() {
            throw new Error("after failed");
          },
        },
      ),
      /after failed/,
    );
    assert.equal((await store.read()).value, "after-failure");
  });
});

test("cleans unique lock candidates and temporary files", async () => {
  let failNextFileSync = false;

  await withStore(async ({ directory, store }) => {
    await store.initialize({ version: 1, count: 0 });
    failNextFileSync = true;

    await assert.rejects(
      store.transact(() => ({
        state: { version: 1, count: 1 },
        result: null,
      })),
    );

    assert.deepEqual(await readdir(directory), ["state.json"]);
  }, {
    async syncHandle(handle, kind) {
      if (kind === "file" && failNextFileSync) {
        failNextFileSync = false;
        throw Object.assign(new Error("injected sync failure"), {
          code: "EIO",
        });
      }

      await handle.sync();
    },
  });
});

test("synchronizes files and the containing directory", async () => {
  const synchronized = [];

  await withStore(async ({ store }) => {
    await store.initialize({ version: 1, count: 0 });
    await store.transact((state) => ({
      state: { ...state, count: 1 },
      result: null,
    }));
  }, {
    async syncHandle(handle, kind) {
      synchronized.push(kind);
      await handle.sync();
    },
  });

  assert.ok(synchronized.filter((kind) => kind === "file").length >= 4);
  assert.ok(synchronized.filter((kind) => kind === "directory").length >= 2);
});

test("treats Windows directory fsync EPERM as unsupported without skipping file fsync", async () => {
  const synchronized = [];
  await withStore(async ({ store }) => {
    await store.initialize({ version: 1, count: 0 });
  }, {
    platform: "win32",
    protectDirectory: async () => {},
    async syncHandle(handle, kind) {
      synchronized.push(kind);
      if (kind === "directory") {
        throw Object.assign(new Error("directory fsync unsupported"), {
          code: "EPERM",
        });
      }
      await handle.sync();
    },
  });
  assert.ok(synchronized.includes("file"));
  assert.ok(synchronized.includes("directory"));
});

test("reports absent, invalid, live, and stale lock observations", async () => {
  await withStore(async ({ stateFile, store }) => {
    await store.initialize({ version: 1, count: 0 });
    const lockFile = `${stateFile}.lock`;

    assert.equal((await store.inspectLock()).status, "absent");

    await writeFile(lockFile, "invalid", { mode: 0o600 });
    assert.equal((await store.inspectLock()).status, "invalid");

    await writeFile(
      lockFile,
      `${JSON.stringify({
        pid: process.pid,
        token: "live",
        createdAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    assert.equal((await store.inspectLock()).status, "owned");

    await writeFile(
      lockFile,
      `${JSON.stringify({
        pid: 999_999,
        token: "dead",
        createdAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    assert.equal((await store.inspectLock()).status, "stale");
  });
});
