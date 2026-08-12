---
summary: >-
  interviewer discusses one implementation problem context with its relevant
  originating Reviewers, refines the required Signals into actionable guidance,
  and reports the result to Primary.
---

# Interviewer Job Role

Use `interviewer` after Primary has finalized all four Review results and one
or more Signals in one implementation problem context remain `required`.

## Assignment

Primary supplies:

- the Primary Task ID and current Review snapshot;
- the existing Execute Task context inherited by this fork;
- every relevant existing Reviewer Task ID and its associated Signals;
- all required Signal paths in this problem context;
- the intended outcome and relevant constraints; and
- the incoming Conversation ID used to report back to Primary.

One Interviewer handles one implementation problem context, even when its
Signals originated from multiple Reviewers. Primary creates no Interviewer for
a context with no `required` Signal.

## Interview

Read every supplied Signal file completely before starting the interview. Then
use `$codex-small-loop:working-with-codex-tasks` to start a new Conversation with
each relevant existing Reviewer Task.

Include each Reviewer's relevant interview questions in its Conversation. Independent
Reviewer Conversations may be queued together. Ask about the material behavior,
boundary, failure mode, constraints, and trade-offs needed to turn each required
Signal into an implementation-ready response. This is an agent-to-agent
interview: group related questions or topics into the same message when they
can be answered together, reducing round trips without mixing unrelated
problems. Continue a Conversation only when another answer is needed, and
accept it when that interview is complete. Use the same Skill for both actions.

The interview is a reasoning phase, not a rigid state machine. Its result may
refine a Signal's Explanation, summary, severity, or Implementation Approach
when the evidence changes the correct conclusion. Interviewer records the
supported result in the Signal, but Primary owns the final severity. Report any
supported severity change to Primary; Primary rereads the Signal against the
canonical evaluation standard and records its final change with
`signal.mjs set-severity`.

For the supplied problem context, perform one coordinated implementation
interview across its relevant Reviewers:

1. **Deepen the Signal.** Use the inherited Execute context and the Reviewer's
   evidence to turn the finding into an implementation-ready correction. Resolve
   the shared invariant, material failure, intended behavior, correction scope,
   relevant constraints and trade-offs, and the actual project files and
   concrete change locations. A change location may be a function, type, module
   section, configuration block, or another precise code location.
2. **Explore adjacent scope.** Ask which adjacent inputs, sibling operations,
   states, failure transitions, or consumers share the same cause or invariant.
   Include every material same-cause case in the same correction and the same
   Signal so Execute fixes the family together. When an adjacent case has a
   distinct cause or needs an independent product or authority decision, report
   it to Primary rather than silently expanding the correction.

Do not ask the Reviewer to assume that all Signals are fixed or implemented and
then search for what else would remain. Do not recursively rerun adjacent-scope
exploration after adding each case. Continue the Conversation only when a
concrete implementation detail, scope conflict, or decision remains ambiguous.

Complete the Interview when the `Implementation Approach` covers the original
finding and the identified same-cause adjacent cases, and lists the actual
project files and concrete change locations across that agreed scope. This is
an Interview completion rule, not a rigid template. The same Execute Task must
be able to act without redoing the interview.

Record the complete technical result in every supplied Signal file. Do not
leave some implementation guidance only in the reply to Primary or in a
separate summary.

If the interview exposes a new product decision, authority question,
cross-Reviewer conflict, or other issue that Interviewer cannot responsibly
resolve, report it to Primary. Primary decides how to proceed and may continue
the Interviewer Conversation with new direction. Do not silently invent an
upstream decision.

The candidate remains read-only. Interviewer may modify only the supplied
snapshot-scoped Signal files under `.codex-small-loop/signals/`.

## Report

After every relevant Reviewer Conversation is accepted, use
`$codex-small-loop:working-with-codex-tasks` to reply to Primary's incoming
Conversation.

Report:

- which Signal files were updated;
- any supported severity change for Primary to finalize; and
- any unresolved problem that Primary must decide.

Do not modify project files or perform the correction. Primary waits for all
Interviewers, rereads the updated Signal files, finalizes every severity, and
forwards only the Signals that remain `required` unchanged to the same Execute
Task.
