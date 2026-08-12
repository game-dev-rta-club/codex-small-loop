---
summary: >-
  Define exact repository snapshots for Review passes and durable,
  snapshot-scoped Signal records for material Reviewer findings and their
  current severity.
---

# Review Snapshots And Signals

Every Review pass uses one immutable candidate identity shared by all four
Review Tasks. Findings are stored separately from the candidate so Reviews can
remain read-only while Primary retains a durable acceptance record.

## Snapshot Contract

Primary creates a snapshot with:

```text
node <plugin-root>/components/commands/snapshot.mjs create \
  --task <primary-task-id> --project-root <directory>
```

The result contains `previousSnapshot`, `currentSnapshot`, and one exact diff
command. A snapshot can be a Git commit or a private snapshot commit created
from the current index and worktree. Private refs and temporary index files
keep capture isolated from the user's index and current branch. Untracked files
are included; ignored private runtime data is excluded.

The first pass compares the agreed base with the candidate. A correction pass
compares the previously reviewed candidate with the revised candidate. Primary
sends the same pair and command to every Reviewer and does not substitute a
later working-tree diff.

`--force-new` creates a distinct pass identity when legacy or invalid Signal
records make the current identity unusable. Snapshot creation fails explicitly
for unsupported repository state, capture failure, or an unresolved identity.

## Signal Contract

One material finding produces one file under:

```text
<project>/.codex-small-loop/signals/<primary-task-id>/<currentSnapshot>/<name>.md
```

Review creates it with `signal.mjs create`, sets `severity`, `summary`, and a
single complete `Explanation`, and does not prescribe the correction.
`Implementation Approach` remains a placeholder until an Interviewer deepens a
required finding.

Severity is one of `required`, `consider`, `later`, or `dismiss`. The canonical
definitions and evaluation lenses live in
[Signal Evaluation](/implementation/contents/review/signal-evaluation.md).

`signal.mjs list` validates all records for the exact Primary and snapshot.
Primary may use `signal.mjs set-severity` to correct a Reviewer's classification.
There is no separate decision or disposition record.

Legacy Review Issue files are never silently interpreted as Signals. Listing
fails with `SIGNAL_LEGACY_ISSUES_PRESENT` or `SIGNAL_INVALID_RECORDS`; old files
remain untouched and Primary creates a forced-new Review snapshot rather than
treating the list as empty.

## Implementation And Proof

- [Snapshot command](/implementation/components/commands/snapshot.mjs)
- [Snapshot implementation](/implementation/components/runtime/source/review-snapshot.mjs)
- [Signal command](/implementation/components/commands/signal.mjs)
- [Signal implementation](/implementation/components/runtime/source/signal.mjs)
- [Signal template](/implementation/components/runtime/templates/signals/review-signal.md)
- [Snapshot CLI tests](/implementation/components/runtime/tests/snapshot-cli.test.mjs)
- [Snapshot integration tests](/implementation/components/runtime/tests/review-snapshot.test.mjs)
- [Signal CLI tests](/implementation/components/runtime/tests/signal-cli.test.mjs)
- [Signal record tests](/implementation/components/runtime/tests/review-signal.test.mjs)

## Review Snapshot Detailed Contract

Primary creates one Review snapshot after an execute result is accepted and
before the four Review responsibilities inspect that candidate:

```text
node <plugin-root>/components/commands/snapshot.mjs create \
  --task <primary-task-id> [--project-root <directory>] [--force-new]
```

The project must be inside a Git worktree with a committed `HEAD`. The command
captures tracked, staged, and untracked files from the current candidate. It
does not include ignored files. Use `--force-new` only when coordination needs
a distinct Review-pass identity despite an unchanged candidate tree, such as
recovery from legacy or malformed Signal records.

### Result

A successful command writes one JSON object:

```json
{
  "run": "ok",
  "operation": "snapshot-create",
  "primaryTaskId": "019f...",
  "gitRoot": "/project",
  "ref": "refs/codex-small-loop/review-snapshots/<primary-task-hash>",
  "created": true,
  "previousSnapshot": "<commit-oid>",
  "currentSnapshot": "<commit-oid>",
  "tree": "<tree-oid>",
  "diff": {
    "command": "git",
    "args": [
      "-C",
      "/project",
      "diff",
      "--find-renames",
      "--no-ext-diff",
      "--no-color",
      "<previous-oid>",
      "<current-oid>",
      "--",
      "."
    ]
  }
}
```

