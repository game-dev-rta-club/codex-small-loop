import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdtemp,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { resolveProject } from "./project.mjs";

const execFileAsync = promisify(execFile);
const MAX_ID_LENGTH = 512;
const MAX_ERROR_LENGTH = 512;
const REF_PREFIX = "refs/codex-small-loop/review-snapshots";
export const REVIEW_SNAPSHOT_AUTHOR_NAME = "Codex Small Loop";
export const REVIEW_SNAPSHOT_AUTHOR_EMAIL = "snapshot@codex-small-loop.invalid";
export const REVIEW_SNAPSHOT_SUBJECT = "Codex Small Loop review snapshot";
export const MAX_REVIEW_SNAPSHOT_HISTORY = 256;

export class ReviewSnapshotError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "ReviewSnapshotError";
    this.code = code;
  }
}

function bounded(value, maximum = MAX_ERROR_LENGTH) {
  const text = String(value);
  return text.length <= maximum
    ? text
    : `${text.slice(0, maximum - 1)}…`;
}

function snapshotError(code, message, cause) {
  return new ReviewSnapshotError(code, bounded(message), cause);
}

function requirePrimaryTaskId(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_ID_LENGTH
    || /\s/.test(value)
  ) {
    throw snapshotError(
      "REVIEW_SNAPSHOT_INVALID",
      "Primary Task ID must be a non-empty bounded identifier.",
    );
  }
  return value;
}

export function reviewSnapshotRef(primaryTaskId) {
  primaryTaskId = requirePrimaryTaskId(primaryTaskId);
  const taskKey = createHash("sha256").update(primaryTaskId).digest("hex");
  return `${REF_PREFIX}/${taskKey}`;
}

export async function runReviewSnapshotGit(
  cwd,
  args,
  env = process.env,
  execute = execFileAsync,
) {
  try {
    const { stdout } = await execute("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env,
      maxBuffer: 16 * 1_024 * 1_024,
      shell: false,
      windowsHide: true,
    });
    return stdout.trim();
  } catch (cause) {
    throw snapshotError(
      "REVIEW_SNAPSHOT_GIT_FAILED",
      cause?.stderr || cause?.message || "Git snapshot operation failed.",
      cause,
    );
  }
}

async function resolveGitRoot(projectRoot) {
  let project;
  try {
    project = await resolveProject(projectRoot);
  } catch (cause) {
    throw snapshotError(
      "REVIEW_SNAPSHOT_INVALID",
      cause?.message || "Project root could not be resolved.",
      cause,
    );
  }

  let gitRoot;
  try {
    gitRoot = await runReviewSnapshotGit(
      project.root,
      ["rev-parse", "--show-toplevel"],
    );
    const inside = await runReviewSnapshotGit(
      project.root,
      ["rev-parse", "--is-inside-work-tree"],
    );
    if (inside !== "true") {
      throw new Error("Project is not inside a Git worktree.");
    }
  } catch (cause) {
    throw snapshotError(
      "REVIEW_SNAPSHOT_GIT_UNAVAILABLE",
      "Review snapshots require a Git worktree with a committed baseline.",
      cause,
    );
  }

  try {
    const baseline = await runReviewSnapshotGit(
      gitRoot,
      ["rev-parse", "--verify", "HEAD^{commit}"],
    );
    return { gitRoot, baseline };
  } catch (cause) {
    throw snapshotError(
      "REVIEW_SNAPSHOT_GIT_UNAVAILABLE",
      "Review snapshots require a Git worktree with a committed baseline.",
      cause,
    );
  }
}

async function existingRef(gitRoot, ref) {
  try {
    return await runReviewSnapshotGit(
      gitRoot,
      ["rev-parse", "--verify", `${ref}^{commit}`],
    );
  } catch (error) {
    if (error.cause?.code === 128) {
      return null;
    }
    throw error;
  }
}

export async function resolveCurrentReviewSnapshot({
  primaryTaskId,
  projectRoot,
}) {
  primaryTaskId = requirePrimaryTaskId(primaryTaskId);
  const { gitRoot } = await resolveGitRoot(projectRoot);
  const ref = reviewSnapshotRef(primaryTaskId);
  const currentSnapshot = await existingRef(gitRoot, ref);
  if (!currentSnapshot) {
    throw snapshotError(
      "REVIEW_SNAPSHOT_NOT_FOUND",
      "The Primary Task does not have a Review snapshot.",
    );
  }
  return {
    primaryTaskId,
    gitRoot,
    ref,
    currentSnapshot,
  };
}

