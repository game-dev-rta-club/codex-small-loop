---
summary: >-
  A continuous delivery loop keeps planning, implementation, independent
  review, correction, re-review, and delivery in one Controller-owned request.
---

# Continuous Delivery Loop

Agreement establishes the destination; it does not turn internal Milestones
into user approval checkpoints. One Controller retains the complete request,
while each Milestone gets a fresh Primary and a Milestone-scoped Execute and
four Review Tasks.

Controller may divide a large destination into coherent Milestones so Primary
does not have to understand and verify the whole implementation in one pass.
Each Milestone uses one fresh Primary forked directly from the same Controller.
That Primary and its Execute and Review Tasks are reused across implementation
contexts and correction passes inside the Milestone, then retired. The outline
can change from evidence; it is not persisted progress state and is not a user
approval surface.

Within a Milestone, Primary gives Execute one problem context at a time. Work
that shares a problem, governing premises, implementation direction, and
verification approach stays together even when it spans many files. Work that
needs a different context follows in a later Conversation with the same Execute
Task. This keeps attention coherent without turning file count, change volume,
or a fixed step list into artificial boundaries. Review begins after those
contexts form one integrated candidate.

Each candidate is reviewed from complementary perspectives. Material findings
become durable Signals. Primary owns their final severity, and only required
findings enter the current correction loop. Interviewer deepens a required
finding only when implementation detail is missing, and Execute corrects the
candidate. Same-context corrections remain together; different correction
contexts arrive sequentially. The same Reviews inspect the new integrated
state, and the loop continues until the agreed evidence supports delivery.

Continuity reduces context loss without weakening independence: Controller
retains user intent and final acceptance across Milestones, each Primary
retains its Milestone integration context, implementation context remains with
its Execute, and judgment context remains with each Reviewer for that
Milestone.

## Realization

- [Task Coordination domain](/specification/system-specification/coordination/task-coordination.md)
- [Working With Codex Tasks](/specification/system-specification/skills/working-with-codex-tasks.md)
- [Review snapshots and Signals](/specification/technical-specification/runtime/review-snapshots-and-signals.md)
