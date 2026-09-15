---
keyPoints: >-
  When an App Heartbeat operation is unavailable, the adapter preserves its
  exact schedule, target Task, prompt, cadence, and operation while returning
  control to the same Task-owned Codex Small Loop schedule boundary. Recovery
  requires real Heartbeat evidence and never introduces another scheduler.
---

# Recover Unavailable Thread Schedules

The installed
[`codex-small-loop:recover-unavailable-thread-schedules` Skill](/implementation/skills/recover-unavailable-thread-schedules/SKILL.md)
adapts a failed Codex App `automation_update` request into the canonical Codex
Small Loop schedule command.

## Recovery Boundary

The adapter applies only to a Codex Small Loop Heartbeat whose App operation is
unavailable or rejected, including the local-thread restriction. It preserves
the exact schedule ID, target Task, complete prompt, cadence, and requested
operation. The target Task operates its own schedule; another Task may request
that operation through one managed Conversation but cannot become a relay or
retarget the Heartbeat.

## Schedule Contract

Recovery uses the same `schedule apply/read/delete` interface as ordinary
Codex Small Loop coordination. It preserves the `codex-small-loop-` namespace,
current-Task ownership, `if-match=absent` creation, opaque-etag updates and
deletion, full-definition read-back, and confirmed absence.

Pause is represented by a confirmed deletion after preserving the complete
definition in the result. Resume recreates that definition only when the exact
schedule is absent. The adapter never writes, moves, or enumerates automation
TOML and never creates a parallel scheduler.

## Runtime Evidence

Stored state alone is not activation evidence. Creation and resume require one
real Heartbeat Turn after the target becomes idle. Pause and removal require
confirmed absence followed by two eligible intervals without another
Heartbeat Turn.

## Related Contracts

- [Task mechanics](/specification/system-specification/skills/working-with-codex-tasks.md)
- [Lifecycle and recovery](/specification/technical-specification/runtime/lifecycle-and-recovery.md)
- [Runtime Skill](/implementation/skills/recover-unavailable-thread-schedules/SKILL.md)
- [Codex UI metadata](/implementation/skills/recover-unavailable-thread-schedules/agents/openai.yaml)
