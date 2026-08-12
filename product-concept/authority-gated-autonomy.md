---
summary: >-
  Authority-Gated Autonomy keeps every trajectory working inside explicit
  authority, escalates consequential decisions through its parent chain, and
  involves the user only when a decision reaches the user-facing Controller.
---

# Authority-Gated Autonomy

Authority-Gated Autonomy keeps work moving inside explicit authority boundaries.
The agent carries routine execution, review follow-up, and repair forward without
using human attention as a default checkpoint. Human involvement is reserved for
consequential decisions that require authority unavailable to the current
trajectory.

The purpose is execution speed: a loop should spend its time advancing the work,
while still preserving human control over actions with meaningful consequences.

For Controller, approval of the overall plan includes broad completion authority
inside that outcome. An unspecified detail, newly discovered implementation
need, or adjustment to remaining Milestones is not automatically an authority
request. Controller decides it when the decision remains inside the agreed
boundary, including adding or removing work needed for completion. It returns to
the user only when the outcome or authority boundary itself must change, new
external authority is required, or the action is materially destructive or
difficult to reverse beyond the agreement.

## Operating Model

1. A trajectory acts autonomously within its explicit authority.
2. A consequential action becomes an authority request. The acting trajectory
   does not self-approve it.
3. Only the specific affected action pauses. Other safe and useful work
   continues.
4. The request goes to the parent trajectory first.
5. Each parent decides within its own authority or escalates to its parent.
6. The user-facing Controller asks the user when the request reaches that
   boundary.

The trajectory retains ownership while waiting. It returns the decision to the
appropriate authority rather than returning unfinished work.

## Human Relationship

The user can inspect progress, review results, and intervene at any time, but the
loop does not require continuous supervision. Progress and completion
notifications provide visibility without becoming approval gates.

Only an authority request requires a response. A progress, completion, or
blocker notification does not return unfinished work to the user.

This is closer to **human-on-the-loop** supervision than
human-out-of-the-loop execution: the system works autonomously, while a human
retains meaningful authority and a route to intervene. Authority-Gated Autonomy
adds a stricter routing rule by resolving decisions at the nearest capable
trajectory before spending user attention.

## Notifications

Notifications are attention signals. Primary tasks report to their direct
parent; the user-facing Controller is the only boundary that notifies the
user externally. The initial external delivery mechanism is a one-way Slack
reminder, while the original Codex conversation remains the place for decisions
and discussion.

The provider can change without changing the concept. The stable contract is the
event, authority route, and response location.

## Detailed Contract

- [Sending User Notifications](/specification/system-specification/skills/sending-user-notifications.md)
- [Primary Job Role](/specification/system-specification/roles/primary.md)
- [Controller Job Role](/specification/system-specification/roles/controller.md)
