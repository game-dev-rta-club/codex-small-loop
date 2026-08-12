---
name: interview-me
description: Use only when Codex Small Loop is explicitly active in an interactive user-facing Root Task and material ambiguity remains after discoverable context has been inspected. Clarifies intent before the Codex Small Loop plan and agreement gate.
---

# Codex Small Loop Interview

## Confirm The Codex Small Loop Boundary

Apply this adapter only when:

- the user explicitly invoked `$codex-small-loop:interview-me`; or
- Controller explicitly loaded it while Codex Small Loop is active for the
  current request.

The conversation must be interactive and material intent, constraints,
authority, or the desired result must remain unresolved after inspecting
discoverable context.

An ordinary request, a generic or external `interview-me` invocation, a
scheduled or autonomous run, a managed Child Task, and an already clear request
remain outside this adapter. Return to the caller without interviewing when
these conditions are not met. This narrow boundary lets a generic interview
skill and `codex-small-loop:interview-me` be installed together.

## Load The Upstream Procedure

1. Resolve the directory containing this `SKILL.md`.
2. Resolve the Codex Small Loop plugin root two directory levels above it.
3. Read
   `third_party/agent-skills/interview-me/SKILL.md` from that plugin root
   completely before asking the first question.
4. Apply its interview procedure subject to the Codex Small Loop adaptations
   below.

## Apply The Codex Small Loop Adaptations

1. Use the project context already gathered by Controller. Inspect any
   additional cheaply discoverable context before asking the user.
2. State the current hypothesis and confidence. Ask one question at a time
   with a guess attached, then wait for the user's answer before continuing.
3. Continue until the upstream procedure produces an explicitly confirmed
   statement of intent.
4. Return that confirmed statement of intent to Controller as the input to its
   plan and agreement gate.

The confirmed intent is the adapter's only output. Controller owns the
downstream plan and execution path, so return to Controller instead of handing
off to upstream
`idea-refine`, `spec-driven-development`, or other downstream skills.

The Review Signal job role named `interviewer` is a separate correction-time
role. It does not participate in this user-requirement interview.

## Completion

- The user saw one focused question at a time.
- Every question included the agent's current guess.
- The final Outcome, User, Why now, Success, Constraint, and Out of scope
  statement was explicitly confirmed.
- The confirmed statement of intent was returned to Controller for planning.
