---
summary: >-
  The Managed Delivery Loop composes user handling, project ownership,
  implementation, independent review, and finding clarification into one
  retained trajectory from agreement to verified delivery.
---

# Managed Delivery Loop

Codex Small Loop keeps one accountable Controller connected from clarified intent
to verified delivery. Controller delegates each dynamically sized Milestone to
a fresh Primary instead of asking the user to
coordinate agents or sending one enormous implementation assignment.

## Responsibility Composition

The user-facing Root has the Controller Job Role. Controller owns interview,
agreement, monitoring, safe recovery, independent acceptance, notifications,
and delivery. For each Milestone it forks a fresh Primary directly with complete
Controller conversation history and the approved context. Primary owns that
Milestone's implementation coordination and returns evidence to Controller.

One fresh Execute owns each Milestone and its later corrections. Four Review
responsibilities independently judge each candidate through Baseline
Verification, Trust Review, Technical Excellence Review, and Customer Value
Review. These are broad outcome goals, not fixed checklists. One Interviewer
handles one required-Signal problem context for exactly one originating
Reviewer. Each additional originating Reviewer gets a separate Interviewer.

A Job Role defines what an agent owns. A Skill supplies reusable behavior used
to fulfill that responsibility. Installed Role definitions remain passive
until the appropriate Skill loads them.

## Candidate And Correction Loop

After the user agrees to the outcome, constraints, authority boundary, plan,
and evidence bar, Primary organizes the current Milestone by problem context.
Changes that can share one problem, set of premises, implementation direction,
and verification approach go to Execute together even when broad. Different
problem contexts go to the same Milestone-scoped Execute sequentially, so unrelated
reasoning does not compete in one turn. File count and change volume alone do
not define this boundary. After every current-Milestone context is integrated,
Primary records one exact snapshot before all four Reviews inspect that same
candidate.

Review is read-only. Each Reviewer records material findings as Signals and
classifies them with the shared
[Signal Evaluation](/implementation/contents/review/signal-evaluation.md)
standard without prescribing implementation. Primary owns the final severity
of every Signal. Only required findings enter the current correction loop; the
other severities remain observations for that pass and are not carried forward.
Primary preserves all Signal files, keeps one representative required for a
same-cause correction, and dismisses duplicates with an Explanation reference
to that representative. For each remaining required problem context, Primary
creates one Interviewer per originating Reviewer and runs the Interviewers in
parallel. Each Interviewer consults only its assigned Reviewer, and Primary
integrates their results. Primary keeps coupled or same-context corrections
together, sends different correction contexts sequentially to the same
Milestone Execute, and creates the next snapshot only after all of them are
integrated. The same four Reviews then inspect it.

The current Milestone ends only when the candidate, Review results, tests,
real-environment evidence, and Controller's independent verification agree.
Controller confirms a same-schedule `ADVANCE_STOP` revision before acceptance;
that state alone accepts the exact replied Conversation, stops the completed
Primary, and binds `ADVANCE_DELETE`. The latter deletes and confirms absence of
the exact outgoing heartbeat. Only then does Controller reassess the remaining
outline and fork a fresh Primary directly for the next Milestone. It does not
fork before exact deletion. It briefly notifies the user of the verified
Milestone and next work, but does not ask the user to approve the internal
transition. The
delivery loop ends only when the whole request
satisfies its approved evidence bar. Execute and Review Tasks are reused only
inside their Primary's Milestone; no role searches for older Task IDs.

Controller does not implement, does not directly operate Primary's children,
and does not create a separate Monitor. Every Primary bootstrap and live
pre-execution interview is heartbeat-free. Only after that Primary reports
`READY_FOR_EXECUTION` does Controller create and confirm one Primary-scoped
`START_PENDING` heartbeat with literal uncommitted Conversation before starting
the execution Conversation. A committed ID is immediately rebound and read
back on that same schedule as `START_BOUND` before any supervision or recovery.
Once Execute has started, it updates the same schedule identity to the default ten-minute or
user-selected steady cadence. Callback identity and Milestone generation are
validated with state and revision before any action, and no startup/steady or cross-Milestone schedules
run in parallel. There is no fixed timeout. Later feedback resumes the same
Controller from zero schedules but starts a fresh Primary because it is a new
Milestone.

## Boundaries

User-visible activation and agreement belong to
[Activation And Execution Profile](/specification/interaction-specification/activation/activation-and-execution-profile.md)
and
[Intent And Plan Agreement](/specification/interaction-specification/agreement/intent-and-plan-agreement.md).
Progress, authority requests, and final presentation belong to
[Progress, Authority, And Delivery](/specification/interaction-specification/delivery/progress-authority-and-delivery.md).

Mechanical state and recovery belong to focused Technical Specification
documents for
[Project Runtime](/specification/technical-specification/runtime/project-runtime.md),
[Task Coordination](/specification/technical-specification/runtime/task-coordination.md),
and
[Lifecycle And Recovery](/specification/technical-specification/runtime/lifecycle-and-recovery.md).

The product reason for retaining this trajectory is defined by the
[Continuous Delivery Loop](/product-concept/continuous-delivery-loop.md).