async function prepareAlternateIndex(gitRoot, indexFile) {
  const gitIndex = await runReviewSnapshotGit(
    gitRoot,
    ["rev-parse", "--git-path", "index"],
  );
  const sourceIndex = path.isAbsolute(gitIndex)
    ? gitIndex
    : path.resolve(gitRoot, gitIndex);
  try {
    await access(sourceIndex);
    await copyFile(sourceIndex, indexFile);
  } catch {
    await runReviewSnapshotGit(gitRoot, ["read-tree", "HEAD"], {
      ...process.env,
      GIT_INDEX_FILE: indexFile,
    });
  }
}

function snapshotEnvironment(indexFile) {
  return {
    ...process.env,
    GIT_INDEX_FILE: indexFile,
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function commitEnvironment() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: REVIEW_SNAPSHOT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: REVIEW_SNAPSHOT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: REVIEW_SNAPSHOT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: REVIEW_SNAPSHOT_AUTHOR_EMAIL,
  };
}

function diffCommand(gitRoot, previousSnapshot, currentSnapshot) {
  return {
    command: "git",
    args: [
      "-C",
      gitRoot,
      "diff",
      "--find-renames",
      "--no-ext-diff",
      "--no-color",
      previousSnapshot,
      currentSnapshot,
      "--",
      ".",
    ],
  };
}

