---
keyPoints: >-
  Lifecycle authority follows the exact active Conversation and a versioned
  per-Milestone Heartbeat state rather than Task ancestry or age. A detached
  project supervisor performs only evidence-backed mechanical recovery; stale,
  ambiguous, or incomplete observations grant no authority to advance.
---

# Lifecycle And Recovery

Lifecycle and recovery follow the current active Conversation branch rather
than launch ancestry. They keep reply obligations moving without introducing a
recovery agent, project-wide Codex Automation, task-age timeout, or permanent
operating-system service.

## Controller Observation Policy

Controller owns user-level supervision; it does not create a Monitor Task.
Intent clarification and plan agreement stay in the active user conversation.
Controller opens or boundedly attempts the Board before each fresh Primary;
this page boundary remains separate from heartbeat authority.
Every scheduled prompt embeds the closed tuple
`(C,P,S,G,R,STATE,conversation)`. `C/S/G` are exact Controller, schedule, and
Milestone generation; `P` is literal `uncommitted` only while the Primary fork
is pending and exact thereafter; `R` is a monotonic schedule revision;
`STATE` is one token below; and Conversation is literal `uncommitted` or one
exact ID. Every same-`S` `schedule apply` update consumes the opaque etag from
an exact `schedule read`, increments `R`, and requires a full-definition and
full-tuple read-back before the new authority is used. Old revision, missing or
different identity/generation/state/binding, unknown state, or deleted schedule
is an unconditional no-op, including a prompt delivered before an update. No
callback enumerates or changes unrelated automations.

| State | Exclusive authority | Transition after read-back |
| --- | --- | --- |
| `LIVE` | No schedule or callback; ordinary Controller may arm the next Milestone | create `PRIMARY_PENDING` |
| `PRIMARY_PENDING` | Inspect/recover one exact queued fork; bind its one committed Child; or delete only after proven failed noncommitment | `PRIMARY_BOUND` or `LIVE` |
| `PRIMARY_BOUND` | Inspect/recover exact P through bootstrap and live interview; arm execution startup | `START_PENDING` |
| `START_PENDING` | Inspect bounded evidence; bind one exact CID; or restore exact P preparation only on the exact failed-start predicate below | `START_BOUND` or `PRIMARY_BOUND` |
| `START_BOUND` | Inspect/recover exact P/CID and prove Execute started | `STEADY` |
| `STEADY` | Supervise exact P/CID; arm nonterminal or terminal handoff | `ADVANCE_STOP` or `TERMINAL_DELETE` |
| `ADVANCE_STOP` | Accept exact replied CID; stop/recover exact P; arm deletion only after proven stop | `ADVANCE_DELETE` |
| `ADVANCE_DELETE` | Delete and confirm exact S only | `LIVE` at G+1 |
| `TERMINAL_DELETE` | Delete and confirm exact S; ordinary Controller may then stop exact P; never fork | terminal |

`PRIMARY_PENDING` is created and read back before the fork as
`P=uncommitted,conversation=uncommitted`. It keeps the exact deferred launch
recoverable after the Controller turn ends. One committed Child ID rebinds the
same schedule as `PRIMARY_BOUND` before bootstrap or interview recovery.
`START_PENDING` is then created from that same schedule after
`READY_FOR_EXECUTION` as `conversation=uncommitted`. It cannot operate any Task
or Conversation. Zero
matching Conversations is always a no-op, including before invocation,
in-flight, interrupted/lost result, timeout, missing/malformed output,
authentication/App-read ambiguity, and delayed visibility.

Restoring `PRIMARY_BOUND` requires all evidence together: the exact current pending tuple;
exactly one attributable `conversation start` invocation for exact P after its
read-back and no later invocation; completed exit 1; one bounded parseable
result with `operation="start"`, `run="failed"`, and present `code`/`message`;
no CID, partial, queued, delivery, or committed evidence; and bounded zero
matching Controller-to-P Conversations for G. Exit 2/partial, `ok`, any CID,
failed-with-CID, stale R/G, wrong target, later attempt, missing/truncated/
malformed/unattributable result, contradictory CID, or multiple matches retains
pending and forbids restoration.

One proven Controller-to-P commitment
rebinds same `S` at `R+1` to `START_BOUND/<CID>`; ambiguous/multiple/mismatched
evidence permits neither delete nor rebind. An `ok` or `partial` start result with
one committed CID requires this rebind and read-back before recovery,
supervision, or end turn. Rebind failure and an interruption after commit retain
pending; only pending may boundedly discover and bind that unique CID. Execute
proof similarly requires a confirmed same-`S` `STEADY` revision. Accepted CID
in `START_BOUND` or `STEADY` is stale and cannot act.

There is exactly one ordinary Controller start invocation per pending tuple.
Callbacks and recovery never retry it; only a confirmed same-schedule return to
`PRIMARY_BOUND` followed by a new pending revision, or `START_BOUND` settlement,
permits later action.

