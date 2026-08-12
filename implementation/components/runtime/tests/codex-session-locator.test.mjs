import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  locateTaskHistories,
  locateTaskHistory,
  resolveCodexSessionRoots,
} from "../source/codex-session-locator.mjs";

async function withCodexHome(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-locator-"));
  const active = path.join(root, "sessions");
  const archived = path.join(root, "archived_sessions");
  await mkdir(active, { recursive: true });
  await mkdir(archived, { recursive: true });

  try {
    await run({
      active,
      archived,
      root,
      roots: resolveCodexSessionRoots(root),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function historyFile(root, taskId, relativeDirectory = "") {
  const directory = path.join(root, relativeDirectory);
  const file = path.join(directory, `rollout-prefix-${taskId}.jsonl`);
  await mkdir(directory, { recursive: true });
  await writeFile(file, "");
  return file;
}

function expectDiagnostic(result, code) {
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, code);
  assert.ok(result.diagnostics[0].message.length <= 512);
}

test("resolves canonical active and archived session roots", () => {
  const codexHome = path.join(path.sep, "absolute", "codex-home");

  assert.deepEqual(resolveCodexSessionRoots(codexHome), [
    {
      location: "active",
      directory: path.join(codexHome, "sessions"),
    },
    {
      location: "archived",
      directory: path.join(codexHome, "archived_sessions"),
    },
  ]);

  assert.throws(
    () => resolveCodexSessionRoots("relative-home"),
    (error) => error.code === "CODEX_SESSION_ROOT_INVALID",
  );
});

test("uses valid cached active and archived history paths", async () => {
  await withCodexHome(async ({ active, archived, roots }) => {
    const activeFile = await historyFile(active, "active-task", "2026/07");
    const archivedFile = await historyFile(archived, "archived-task", "2026/06");
    const results = await locateTaskHistories(
      ["active-task", "archived-task"],
      {
        roots,
        cachedPaths: new Map([
          ["active-task", activeFile],
          ["archived-task", archivedFile],
        ]),
      },
    );

    assert.deepEqual(results.get("active-task"), {
      taskId: "active-task",
      location: "active",
      historyFile: activeFile,
      diagnostics: [],
    });
    assert.deepEqual(results.get("archived-task"), {
      taskId: "archived-task",
      location: "archived",
      historyFile: archivedFile,
      diagnostics: [],
    });
  });
});

test("rediscovers a cached history after an archive move", async () => {
  await withCodexHome(async ({ active, archived, roots }) => {
    const taskId = "moved-task";
    const activeFile = await historyFile(active, taskId, "2026/07");
    const archivedFile = path.join(archived, `rollout-${taskId}.jsonl`);
    await rename(activeFile, archivedFile);

    const result = await locateTaskHistory(taskId, {
      roots,
      cachedPaths: { [taskId]: activeFile },
    });

    assert.deepEqual(result, {
      taskId,
      location: "archived",
      historyFile: archivedFile,
      diagnostics: [],
    });
  });
});

test("active history wins during a cross-root overlap", async () => {
  await withCodexHome(async ({ active, archived, roots }) => {
    const taskId = "overlap-task";
    const activeFile = await historyFile(active, taskId, "new");
    await historyFile(archived, taskId, "old");

    const result = await locateTaskHistory(taskId, {
      roots: [...roots].reverse(),
    });

    assert.equal(result.location, "active");
    assert.equal(result.historyFile, activeFile);
    assert.deepEqual(result.diagnostics, []);
  });
});

test("rejects same-location ambiguity without choosing a file", async () => {
  await withCodexHome(async ({ active, roots }) => {
    const taskId = "ambiguous-task";
    await historyFile(active, taskId, "a");
    await historyFile(active, taskId, "b");

    const result = await locateTaskHistory(taskId, { roots });

    assert.equal(result.taskId, taskId);
    assert.equal(result.location, "active");
    assert.equal(result.historyFile, null);
    expectDiagnostic(result, "TASK_HISTORY_AMBIGUOUS");
  });
});

test("returns bounded missing evidence when roots or histories are absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-missing-"));
  try {
    const roots = resolveCodexSessionRoots(root);
    const result = await locateTaskHistory("missing-task", { roots });

    assert.deepEqual(
      {
        taskId: result.taskId,
        location: result.location,
        historyFile: result.historyFile,
      },
      {
        taskId: "missing-task",
        location: "missing",
        historyFile: null,
      },
    );
    expectDiagnostic(result, "TASK_HISTORY_MISSING");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("matches only filenames ending with the exact Task ID", async () => {
  await withCodexHome(async ({ active, roots }) => {
    const taskId = "exact-task";
    await writeFile(path.join(active, `rollout-${taskId}-suffix.jsonl`), "");
    await writeFile(path.join(active, `rollout-${taskId}.jsonl.backup`), "");
    const exactFile = await historyFile(active, taskId, "nested");

    const result = await locateTaskHistory(taskId, { roots });

    assert.equal(result.historyFile, exactFile);
  });
});

test("walks each directory once for an unresolved batch in sorted order", async () => {
  await withCodexHome(async ({ active, archived, roots }) => {
    await historyFile(active, "task-a", "z");
    await historyFile(active, "task-b", "a");
    await historyFile(archived, "task-c", "archive");
    const visited = [];
    const fileSystem = {
      async readdir(directory, options) {
        visited.push(directory);
        return readdir(directory, options);
      },
      realpath,
      stat,
    };

    const results = await locateTaskHistories(
      ["task-a", "task-b", "task-c"],
      { roots, fileSystem },
    );

    assert.deepEqual(
      [...results.values()].map(({ taskId, location }) => ({ taskId, location })),
      [
        { taskId: "task-a", location: "active" },
        { taskId: "task-b", location: "active" },
        { taskId: "task-c", location: "archived" },
      ],
    );
    assert.equal(visited.filter((directory) => directory === active).length, 1);
    assert.equal(visited.filter((directory) => directory === archived).length, 1);
    assert.deepEqual(
      visited.filter((directory) => directory.startsWith(active)),
      [active, path.join(active, "a"), path.join(active, "z")],
    );
  });
});

test("rejects cached paths outside configured roots and rediscovers safely", async () => {
  await withCodexHome(async ({ active, root, roots }) => {
    const taskId = "outside-cache";
    const outside = path.join(root, `outside-${taskId}.jsonl`);
    await writeFile(outside, "");
    const expected = await historyFile(active, taskId, "inside");

    const result = await locateTaskHistory(taskId, {
      roots,
      cachedPaths: new Map([[taskId, outside]]),
    });

    assert.equal(result.location, "active");
    assert.equal(result.historyFile, expected);
  });
});

test("throws a stable batch error when a configured root is unreadable", async () => {
  await withCodexHome(async ({ roots }) => {
    const fileSystem = {
      async readdir() {
        const error = new Error("sensitive operating system detail");
        error.code = "EACCES";
        throw error;
      },
      realpath,
      stat,
    };

    await assert.rejects(
      locateTaskHistories(["task-a"], { roots, fileSystem }),
      (error) => {
        assert.equal(error.code, "CODEX_SESSION_ROOT_UNREADABLE");
        assert.ok(error.message.length <= 512);
        return true;
      },
    );
  });
});

test("rejects invalid roots, Task IDs, and duplicate batch IDs", async () => {
  await assert.rejects(
    locateTaskHistories(["task-a"], { roots: [] }),
    (error) => error.code === "CODEX_SESSION_ROOT_INVALID",
  );
  await assert.rejects(
    locateTaskHistories([""], {
      roots: [{
        location: "active",
        directory: path.join(path.sep, "tmp", "sessions"),
      }],
    }),
    (error) => error.code === "CODEX_SESSION_ROOT_INVALID",
  );
  await assert.rejects(
    locateTaskHistories(["task-a", "task-a"], {
      roots: [{
        location: "active",
        directory: path.join(path.sep, "tmp", "sessions"),
      }],
    }),
    (error) => error.code === "CODEX_SESSION_ROOT_INVALID",
  );
});
