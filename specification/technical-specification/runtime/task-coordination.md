---
summary: >-
  Define managed Task identity, launch and fork, execution-profile inheritance,
  topology queries, role loading, and durable assignment startup.
---

# Task Coordination

Create or fork one managed Child Task, reload its role in a program-owned turn,
start its Parent assignment as the first Conversation in the next turn, and
record launch ancestry separately from communication state.

## Implementation Surface

- [`task.mjs`](/implementation/components/commands/task.mjs)
  provides the public `create`, `fork`, exact-Turn `read`, and exact-Turn `wait`
  commands. `launch` is a deprecated compatibility alias for `create` and is
  not emitted by installed guidance.
- [`task-turn-observation.mjs`](/implementation/components/runtime/source/task-turn-observation.mjs)
  implements bounded exact-Turn snapshots and waiting without App task tools.
- [`task-launch.mjs`](/implementation/components/runtime/source/task-launch.mjs)
  coordinates preflight, durable pending state, Codex calls, and promotion.
- [`task-messaging.mjs`](/implementation/components/runtime/source/task-messaging.mjs)
  combines launch routing with the caller's exact assignment.
- [`codex-app-server.mjs`](/implementation/components/runtime/source/codex-app-server.mjs)
  normalizes Codex task creation, fork, and turn-start operations.
- [`codex-runtime-resolver.mjs`](/implementation/components/runtime/source/codex-runtime-resolver.mjs)
  selects the platform adapter and returns one normalized, attested Codex
  runtime. The macOS adapter verifies the signed Desktop executable; the
  Windows adapter verifies the standalone OpenAI executable.
- [`codex-app-server-host.mjs`](/implementation/components/runtime/source/codex-app-server-host.mjs)
  starts the private shared app-server host from that executable and lets
  detached Codex Small Loop processes either reuse the recorded verified host or
  cold-start one through the same platform resolver.
- [`codex-app-server-host-platform.mjs`](/implementation/components/runtime/source/codex-app-server-host-platform.mjs)
  selects the current host adapter. The Darwin adapter retains the Unix-socket
  host; the Win32 adapter owns the authenticated dynamic loopback host,
  protected capability token, and Windows process inspection.
- [`codex-app-server-websocket.mjs`](/implementation/components/runtime/source/codex-app-server-websocket.mjs)
  validates typed endpoints and performs one bounded WebSocket upgrade for
  both platforms.
- [`heartbeat.mjs`](/implementation/components/runtime/source/heartbeat.mjs)
  continues deferred forks and reconciles interrupted promotion.

## CLI Contract

Both commands require:

- `--name <agent-name>`;
- `--parent <parent-task-id>`;
- `--role <job-role>`;
- an optional `--project-root <directory>`; and
- an optional complete `--model <model-id>` and
  `--reasoning-effort <effort>` pair; and
- an optional independent `--service-tier <tier|default>` (`default` maps to
  the normal Codex tier represented internally by `null`); and
- one non-empty assignment on standard input.

`fork` additionally accepts an optional `--source <task-id>`. `--parent`
always identifies the managing Parent and launch ancestry. `--source`
identifies the Task whose completed conversation context and execution profile
the Child inherits. When omitted, the fork source defaults to the Parent.
`create` rejects `--source`.

```text
node <plugin-root>/components/commands/task.mjs create \
  --name <agent-name> \
  --parent <parent-task-id> \
  --role <job-role> [--project-root <directory>] \
  [--model <model-id> --reasoning-effort <effort>] \
  [--service-tier <tier|default>]
```

```text
node <plugin-root>/components/commands/task.mjs fork \
  --name <agent-name> \
  --parent <parent-task-id> \
  [--source <fork-source-task-id>] \
  --role <job-role> [--project-root <directory>] \
  [--model <model-id> --reasoning-effort <effort>] \
  [--service-tier <tier|default>]
```

The caller writes the human-readable assignment body and provides it through a
pipe or here-document in the same invocation. This non-interactive standard
input must close automatically; an interactive TTY is rejected before task
creation. Codex Small Loop protocol markers are program-owned and rejected in
assignment bodies. The command also rejects an empty assignment or UTF-8
content above 64 KiB before task creation.

After create or fork state commits, a Recovery Supervisor startup failure
returns `run: "partial"`, `phase: "supervisor_start"`, and exit status `2`.
The caller must not repeat create or fork. A result with a Child Task ID directs
the caller to resume that Child; a deferred fork without one directs the caller
to inspect runtime status. Failures before accepted or durable task state return
`run: "failed"` and exit status `1`.