For nonterminal advancement, independent verification is followed by confirmed
same-`S` `ADVANCE_STOP` **before** acceptance. Arming failure forbids accept.
That state alone accepts exact replied CID, stops/retries/recover exact P, then
after proven committed or partial stop confirms `ADVANCE_DELETE`. The latter
only deletes/confirms exact S. Failure retains the current state; no next fork,
new schedule, generation advance, Child action, or unrelated Conversation is
allowed. Absence permits ordinary Controller to enter `LIVE` at G+1, arm a new
`PRIMARY_PENDING` schedule, and then fork. A queued older revision/generation is inert.

Terminal flow instead confirms `TERMINAL_DELETE`, deletes/confirms S, then
ordinary Controller stops P; it never forks. `PRIMARY_PENDING` creation failure
prevents the fork, and `START_PENDING` transition failure prevents execution
start. Board failure remains bounded; fork, bootstrap, and live-interview
failures remain observable through the current one-minute schedule.
Authentication/App-read ambiguity grants no authority. A failed same-S update
or read-back retains the last confirmed tuple and cadence. Interrupted turns
resume only that tuple. User cadence applies independently per Milestone; no
states or schedules run in parallel. This uses Codex Small Loop
`schedule apply/read/delete`, not Codex App `automation_update`, raw TOML, or
project cron. Create uses `if-match=absent`; update and delete consume a read
etag, and deletion is confirmed by a final absent read. There is no timeout.
An inherited App scheduling failure loads
`$codex-small-loop:recover-unavailable-thread-schedules`, which returns the
request to this same exact-Task, etag-guarded boundary without adding a raw
store path.

Controller uses `task resume` for a safe recovery that preserves the existing
Conversation graph. It does not replace tasks merely to escape a stopped state.
If recovery is impossible or would create an untrustworthy graph, Controller
leaves the trajectory stopped and notifies the user. A normal Milestone
transition follows the exact stop/delete/fork ordering above. Later user
feedback resumes the Controller from zero schedules and begins a fresh Primary
Milestone.

## Stop And Resume

`task.mjs stop` and `task.mjs resume` select the requested Task and downstream
Responders reachable through active `awaiting_reply` Conversations. Siblings
outside that branch remain unchanged. Stop marks open links `stopped`, queues
retryable interrupt deliveries, and suppresses recovery. Resume reopens the
branch and sends a fixed message only to reopened Conversation leaves. A Task
below a stopped active ancestor cannot resume independently.

Conversation acceptance is separate: `conversation accept` closes one exchange but
does not accept, archive, or complete its Tasks. Internal archive cleanup may
terminally compact a launch link only after dependent work settles.

## State Observation

Observation locates the exact Codex session history for each managed Task,
streams bounded JSONL, reduces relevant turn events, and reports the latest
state and Turn identity. Location, file identity, and turn-boundary checks make
stale observations fail closed. The runtime observes only Tasks involved in
active Conversations, pending launches, lifecycle delivery, or exact assignment
reconciliation.

Ordinary observation remains metadata-only. The public exact-Turn `task read`
and `task wait` path explicitly opts into the selected `task_complete` event's
`last_agent_message` and exposes it as `finalAnswer`. No user messages, tool
arguments, unrelated assistant messages, or answers from another Turn enter
the reduced event. `read` does not wait. `wait` repeatedly observes the same
Task and Turn IDs and treats a bounded timeout as a normal in-progress result.

## Heartbeat Pipeline

One `heartbeat.mjs` pass reconciles pending launches and App-message schedules,
observes active Tasks, applies lifecycle deliveries, derives every leaf
Responder in the active obligation forest, sends deduplicated recovery messages
to eligible terminal Responders, and compacts settled records. Independent
branches are evaluated separately; one failure yields a bounded partial result
without hiding healthy siblings.

A Responder is recovered only when it still owes an `awaiting_reply`
Conversation, is an active leaf, is not stopped, has a terminal turn, and has no
message or delivery already protecting that same boundary. The recovery key
includes the Responder and observed Turn, so a later terminal turn may be
recovered again. There is no total retry limit.

## Detached Supervisor And Diagnostics

One detached Node.js Recovery Supervisor per project repeats Heartbeat every
five seconds while actionable work remains. Task launch, resume, and messaging
start or reuse it. A private lock prevents duplicates; stale ownership is
removed only after the recorded process is proven absent and the lock is
unchanged.

Thrown failures retry with bounded exponential backoff. Thrown and partial
passes write bounded evidence to
`.codex-small-loop/recovery-supervisor-error.json`; a later successful pass
clears it. `runtime status` surfaces retained evidence as `repair_required`.
If diagnostics cannot be persisted, the supervisor exits rather than operating
invisibly. A machine restart or forced kill requires a later Codex Small Loop
command to start it again.

## Implementation And Proof

