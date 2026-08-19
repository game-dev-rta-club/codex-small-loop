---
name: working-with-codex-tasks
description: Use when creating, forking, stopping, resuming, notifying, conversing with, reading, waiting for, scheduling, monitoring, or recovering a Codex Task or exact Turn through Codex Small Loop.
---

# Working With Codex Tasks

Perform the mechanical operation requested by the caller. The caller's Role
decides when and why an operation is needed, which Task should receive it,
whether Role reload is appropriate, what the message means, and whether a
returned result satisfies the work. This Skill owns only Task creation,
messaging, lifecycle, transport, and recovery mechanics.

It does not define a development workflow, review policy, project structure, or
the meaning of an assignment.

## Resolve Commands

1. Resolve the directory containing this `SKILL.md`.
2. Resolve the plugin root two directory levels above it.
3. Run commands with Node from `<plugin-root>/components/commands/`.
4. Pass the exact Task or Conversation ID and relevant project root. Never infer
   the current Task ID from the shell.
5. Pass only the natural-language message body with `--message <text>`. The
   runtime owns protocol markers, Role instructions, routing, and Next Actions.
   Programmatic callers may instead write UTF-8 bytes directly to standard
   input. Do not pipe text from Windows PowerShell 5.1 to a native Node process,
   because its default ASCII output encoding can replace Unicode before the
   runtime receives it.

Use:

- `task.mjs` for Task creation, fork, stop, resume, exact Turn read, and exact
  Turn wait;
- `message.mjs` for one-way Notifications;
- `conversation.mjs` for exchanges that require a reply;
- `schedule.mjs` for exact Task-owned heartbeat schedule apply, read, and
  delete; and
- `runtime.mjs` only for explicit runtime status and repair.

Other project or workflow commands are outside this Skill.

## Create Or Fork A Task

Create a Task without inherited conversation history:

```text
node <plugin-root>/components/commands/task.mjs create \
  --name <agent-name> \
  --parent <parent-task-id> \
  --role <job-role> [--project-root <directory>] \
  [--model <model-id> --reasoning-effort <effort>] \
  [--service-tier <tier|default>]
```

Fork an ended source Task's conversation history:

```text
node <plugin-root>/components/commands/task.mjs fork \
  --name <agent-name> \
  --parent <parent-task-id> \
  --role <job-role> [--source <source-task-id>] \
  [--project-root <directory>] \
  [--model <model-id> --reasoning-effort <effort>] \
  [--service-tier <tier|default>]
```

Provide the assignment body through a pipe or here-document so standard input
closes automatically. Run the command without allocating a PTY. Choose an
explicit agent name that is unique among the managing Parent's direct Children.
Do not repeat the name, Role, Parent identity, protocol instructions, or Next
Actions in the body.

An unmanaged Controller may set `--project-root` to a descendant of its cwd to
bootstrap a focused nested project. That directory becomes the canonical root
for the new Primary and all of its managed descendants. Existing managed Tasks
cannot change roots, and sibling or ancestor targets fail closed.

For `create`, omitted execution-profile fields inherit the direct Parent's
effective values. For `fork`, they inherit the source Task's effective values;
the source defaults to the Parent. Model and reasoning effort are one pair:
omit both or supply both. Service tier is independent. The runtime resolves and
passes model, reasoning effort, service tier, approval policy, and the active
permission profile or sandbox policy. Profile overrides never change authority,
and missing authority fails closed.

Creation and fork load the requested Role before the assignment. Honor a
returned `end_turn`; do not poll or pursue the Child in the same turn. A fork
returns a launch ID. Record the Child's Task ID from `Responder Task ID` in its
first Conversation rather than rediscovering it later.

## Choose Notification Or Conversation

| Intent | Operation | Reply obligation |
|---|---|---|
| Information only | Notification | None |
| Assignment, question, clarification, or decision | Conversation | One managed reply |
| Follow-up or closure of an existing exchange | Continue or accept that Conversation | Follows its current state |

Use a Notification only when no reply or acknowledgement is required:

```text
node <plugin-root>/components/commands/message.mjs notify \
  --task <target-task-id> [--message <notification-body>] \
  [--project-root <sender-project-directory>]
```

A Notification may target a readable managed or unmanaged Task, including one
in another project. It creates no Conversation, reply obligation, acceptance
step, or Recovery work. A queued App-owned Notification includes an exact
temporary-schedule cleanup action; follow that generated action after reading
the message.

Use a Conversation whenever the message asks for work, a reply, or a decision.

Start an exchange:

```text
node <plugin-root>/components/commands/conversation.mjs start \
  --task <target-task-id> [--message <body>] \
  [--reload-role] [--project-root <directory>]
```

Reply to the exact incoming exchange:

```text
node <plugin-root>/components/commands/conversation.mjs reply \
  --conversation <conversation-id> [--message <body>] \
  [--project-root <directory>]
```

After reading a reply, the Initiator either continues or accepts it:

```text
node <plugin-root>/components/commands/conversation.mjs continue \
  --conversation <conversation-id> [--message <body>] \
  [--project-root <directory>]

node <plugin-root>/components/commands/conversation.mjs accept \
  --conversation <conversation-id> [--project-root <directory>]
```

Use `--reload-role` only when the caller's Role procedure explicitly requests
a Role reload at that boundary. The runtime derives the Task's recorded Role
and places its Role-loading command before the message; callers do not pass a
duplicate Role name.

`start` and `continue` create a reply obligation for the Responder. `reply`
fulfills it. `accept` closes only that Conversation; it never completes,
archives, or accepts the Task. An accepted Conversation cannot be continued,
so use a new `start` operation for a later exchange.

