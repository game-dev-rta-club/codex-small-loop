---
name: recover-unavailable-thread-schedules
description: Use when Codex Small Loop must recover a Task-owned Heartbeat after Codex App `automation_update` is unavailable or rejects the operation, including local-thread restriction errors.
---

# Recover Unavailable Thread Schedules

Recover an unavailable App schedule by re-entering the canonical Codex Small
Loop Task-owned schedule boundary. This Skill adapts the failed request; it does
not introduce a second scheduler or weaken schedule ownership.

## Confirm The Recovery Boundary

Use this route only when the requested operation is a Codex Small Loop
Heartbeat and Codex App `automation_update` is unavailable or returned an error
such as:

```text
Automations are only supported for local threads.
```

Preserve the requested schedule ID, target Task, complete prompt, cadence, and
operation. The exact requesting Task remains the Heartbeat target. A recovery
changes the scheduling surface, not ownership or monitoring meaning.

Load `$codex-small-loop:working-with-codex-tasks` for the mechanical Task and
schedule operations. If the current Task is not the exact target, use one
managed Conversation to ask that target Task to perform the recovery. Do not
create a relay Task, retarget the Heartbeat, or operate another Task's schedule.

## Inspect The Exact Schedule

Resolve this Skill's plugin root and use the bundled schedule command:

```text
node <plugin-root>/components/commands/schedule.mjs read \
  --schedule <schedule-id> --task <target-task-id>
```

Use only an ID in the `codex-small-loop-` namespace. Read the exact candidate
before creating, updating, pausing, or removing it. A present schedule with a
different target, prompt, cadence, or lifecycle tuple is a conflict for the
calling Role to resolve, not permission to overwrite or create a duplicate.

## Recover The Requested Operation

Create an absent schedule with the complete prompt and cadence:

```text
node <plugin-root>/components/commands/schedule.mjs apply \
  --schedule <schedule-id> --task <target-task-id> \
  --if-match absent --interval-minutes <minutes> --message <complete-prompt>
```

For an update, use the opaque etag from the exact read with the new complete
definition. Read back after either apply and require the same schedule ID,
target Task, prompt, cadence, and a new current etag.

Codex Small Loop represents a paused Heartbeat by confirmed absence rather
than a second persisted paused state. To pause or remove, preserve the current
definition in the recovery result, delete with the etag from the exact read,
then read again and require `present: false`:

```text
node <plugin-root>/components/commands/schedule.mjs delete \
  --schedule <schedule-id> --task <target-task-id> \
  --if-match <returned-etag>
```

Resume a previously paused definition only through a new `apply` with
`if-match=absent` and its complete preserved prompt and cadence. Never edit,
move, or enumerate automation TOML directly. Never retry an etag mismatch
without another exact read and a fresh Role decision.

## Verify Runtime Behavior

A successful command proves only the stored definition. Verify behavior
separately:

1. Confirm the target Task is idle; a Heartbeat does not wake a running Task.
2. After the next eligible interval, confirm a new Heartbeat Turn appeared in
   that exact Task.
3. Treat creation or resume as unverified until that real Turn exists.
4. After pause or removal, wait through two eligible intervals and confirm no
   additional Heartbeat Turn appeared.

## Report

Report:

- the App failure that triggered recovery;
- the exact schedule ID and target Task ID;
- the recovered operation and confirmed stored definition or absence;
- the etag/read-back evidence; and
- the real Heartbeat Turn, or the no-new-Turn interval evidence.

