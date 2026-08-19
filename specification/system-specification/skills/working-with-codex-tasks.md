---
summary: >-
  Define the installed primitive Skill for creating, messaging, controlling,
  and recovering Codex Tasks without owning a development workflow.
---

# Working With Codex Tasks

The installed
[`codex-small-loop:working-with-codex-tasks` Skill](/implementation/skills/working-with-codex-tasks/SKILL.md)
owns Agent-facing mechanics for Task creation, fork, Notification,
Conversation, stop, resume, runtime diagnosis, and safe recovery.

Job Roles own all semantic decisions: when and why to perform an operation,
which Task and Role should participate, whether Role reload is needed, what the
message contains, and how to evaluate its result. The Skill does not define
Milestones, Execute or Review sequencing, Signal handling, Interview, project
knowledge, or acceptance policy.

## Task Creation And Fork

The caller supplies an explicit unique agent name, Parent Task ID, Job Role,
project root, natural-language assignment body, and optional execution-profile
overrides. Create starts without inherited conversation history. Fork inherits
an ended source Task's history; the source defaults to the Parent.

The assignment uses non-interactive standard input through a pipe or
here-document so EOF is deterministic. The Skill runs Task creation and fork
without a PTY; the command rejects interactive TTY input before creating a
Task.

An unmanaged Controller may bootstrap a project strictly below its own cwd by
passing that nested canonical root explicitly. The created Primary and every
managed descendant remain bound to the nested root; managed Tasks cannot move
between roots.

Creation and fork load the requested Role before the assignment. They return a
durable Task ID that the caller records directly. A required `end_turn` is
honored without polling in the same turn.

Omitted execution-profile fields inherit from the direct Parent for create or
the source Task for fork. Model and reasoning effort are one pair; service tier
is independent. Approval policy and the active permission profile or sandbox
policy are inherited as authority and cannot be changed by profile overrides.
Unknown authority fails closed.

## Notification And Conversation

Information-only delivery uses a Notification and creates no reply obligation.
Assignments, questions, clarifications, and decisions use a Conversation.

A Conversation Initiator starts an exchange, reads the Responder's reply, and
either continues or accepts it. Acceptance closes only the Conversation, not
the Task. A target may have only one active incoming reply obligation; a
conflicting attempt fails with `MESSAGE_TARGET_BUSY`.

When a concrete Role procedure requests Role reload, the caller includes the
reload option on start or continue. Runtime derives the recorded Role and
places Role loading before the message. Creation and fork already load their
Role, so callers do not duplicate it.

The target's `threadSource` selects transport. Daemon-managed delivery returns
a started or steered turn. App-owned delivery returns a durable queued message
and an exact temporary-schedule cleanup action. Agents follow generated actions
and do not construct protocol markers or substitute transports.

## Lifecycle And Recovery

Stop and resume follow the active incoming Conversation branch rather than
historical launch ancestry. Resume is idempotent and is the normal entry point
for stopped-work recovery.

Ordinary commands initialize the private project runtime automatically. Status
is used for explicit diagnosis. Repair is restricted to deterministic local
runtime damage and never creates a Task or Automation.

A structured result whose `run` is not `ok` is diagnostic evidence, not
success. The caller inspects its operation, phase, delivery state, relevant IDs,
and recommended action before retrying. Already-committed create, fork,
delivery, or lifecycle transitions are never duplicated. User action is needed
only for new authority, an external action, or a destructive choice.

## Related Contracts

- [Codex UI metadata](/implementation/skills/working-with-codex-tasks/agents/openai.yaml)
- [Task Coordination](/specification/technical-specification/runtime/task-coordination.md)
- [Task Lifecycle](/specification/technical-specification/runtime/lifecycle-and-recovery.md)
- [Task Message Routing](/specification/technical-specification/runtime/conversations.md)
- [Coordination contract tests](/implementation/components/contract-tests/tests/task-communication-contracts.test.mjs)