Names are explicit and unique among one Parent's direct Children. Codex Small
Loop does not infer the caller's Task ID or invent an agent name.

Exact-Turn observation has a separate non-mutating CLI contract:

```text
node <plugin-root>/components/commands/task.mjs read \
  --task <task-id> --turn <turn-id>

node <plugin-root>/components/commands/task.mjs wait \
  --task <task-id> --turn <turn-id> [--timeout-ms <0-300000>]
```

`read` performs one immediate snapshot. `wait` defaults to `120000`
milliseconds and observes until the exact Turn ends, aborts, or reaches its
deadline. Deadline expiry returns exit status `0`, `run: "ok"`,
`turnState: "in_progress"`, and `timedOut: true`. The command reads no
assignment from standard input, starts no project runtime, and performs no
Task lifecycle transition.

For `create`, Codex Small Loop reads the direct Parent's effective model,
reasoning effort, and service tier before creation. For `fork`, it reads the
fork source's effective profile. Omitted fields inherit those applicable source
values.
The read path uses `thread/read` only to obtain the matching persisted session
path, then streams the latest complete `turn_context` and the latest applied
service tier from `thread_settings_applied` in session JSONL. Codex may omit the
applied tier from `turn_context`, so that record alone is not authoritative for
service tier. This read does not call `thread/resume` or acquire a second writer
for an App-owned source Task. Missing, malformed, cwd-mismatched, or
unrepresentable authority evidence fails closed before Child creation.
Model and reasoning effort form one pair: both must be omitted or both must be
provided. Service tier is independent and may be overridden on its own. Codex
Small Loop passes the fully resolved three-field profile explicitly to Codex task
creation or fork and to both Child turns. The Codex response must confirm the
expected profile before the Child ID is accepted.

## Shared Preflight

Before Codex may create a Child, launch and fork:

1. resolve the canonical project;
2. ensure the project runtime and ledger are available;
3. find the Parent in Codex session storage;
4. prove that the Parent is active and not archived;
5. require a managed Parent to belong to the same canonical project; an
   unmanaged Root Controller may bootstrap a canonical project strictly below
   its own cwd, but not a sibling or ancestor project; and
6. reject a managed Parent whose incoming relationship is stopped or accepted;
   and
7. for an explicit fork source, independently prove that it exists, is active,
   is not archived, and belongs to the same canonical project.

The nested-project exception applies only to the external Controller boundary.
The created Primary uses the nested canonical root, and every managed
descendant must then match that root exactly. This supports a focused project
such as `repository/mokup/abyss-cycle-v1` without allowing an existing managed
Task to drift between projects.

An unregistered Parent is valid and becomes a derived `controller` Root Task
after its first Child relationship is promoted. Managed descendants retain
their recorded role; the Controller default applies only when no managed or
incoming role exists.

## Pending Launch Record

The assignment is persisted before any task or fork request. This is required
for deferred fork: the Parent turn must end before the fork can inherit it.

```json
{
  "assignment": "Inspect the project.",
  "id": "launch-id",
  "model": null,
  "name": "Curie",
  "parentTaskId": "parent-task-id",
  "sourceTaskId": "source-task-id",
  "reasoningEffort": null,
  "serviceTier": null,
  "role": "execute",
  "childTaskId": null,
  "phase": "prepared",
  "roleTurnId": null,
  "assignmentTurnId": null,
  "createdAt": "2026-07-25T00:00:00.000Z",
  "updatedAt": "2026-07-25T00:00:00.000Z",
  "lastError": null
}
```

`sourceTaskId` is present only for a sourced fork. Legacy and ordinary launch
records omit it. Once promoted, the fork relationship retains both
`parentTaskId` for management ancestry and `sourceTaskId` for context
provenance.

Ordinary launch phases:

```text
prepared
  → creating
  → child_created
  → role_started
  → assignment_starting
  → assignment_started
  → open link
```

Deferred fork phases:

```text
fork_queued
  → fork_creating
  → fork_child_created
  → fork_role_started
  → fork_assignment_starting
  → fork_assignment_started
  → open link
```

`ready` is a result, not a stored pending phase. Promotion removes the pending
record and atomically inserts the managed task and open link.

## Ordinary Launch

`launch` performs this sequence:

1. persist the assignment in `prepared`;
2. resolve the Parent execution profile while the launch remains safely
   retryable in `prepared`;
3. persist `creating`, then create the Child without inherited conversation
   history using the resolved model, reasoning effort, and service tier;
4. persist its Task ID as `child_created`;
5. set its Codex Task name to the explicit Agent name;
6. start a program-owned Role System turn;
7. persist its turn ID as `role_started` and wait for `completed`;
8. claim the assignment start as `assignment_starting`;
9. start a separate Parent turn containing the exact stored assignment;
10. persist its turn ID as `assignment_started`;
11. promote the pending record and its first `awaiting_reply` Conversation
    atomically; and
12. return the ready Child ID and a required `end_turn`.

The command waits for the Role System turn, but not for the assignment turn. A
durable assignment turn ID proves that Codex accepted the work; waiting for
task completion would make launch latency equal to the delegated job's runtime.

## Deferred Fork

Fork must inherit the source Task's whole completed turn, while the managing
Parent must also finish the turn that queued the work. Calling `thread/fork`
while either relevant turn is active could capture incomplete context or race
the management assignment, so the public `fork` command only persists
`fork_queued` and returns:

```json
{
  "run": "ok",
  "operation": "fork",
  "phase": "fork_queued",
  "nextAction": {
    "type": "end_turn",
    "required": true,
    "reason": "The fork starts after this Parent turn ends."
  }
}
```

The project runtime observes the Parent and fork source. After both relevant
turns have ended, it:

1. reads the fork source's effective execution profile while the launch remains
   safely retryable in `fork_queued`, then merges the stored override;
2. persists `fork_creating`, then forks with the resolved model, reasoning
   effort, and service tier explicitly;
3. persists the Child Task ID;
4. sets the Child's Codex Task name to its explicit Agent name;
5. starts and persists a Fork Notification turn, then waits for it to complete;
6. claims the assignment start so concurrent reconciliation cannot duplicate it;
7. starts the stored assignment as a Conversation in a separate Parent turn;
8. persists the assignment turn ID; and
9. promotes the launch link and first Conversation atomically.

There is no `Fork System` ready callback. The assignment entered with `fork` is
the Parent turn started after the Fork Notification turn completes.

## Child Launch Turns

For an ordinary launch, `renderLaunchRoleInstructions(...)` produces the first
turn. It contains only program-owned role reload instructions and does not
claim that the task inherited conversation history:

```text
=== Codex Small Loop · Role System (System) ===

=== System Instructions ===
This is a new managed task with a Codex Small Loop identity and role.

Parent Task ID: <parent-task-id>
Current Task ID: <child-task-id>
Current role: <job-role>

Before doing any assigned work:
1. Run `node <plugin-root>/components/commands/role.mjs <job-role>`.
2. Read the command's complete output and apply it as the current role.
3. End this turn after confirming that the current role is active.

Do not execute the Parent assignment in this turn.
Do not act as the Parent or Root task.
```

For a fork, `renderForkNotification(...)` produces the first turn:

```text
=== Codex Small Loop · Fork Notification (System) ===

=== IMPORTANT ===

Hello. This is a new task forked from a previous task.

This new thread has inherited the previous task's conversation context.
Reload the current role, then proceed with the assignment from the Parent task.

Previous role: <fork-source-role>
Current role: <child-role>
Parent Task ID: <parent-task-id>
Fork Source Task ID: <fork-source-task-id>
Current Task ID: <child-task-id>

=== System Instructions ===

First Step:
1. Run `node <plugin-root>/components/commands/role.mjs <child-role>`.
2. Read the command's complete output and apply it as the current role.
3. End this turn after confirming that the current role is active.

Do not execute the Parent assignment in this turn.
Do not act as the Parent or the fork source.
```

After that turn reports `completed`, `renderLaunchAssignment(...)` produces the
second turn:

```text
=== Codex Small Loop · <parent-role> → <child-role> ===

=== Conversation ===
Initiator Task ID: <parent-task-id>
Responder Task ID: <child-task-id>
Conversation ID: <conversation-id>

=== Message ===
<exact caller assignment>

=== Next Actions ===
1. Reply to this Conversation after completing the requested work.
   Conversation ID: <conversation-id>
   Use Codex Small Loop `conversation reply --conversation <conversation-id>`.

After completing the protocol actions above, resume the currently loaded Role
and perform its next applicable Action for the resulting state.
```

