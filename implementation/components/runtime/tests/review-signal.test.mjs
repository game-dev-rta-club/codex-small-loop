import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

import {
  createSignal,
  listSignals,
  setSignalSeverity,
  SignalError,
} from "../source/signal.mjs";
import {
  createReviewSnapshot,
} from "../source/review-snapshot.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  }).trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "csl-review-signal-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Codex Small Loop Test");
  git(root, "config", "user.email", "codex-small-loop@example.invalid");
  await writeFile(path.join(root, ".gitignore"), "/.codex-small-loop/\n");
  await writeFile(path.join(root, "candidate.txt"), "baseline\n");
  git(root, "add", ".gitignore", "candidate.txt");
  git(root, "commit", "-qm", "baseline");
  return root;
}

async function createCompletedSignal({
  root,
  primaryTaskId,
  currentSnapshot,
  signalName,
  severity,
  summary,
}) {
  const created = await createSignal({
    primaryTaskId,
    currentSnapshot,
    signalName,
    templateName: "review-signal",
    projectRoot: root,
  });
  const source = (await readFile(created.file, "utf8"))
    .replace(
      'severity: "<required | consider | later | dismiss>"',
      `severity: ${severity}`,
    )
    .replace(
      'summary: "<Concise one-line summary of the material finding>"',
      `summary: ${summary}`,
    )
    .replace(
      "<Explain the finding and why the selected severity is accurate.>",
      "The observed behavior supports this severity.",
    );
  await writeFile(created.file, source);
  return created;
}

test("creates one ignored Signal from the four-severity template", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(path.join(root, "candidate.txt"), "candidate\n");
  const snapshot = await createReviewSnapshot({
    primaryTaskId: "primary-task-create",
    projectRoot: root,
  });
  const statusBefore = git(root, "status", "--porcelain=v1");

  const result = await createSignal({
    primaryTaskId: "primary-task-create",
    currentSnapshot: snapshot.currentSnapshot,
    signalName: "role-provenance",
    templateName: "review-signal",
    projectRoot: root,
  });

  assert.equal(result.run, "ok");
  assert.equal(result.operation, "signal-create");
  assert.equal(
    result.relativeFile,
    `.codex-small-loop/signals/primary-task-create/${snapshot.currentSnapshot}/role-provenance.md`,
  );
  assert.equal(
    await readFile(result.file, "utf8"),
    [
      "---",
      "template: review-signal",
      'severity: "<required | consider | later | dismiss>"',
      'summary: "<Concise one-line summary of the material finding>"',
      "---",
      "",
      "## Explanation",
      "",
      "<Explain the finding and why the selected severity is accurate.>",
      "",
      "## Implementation Approach",
      "",
      "<During Interview, describe the agreed implementation approach. Review leaves this placeholder unchanged.>",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(await readFile(result.file, "utf8"), /disposition|decision/i);
  assert.equal(git(root, "status", "--porcelain=v1"), statusBefore);
});

test("never overwrites an existing Signal", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await createReviewSnapshot({
    primaryTaskId: "primary-task-existing",
    projectRoot: root,
  });
  const input = {
    primaryTaskId: "primary-task-existing",
    currentSnapshot: snapshot.currentSnapshot,
    signalName: "duplicate-finding",
    templateName: "review-signal",
    projectRoot: root,
  };
  const created = await createSignal(input);
  await writeFile(created.file, "reviewer explanation\n");

  await assert.rejects(
    createSignal(input),
    ({ code }) => code === "SIGNAL_EXISTS",
  );
  assert.equal(await readFile(created.file, "utf8"), "reviewer explanation\n");
});

test("Primary changes only the severity and the update is idempotent", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await createReviewSnapshot({
    primaryTaskId: "primary-task-severity",
    projectRoot: root,
  });
  const created = await createCompletedSignal({
    root,
    primaryTaskId: "primary-task-severity",
    currentSnapshot: snapshot.currentSnapshot,
    signalName: "incorrect-total",
    severity: "consider",
    summary: "Sum is incorrect",
  });

  const input = {
    primaryTaskId: "primary-task-severity",
    currentSnapshot: snapshot.currentSnapshot,
    signalName: "incorrect-total",
    severity: "required",
    projectRoot: root,
  };
  const changed = await setSignalSeverity(input);
  const repeated = await setSignalSeverity(input);

  assert.equal(changed.operation, "signal-set-severity");
  assert.equal(changed.severity, "required");
  assert.equal(changed.changed, true);
  assert.equal(repeated.changed, false);
  const source = await readFile(created.file, "utf8");
  assert.match(source, /^severity: required$/m);
  assert.match(source, /## Explanation/);
  assert.doesNotMatch(source, /disposition|decision/i);
  await assert.rejects(
    readFile(`${created.file}.decision.json`, "utf8"),
    ({ code }) => code === "ENOENT",
  );

  assert.deepEqual(
    (await listSignals({
      primaryTaskId: "primary-task-severity",
      currentSnapshot: snapshot.currentSnapshot,
      projectRoot: root,
    })).signals,
    [{
      template: "review-signal",
      severity: "required",
      summary: "Sum is incorrect",
      file: "incorrect-total.md",
    }],
  );
});