Primary supplies the same `previousSnapshot`, `currentSnapshot`, and exact
`diff` command to Baseline Verification, Trust Review, Technical Excellence
Review, and Customer Value Review. Review Children execute the supplied command
before inspecting the complete current candidate in their assigned
responsibility.

The first snapshot compares committed `HEAD` with the candidate. Every later
snapshot for the same Primary Task compares the candidate from the preceding
Review pass with the current candidate. If the tree has not changed, the
command returns `created: false`, reuses the current snapshot, and returns an
empty same-OID diff. With `--force-new`, it instead creates a new commit with
the same tree and the current snapshot as parent; the exact diff remains empty,
but coordination files are scoped to the new Review pass.

### Storage And Isolation

The implementation hashes the Primary Task ID into a dedicated ref:

```text
refs/codex-small-loop/review-snapshots/<sha256>
```

It copies the existing Git index into a temporary alternate index, stages the
working tree there, writes a tree and commit directly into the existing Git
object database, and advances only the dedicated ref. The temporary index is
removed afterward. Every Git operation uses an argument array rather than a
shell command and hides child-window creation on Windows. Native absolute paths,
including paths containing spaces, use the same implementation on macOS and
Windows.

This process does not check out files, create a worktree, change `HEAD`, move
the current branch, modify the user's index, or edit project files. Snapshot
cost is therefore the Git scan and object hashing for the current repository,
not a second checkout. Git reuses objects whose content is already present.

The dedicated ref retains the Review-pass commit chain for later inspection.
This version does not prune old snapshot refs automatically.

The read-only Board enumerates that chain through the same computed ref. It
accepts only consecutive first-parent commits bearing the snapshot creator's
fixed author, committer, and subject attestation, orders them by ancestry rather
than timestamp, and stops before the ordinary repository parent. Each verified
record exposes immutable commit time and sequence. Traversal is bounded; an
absent ref is empty, while a wrong object, non-attested tip, broken ancestry, or
unavailable Git evidence fails closed for that Primary.

The returned `currentSnapshot` also scopes private
[Review Signals](/specification/technical-specification/runtime/review-snapshots-and-signals.md).
Those ignored Markdown files are local coordination records and are not
captured in the snapshot candidate.

### Failure Behavior

The CLI returns `run: "failed"` with a bounded error code and message when the
arguments are invalid, no committed Git baseline exists, Git cannot complete
the snapshot, or another process advances the same Primary Task ref
concurrently. It does not guess a fallback baseline.

### Implementation And Proof

- [snapshot command](/implementation/components/commands/snapshot.mjs)
- [Review snapshot implementation](/implementation/components/runtime/source/review-snapshot.mjs)
- [snapshot CLI tests](/implementation/components/runtime/tests/snapshot-cli.test.mjs)
- [Review snapshot integration tests](/implementation/components/runtime/tests/review-snapshot.test.mjs)
- [Task interaction Skill](/implementation/skills/working-with-codex-tasks/SKILL.md)
- [Primary role](/implementation/components/roles/primary/role.md)
- [Review role](/implementation/components/roles/review/role.md)


## Review Signals Detailed Contract

Review Signals are private coordination records for one Review pass. One
material finding uses one file:

```text
.codex-small-loop/signals/<primary-task-id>/<currentSnapshot>/<signal-name>.md
```

The directory is ignored by Git, so Signal records do not enter the candidate
or its commit history. Files remain available locally after the pass for
retrospective analysis.

All commands must run from the project worktree. They require the exact
Primary Task ID and full `currentSnapshot`. The command verifies that the
snapshot is still the current Review snapshot for that Primary Task instead of
reading or writing another pass.

Every Review Signal has exactly three frontmatter fields: `template`,
`severity`, and `summary`. Before listing or changing severity, `summary` must
contain one non-empty bounded line. `severity` must be `required`, `consider`,
`later`, or `dismiss`. Instructional placeholder values and extra or legacy
frontmatter fields are not accepted as completed Signal data.

### Create

Review creates an empty Signal from the selected bundled template:

```text
node <plugin-root>/components/commands/signal.mjs create \
  --task <primary-task-id> \
  --snapshot <currentSnapshot> \
  --name <lowercase-kebab-case-signal-name> \
  --template review-signal
```

The template is Obsidian-compatible Markdown:

