import {
  readdir as readDirectory,
  realpath as resolveRealPath,
  stat as readStat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_DIAGNOSTIC_LENGTH = 512;
const MAX_TASK_ID_LENGTH = 512;
const LOCATIONS = new Set(["active", "archived"]);

const DEFAULT_FILE_SYSTEM = Object.freeze({
  readdir: readDirectory,
  realpath: resolveRealPath,
  stat: readStat,
});

function bounded(value, maximum = MAX_DIAGNOSTIC_LENGTH) {
  const text = String(value);
  return text.length <= maximum
    ? text
    : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function createError(code, message, details = {}) {
  const error = new Error(bounded(message));
  error.name = "CodexSessionLocatorError";
  error.code = code;
  Object.assign(error, details);
  return error;
}

function diagnostic(code, message) {
  return {
    code,
    message: bounded(message),
  };
}

function validTaskId(taskId) {
  return typeof taskId === "string"
    && taskId.trim().length > 0
    && taskId.length <= MAX_TASK_ID_LENGTH
    && !taskId.includes("/")
    && !taskId.includes("\\");
}

function validateTaskIds(taskIds) {
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    throw createError(
      "CODEX_SESSION_ROOT_INVALID",
      "Task history lookup requires at least one Task ID",
    );
  }

  const seen = new Set();
  for (const taskId of taskIds) {
    if (!validTaskId(taskId)) {
      throw createError(
        "CODEX_SESSION_ROOT_INVALID",
        "Task history lookup received an invalid Task ID",
      );
    }
    if (seen.has(taskId)) {
      throw createError(
        "CODEX_SESSION_ROOT_INVALID",
        `Task history lookup received duplicate Task ID ${bounded(taskId, 256)}`,
      );
    }
    seen.add(taskId);
  }
}

function validateRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw createError(
      "CODEX_SESSION_ROOT_INVALID",
      "At least one Codex session root is required",
    );
  }

  const locations = new Set();
  const directories = new Set();

  const normalized = roots.map((root) => {
    if (
      root === null
      || typeof root !== "object"
      || Array.isArray(root)
      || !LOCATIONS.has(root.location)
      || typeof root.directory !== "string"
      || !path.isAbsolute(root.directory)
    ) {
      throw createError(
        "CODEX_SESSION_ROOT_INVALID",
        "Codex session roots require a known location and absolute directory",
      );
    }

    const directory = path.normalize(root.directory);
    if (locations.has(root.location) || directories.has(directory)) {
      throw createError(
        "CODEX_SESSION_ROOT_INVALID",
        "Codex session roots must have unique locations and directories",
      );
    }

    locations.add(root.location);
    directories.add(directory);
    return {
      location: root.location,
      directory,
    };
  });

  return normalized.sort(
    (left, right) => (
      left.location === right.location
        ? 0
        : left.location === "active" ? -1 : 1
    ),
  );
}

function validateFileSystem(fileSystem) {
  if (
    fileSystem === null
    || typeof fileSystem !== "object"
    || typeof fileSystem.readdir !== "function"
    || typeof fileSystem.realpath !== "function"
    || typeof fileSystem.stat !== "function"
  ) {
    throw new TypeError("fileSystem must provide readdir, realpath, and stat");
  }
  return fileSystem;
}

function cachedPathFor(cachedPaths, taskId) {
  if (cachedPaths instanceof Map) {
    return cachedPaths.get(taskId);
  }
  if (
    cachedPaths !== null
    && typeof cachedPaths === "object"
    && Object.hasOwn(cachedPaths, taskId)
  ) {
    return cachedPaths[taskId];
  }
  return undefined;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}

function matchesTaskHistory(fileName, taskId) {
  return fileName.endsWith(`${taskId}.jsonl`);
}