Codex Small Loop sets the Child's Codex Task name to `<agent-name>` for runtime
uniqueness and Codex Task navigation, but it does not read or render Parent or
Child Task names in the assignment envelope. The managed-task registry and Task
Forest supply the two Job Roles; represented Root Tasks use `Controller`. Routing,
identity, and protocol markers remain runtime-owned. The caller supplies only
the substantive assignment body, which appears unchanged under the separate
Parent `Message` envelope. The runtime never places the assignment in the Role
System or Fork Notification turn.

Creation, fork, Role setup, assignment, direct message, and recovered turns all
use one validated Task Run Context. It contains the confirmed model, reasoning
effort, service tier, approval policy, and exactly one authority source: either
an active named permission profile or a sandbox policy. Child creation and fork
inherit the applicable Parent or source authority. Explicit model, reasoning,
or service-tier overrides cannot change that authority. Missing, invalid, or
unrepresentable authority fails closed; the runtime never substitutes
`danger-full-access` as a fallback.

## Crash Boundaries And Recovery

External Codex calls and ledger commits cannot be one atomic transaction.
Pending phases preserve the last proven boundary.

- `prepared` and `fork_queued` remain retryable until execution-profile
  resolution succeeds; no Child creation call has started in either phase.
- `creating` means task creation may have happened without a persisted Task ID.
- `child_created` means the role setup turn may have started without a
  persisted turn ID.
- `role_started` means the Role System or Fork Notification turn is durable.
  Heartbeat waits while
  it is active and can continue the Parent assignment after a restart once the
  exact role setup turn has ended.
- `assignment_starting` means one process claimed the external assignment
  start. A crash in this phase is ambiguous and requires repair rather than a
  duplicate send.
- `assignment_started` means the exact Child and turn IDs are durable but
  promotion did not finish.

The first two states require repair rather than blind duplication. For the
third, Heartbeat confirms the exact task/turn boundary and promotes it whether
the accepted turn is running, ended, or aborted. Once the relationship
exists, ordinary recovery owns any interrupted work.

Ledger version 10 stores the assignment, execution-profile override,
`roleTurnId`, and `assignmentTurnId`, then uses the Launch ID as the first
Conversation ID during atomic promotion. Earlier prototype ledgers are not
migrated. They fail closed with `LEDGER_VERSION_UNSUPPORTED`; reinitialize the
private runtime before using this model.

## Result And Errors

Successful ordinary launch returns a ready Child and requires the Parent turn
to end:

```json
{
  "run": "ok",
  "operation": "create",
  "launchId": "launch-id",
  "parentTaskId": "parent-task-id",
  "childTaskId": "child-task-id",
  "role": "primary",
  "phase": "ready",
  "nextAction": {
    "type": "end_turn",
    "required": true
  }
}
```

Failures before an external Child may exist return `run: "failed"` and exit
status `1`. Ambiguous failures after creation begins return `run: "partial"`
and exit status `2`, including only bounded launch evidence. When a wrapped
failure has a stable internal code, the result exposes it as `causeCode`; raw
causes, stacks, and unrelated fields are never emitted.

Stable error families include invalid Parent/source/name/role/assignment input,
project or runtime mismatch, Child creation failure, Codex Task naming failure,
assignment-start failure, and repair-required persistence windows. Explicit
source failures do not fall back to the Parent; they report the source Task ID
with `FORK_SOURCE_TASK_NOT_FOUND`, `FORK_SOURCE_TASK_ARCHIVED`, or
`FORK_SOURCE_PROJECT_ROOT_MISMATCH`.

## Required Verification

Unit and contract tests must prove:

- invalid input and preflight failures happen before Codex task creation;
- explicit fork source validation fails closed without falling back to Parent;
- assignment text is required, bounded, and persisted before external work;
- absent execution settings inherit the direct Parent for create and the fork
  source for fork, while valid overrides are persisted and honored;
- incomplete overrides and mismatched Codex response profiles fail closed;
- creation, fork, Role, Assignment, message, and Recovery turns pass the
  resolved three-field execution profile explicitly;
- Child Task ID persistence precedes role setup turn start;
- the persisted Child receives its explicit Agent name before assignment start;
- the first Child turn contains only role reload instructions;
- assignment starts in a separate Parent turn after role setup completion;
- create returns after a durable turn ID without waiting for task completion;
- deferred fork starts the stored assignment without a ready callback;
- pending-to-link promotion is atomic and safe under parallel siblings;
- exact task/turn recovery promotes an accepted assignment after a crash;
- ambiguous creation windows never duplicate work blindly;
- version-4 migration does not silently revive the removed split route;
- version-5 and version-8 migrations preserve execution-profile inheritance;
  and