```markdown
---
template: review-signal
severity: "<required | consider | later | dismiss>"
summary: "<Concise one-line summary of the material finding>"
---

## Explanation

<Explain the finding and why the selected severity is accurate.>

## Implementation Approach

<During Interview, describe the agreed implementation approach. Review leaves this placeholder unchanged.>
```

The CLI reads the selected template, normalizes CRLF or legacy CR input to LF,
and publishes the new file atomically without overwriting an existing Signal.
The reviewer edits the returned file
and replaces the `severity`, `summary`, and `Explanation` placeholders. It
leaves the `Implementation Approach` placeholder unchanged for Interview. The
complete finding and the reason its severity is accurate stay under the single
`Explanation` heading. Review does not prescribe an implementation plan or
correction. Create never overwrites an existing Signal; a duplicate name
returns an error with the existing path so the agent can reuse it or choose a
distinct name.

### List

Primary lists one exact task and snapshot after all four Review results arrive:

```text
node <plugin-root>/components/commands/signal.mjs list \
  --task <primary-task-id> \
  --snapshot <currentSnapshot>
```

The default output prints the common envelope once per Signal:

```text
Directory: .codex-small-loop/signals/<primary-task-id>/<currentSnapshot>/

SEVERITY  SUMMARY                       FILE
REQUIRED  Unsafe provenance fallback    provenance-fallback.md
CONSIDER  Future compatibility concern  future-compatibility.md
DISMISS   Accepted compatibility risk   compatibility-risk.md
```

Rows sort by filename. Missing or invalid frontmatter fails closed with
`SIGNAL_INVALID_RECORDS`; it is never treated as a valid Signal. A Signal with
an instructional placeholder, invalid severity, extra field, or legacy field
also fails closed. An empty snapshot directory returns a successful list.

### Set Severity

Primary may change a Signal's severity after reviewing its explanation:

```text
node <plugin-root>/components/commands/signal.mjs set-severity \
  --task <primary-task-id> \
  --snapshot <currentSnapshot> \
  --name <signal-name-without-.md> \
  --severity <required-consider-later-or-dismiss>
```

The command normalizes line endings, validates the complete Signal, and
atomically replaces only the severity value. Windows treats an unsupported
directory `fsync` as a no-op after the file itself has been synchronized;
macOS retains both file and directory synchronization. Repeating the same
severity is idempotent. It creates no
sidecar record and adds no decision metadata. Primary lists the snapshot again
when it needs to verify the resulting classifications.

Add `--json` to any command only when structured output is needed. Without
that flag, create, set-severity, and list use human-readable output.

### Upgrade Boundary

Former Review Issue files and Signals using the removed decision/disposition
schema are not silently interpreted as current Signals. If
`.codex-small-loop/issues/` contains records
for the exact current snapshot, `signal list` fails with
`SIGNAL_LEGACY_ISSUES_PRESENT`. Primary runs
`snapshot.mjs create --task <primary-task-id> --force-new` and starts four new
Signal-capable Conversations with the retained Review Tasks against the
resulting distinct snapshot.
Old files remain untouched for retrospective analysis.

### Boundaries

- `--task` and `--snapshot` are required for all operations.
- `--name` is required for create and set-severity; list has no optional filters.
- Set-severity also requires `--severity required|consider|later|dismiss`.
- Signal names are bounded lowercase kebab-case names.
- List reads at most 1,000 Markdown files and only the first 8 KiB needed for
  each file's frontmatter.
- Unsafe filenames and malformed or unreadable regular records fail closed.
  Symlink entries are ignored rather than exposing content outside the Signal
  directory.

### Implementation And Proof

- [Signal command](/implementation/components/commands/signal.mjs)
- [Signal implementation](/implementation/components/runtime/source/signal.mjs)
- [Review Signal template](/implementation/components/runtime/templates/signals/review-signal.md)
- [Signal CLI tests](/implementation/components/runtime/tests/signal-cli.test.mjs)
- [Review Signal tests](/implementation/components/runtime/tests/review-signal.test.mjs)
- [Review Snapshot](/specification/technical-specification/runtime/review-snapshots-and-signals.md)
- [Review Job Role](/specification/system-specification/roles/review.md)
- [Interviewer Job Role](/specification/system-specification/roles/interviewer.md)
- [Primary Job Role](/specification/system-specification/roles/primary.md)