- [Task lifecycle](/implementation/components/runtime/source/task-lifecycle.mjs)
- [Task state observer](/implementation/components/runtime/source/task-state-observer.mjs)
- [Exact Turn observation](/implementation/components/runtime/source/task-turn-observation.mjs)
- [Session locator](/implementation/components/runtime/source/codex-session-locator.mjs)
- [JSONL parser](/implementation/components/runtime/source/codex-jsonl.mjs)
- [Heartbeat internal entry point](/implementation/components/runtime/internal/heartbeat.mjs)
- [Heartbeat implementation](/implementation/components/runtime/source/heartbeat.mjs)
- [Abnormal recovery](/implementation/components/runtime/source/abnormal-recovery.mjs)
- [Recovery Supervisor](/implementation/components/runtime/source/recovery-supervisor.mjs)
- [Supervisor diagnostics](/implementation/components/runtime/source/recovery-supervisor-diagnostic.mjs)
- [Lifecycle tests](/implementation/components/runtime/tests/task-lifecycle.test.mjs)
- [Observation tests](/implementation/components/runtime/tests/task-state-observer.test.mjs)
- [Exact Turn observation tests](/implementation/components/runtime/tests/task-turn-observation.test.mjs)
- [Heartbeat tests](/implementation/components/runtime/tests/heartbeat.test.mjs)
- [Recovery tests](/implementation/components/runtime/tests/abnormal-recovery.test.mjs)
- [Supervisor tests](/implementation/components/runtime/tests/recovery-supervisor.test.mjs)

## Task Lifecycle Detailed Contract

Task lifecycle exposes only `stop` and `resume`:

```text
node <plugin-root>/components/commands/task.mjs stop \
  --task <task-id> [--project-root <directory>]

node <plugin-root>/components/commands/task.mjs resume \
  --task <task-id> [--project-root <directory>]
```

There is no public Task acceptance command. `conversation accept` closes a
Conversation without accepting, archiving, or completing its Tasks.

### Selection

Stop and resume derive their dynamic branch from active
`awaiting_reply` Conversations:

- the selected Task is included;
- every downstream Responder reached through an active Conversation is
  included;
- siblings outside that branch are unchanged; and
- launch ancestry does not override the current message flow.

This lets an Interviewer stop or resume a Reviewer that was originally forked
by Primary but currently owes the Interviewer a reply.

### Stop

Stop changes each selected open Task link to `stopped`, commits an interrupt
delivery for each newly stopped Task, and suppresses Recovery for stopped
Responders. A failed interrupt remains retryable without reopening the Task.
Stopping an already stopped branch is an idempotent no-op.

### Resume

Resume reopens stopped links in the selected Conversation branch. Only reopened
Conversation leaves receive a fixed Resume System message. That message names
the exact active Conversation and tells its Responder to run:

```text
conversation reply --conversation <conversation-id>
```

A Task beneath a stopped active Conversation ancestor cannot be resumed
independently. Resume starts or reuses the Recovery Supervisor.

`task resume` is the complete normal recovery entry point for stopped work and
is safe to repeat. If lifecycle state commits but the Recovery Supervisor
cannot start, the command returns `run: "partial"`,
`phase: "supervisor_start"`, the committed state (`resumed` or
`already_active`), and `recommendedAction: "retry_resume"`. Retrying the same
`task resume` command does not repeat committed lifecycle changes and ensures
supervision is started. `runtime repair` is reserved for deterministic local
runtime damage reported by diagnostics; it is not a fallback resume path.

### Internal Archive

Archive cleanup may still mark launch links `accepted` with reason `archive` so
historical runtime records can be compacted. This is an internal terminal
cleanup operation, not Agent-facing work acceptance.

### Durability

Link changes and mechanical deliveries commit atomically. Deliveries are
leased, revalidated against the current Conversation position, sent, and then
acknowledged or released for retry. Concurrent lifecycle commands replan from
the newest ledger revision under the project lock.

### Stable Errors

```text
TASK_NOT_MANAGED
TASK_ANCESTOR_STOPPED
TASK_LIFECYCLE_INVALID
TASK_LIFECYCLE_PARTIAL
```

### Implementation

- [Task command](/implementation/components/commands/task.mjs)
- [Lifecycle implementation](/implementation/components/runtime/source/task-lifecycle.mjs)
- [Conversation state](/implementation/components/runtime/source/conversation.mjs)
- [Lifecycle tests](/implementation/components/runtime/tests/task-lifecycle.test.mjs)
- [Task CLI tests](/implementation/components/runtime/tests/task-cli.test.mjs)


## Task State Observation Detailed Contract

Read-only modules locate Codex session history and convert its
JSONL events into bounded mechanical task evidence. Consumers receive snapshots;
the observer does not change lifecycle or send messages.

### Implementation

- [`components/runtime/source/codex-session-locator.mjs`](/implementation/components/runtime/source/codex-session-locator.mjs)
  - session-root resolution, cached-path validation, active and archived
    history discovery, and batched indexing;
- [`components/runtime/source/codex-jsonl.mjs`](/implementation/components/runtime/source/codex-jsonl.mjs)
  - streaming JSONL parser and task-event reducer;
- [`components/runtime/source/task-state-observer.mjs`](/implementation/components/runtime/source/task-state-observer.mjs)
  - exact-turn, latest-turn, and bounded batch observation;