export async function createReviewSnapshot({
  primaryTaskId,
  projectRoot,
  forceNew = false,
}) {
  primaryTaskId = requirePrimaryTaskId(primaryTaskId);
  if (typeof forceNew !== "boolean") {
    throw snapshotError(
      "REVIEW_SNAPSHOT_INVALID",
      "forceNew must be a boolean.",
    );
  }
  const { gitRoot, baseline } = await resolveGitRoot(projectRoot);
  const ref = reviewSnapshotRef(primaryTaskId);
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "codex-small-loop-review-snapshot-"),
  );
  const indexFile = path.join(temporaryDirectory, "index");

  try {
    await prepareAlternateIndex(gitRoot, indexFile);
    const indexEnvironment = snapshotEnvironment(indexFile);
    await runReviewSnapshotGit(
      gitRoot,
      ["add", "-A", "--", "."],
      indexEnvironment,
    );
    const tree = await runReviewSnapshotGit(gitRoot, ["write-tree"], indexEnvironment);
    const previousRef = await existingRef(gitRoot, ref);

    if (previousRef) {
      const previousTree = await runReviewSnapshotGit(
        gitRoot,
        ["rev-parse", `${previousRef}^{tree}`],
      );
      if (previousTree === tree && !forceNew) {
        return {
          run: "ok",
          operation: "snapshot-create",
          primaryTaskId,
          gitRoot,
          ref,
          created: false,
          previousSnapshot: previousRef,
          currentSnapshot: previousRef,
          tree,
          forced: false,
          diff: diffCommand(gitRoot, previousRef, previousRef),
        };
      }
    }

    const previousSnapshot = previousRef ?? baseline;
    const currentSnapshot = await runReviewSnapshotGit(
      gitRoot,
      [
        "commit-tree",
        tree,
        "-p",
        previousSnapshot,
        "-m",
        REVIEW_SNAPSHOT_SUBJECT,
      ],
      commitEnvironment(),
    );
    const expectedOld = previousRef
      ?? "0".repeat(currentSnapshot.length);

    try {
      await runReviewSnapshotGit(
        gitRoot,
        ["update-ref", ref, currentSnapshot, expectedOld],
      );
    } catch (cause) {
      throw snapshotError(
        "REVIEW_SNAPSHOT_CONFLICT",
        "Another review snapshot updated this Primary Task concurrently.",
        cause,
      );
    }

    return {
      run: "ok",
      operation: "snapshot-create",
      primaryTaskId,
      gitRoot,
      ref,
      created: true,
      previousSnapshot,
      currentSnapshot,
      tree,
      forced: forceNew,
      diff: diffCommand(gitRoot, previousSnapshot, currentSnapshot),
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function snapshotDiagnostic(code, message) {
  return { code, message: bounded(message) };
}

async function exactRef(gitRoot, ref) {
  const output = await runReviewSnapshotGit(gitRoot, [
    "for-each-ref",
    "--format=%(refname)%1f%(objectname)",
    ref,
  ]);
  if (!output) return null;
  const [name, object, ...extra] = output.split("\u001f");
  if (name !== ref || !object || extra.length > 0) {
    throw snapshotError(
      "REVIEW_SNAPSHOT_HISTORY_INVALID",
      "The Review snapshot ref is malformed or ambiguous.",
    );
  }
  return object;
}

async function inspectSnapshotCommit(gitRoot, commit) {
  const separator = "\u001f";
  const output = await runReviewSnapshotGit(gitRoot, [
    "show",
    "-s",
    `--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%s%x1f%cI`,
    commit,
  ]);
  const fields = output.split(separator);
  if (fields.length !== 8 || fields[0] !== commit) {
    throw snapshotError(
      "REVIEW_SNAPSHOT_HISTORY_INVALID",
      "Review snapshot history returned malformed Git metadata.",
    );
  }
  const parents = fields[1] ? fields[1].split(" ") : [];
  const createdAt = new Date(fields[7]);
  return {
    commit: fields[0],
    parents,
    attested: fields[2] === REVIEW_SNAPSHOT_AUTHOR_NAME
      && fields[3] === REVIEW_SNAPSHOT_AUTHOR_EMAIL
      && fields[4] === REVIEW_SNAPSHOT_AUTHOR_NAME
      && fields[5] === REVIEW_SNAPSHOT_AUTHOR_EMAIL
      && fields[6] === REVIEW_SNAPSHOT_SUBJECT,
    createdAt: Number.isNaN(createdAt.valueOf()) ? null : createdAt.toISOString(),
  };
}

export async function listReviewSnapshots({
  primaryTaskId,
  projectRoot,
  maximum = MAX_REVIEW_SNAPSHOT_HISTORY,
}) {
  primaryTaskId = requirePrimaryTaskId(primaryTaskId);
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_REVIEW_SNAPSHOT_HISTORY) {
    throw snapshotError(
      "REVIEW_SNAPSHOT_INVALID",
      "Review snapshot history maximum is invalid.",
    );
  }
  const { gitRoot } = await resolveGitRoot(projectRoot);
  const ref = reviewSnapshotRef(primaryTaskId);
  const rawTip = await exactRef(gitRoot, ref);
  if (!rawTip) {
    return { primaryTaskId, ref, snapshots: [], diagnostics: [], partial: false };
  }
  let tip;
  try {
    tip = await runReviewSnapshotGit(
      gitRoot,
      ["rev-parse", "--verify", `${ref}^{commit}`],
    );
  } catch (cause) {
    throw snapshotError(
      "REVIEW_SNAPSHOT_HISTORY_INVALID",
      "The Review snapshot ref does not resolve to a commit.",
      cause,
    );
  }
  const newestFirst = [];
  const diagnostics = [];
  let current = tip;
  while (current) {
    if (newestFirst.length >= maximum) {
      diagnostics.push(snapshotDiagnostic(
        "REVIEW_SNAPSHOT_HISTORY_BOUNDED",
        "Review snapshot history reached its traversal bound.",
      ));
      break;
    }
    let inspected;
    try {
      inspected = await inspectSnapshotCommit(gitRoot, current);
    } catch (cause) {
      if (newestFirst.length > 0) {
        diagnostics.push(snapshotDiagnostic(
          "REVIEW_SNAPSHOT_HISTORY_TRUNCATED",
          "Only a verified suffix of Review snapshot history is available.",
        ));
        break;
      }
      throw snapshotError(
        "REVIEW_SNAPSHOT_HISTORY_INVALID",
        "Review snapshot history could not be verified.",
        cause,
      );
    }
    if (!inspected.attested) {
      if (newestFirst.length === 0) {
        throw snapshotError(
          "REVIEW_SNAPSHOT_HISTORY_INVALID",
          "The Review snapshot tip is not attested by Codex Small Loop.",
        );
      }
      break;
    }
    if (inspected.parents.length !== 1 || !inspected.createdAt) {
      throw snapshotError(
        "REVIEW_SNAPSHOT_HISTORY_INVALID",
        "An attested Review snapshot has invalid ancestry or time metadata.",
      );
    }
    newestFirst.push({
      primaryTaskId,
      snapshot: inspected.commit,
      previousSnapshot: inspected.parents[0],
      createdAt: inspected.createdAt,
    });
    current = inspected.parents[0];
  }
  const snapshots = newestFirst.reverse().map((snapshot, sequence) => ({
    ...snapshot,
    sequence,
  }));
  return {
    primaryTaskId,
    ref,
    snapshots,
    diagnostics,
    partial: diagnostics.length > 0,
  };
}
