---
summary: >-
  Keep delegated Codex work moving through durable conversations, explicit
  reply obligations, and bounded lifecycle state without turning task ancestry
  into a workflow.
---

# Task Coordination

Codex Small Loop adds only the coordination semantics that delegated Codex work
needs beyond an isolated task.

1. A **managed Task** is a Codex task whose identity and current lifecycle are
   known to the active project trajectory.
2. A **Conversation** is a request-and-reply relationship between an Initiator
   and a Responder. It may cross launch ancestry.
3. Assignment, discussion, correction, results, and acceptance remain ordinary
   Codex task Conversations. Launch ancestry is retained for identity and
   lifecycle, but it does not determine later message flow.
4. The system records only the active obligations needed to keep those
   relationships moving. Codex tasks retain the human-readable history.

## Automatic Continuity

An active reply obligation remains actionable even after the Responder's turn
ends. A running Responder is healthy, a deliberately stopped branch is
inactive, and an ended Responder that still owes a reply is resumed through the
available Codex delivery surface.

Continuity does not introduce a separate recovery agent or ask the user to
manually relay routine internal messages.

## Conversation Semantics

Each substantive Conversation has one active Responder obligation. The
Initiator may continue the exchange or accept that Conversation after a reply.
Accepting a Conversation closes only the exchange; it does not accept or retire
the Task. Information-only Notifications create no reply obligation.

A Task may participate in several outgoing Conversations while owing at most
one incoming reply at a time. This keeps active obligations unambiguous without
restricting later communication to the original parent-child tree.

## Active State

Coordination state is active state, not permanent project history. Accepted
Conversations, delivered Notifications, and settled lifecycle actions leave
active coordination after dependent work is settled.

The current coordination surface therefore scales with active work rather than
every task ever created.

## Technical Ownership

Storage, commands, transports, reminder schedules, process lifetime, and
recovery diagnostics are implementation choices owned by focused
Technical Specification documents for
[Task Coordination](/specification/technical-specification/runtime/task-coordination.md),
[Conversations](/specification/technical-specification/runtime/conversations.md), and
[Lifecycle And Recovery](/specification/technical-specification/runtime/lifecycle-and-recovery.md).
Agent-facing command behavior is owned by
[Working With Codex Tasks](/specification/system-specification/skills/working-with-codex-tasks.md).
