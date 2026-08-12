---
summary: >-
  Codex Small Loop lets a Codex Desktop user delegate an agreed project outcome
  and receive a verified result without manually coordinating the agents,
  reviews, corrections, and recovery needed to produce it.
---

# Codex Small Loop

> Give Codex the whole job.

Codex Small Loop is an installable Codex Desktop plugin for delegating a project
outcome instead of a sequence of agent actions. The user explains the result
they want. Codex Small Loop clarifies material ambiguity, agrees on the execution
profile and plan, advances the project, checks the result from four independent
perspectives, corrects required findings, verifies the final state, and returns
the deliverable with evidence.

The distinctive promise is continuity. The user does not need to create worker
threads, route their messages, combine partial answers, restart execution after
review, or reconstruct context for a new agent. One user-facing Root retains the
intent and acceptance boundary while persistent Execute and Review Tasks keep
their own implementation and judgment context across correction cycles.

## From Request To Delivery

1. **Activate and agree.** Codex Small Loop runs only when explicitly selected or
   requested. It presents the model and speed profile, inspects discoverable
   project context, clarifies only decisions that materially affect the result,
   and asks the user to approve the outcome, constraints, and evidence bar.
2. **Ground and execute.** The Root reads the project's Overview-rooted Work
   Graph. Primary sends coherent problem contexts sequentially to one persistent
   Execute Task, keeping unrelated reasoning separate while retaining
   implementation knowledge and the user-facing intent.
3. **Review independently.** The same four persistent Review Tasks inspect the
   candidate through Baseline Verification, Trust Review, Technical Excellence
   Review, and Customer Value Review. Reviewers record material findings as
   durable Signals and do not modify the candidate they judge.
4. **Correct continuously.** Primary finalizes each Signal's severity against
   the shared evaluation standard. Required findings are clarified with their
   originating Reviewer when needed, returned to the same Execute Task, and
   checked by the same four Reviews in a new pass.
5. **Verify and deliver.** Completion means the deliverable, review results,
   required corrections, tests, and real-environment evidence agree. The Root
   returns that exact accepted state and its material limits to the user.

## Product Boundaries

Codex Small Loop is a Codex-native coordination and knowledge layer. It uses
Codex Tasks, conversations, skills, and Desktop-hosted execution rather than a
separate hosted agent service or a fixed domain workflow. Its local mechanical
runtime preserves active coordination, message delivery, lifecycle operations,
and recovery; agents continue to understand, decide, implement, and review.

Autonomy is bounded by granted authority. Routine, reversible work proceeds
without user checkpoints. A consequential action that needs new authority is
escalated through the managed parent chain, and only the affected action waits.
The user can inspect or intervene at any time, but is not made responsible for
ordinary coordination.

Project knowledge is maintained as a Work Graph rather than a task history.
Overview, Product Concept, Interaction Specification, System Specification,
Technical Specification, Implementation, and User Documentation stay connected
as approved current or future production outputs. Graph membership does not
claim completion. This makes the latest intent and implementation routes
recoverable by a newly started agent without replaying the project.

## Where To Continue

- [Product Concept](/product-concept/whole-job-ownership.md) explains the stable
  product principles behind whole-job delegation.
- [Activation And Execution Profile](/specification/interaction-specification/activation/activation-and-execution-profile.md)
  begins the user-visible path through activation, agreement, and delivery.
- [Managed Delivery Loop](/specification/system-specification/coordination/managed-delivery-loop.md)
  defines how the system composes responsibilities from agreement to verified
  delivery.
- [Repository Structure](/specification/technical-specification/package/repository-structure.md)
  explains the plugin package, while
  [Project Runtime](/specification/technical-specification/runtime/project-runtime.md)
  leads into the local coordination capabilities.
- [Run a Task](/user-documentation/run-a-task.md) is the operating path for a
  user who wants to start Codex Small Loop.