- output and diagnostics remain bounded.

Mock tests cover protocol behavior. A final manual E2E uses a Codex App project
to prove that a real Child begins the assignment in its first visible turn.

## Related Contracts

- [Recovery Supervisor](/specification/technical-specification/runtime/lifecycle-and-recovery.md)
- [Project Runtime](/specification/technical-specification/runtime/project-runtime.md)
- [Task State Observation](/specification/technical-specification/runtime/lifecycle-and-recovery.md)
- [Heartbeat](/specification/technical-specification/runtime/lifecycle-and-recovery.md)
- [Working With Codex Tasks](/specification/system-specification/skills/working-with-codex-tasks.md)

## Managed Topology

Launch ancestry is retained as a forest of managed Task links for identity and
lifecycle selection. The forest validates one parent per Child, rejects missing
endpoints and cycles, derives roots deterministically, and supports parent,
children, subtree, and leaf queries. It is not the Conversation graph and does
not constrain later Initiator-to-Responder messaging.

[`task-forest.mjs`](/implementation/components/runtime/source/task-forest.mjs)
implements these pure queries, with required cases in
[`task-forest.test.mjs`](/implementation/components/runtime/tests/task-forest.test.mjs).

## Managed Topology Detailed Contract

The task-forest module provides structural operations on ready parent-child links. It
performs no I/O or state mutation and returns deterministic graph queries from a
validated ledger snapshot.

### Implementation

- [components/runtime/source/task-forest.mjs](/implementation/components/runtime/source/task-forest.mjs)
  - graph validation, indexes, roots, subtrees, and leaves;
- [components/runtime/tests/task-forest.test.mjs](/implementation/components/runtime/tests/task-forest.test.mjs)
  - multiple roots, recursive and parallel branches, invalid graphs, filtering,
    deterministic ordering, and input immutability.

Pending launches are not passed to this module. Only ready records from
`state.links` participate in the forest.

### Input Link

The module consumes the structural fields of each ledger link:

```json
{
  "parentTaskId": "parent-task-id",
  "childTaskId": "child-task-id",
  "lifecycle": "open"
}
```

Additional ledger fields are retained by the caller and ignored by structural
queries. The module accepts `open`, `stopped`, and `accepted` lifecycle values
so callers can select the subset relevant to an operation.

### Build Interface

The primary entry point is:

```text
buildTaskForest(links) → forest
```

It validates the complete input and builds:

```text
forest.links
forest.linkByChildTaskId
forest.childLinksByParentTaskId
forest.rootTaskIds
```

`links` is a shallow copy in deterministic order. `linkByChildTaskId` maps one
managed Child Task to its incoming relationship.
`childLinksByParentTaskId` maps every parent to an array; it never exposes a
single `activeChildId`.

Within every returned collection, links and Task IDs are sorted
lexicographically by Task ID. Output order therefore does not depend on
filesystem order, insertion timing, object-key order, or concurrent sibling
launch order.

The returned forest is treated as immutable. Query functions never modify it or
the caller's input array and links.

### Structural Validation

`buildTaskForest` rejects the snapshot when:

- a Task ID is missing or malformed;
- parent and child IDs are equal;
- one Child Task appears under more than one parent;
- an unknown lifecycle value is present; or
- the relationships contain a direct or indirect cycle.

One parent may have any number of children, and a Child Task may also appear as
a parent. Several unrelated roots are valid.

Cycle detection traverses every component, including components not reachable
from the first root candidate. It returns a stable error code and the involved
Task IDs rather than relying on a recursive stack overflow.

The ledger validator remains responsible for schema version, project identity,
timestamps, and completion metadata. Task Forest only validates facts required
to construct the graph safely.

### Root Derivation

Root Task IDs are derived, not stored:

```text
all Parent Task IDs
minus
all Child Task IDs
```

The interface is:

```text
rootTaskIds(forest) → task-id[]
```

The result includes only roots represented by at least one ready link. A
user-created task with no managed child is absent because there is no structural
record to query.

Example:

```text
A → A1
A → A2
A1 → A1a
B → B1

rootTaskIds
  → [A, B]
```

The local Recovery Supervisor is a process rather than a task and never appears
in `state.links`.