A Task may initiate several Conversations and may initiate downstream work
while it owes an upstream reply. A target may have only one active incoming
reply obligation. A simultaneous target attempt fails with
`MESSAGE_TARGET_BUSY`. The active Conversation obligation graph, not launch
ancestry, determines reply and Recovery responsibility.

For a daemon-managed target, success reports `delivery: "steered"` or
`"started"` with a valid `turnId`. For an App-owned target, durable handoff
reports `delivery: "queued"` with a `messageId`. The target's `threadSource`
chooses transport; callers never substitute a different transport themselves.

## Read Or Wait For An Exact Turn

When a direct `message` or `conversation` result contains `taskId`, `turnId`,
and `delivery: "started"` or `"steered"`, preserve both IDs. Read that exact
Turn immediately without waiting:

```text
node <plugin-root>/components/commands/task.mjs read \
  --task <task-id> --turn <turn-id>
```

Wait for the same Turn to end or abort:

```text
node <plugin-root>/components/commands/task.mjs wait \
  --task <task-id> --turn <turn-id> [--timeout-ms <milliseconds>]
```

`read` is always an immediate snapshot. `wait` defaults to a bounded two-minute
wait and accepts `0` through `300000` milliseconds. A wait timeout returns
`run: "ok"`, `turnState: "in_progress"`, and `timedOut: true`; it is not a
delivery or Task failure. Reuse the same IDs for a later read or wait. An ended
Turn returns its ordinary local `finalAnswer`; an aborted Turn returns no final
answer.

These commands are the required observation route for a Codex Small Loop Turn.
Do not use Codex App `read_thread` or `wait_threads` for a direct Turn returned
by Codex Small Loop, and do not use those App tools as fallback after a Whole Job
Loop observation error. For `delivery: "queued"`, only `messageId` is proven:
follow the existing App-owned delivery action and never invent a Turn ID.

## Apply, Read, Or Delete A Schedule

Use the Codex Small Loop schedule command for every schedule created or managed
by Codex Small Loop. Do not use Codex App `automation_update` for these
operations and do not edit automation TOML directly.

For a Controller heartbeat, use one stable ID shaped
`codex-small-loop-monitor-<controller-task-id>-g<generation>` for that schedule
lifetime and update that same ID. Temporary message schedules are derived by the runtime
under `codex-small-loop-message-`; callers do not invent them.

Create an exact current-Task schedule only when it is absent:

```text
node <plugin-root>/components/commands/schedule.mjs apply \
  --schedule <codex-small-loop-schedule-id> --task <current-task-id> \
  --if-match absent --interval-minutes <minutes> [--message <prompt>]
```

Before an update or deletion, read the exact definition and opaque etag:

```text
node <plugin-root>/components/commands/schedule.mjs read \
  --schedule <schedule-id> --task <current-task-id>
```

Update with the returned etag by running `apply` with the new complete prompt
and cadence. Delete with that same concurrency guard:

```text
node <plugin-root>/components/commands/schedule.mjs delete \
  --schedule <schedule-id> --task <current-task-id> \
  --if-match <returned-etag>
```

After apply, read back and confirm the complete definition and returned etag.
After delete, read back and confirm `present: false`. Never retry an etag
mismatch blindly: read again and let the caller's Role decide whether the new
definition still authorizes the intended transition. The CLI refuses to
operate a schedule for a Task other than `CODEX_THREAD_ID` and refuses IDs
outside the `codex-small-loop-` namespace.

A queued App-owned message contains this same read-then-delete action. Follow
it before continuing; the runtime acknowledges delivery when the temporary
schedule disappears.

## Stop Or Resume A Task

```text
node <plugin-root>/components/commands/task.mjs stop \
  --task <task-id> [--project-root <directory>]

node <plugin-root>/components/commands/task.mjs resume \
  --task <task-id> [--project-root <directory>]
```

Stop and resume follow the current active incoming Conversation branch, not
historical launch ancestry. Stop suppresses Recovery for the selected branch.
Resume is idempotent, reopens that branch, and is the normal stopped-work
recovery entry point.

## Inspect Or Repair Runtime State

Ordinary Task and message commands initialize the private project runtime
automatically. Do not create a Runtime Task, project-wide Automation, or manual
setup step.

Inspect explicit runtime state with:

```text
node <plugin-root>/components/commands/runtime.mjs status \
  --project-root <directory>
```

Use `runtime.mjs repair --project-root <directory>` only when status identifies
deterministic local runtime damage. Repair recreates missing local state and
compacts terminal records; it never creates a Codex Task or Automation.

## Handle Structured Non-Ok Results

A structured result whose `run` is other than `ok` is not success. Inspect its
bounded `code`, optional `causeCode`, `operation`, `phase`, delivery state, and
relevant Task, Conversation, launch, or message IDs. Do not blindly repeat a
failed operation.

- A create or fork result with `run: "partial"` and
  `phase: "supervisor_start"` means Task state already committed. Never create
  or fork again. If it returns a Child Task ID and recommends
  `resume_child_task`, resume that Child; otherwise inspect runtime status.
- A Conversation or Notification result with `delivery: "queued"` is durable.
  Wait for delivery; do not repeat the transition.
- A direct Conversation or Notification result with a `turnId` is observed
  only through exact `task read` or `task wait`. Treat `timedOut: true` as a
  normal in-progress result and preserve the IDs.
- A resume result with `run: "partial"`, `phase: "supervisor_start"`, and
  `recommendedAction: "retry_resume"` committed lifecycle state already.
  Repeat that exact resume operation once to start supervision.
- For apparent stalls or background failures, inspect runtime status and use
  retained issue details as evidence before choosing a targeted retry.

Use repair only when diagnostics call for it. Ask for user action only when
recovery needs new authority, an external action, or a destructive choice.
Summarize cause, impact, and next action instead of dumping raw JSON.
