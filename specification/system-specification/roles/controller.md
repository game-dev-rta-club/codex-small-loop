---
summary: >-
  Controller advances Codex Small Loop to completion and reports progress,
  decisions, and completion to the user.
---

# Controller Job Role

The user-facing Codex Task uses `controller`. One request has one Controller and
one fresh Primary per Milestone. A separate Monitor role and multiple Primaries
inside one Milestone are outside the current design.

## Contract

Controller is responsible for advancing Codex Small Loop to completion and for
reporting progress, decisions, and completion to the user. The user does not
own routine monitoring or recovery. Primary owns each Milestone's
implementation. Controller also owns user conversation, intent and plan
agreement, completion authority, Milestone sizing, each Milestone-scoped
Primary relationship, monitoring, safe recovery, independent verification,
important notifications, and final delivery.

Controller does not modify project files or directly operate Primary's
Children. It does not start a second Primary for the same Milestone. It asks the user again only for a
decision outside delegated authority, a material change to the agreed outcome,
new external authority, or a destructive or difficult-to-reverse boundary it
cannot safely resolve.

## Operating Sequence

Controller begins after `codex-small-loop:handling-user-requests` has shown the
welcome guide and resolved the execution profile. It follows one ordered
lifecycle:

1. It inspects discoverable project and external context,
   interviews only for material ambiguity, reads the Work Graph for project
   changes, presents the plan and evidence bar, and proceeds when the user has
   clearly agreed by meaning rather than by a required phrase.
2. It forms a rough internal Milestone outline and sizes the first coherent
   user-visible capability. The user does not approve this internal breakdown.
3. It runs the project Board `ensure` once and opens the returned
   project-scoped loopback URL in Codex Browser before Primary exists. Opening
   the Browser is the complete user-facing action; Controller sends no separate
   textual notice or URL. A bounded start/open failure does not prevent Primary
   creation, and no non-Controller role operates the user's Browser.
4. With zero heartbeat schedules for the Milestone, it forks a fresh Primary
   directly from its complete conversation for the
   current Milestone with a bootstrap-only
   launch assignment and explicitly applies the managed-Agent model, reasoning
   effort, and speed selected during initial setup. The Controller Task retains
   its own Codex App settings. Primary sends the one required launch reply,
   Controller accepts that Conversation, and no heartbeat is active yet.
5. It runs a live pre-execution interview by using
   `$codex-small-loop:working-with-codex-tasks` to send one-way Notifications and
   reading each ordinary local final answer through Codex Small Loop exact-Turn
   `task wait`. These Notification turns create no reply obligation. Primary
   asks one material question or reports
   `READY_FOR_EXECUTION`; it does not start Execute during this phase.
6. When execution is ready, Controller creates and reads back one one-minute
   startup heartbeat in `START_PENDING` whose revisioned tuple binds exact Controller,
   Primary, schedule, generation, and literal `conversation=uncommitted`. It
   then starts the current Milestone managed Conversation with Role reload. An
   `ok` or `partial` committed ID
   must be rebound on the same schedule as next-revision `START_BOUND` and read
   back before recovery, supervision, or end turn. A pending callback can only
   inspect bounded commitment evidence, perform that exact rebind, or delete
   only on one attributable post-read-back exit-1 structured
   `operation=start, run=failed, code/message present` result for exact P with
   no CID/partial/committed evidence, no later invocation, and bounded zero
   matches. Zero matching Conversations alone is always a no-op. It cannot operate a Task or
   Conversation.
7. Once Execute has started, Controller updates/read-backs that same schedule
   as next-revision `STEADY` with the exact Conversation and user-selected
   cadence (ten minutes by default). It never creates a parallel schedule and
   does not reopen a healthy Board.
8. It advises Primary, answers non-fatal questions, and preserves the existing
   Task graph through safe recovery. It recognizes user feedback during active
   work immediately and incorporates it at a safe time and in a safe way,
   continuing unaffected work when useful or pausing when no stable route is
   clear.
9. It independently verifies the current Milestone and returns corrections to
   the same Primary. Before nonterminal acceptance it updates/read-backs the
   same `STEADY` schedule as next-revision `ADVANCE_STOP` with exact
   Controller/Primary/schedule/generation/Conversation.