- [`components/runtime/tests/codex-session-locator.test.mjs`](/implementation/components/runtime/tests/codex-session-locator.test.mjs)
  - active and archived discovery, cache movement, duplicates, missing roots,
    and batch scans;
- [`components/runtime/tests/codex-jsonl.test.mjs`](/implementation/components/runtime/tests/codex-jsonl.test.mjs)
  - chunk boundaries, partial tails, malformed lines, event reduction, and
    conversation-field exclusion;
- [`components/runtime/tests/task-state-observer.test.mjs`](/implementation/components/runtime/tests/task-state-observer.test.mjs)
  - snapshots, degraded evidence, exact-turn readiness, batching, and
    re-observation.

The observer may update a ready link's `historyFile` cache through a caller's
separate Task Ledger transaction. Its own functions remain read-only.

### Session Roots

`resolveCodexSessionRoots(codexHome)` returns:

```json
[
  {
    "location": "active",
    "directory": "/absolute/codex-home/sessions"
  },
  {
    "location": "archived",
    "directory": "/absolute/codex-home/archived_sessions"
  }
]
```

`codexHome` is injected by the caller and defaults through the installed runtime
environment. The locator does not assume the Codex Small Loop project is inside
Codex's storage and does not search arbitrary home-directory paths.

The location of the history file is the archive evidence:

```text
sessions             → active
archived_sessions    → archived
no history found     → missing
```

The JSONL body is not inspected for an independently invented archive flag.

### History Locator API

`codex-session-locator.mjs` exports:

```text
resolveCodexSessionRoots(codexHome) → roots
locateTaskHistories(taskIds, options) → Map<taskId, locationResult>
locateTaskHistory(taskId, options) → locationResult
```

`options` contains the ordered roots and optional cached paths keyed by Task ID.
A location result is:

```json
{
  "taskId": "task-id",
  "location": "active",
  "historyFile": "/absolute/path/to/rollout-task-id.jsonl",
  "diagnostics": []
}
```

The locator:

1. validates cached paths that still exist beneath one configured root and whose
   filename ends with the exact Task ID plus `.jsonl`;
2. discards a missing or invalid cache instead of treating it as archive proof;
3. walks active storage once for all unresolved Task IDs;
4. walks archived storage once for IDs still unresolved;
5. returns active evidence before archived evidence; and
6. returns `missing` with a bounded diagnostic for every unresolved ID.

This batched API prevents one recursive filesystem walk per task during a
project-wide heartbeat. Directory entries are processed in deterministic sorted
order.

If more than one matching file for the same Task ID exists within the selected
location, the result is degraded with `TASK_HISTORY_AMBIGUOUS`. The observer does
not choose a file from two same-priority candidates.

During an App archive move, a task may briefly be visible in both roots. Active
storage wins for that run. Once the active path disappears, cached-path
validation fails and the next lookup discovers the archived path.

### JSONL Event Contract

The parser uses only this verified envelope:

```json
{
  "type": "event_msg",
  "payload": {
    "type": "task_started",
    "turn_id": "turn-id"
  }
}
```

Supported payload types are:

```text
task_started
task_complete
turn_aborted
```

Additional payload fields and every other record type are ignored. In
particular, the parser does not retain message text, `last_agent_message`, tool
arguments, tool output, reasoning, or token usage.

`readCodexSessionMetadata(readable, expectedTaskId)` reads the first matching
`session_meta` record and returns only:

```json
{
  "taskId": "task-id",
  "cwd": "/canonical/project/root",
  "threadSource": "codex-small-loop"
}
```

It requires the stored Task ID to match the requested Task and `cwd` to be
absolute. `threadSource` is either a bounded string copied from
`session_meta.thread_source` or `null` when Codex did not persist one. It does
not return base instructions, Git metadata, tools, model configuration, or
conversation content. Task Launch resolves this `cwd` through Project Runtime
before comparing canonical project identity. Message routing uses
`threadSource` only as a fallback when metadata-only `thread/read` omits the
same field.

The implementation checks the outer record type, payload object, supported
payload type, and non-empty bounded `turn_id`. It does not depend on unrelated
fields remaining stable across Codex versions.

The scanner passes a minimal normalized event to its reducer:

```json
{
  "type": "task_started",
  "turnId": "turn-id"
}
```

`createTaskEventReducer(options)` provides a bounded stateful reducer for direct
streaming use. Its `accept(event)` method consumes normalized events and its
`result()` method returns the same result shape as `reduceTaskEvents`.

### Streaming Parsers

`scanCodexTaskEvents(readable, reducer)` reads bytes incrementally rather than
loading a potentially long session into memory.

It:

1. decodes UTF-8 across chunk boundaries;
2. recognizes LF and CRLF line endings;
3. retains and parses lines up to the shared JSONL line limit;
4. skips every larger line without inspecting its record type or contents;
5. ignores a malformed final fragment only when end-of-file arrives without a
   line ending;
