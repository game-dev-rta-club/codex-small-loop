import { createHash } from "node:crypto";
import {
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";

const MAX_ERROR_LENGTH = 512;

function bounded(value, maximum = MAX_ERROR_LENGTH) {
  const text = String(value);
  return text.length <= maximum
    ? text
    : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function projectError(message, cause) {
  const error = new Error(bounded(message));
  error.name = "ProjectRuntimeError";
  error.code = "PROJECT_ROOT_MISMATCH";
  if (cause) {
    error.cause = cause;
  }
  return error;
}

export async function resolveProject(projectRoot) {
  if (
    typeof projectRoot !== "string"
    || projectRoot.trim().length === 0
    || !path.isAbsolute(projectRoot)
  ) {
    throw projectError("Project root must be an explicit absolute directory");
  }

  let root;
  let rootStat;
  try {
    root = await realpath(projectRoot);
    rootStat = await stat(root, { bigint: true });
  } catch (cause) {
    throw projectError("Project root could not be resolved", cause);
  }

  if (!rootStat.isDirectory()) {
    throw projectError("Project root must resolve to a directory");
  }

  const directory = path.join(root, ".codex-small-loop");
  const rootIdentity = Object.freeze({
    dev: rootStat.dev,
    ino: rootStat.ino,
  });
  return Object.freeze({
    root,
    rootIdentity,
    key: createHash("sha256").update(root).digest("hex"),
    directory,
    stateFile: path.join(directory, "state.json"),
  });
}