10. After independently verifying a nonfinal Milestone, it briefly notifies the
   user what completed and what continues next, without waiting for approval.
   When work remains, only `ADVANCE_STOP` may accept the exact replied
   Conversation, stop/recover the exact Primary, and after proven stop update
   the same schedule to confirmed `ADVANCE_DELETE`. That state only
   deletes/confirms the exact schedule. Only absence enters `LIVE` for the next
   generation, after which Controller reassesses, reads the Work Graph, and
   forks a fresh Primary without further user approval.
   The new Primary creates fresh Execute and Review Tasks and does not rediscover
   old Child Task IDs.
11. At verified completion or unrecoverable stop, it removes monitoring by
    updating/read-backing `STEADY` as `TERMINAL_DELETE`, deletes/confirms the
    exact schedule, then stops the Primary, notifies the user, and delivers the
    completion evidence or stop reason. Terminal flow never forks.

Controller never runs the one-minute and ten-minute heartbeats together. It
does not create a heartbeat during the pre-execution interview, manage raw
automation files, or use a standalone project cron job. There is no fixed
elapsed-time limit.

All heartbeat creation, update, inspection, and deletion goes through Whole
Job Loop `schedule apply/read/delete`, never Codex App `automation_update`.
Creation requires `if-match=absent`; updates and deletions require the opaque
etag from an exact read. Controller reads back after apply and confirms absence
after delete. An etag mismatch retains the last confirmed state and grants no
dependent authority.

Every scheduled prompt embeds
`(C,P,S,G,R,STATE,conversation=uncommitted|exact CID)`. Every same-`S` update
increments `R` and requires read-back. A callback acts only when every tuple
field equals the current schedule; an old revision, accepted CID in
`START_BOUND`/`STEADY`, missing/replaced schedule, unknown state, or identity or
generation mismatch is a no-op. Stable states are `LIVE`, `START_PENDING`,
`START_BOUND`, `STEADY`, `ADVANCE_STOP`, `ADVANCE_DELETE`, and
`TERMINAL_DELETE`, with the disjoint allowlists defined by the runtime Role.
Arming/read-back failure forbids the dependent action. Noncommitted stop retains
`ADVANCE_STOP`; committed/partial stop follows only structured exact-stop
recovery before `ADVANCE_DELETE`. Deletion failure blocks fork and schedule
creation. Interrupted turns resume only from the confirmed tuple. User cadence
applies afresh to every Milestone.

While `START_PENDING`, not-yet-invoked, in-flight, interrupted/lost result,
timeout, malformed/missing/unattributable output, authentication/observation
ambiguity, delayed visibility, exit 2/partial, `ok`, any CID, queued/committed
delivery, failed-with-CID, stale/wrong-target/later attempt, or contradictory or
multiple evidence cannot delete. Unique commitment permits only same-S
`START_BOUND` rebinding; ambiguity permits neither action. Controller invokes
`conversation start` once per pending tuple and never retries until confirmed
`LIVE` cleanup or `START_BOUND` settlement.

## Milestone Shape

Milestones are lightweight reasoning boundaries, not persisted project records.
They prevent one Primary assignment from becoming broad enough to reduce
implementation and verification quality without making every small operation
pay the complete loop cost.

For a lifestyle management app, TODO management, journal writing, and a
calendar that integrates both are useful Milestones. Splitting TODO
add/edit/delete separately is too small; combining all three capabilities at
once is too large. Cross-cutting work lands when its current capability first
needs it.

Later feedback resumes the same Controller and creates a fresh Primary as a new
Milestone. Corrections and Review passes inside one Milestone reuse that
Milestone's Primary, Execute, and Review Tasks; later Milestones reuse none of
those Child Tasks.

## Implementation

- [Runtime role](/implementation/components/roles/controller/role.md)
- [Root entry Skill](/implementation/skills/handling-user-requests/SKILL.md)
- [Lifecycle and recovery](/specification/technical-specification/runtime/lifecycle-and-recovery.md)
- [Contract tests](/implementation/components/contract-tests/tests/codex-small-loop-contracts.test.mjs)