6. rejects a malformed ended line with its line number;
7. bounds the retained fragment and diagnostic length; and
8. closes the stream after success or failure.

Ignoring one incomplete tail is conservative. A terminal event that is still
being appended remains invisible, so an active turn looks `in_progress` until a
later observation. The parser never rewrites or truncates Codex history.

The size rule is uniform: every oversized physical line is skipped. A later
bounded lifecycle event therefore remains observable after large image, tool,
or future record types. If a lifecycle event itself exceeds the limit, the
observer continues to the preceding event and remains conservative rather than
treating that large record as termination evidence.

`scanCodexTaskEventsFromEnd(historyFile, reducer)` is the normal Task-state
observation path. It treats Codex history as an append-only log, reads one line
at a time from EOF toward BOF, and emits bounded supported events newest-first.
It stops as soon as every requested latest or exact Turn is resolved. If the
required event is old or absent, the same scan continues safely to BOF.

The reverse scan has no persisted cursor, cache revision, or sidecar index.
Every observation is therefore independent, while recent Turns normally cost
only the small suffix containing their newest lifecycle event. Its private
buffer size affects throughput only and is not an option or behavior contract.
Diagnostics use byte offsets because finding a source line number would require
scanning the discarded prefix of the file.

### Event Reducer

`reduceTaskEvents(events, options)` supports two modes:

```text
latest
  → reduce the latest task_started turn

exact
  → reduce only options.turnId
```

Turn states are:

```text
not_started
in_progress
ended
aborted
unknown
```

For latest mode:

- no `task_started` event produces `not_started`;
- each later `task_started` establishes the new latest Turn ID and
  `in_progress`;
- a matching later `task_complete` produces `ended`;
- a matching later `turn_aborted` produces `aborted`; and
- terminal events for older turns do not change the latest turn.

For exact mode, the reducer tracks the supplied Turn ID even if a newer turn
exists. This lets launch check its stored assignment turn rather than whichever
turn happens to be newest later.

Contradictory terminal events for the selected turn, a terminal event followed
by a repeated start for the same Turn ID, or another unsupported ordering
produces `unknown` with a diagnostic. It never chooses the more convenient
terminal result.

`ended` means one Codex turn ended normally. It is not the Task Ledger's
`accepted` lifecycle and does not prove that a delegated outcome succeeded.

The forward reducer remains the strict sequence-validation primitive for direct
streaming callers. Task-state observation instead selects the newest supported
event for each requested Turn while scanning backward. In an append-only Codex
history, that event is the current persisted state and lets observation finish
without replaying older lifecycle events.

### Observation API

`task-state-observer.mjs` exports:

```text
observeLatestTask(taskId, options) → snapshot
observeExactTurn(taskId, turnId, options) → snapshot
observeTasks(requests, options) → snapshot[]
sameTurnBoundary(left, right) → boolean
```

Latest-turn snapshot:

```json
{
  "taskId": "task-id",
  "location": "active",
  "historyFile": "/absolute/path/to/task.jsonl",
  "latestTurnId": "turn-id",
  "turnState": "ended",
  "diagnostics": []
}
```

Exact-turn snapshot:

```json
{
  "taskId": "task-id",
  "location": "active",
  "historyFile": "/absolute/path/to/task.jsonl",
  "turnId": "assignment-turn-id",
  "turnState": "ended",
  "diagnostics": []
}
```

The base identity, location, turn-state, and diagnostic fields remain present.
Missing history returns:

```json
{
  "taskId": "task-id",
  "location": "missing",
  "historyFile": null,
  "latestTurnId": null,
  "turnState": "unknown",
  "diagnostics": [
    {
      "code": "TASK_HISTORY_MISSING",
      "message": "bounded diagnostic"
    }
  ]
}
```

An existing history with no started turn returns `not_started`. An exact Turn ID
absent from an otherwise readable history returns `unknown` with
`TASK_TURN_NOT_FOUND`.

`observeTasks` indexes histories once, scans each independent file suffix once
with a bounded concurrency limit, and returns results in the same order as its
requests. Multiple latest and exact requests for one Task share that reverse
scan. One unreadable task becomes a degraded snapshot without suppressing
healthy siblings. Failure to resolve the configured roots is a batch-level
error.

### Consumers

Consumers use snapshots narrowly:

- Task Launch reads the bounded session identity for same-project preflight;
- Heartbeat calls `observeTasks` for every relevant Root and Child Task,
  including an exact assignment Turn when launch promotion was interrupted;
- Abnormal Recovery combines latest-turn snapshots with open leaf relationships;
  and
- Task Lifecycle uses archive evidence to plan defensive completion.

The observer does not derive waiting parents or recovery candidates itself.
Those decisions require Task Ledger lifecycle and Task Forest structure and
belong to their consuming modules.

An archived location takes precedence over its latest turn state for archive
termination. A missing or `unknown` snapshot is degraded evidence, never proof
that a task is idle, ended, or safe to recover.

### Cache Update

After a successful lookup, a caller may store the returned `historyFile` on the
ready Child Task link. Cache updates:

- occur in a short ledger transaction after observation;
- match the Child Task ID and current link;
- do not change lifecycle or revision-independent business meaning;
- are skipped when the value is unchanged; and
- never store Root Task paths because roots have no link record.

Root histories are rediscovered through the batched index. Cache failure does
not invalidate an otherwise valid snapshot.

### Race Boundary

A snapshot describes one accepted file scan. Codex may start another turn or
the parent may change lifecycle immediately afterward.

Recovery does not hold the ledger lock while reading JSONL. It:

1. derives a candidate from a ledger snapshot and first task observation;
2. observes the task and direct Parent again outside the ledger transaction;
3. requires `sameTurnBoundary` to match Task ID, active location, latest Turn
   ID, and terminal turn state;
4. opens a short ledger transaction, rebuilds the forest, proves that the
   relationship is still `open` and on the unfinished leaf frontier, confirms
   that no pending report or resume explains the terminal state, and enqueues a
   deduplicated delivery for that exact Turn ID; and
5. re-observes a leased delivery before its external send, discarding the
   unsent action if the execution boundary changed.

If any fact changes, the candidate is discarded. A new turn can still begin
between the final observation and the external App send because JSONL and App
messaging share no transaction. The fixed recovery message must therefore be
safe when received redundantly; the implementation does not claim to eliminate
that final race.

The observer provides snapshots and the comparison helper. Abnormal Recovery
owns candidate selection and delivery.

Launch uses the same principle with an exact stored assignment Turn ID before
promoting a pending launch.

### Boundary

Task State Observation does not:

- parse agent prose or completion reports;
- return conversation or tool content;
- judge outcome success or parent acceptance;
- mutate lifecycle;
- create, interrupt, resume, archive, or message a task;
- infer recovery from JSON-RPC list metadata;
- register Root Tasks or subagents; or
- treat missing evidence as a stopped task.

App-server JSON-RPC remains the control path for creating tasks and starting
turns. Session JSONL is the evidence path for observing their actual execution
and for reading the latest persisted execution settings without acquiring a
Task writer.

### Stable Errors

Stable diagnostic and error codes are:

```text
CODEX_SESSION_ROOT_INVALID
CODEX_SESSION_ROOT_UNREADABLE
TASK_HISTORY_MISSING
TASK_HISTORY_AMBIGUOUS
TASK_HISTORY_UNREADABLE
TASK_JSONL_MALFORMED
TASK_EVENT_INVALID
TASK_EVENT_CONTRADICTORY
TASK_TURN_NOT_FOUND
```

Per-task location, read, parse, and event errors normally become bounded
degraded snapshots. Invalid root configuration or a failed batch index that
prevents all trustworthy observation throws a bounded operation error.

### Required Tests

`components/runtime/tests/codex-session-locator.test.mjs` must prove:

- canonical active and archived root resolution;
- cached active and archived path validation;
- rediscovery after an archive move;
- active precedence during a cross-root overlap;
- same-location ambiguity rejection;
- missing roots and missing task history;
- filenames that merely contain, but do not end with, the exact Task ID;
- one deterministic directory walk for a batch of Task IDs; and
- cached paths outside configured roots are rejected.

`components/runtime/tests/codex-jsonl.test.mjs` must prove:

- LF, CRLF, UTF-8, and arbitrary chunk boundaries;
- blank and unrelated records are ignored;
- oversized lines are skipped uniformly while later events and persisted Task
  settings remain observable;
- reverse scanning stops after a recent lifecycle event without reading old
  history and crosses oversized records without inspecting their type;
- only one incomplete final fragment is ignored;
- malformed ended lines fail boundedly and oversized fragments are skipped;
- the three supported event envelopes and invalid Turn IDs;
- latest and exact mode across multiple turns;
- older terminal events do not finish the latest turn;
- contradictory selected-turn sequences become `unknown`;
- very large histories are processed incrementally; and
- conversation, tool, and `last_agent_message` fields never enter reducer
  output.

`components/runtime/tests/task-state-observer.test.mjs` must prove:

- active, archived, missing, not-started, in-progress, ended, aborted, and
  unknown snapshots;
- terminal Task state remains observable after oversized unrelated output;
- normal observation reads from EOF and shares one suffix scan across requests;
- exact assignment-turn observation after a newer turn exists;
- batch output order and bounded concurrency;
- one degraded task does not hide healthy sibling snapshots;
- successful cache replacement after a moved history;
- `sameTurnBoundary` rejects location, Turn ID, and state changes; and
- all output and diagnostics remain bounded.

Fixtures reproduce the verified event envelope. Tests do not inspect the user's
real Codex conversations.

### Related Contracts

- [Project Runtime](/specification/technical-specification/runtime/project-runtime.md)
- [Task Launch](/specification/technical-specification/runtime/task-coordination.md)
- [Task Ledger](/specification/technical-specification/runtime/project-runtime.md)
- [Task Forest](/specification/technical-specification/runtime/task-coordination.md)
- [Task Lifecycle](/specification/technical-specification/runtime/lifecycle-and-recovery.md)
- [Heartbeat](/specification/technical-specification/runtime/lifecycle-and-recovery.md)
- [Abnormal Recovery](/specification/technical-specification/runtime/lifecycle-and-recovery.md)


