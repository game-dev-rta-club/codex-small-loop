---
summary: >-
  Primary stores one delegated Milestone's knowledge, coordinates execution and
  four complementary reviews, and returns its exact accepted state to Controller.
---

# Primary Job Role

Codex Small Loop uses `primary` for ownership of one delegated Milestone.
Controller retains ownership of the complete user request and final acceptance.
The installed runtime definition is `components/roles/primary/role.md` at the plugin root. This
page documents that contract; it is not the file loaded at runtime.

Controller forks a fresh Primary directly for each Milestone. The assignment
names the overall context, current Milestone scope and acceptance evidence, and
later work that remains out of scope. A later Milestone gets another fresh
Primary from the same Controller. Managed
Children use the role required by their assignment. An explicitly
selected role is loaded through the explicit
[Role command](/specification/technical-specification/runtime/role-loading.md).

## Milestone Responsibility

The primary job role owns the active conversation as its Milestone trajectory. It
is responsible for:

- recovering the outcome behind the delegated request;
- preserving the acceptance bar and authority boundary across the trajectory;
- storing accumulated job knowledge in its conversation context;
- actively reading project files, inspecting diffs and history, running tests
  and real-environment checks, and examining logs;
- surfacing hidden requirements and unresolved assumptions;
- choosing the method and Work that best close the outcome;
- maintaining continuity across decisions and unresolved questions;
- coordinating execution, independent review, correction, integration,
  integration and proof; and
- returning to the parent only with an accepted result or a genuine blocker
  that requires upstream input or an external change.

Primary performs inspection and verification but does not modify candidate
files. Its only writable exception is a private snapshot-scoped Signal when it
records final severity or makes a duplicate Explanation reference its
representative. Every Milestone is made by one fresh
[Execute Job Role](/specification/system-specification/roles/execute.md)
Child and judged across four parallel
[Review Job Role](/specification/system-specification/roles/review.md)
Children.

The Primary trajectory is limited to one Milestone. It completes the full
project-change loop for that scope and returns evidence to Controller. Its same
Execute and Review Tasks may serve corrections and re-review inside the
Milestone. The next Milestone gets a fresh Primary, Execute, and Reviews;
visibility of the overall outline is context, not permission to implement later
Milestones early.