test("accepts exactly the four canonical severity values", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await createReviewSnapshot({
    primaryTaskId: "primary-task-four-severities",
    projectRoot: root,
  });

  for (const severity of ["required", "consider", "later", "dismiss"]) {
    await createCompletedSignal({
      root,
      primaryTaskId: "primary-task-four-severities",
      currentSnapshot: snapshot.currentSnapshot,
      signalName: `finding-${severity}`,
      severity,
      summary: `Finding ${severity}`,
    });
  }
  const result = await listSignals({
    primaryTaskId: "primary-task-four-severities",
    currentSnapshot: snapshot.currentSnapshot,
    projectRoot: root,
  });
  assert.deepEqual(
    new Set(result.signals.map(({ severity }) => severity)),
    new Set(["required", "consider", "later", "dismiss"]),
  );

  await assert.rejects(
    setSignalSeverity({
      primaryTaskId: "primary-task-four-severities",
      currentSnapshot: snapshot.currentSnapshot,
      signalName: "finding-required",
      severity: "high",
      projectRoot: root,
    }),
    (error) => error instanceof SignalError && error.code === "SIGNAL_INVALID",
  );
});

test("fails closed on old and malformed Signal records", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await createReviewSnapshot({
    primaryTaskId: "primary-task-old-signal",
    projectRoot: root,
  });
  const created = await createSignal({
    primaryTaskId: "primary-task-old-signal",
    currentSnapshot: snapshot.currentSnapshot,
    signalName: "old-decision-model",
    templateName: "review-signal",
    projectRoot: root,
  });
  await writeFile(
    created.file,
    [
      "---",
      "template: review-signal",
      "severity: high",
      "summary: Old Signal",
      "disposition: adopt",
      "decision: Fix this",
      "---",
      "",
      "## Finding",
      "",
      "Old format.",
    ].join("\n"),
  );

  for (const operation of [
    () => listSignals({
      primaryTaskId: "primary-task-old-signal",
      currentSnapshot: snapshot.currentSnapshot,
      projectRoot: root,
    }),
    () => setSignalSeverity({
      primaryTaskId: "primary-task-old-signal",
      currentSnapshot: snapshot.currentSnapshot,
      signalName: "old-decision-model",
      severity: "required",
      projectRoot: root,
    }),
  ]) {
    await assert.rejects(
      operation(),
      (error) =>
        error instanceof SignalError
        && ["SIGNAL_INVALID", "SIGNAL_INVALID_RECORDS"].includes(error.code),
    );
  }
});

test("rejects a non-current snapshot and unsafe path segments", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await createReviewSnapshot({
    primaryTaskId: "primary-task-paths",
    projectRoot: root,
  });

  await assert.rejects(
    createSignal({
      primaryTaskId: "primary-task-paths",
      currentSnapshot: "a".repeat(snapshot.currentSnapshot.length),
      signalName: "wrong-snapshot",
      templateName: "review-signal",
      projectRoot: root,
    }),
    ({ code }) => code === "SIGNAL_SNAPSHOT_MISMATCH",
  );
  for (const signalName of ["../escape", "UPPERCASE", "two words"]) {
    await assert.rejects(
      createSignal({
        primaryTaskId: "primary-task-paths",
        currentSnapshot: snapshot.currentSnapshot,
        signalName,
        templateName: "review-signal",
        projectRoot: root,
      }),
      ({ code }) => code === "SIGNAL_INVALID",
    );
  }
});