## Heartbeat Pipeline Detailed Contract

`heartbeat.mjs` runs one bounded mechanical continuity pass. Recovery Supervisor
repeats this command locally while actionable work remains. It is not a Codex
Automation entry point.

### Pipeline

1. Resolve or initialize the project runtime.
2. Reconcile existing App-owned message schedules and materialize newly queued
   messages without blocking other branches.
3. Observe managed Tasks, active Conversations, Parents of queued forks, and
   exact accepted assignment turns from Codex JSONL.
4. Keep a queued fork waiting while its Parent is active; after normal Parent
   completion, perform the fork, start its stored assignment, and promote the
   relationship.
5. Reconcile pending Child launch phases from the same observation.
6. Re-observe active Conversations after launch reconciliation.
7. Close internal launch records anchored by archived Tasks.
8. Lease and deliver pending interrupt and resume actions.
9. Re-observe after lifecycle changes.
10. Derive every leaf Responder in the active `awaiting_reply` Conversation
    forest.
11. Exclude running, unavailable, stopped, and reply-in-flight Responders.
12. Queue and deliver one deduplicated Recovery message per eligible
    Conversation boundary.
13. Remove accepted Conversations and terminal queue records that no longer
    protect pending work.
14. Return a bounded result.

The pass evaluates parallel branches independently. One failed observation or
delivery produces a partial result without suppressing healthy siblings.

### App Message Schedules

For each ready App-schedule message, Heartbeat creates one deterministic
schedule under the Codex automation directory. The schedule:

- targets the exact App task;
- uses `RRULE:FREQ=MINUTELY;INTERVAL=1`;
- stores `created_at` and `updated_at` one minute in the past so the next minute
  is selected immediately;
- preserves the queued message and appends the exact Codex Small Loop
  `schedule read` then etag-guarded `schedule delete` calls; and
- remains `scheduled` in the ledger while its TOML file exists.

When a later pass finds the schedule missing, it records the message as
delivered. Creation or inspection failures return the message to `ready` for
retry and make the Heartbeat result `partial` and `degraded` with bounded
`app_message_failed` events.

### Recovery Timing

The polling interval controls detection latency only. Recovery never depends on
task age, elapsed time, or a quiet period. `in_progress` remains healthy for any
duration.

### Active-State Bound

Observation requests contain only managed Tasks participating in active
Conversations, Parents with a queued fork, and exact assignment turns from
interrupted promotion. Accepted Conversations are compacted after their
messages and lifecycle actions settle. Runtime work therefore follows current
concurrency rather than lifetime task count.

### Output

The command returns counts and bounded event identifiers only. It never prints
conversation text, raw JSONL, or the full ledger.

### Implementation

- [Heartbeat internal entry point](/implementation/components/runtime/internal/heartbeat.mjs)
- [Heartbeat implementation](/implementation/components/runtime/source/heartbeat.mjs)
- [Schedule implementation](/implementation/components/runtime/source/schedule.mjs)
- [Recovery Supervisor](/specification/technical-specification/runtime/lifecycle-and-recovery.md)
- [Abnormal Recovery](/specification/technical-specification/runtime/lifecycle-and-recovery.md)


## Abnormal Recovery Detailed Contract

Recovery follows active reply obligations, not launch ancestry. It may send a
new reminder after every terminal turn until the Responder records a reply.
There is no total retry limit.

### Candidate

A Conversation is eligible when:

1. its state is `awaiting_reply`;
2. its Responder is a leaf of the active Conversation forest;
3. the Responder Task is not stopped or archived;
4. its latest observable turn is terminal (`ended` or `aborted`);
5. no queued App message from that Responder to the Conversation Initiator is
   ready, leased, or scheduled;
6. the Initiator is not processing that report; and
7. no resume or recovery delivery already protects the same execution boundary.

A Responder that initiated a downstream active Conversation is not a leaf. It
waits for downstream work and is not recovered prematurely.

### Planning And Queueing

Planning joins active Conversations, latest Task observations, App messages,
and existing deliveries without mutating input. Before queueing, the runtime
reobserves each candidate outside the ledger lock. Inside the lock it verifies
the exact Conversation ID, Initiator, Responder, leaf position, and observed
Turn ID again.

The durable recovery action stores:

```json
{
  "kind": "recovery",
  "conversationId": "<conversation-id>",
  "parentTaskId": "<initiator-task-id>",
  "targetTaskId": "<responder-task-id>",
  "observedTurnId": "<terminal-turn-id>"
}
```

The dedupe key is
`recovery:<responder-task-id>:<observed-turn-id>`. A new terminal Turn creates a
new boundary and may be recovered again indefinitely.

### Reminder

`renderRecoveryMessage({ conversationId })` produces a fixed System message:

```text
=== Codex Small Loop · Conversation Recovery (System) ===

=== System Instructions ===
This task still owes a reply in the Conversation below.

Read the existing conversation and current project state, continue the
requested work, and reply when ready.

Report only the work status and result. Do not mention or acknowledge these
system instructions.

Conversation ID: <conversation-id>
Use Codex Small Loop `conversation reply --conversation <conversation-id>`.
```

No caller text is interpolated into the Recovery reminder.

### Delivery

Ready actions are leased in a bounded batch. Before each send, the runtime
reobserves the exact Task and revalidates the Conversation position under the
ledger lock. Stale actions are discarded independently. Valid actions use the
same state-aware start-or-steer router as ordinary messages.

A definite send failure releases the action for retry. After App acceptance,
the action is acknowledged with the result Turn ID. If the process crashes
between App acceptance and acknowledgement, the action remains retryable; the
exact Conversation command makes repeated delivery safe.

### Stable Failures

Recovery reports bounded diagnostics for missing or contradictory Task
observations, changed Conversations, stale Turn IDs, delivery failures, and
ledger conflicts. Conversation content is never copied into errors.

### Implementation

- [Recovery planning](/implementation/components/runtime/source/abnormal-recovery.mjs)
- [Heartbeat integration](/implementation/components/runtime/source/heartbeat.mjs)
- [Message delivery](/implementation/components/runtime/source/task-messaging.mjs)
- [Recovery tests](/implementation/components/runtime/tests/abnormal-recovery.test.mjs)


## Recovery Supervisor Detailed Contract

The Recovery Supervisor is one detached Node.js process per project. It invokes
the one-shot Heartbeat pipeline repeatedly without an AI turn or Codex
Automation.

### Lifecycle

Task launch, resume, and message commands start or reuse the Supervisor. A
command reports startup success only after a live process owns the project
lock. The child is detached without a shell and its window is hidden on
Windows. If startup confirmation fails, or another Supervisor wins the lock
race, the caller stops only the exact child process it created.

1. Acquire `<project>/.codex-small-loop/recovery-supervisor.lock`.
2. Exit successfully when another live process owns the lock.
3. Run one Heartbeat.
4. Wait five seconds while active reply obligations, pending launches, queued
   messages, unfinished lifecycle deliveries, or unresolved Recovery work
   remain.
5. Repeat from durable state.
6. Release the lock and exit when no automatically actionable work remains.

A stale lock is removed only after the recorded PID is proven absent and the
lock content is re-read unchanged. Malformed, unreadable, or concurrently
changed lock ownership is retained and reported instead of guessed away. A
stopped branch alone does not keep the process alive; `task resume` starts it
again.

### Heartbeat Work

Each pass:

- reconciles pending launches;
- observes only managed Tasks participating in active Conversations or pending
  launch reconciliation;
- applies archive termination and stop/resume deliveries;
- materializes and reconciles temporary App-owned message schedules;
- derives every leaf Responder across the active Conversation forest;
- sends deduplicated Recovery messages to eligible terminal Responders; and
- removes terminal runtime records whose dependent work has settled.

Message and Recovery failures remain durable and retryable. An App message
keeps the Supervisor alive while its schedule exists, so schedule deletion can
be reconciled into a delivered ledger state. One branch failure does not hide
independent siblings.

### Scaling

Accepted Conversations are removed from active state after their dependent
deliveries settle. Heartbeat observation and Conversation-forest construction
therefore scale with current obligations, not with the project's lifetime Task
count.

### Failure Boundary

Transient Heartbeat failures retry with bounded exponential backoff, and
per-task failures retry on later passes. Each thrown failure and each
`run: "partial"` pass atomically writes a bounded diagnostic to
`<project>/.codex-small-loop/recovery-supervisor-error.json`; the next successful
`run: "ok"` pass clears it. A partial diagnostic retains only bounded event
types, reasons, relevant Task, launch, or message IDs, omitted counts, and its
consecutive non-ok count. It does not change the normal Heartbeat interval;
only thrown failures increase retry backoff. Runtime status surfaces the
diagnostic as `repair_required`, including its cause code and consecutive
failure count, plus its timestamp and any retained events. An invalid
diagnostic is retained and reported.

If the diagnostic itself cannot be persisted, the Supervisor exits instead of
continuing invisibly. A later Codex Small Loop command restarts a Supervisor that
is no longer running. Temporary App-message schedules do not restart the
Supervisor itself; without an OS service, machine restart or `SIGKILL` requires
another Codex Small Loop command to invoke it.

### Implementation

- [Recovery Supervisor internal entry point](/implementation/components/runtime/internal/recovery-supervisor.mjs)
- [Recovery Supervisor implementation](/implementation/components/runtime/source/recovery-supervisor.mjs)
- [Supervisor diagnostic implementation](/implementation/components/runtime/source/recovery-supervisor-diagnostic.mjs)
- [Heartbeat](/specification/technical-specification/runtime/lifecycle-and-recovery.md)
- [Abnormal Recovery](/specification/technical-specification/runtime/lifecycle-and-recovery.md)