async function realRoot(root, fileSystem) {
  try {
    return await fileSystem.realpath(root.directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw createError(
      "CODEX_SESSION_ROOT_UNREADABLE",
      `Codex ${root.location} session root is unreadable`,
      { cause: error, location: root.location },
    );
  }
}

async function validateCachedPath(
  taskId,
  cachedPath,
  roots,
  realRoots,
  fileSystem,
) {
  if (
    typeof cachedPath !== "string"
    || !path.isAbsolute(cachedPath)
    || !matchesTaskHistory(path.basename(cachedPath), taskId)
  ) {
    return null;
  }

  let realFile;
  let fileStat;
  try {
    [realFile, fileStat] = await Promise.all([
      fileSystem.realpath(cachedPath),
      fileSystem.stat(cachedPath),
    ]);
  } catch {
    return null;
  }

  if (!fileStat.isFile()) {
    return null;
  }

  for (const [index, root] of roots.entries()) {
    const resolvedRoot = realRoots[index];
    if (resolvedRoot && isWithin(resolvedRoot, realFile)) {
      return {
        rootIndex: index,
        result: {
          taskId,
          location: root.location,
          historyFile: path.normalize(cachedPath),
          diagnostics: [],
        },
      };
    }
  }

  return null;
}

async function walkRoot(root, taskIds, fileSystem) {
  const candidates = new Map(taskIds.map((taskId) => [taskId, []]));
  const pendingDirectories = [root.directory];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    let entries;

    try {
      entries = await fileSystem.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw createError(
        "CODEX_SESSION_ROOT_UNREADABLE",
        `Codex ${root.location} session root is unreadable`,
        { cause: error, location: root.location },
      );
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    const childDirectories = [];

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        childDirectories.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      for (const taskId of taskIds) {
        if (matchesTaskHistory(entry.name, taskId)) {
          candidates.get(taskId).push(entryPath);
        }
      }
    }

    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      pendingDirectories.push(childDirectories[index]);
    }
  }

  return candidates;
}

function missingResult(taskId) {
  return {
    taskId,
    location: "missing",
    historyFile: null,
    diagnostics: [
      diagnostic(
        "TASK_HISTORY_MISSING",
        `Codex task history was not found for Task ID ${bounded(taskId, 256)}`,
      ),
    ],
  };
}

function ambiguousResult(taskId, location) {
  return {
    taskId,
    location,
    historyFile: null,
    diagnostics: [
      diagnostic(
        "TASK_HISTORY_AMBIGUOUS",
        `More than one ${location} Codex history matches Task ID ${bounded(taskId, 256)}`,
      ),
    ],
  };
}

export function resolveCodexSessionRoots(
  codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
) {
  if (
    typeof codexHome !== "string"
    || codexHome.trim().length === 0
    || !path.isAbsolute(codexHome)
  ) {
    throw createError(
      "CODEX_SESSION_ROOT_INVALID",
      "Codex home must be an absolute directory",
    );
  }

  const home = path.normalize(codexHome);
  return [
    {
      location: "active",
      directory: path.join(home, "sessions"),
    },
    {
      location: "archived",
      directory: path.join(home, "archived_sessions"),
    },
  ];
}

export async function locateTaskHistories(taskIds, options = {}) {
  validateTaskIds(taskIds);
  const roots = validateRoots(options.roots);
  const fileSystem = validateFileSystem(
    options.fileSystem ?? DEFAULT_FILE_SYSTEM,
  );
  const cachedPaths = options.cachedPaths ?? new Map();
  const realRoots = await Promise.all(
    roots.map((root) => realRoot(root, fileSystem)),
  );
  const validatedCaches = new Map();

  for (const taskId of taskIds) {
    const cachedPath = cachedPathFor(cachedPaths, taskId);
    if (cachedPath !== undefined) {
      const cache = await validateCachedPath(
        taskId,
        cachedPath,
        roots,
        realRoots,
        fileSystem,
      );
      if (cache) {
        validatedCaches.set(taskId, cache);
      }
    }
  }

  const results = new Map();
  const unresolved = new Set(taskIds);

  for (const [rootIndex, root] of roots.entries()) {
    for (const taskId of [...unresolved]) {
      const cache = validatedCaches.get(taskId);
      if (cache?.rootIndex === rootIndex) {
        results.set(taskId, cache.result);
        unresolved.delete(taskId);
      }
    }

    if (unresolved.size === 0) {
      break;
    }

    const candidates = await walkRoot(root, [...unresolved], fileSystem);
    for (const taskId of [...unresolved]) {
      const matches = candidates.get(taskId);
      if (matches.length === 0) {
        continue;
      }

      if (matches.length > 1) {
        results.set(taskId, ambiguousResult(taskId, root.location));
      } else {
        results.set(taskId, {
          taskId,
          location: root.location,
          historyFile: matches[0],
          diagnostics: [],
        });
      }
      unresolved.delete(taskId);
    }
  }

  for (const taskId of unresolved) {
    results.set(taskId, missingResult(taskId));
  }

  return new Map(taskIds.map((taskId) => [taskId, results.get(taskId)]));
}

export async function locateTaskHistory(taskId, options = {}) {
  const results = await locateTaskHistories([taskId], options);
  return results.get(taskId);
}
