---
summary: >-
  interviewer discusses one required-Signal problem context with one originating
  Reviewer and records actionable guidance before Execute.
---

# Interviewer Job Role

The installed runtime definition is
`components/roles/interviewer/role.md`.

After all four Reviews finish, Primary reads every Signal, applies the canonical
evaluation standard, and owns each Signal's final severity. It preserves every
Signal file, keeps one representative `required` for a same-cause correction,
sets duplicate same-cause Signals to `dismiss`, and references the representative
from each duplicate Explanation. It then groups remaining required Signals by
implementation problem context and creates one Interviewer per originating
Reviewer in each context.

Primary is the Interviewer's managing Parent but forks it with the existing
Execute Task as `--source`, so it inherits the implementation context that
produced the candidate. Each Interviewer is paired with exactly one existing
Reviewer Task and receives only that Reviewer's required Signal paths from the
context, plus the current snapshot, outcome, constraints, and incoming
Conversation ID. Independent Interviewers run in parallel to reduce overall
Interview time. No independent Interviewer is a serial gate for another.

The Interviewer reads every supplied Signal file completely, then uses
`$codex-small-loop:working-with-codex-tasks` to start one new Conversation with
its assigned existing Reviewer Task. It never interviews or starts a
Conversation with another Reviewer.

The interview deepens each Signal into an implementation-ready correction. It
resolves the shared invariant, material failure, intended behavior, scope,
constraints, trade-offs, actual project files, and concrete change locations.
It also asks which adjacent inputs, sibling operations, states, failure
transitions, or consumers share the same cause or invariant. Material
same-cause cases are included in the same correction and same Signal so Execute
can fix the family together. A distinct cause or independent product or
authority decision returns to Primary.

This is an agent-to-agent interview. The Interviewer may group related
questions or topics in one message or the same round when they can be answered
together. It keeps unrelated problems separate and uses a follow-up only for a
concrete missing implementation detail, scope conflict, or decision.

Do not ask the Reviewer to assume that all Signals are fixed or implemented and
then search for what else remains. Do not recursively repeat adjacent-scope
exploration after each added case. Interview completes
when the `Implementation Approach` covers the original finding and identified
same-cause adjacent cases and lists the agreed files and locations. This is a
completion rule, not a rigid template.

Interview may refine a Signal's Explanation, summary, severity, or
Implementation Approach when the discussion improves the record. Primary owns
the final severity, rereads every changed Signal against the canonical
evaluation standard, and records a supported final change with
`signal.mjs set-severity`. Only a Signal that still remains `required` proceeds
to Execute.

The Interviewer may modify only the supplied Signal files. All technical
results must be recorded there rather than left only in a reply or separate
summary. It does not change the candidate or implement the fix, and the
original Execute does not edit while Interviews run. Questions that require
product judgment, authority, or cross-Reviewer integration return to Primary,
which integrates the results across Reviewers.

After accepting its assigned Reviewer Conversation, Interviewer replies to Primary's
incoming Conversation with the updated paths, supported severity changes, and
any unresolved Primary decision. Primary waits for every required Interviewer,
rereads the Signals, finalizes their severity, and forwards only the paths that
remain `required` unchanged to the same Execute Task.

## Implementation

- [Runtime role](/implementation/components/roles/interviewer/role.md)
- [Task interaction Skill](/implementation/skills/working-with-codex-tasks/SKILL.md)