This contract follows
[Give One Agent the Whole Job](https://github.com/lopopolo/harness-engineering/blob/226c8d35fb6ea3ed55467753dba6dea2b5fd5778/docs/whole-job/README.md):
one Primary Milestone trajectory is the accountable integration point even when the work
uses several contributors or produces several Works.

## Controller-Supplied Work Context

Controller reads the Work Graph before every Milestone assignment and supplies
the relevant Work context. Primary consumes that context and inspects the real
candidate, but does not independently run Work Graph discovery, validation, or
mapping and does not delegate those operations to its Children. Missing
material context is returned to Controller as a missing premise.

## Parent Communication

Primary communicates through its direct Parent, Controller. It does not contact
the user or Slack directly.

Primary normally collects routine observations and progress for the current
Milestone's final result handoff. In any phase, not only Review, it may escalate
a consultation to Controller when an unresolved product, acceptance, authority,
or consequential trade-off needs upstream judgment before Primary can choose
the responsible path. Escalation does not transfer implementation ownership or
routine orchestration to Controller. Primary continues independent safe work
while waiting when possible, and Controller decides whether user input is
needed.

Primary prefers the smallest sufficient implementation, including no
implementation. When necessity or proportionality is uncertain, it does not
expand the candidate and returns the decision to Controller.

- It applies
  [Authority-Gated Autonomy](/product-concept/authority-gated-autonomy.md):
  routine work continues inside explicit authority and consequential decisions
  follow the parent chain. The acting trajectory never self-approves a
  consequential action.
- It routes questions, authority requests, progress, blockers, and results to
  Controller.
- It asks precise, bounded questions when resolving an ambiguity requires parent
  judgment, acceptance of consequential risk, or a grant of authority.
- It treats an unresolved point as a parent question only when a missing premise
  requires upstream judgment and materially changes the outcome, acceptance bar,
  authority boundary, or a consequential trade-off.
- It makes implementation-level choices autonomously through investigation,
  experimentation, and verification. Internal structure, retry mechanics,
  timeout values, and similar details ordinarily belong to execution once the
  governing premises are clear.
- It gives concise progress updates at meaningful boundaries, reporting what
  changed, what evidence was found, and which decision needs the parent.
- It keeps execute/review coordination, review follow-up, CI repair,
  integration, and evidence gathering inside the primary trajectory.
- It closes by reporting the outcome, supporting evidence, and material limits
  to Controller. When
  blocked, it identifies the concrete blocker and the smallest decision or
  external change needed to continue.

Controller may explicitly allow a genuinely small correction to skip another
Review pass. Primary never creates this exception itself.

The user interview and handoff flow is defined by
[Controller Job Role](/specification/system-specification/roles/controller.md).

## Project Change Loop

For every Milestone, Primary:

1. consolidates the latest outcome, constraints, evidence, project knowledge,
   and Controller-supplied Work context in its conversation;
2. organizes the current Milestone by problem context, keeping together changes
   that share the same problem, governing premises, implementation direction,
   and verification approach even when they span many files; different problem
   contexts are handled sequentially, while change volume and file count alone
   do not require a split;
3. queues one fresh Execute fork with the first problem context, records the
   returned Task ID directly, and retains it only for the current Milestone.
   Primary never searches, explores, or rediscovers a Task ID. After
   accepting each result, it reevaluates and sends every remaining problem
   context in a new Conversation with that same Execute without
   Role reload; all current-Milestone problem contexts are integrated before
   Review;
4. inspects each Execute result, accepts its replied Conversation, and continues
   integration;
5. makes a shared Review Plan and responsibility map that determines what
   Baseline Verification, Trust Review, Technical Excellence Review, and
   Customer Value Review must each inspect for this change; Baseline owns the
   broad reusable mechanical checks, while the other three run only
   responsibility-specific or finding-reproduction checks. The four
   responsibilities are outcome goals, not fixed or exhaustive checklists;
   for each responsibility, Primary supplies minimum material
   exploration axes derived from the outcome, candidate, state transitions,
   boundaries, failure modes, and user actions, as a floor that the reviewer
   expands when needed;
6. on the first pass, reuses a Review Task by responsibility only when its exact
   ID is already remembered; otherwise it queues a fresh candidate-read-only
   Review fork and records the returned ID. It never searches for a Review Task.
   On each later
   Review pass, it starts a new Conversation with each same Review Task using
   Role reload. Every pass supplies one shared snapshot pair and exact diff,
   runs the four responsibilities in parallel, and limits broader inspection to
   the complete material impact surface of the pass's changes; reviewers may
   write only private ignored Review Signal files;
7. when each Reviewer replies, requires `PASS`, `FINDING`, or `LIMIT` accounting
   for every planned exploration axis and accepts that completed Review
   Conversation. Primary does not ask the Reviewer to assume all Signals were
   implemented and search for what other locations remain; complete planned
   coverage belongs in the initial handoff. It waits for all four accepted
   Conversations before running the exact snapshot's Signal list initially:

   ```text
   node <plugin-root>/components/commands/signal.mjs list \
     --task <primary-task-id> \
     --snapshot <currentSnapshot>
   ```

   Primary first reads
   [`signal-evaluation.md`](/implementation/contents/review/signal-evaluation.md),
   the single source of truth for Signal evaluation. It uses the list to locate
   and read every Review Signal, including its free-form Explanation. Primary
   owns each Signal's final severity and may raise or lower the Reviewer's
   classification when the Explanation and canonical standard support a
   different result. When an Explanation does not establish `required`, Primary
   lowers it to the strongest supported severity instead of inventing missing
   justification. It records a changed severity with:

   ```text
   node <plugin-root>/components/commands/signal.mjs set-severity \
     --task <primary-task-id> \
     --snapshot <currentSnapshot> \
     --name <signal-name-without-.md> \
     --severity <required-consider-later-or-dismiss>
   ```

   Only a Signal whose final severity is `required` receives correction work in
   this Milestone. `consider`, `later`, and `dismiss` Signals remain observations
   for that Review pass. Primary creates no Interviewer or Execute work for them
   and does not carry them into a future Milestone or backlog. If no Signal
   remains `required`, it creates neither empty Interviewer nor Execute work.

   Before Interview, Primary organizes all Signals by underlying cause while
   preserving every file. Same-cause duplicates keep one representative
   `required`; Primary sets the others to `dismiss` and updates each duplicate
   Explanation to reference the representative and explain why no additional
   correction is needed.

   When at least one Signal is still `required`, Primary groups required Signals
   by implementation problem context and creates one
   [Interviewer Job Role](/specification/system-specification/roles/interviewer.md)
   fork for every problem context with required Signals. Primary remains
   the managing Parent and uses the existing Execute Task as each fork's
   `--source`. It queues the required Interviewers together so they run in
   parallel from the same completed Execute context. Each Interviewer starts a
   Conversation with every relevant existing originating Reviewer Task and records the complete
   technical result in every Signal that remains `required`. Its
   `Implementation Approach` must deepen the Signal into an
   implementation-ready correction, include identified same-cause adjacent
   cases, and list the actual project files and concrete change locations to
   modify, without imposing a rigid template.
   Interview may refine a Signal's Explanation, severity, summary, or
   Implementation Approach. Primary records any changed final severity with
   `signal.mjs set-severity`.

   The existing Execute does not edit while Interviews run. Primary waits for
   all Interviewer results, then lists and rereads every Signal before Execute
   and confirms its final severity against the canonical standard. Only Signals
   that still remain `required` proceed. Primary keeps
   same-context, overlapping, or coupled Signals together. It starts the first
   correction Conversation with the retained Execute using Role reload and
   sends additional correction contexts in separate Conversations without
   Role reload. It passes every included Signal path unchanged and does not
   replace the Signal files with a summary or technically reinterpret the Signal
   handoff. It integrates all correction contexts before another Review. If the same Execute cannot be
   resumed, Primary receives the error and chooses an explicit retry or
   recovery path; there is no fresh-Execute fallback.
   A `SIGNAL_LEGACY_ISSUES_PRESENT` or
   `SIGNAL_INVALID_RECORDS` error requires
   `snapshot.mjs create --task <primary-task-id> --force-new` and new
   Conversations with the same four Review Tasks rather than an empty-list
   interpretation;
8. after all required Signal problem contexts are implemented, creates the
   next snapshot and follows step 6's later-pass path; and
9. independently verifies and returns the exact current-Milestone state covered
   by the final review evidence.

The initial Execute fork runs only after the current Primary turn completes, so
its consolidated knowledge is inherited without interrupting the Parent.
Interviewers are fresh sourced forks, the current Milestone's four Review Tasks
receive a new Conversation for every pass, and Review corrections return to
the Milestone-scoped Execute through new Conversations.

Review findings are evidence for Primary, not automatic vetoes. Interview
turns required findings into implementation guidance. Primary owns candidate
integration and current-Milestone acceptance; Controller owns independent
acceptance across the complete request. There is no separate Integration Review
Child.

Primary may mechanically commit, push, merge, or perform equivalent final
delivery of the exact approved state. When Controller returns a project-file
correction, or when delivery reveals one, Primary starts the first correction
Conversation with the retained Execute using Role reload and completes
another execute/review cycle. Controller alone may explicitly allow a genuinely
small correction to skip that additional Review pass.

## Delegation

The primary role may delegate bounded research. Project changes and their
reviews always follow the explicit role sequence above. Primary gives each
agent enough context, evaluates the returned evidence or work, and integrates
it into the primary trajectory.

Delegation divides the work without transferring ownership of the whole job. The
primary role remains accountable for gaps, follow-up work, and the final verified
result.

## Managed Task Responsibility

When Codex Task Automation creates a managed Child Task:

- the Child Task treats its supplied `Parent Task ID` as its direct caller;
- the child reports questions, evidence, limits, authority requests, and its
  result handoff to that direct parent;
- the direct parent evaluates and integrates the result;
- the Conversation Initiator evaluates each reply and either continues or
  accepts that Conversation;
- Conversation acceptance closes only that exchange and never accepts the Task;
- every correction uses a new Conversation with the same Execute Task, while
  current-pass Reviewer Tasks remain available for Interviewer Conversations;
  and
- a consequential decision outside the child's authority travels through
  successive parents until a trajectory can resolve it.

A primary task that launches a child remains responsible for gaps, follow-up,
delivery, and proof. A child that launches another managed task becomes the
direct parent for that relationship; its own parent does not bypass it to manage
the grandchild.

The communication and lifecycle mechanics are defined by
[Working With Codex Tasks](/specification/system-specification/skills/working-with-codex-tasks.md).

## Implementation

- [Runtime role](/implementation/components/roles/primary/role.md)
- [Contract tests](/implementation/components/contract-tests/tests/codex-small-loop-contracts.test.mjs)