### Parent and Child Queries

The direct query interfaces are:

```text
parentLink(forest, childTaskId) → link | null
childLinks(forest, parentTaskId, options?) → link[]
```

`childLinks` supports a lifecycle filter:

```json
{
  "lifecycles": ["open", "stopped"]
}
```

Omitting the filter returns all direct links, including accepted history.
Passing an empty lifecycle collection returns an empty result.

These queries do not infer effective execution state, inspect Codex sessions,
or read conversation content.

### Subtree Query

Lifecycle operations use:

```text
subtreeLinks(forest, taskId, options?) → link[]
```

Selection rules are:

- if `taskId` is a managed Child Task, include its incoming link and all links
  below it;
- if `taskId` is a represented Root Task, include all descendant links;
- do not cross into a sibling outside the selected task;
- do not cross into another Root Task tree; and
- reject an ID that appears as neither a child nor a represented root.

An optional lifecycle filter selects only returned links; traversal still walks
through excluded historical links when needed to identify their descendants.
The lifecycle implementation decides whether a particular mixed-state subtree
operation is valid.

Traversal is iterative and tracks visited Task IDs. The same function supports
deep nesting without depending on the JavaScript call-stack limit.

Example:

```text
A
├─ A1
│  ├─ A1a
│  └─ A1b
└─ A2

subtreeLinks(forest, A1)
  → [A → A1, A1 → A1a, A1 → A1b]

subtreeLinks(forest, A)
  → all four links
```

### Leaf Query

A leaf query operates on a caller-selected lifecycle set:

```text
leafTaskIds(forest, {
  withinTaskId?,
  lifecycles
}) → task-id[]
```

A returned Task ID:

1. is the child of a link whose lifecycle is included; and
2. has no outgoing child link whose lifecycle is included.

Accepted children therefore do not prevent an unfinished parent-child position
from becoming a leaf when the caller selects `open` and `stopped`.

```text
A → A1: open
A1 → A1a: stopped
A1 → A1b: accepted
A → A2: open
A2 → A2a: accepted

leafTaskIds(open + stopped)
  → [A1a, A2]

leafTaskIds(open)
  → [A1, A2]
```

The distinction is intentional:

- lifecycle resume can reopen stopped links, then query the resulting `open`
  leaves;
- heartbeat recovery queries `open` leaves only; and
- inspection may query all unfinished leaves with `open + stopped`.

`withinTaskId` applies the same selection boundary as `subtreeLinks`. Omitting
it evaluates every Root Task tree in the project.

The function returns all matching leaves, not one deepest task. This is required
for parallel branches.

### Complexity

Building the forest is `O(n)` before deterministic sorting, where `n` is the
number of ready links. Root, parent, child, subtree, and leaf queries use the
indexes and avoid repeated full-ledger scans inside one command.

The heartbeat builds one forest per committed ledger snapshot and reuses it for
all branch decisions in that run. A new committed snapshot requires a new
forest; the module does not retain a process-global cache.

### Error Contract

Errors use stable codes and structured facts:

```text
TASK_ID_INVALID
TASK_SELF_LINK
TASK_MULTIPLE_PARENTS
TASK_FOREST_CYCLE
TASK_LIFECYCLE_INVALID
TASK_NOT_MANAGED
```

Errors do not include full ledger JSON or conversation content. Where useful,
they include only the involved Task IDs.

### Required Tests

`components/runtime/tests/task-forest.test.mjs` covers at least:

- an empty link collection;
- one root with one child;
- multiple independent roots;
- a parent with several parallel children;
- recursively nested children;
- a child that is also a parent;
- self-link rejection;
- duplicate-parent rejection;
- cycles in any component;
- deterministic root and child ordering;
- direct parent and child lookup;
- Root Task and Child Task subtree boundaries;
- sibling and other-root isolation;
- lifecycle-filtered direct children;
- leaves after accepted descendants;
- all parallel unfinished leaves;
- `withinTaskId` leaf selection;
- an unknown unmanaged target; and
- unchanged input after every query.

### Related References

- [Task Ledger](/specification/technical-specification/runtime/project-runtime.md)
- [Task Lifecycle](/specification/technical-specification/runtime/lifecycle-and-recovery.md)
- [Task State Observation](/specification/technical-specification/runtime/lifecycle-and-recovery.md)
- [Heartbeat](/specification/technical-specification/runtime/lifecycle-and-recovery.md)