test("lists normalized Signal metadata in filename order", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await createReviewSnapshot({
    primaryTaskId: "primary-task-list",
    projectRoot: root,
  });
  for (const [signalName, severity, summary] of [
    ["z-later", "later", "Limited compatibility opportunity"],
    ["b-consider", "CONSIDER", "Infrequent error state"],
    ["a-required", "required", "Primary workflow is unavailable"],
  ]) {
    await createCompletedSignal({
      root,
      primaryTaskId: "primary-task-list",
      currentSnapshot: snapshot.currentSnapshot,
      signalName,
      severity,
      summary,
    });
  }

  const result = await listSignals({
    primaryTaskId: "primary-task-list",
    currentSnapshot: snapshot.currentSnapshot,
    projectRoot: root,
  });

  assert.equal(result.operation, "signal-list");
  assert.deepEqual(result.signals, [
    {
      template: "review-signal",
      severity: "required",
      summary: "Primary workflow is unavailable",
      file: "a-required.md",
    },
    {
      template: "review-signal",
      severity: "consider",
      summary: "Infrequent error state",
      file: "b-consider.md",
    },
    {
      template: "review-signal",
      severity: "later",
      summary: "Limited compatibility opportunity",
      file: "z-later.md",
    },
  ]);
});

test("fails closed on incomplete frontmatter and unsafe directory entries", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await createReviewSnapshot({
    primaryTaskId: "primary-task-malformed",
    projectRoot: root,
  });
  const malformed = await createSignal({
    primaryTaskId: "primary-task-malformed",
    currentSnapshot: snapshot.currentSnapshot,
    signalName: "missing-summary",
    templateName: "review-signal",
    projectRoot: root,
  });

  await assert.rejects(
    listSignals({
      primaryTaskId: "primary-task-malformed",
      currentSnapshot: snapshot.currentSnapshot,
      projectRoot: root,
    }),
    ({ code }) => code === "SIGNAL_INVALID_RECORDS",
  );

  await writeFile(
    malformed.file,
    "---\ntemplate: review-signal\nseverity: required\nsummary: False delimiter\n---not-a-delimiter\n",
  );
  await assert.rejects(
    listSignals({
      primaryTaskId: "primary-task-malformed",
      currentSnapshot: snapshot.currentSnapshot,
      projectRoot: root,
    }),
    ({ code }) => code === "SIGNAL_INVALID_RECORDS",
  );

  await rm(malformed.file);
  const unsafeName = process.platform === "win32"
    ? "unsafe_name.md"
    : "unsafe\nname.md";
  await writeFile(
    path.join(path.dirname(malformed.file), unsafeName),
    "unsafe\n",
  );
  await assert.rejects(
    listSignals({
      primaryTaskId: "primary-task-malformed",
      currentSnapshot: snapshot.currentSnapshot,
      projectRoot: root,
    }),
    ({ code }) => code === "SIGNAL_INVALID",
  );
});

test("rejects unknown templates instead of resolving arbitrary paths", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await createReviewSnapshot({
    primaryTaskId: "primary-task-template",
    projectRoot: root,
  });
  await assert.rejects(
    createSignal({
      primaryTaskId: "primary-task-template",
      currentSnapshot: snapshot.currentSnapshot,
      signalName: "template-escape",
      templateName: "../review-signal",
      projectRoot: root,
    }),
    ({ code }) => code === "SIGNAL_TEMPLATE_UNKNOWN",
  );
});

test("returns an empty list when the snapshot has no Signals", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await createReviewSnapshot({
    primaryTaskId: "primary-task-empty",
    projectRoot: root,
  });
  const result = await listSignals({
    primaryTaskId: "primary-task-empty",
    currentSnapshot: snapshot.currentSnapshot,
    projectRoot: root,
  });
  assert.deepEqual(result.signals, []);
});

test("fails closed when legacy Review issues exist for the current snapshot", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await createReviewSnapshot({
    primaryTaskId: "primary-task-legacy",
    projectRoot: root,
  });
  const legacyDirectory = path.join(
    root,
    ".codex-small-loop",
    "issues",
    "primary-task-legacy",
    snapshot.currentSnapshot,
  );
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(
    path.join(legacyDirectory, "old-review-issue.md"),
    "legacy finding\n",
  );

  await assert.rejects(
    listSignals({
      primaryTaskId: "primary-task-legacy",
      currentSnapshot: snapshot.currentSnapshot,
      projectRoot: root,
    }),
    ({ code }) => code === "SIGNAL_LEGACY_ISSUES_PRESENT",
  );

  const fresh = await createReviewSnapshot({
    primaryTaskId: "primary-task-legacy",
    projectRoot: root,
    forceNew: true,
  });
  assert.deepEqual(
    (await listSignals({
      primaryTaskId: "primary-task-legacy",
      currentSnapshot: fresh.currentSnapshot,
      projectRoot: root,
    })).signals,
    [],
  );
});
