---
keyPoints: >-
  Controller is the only user interaction boundary during execution. Routine
  progress stays internal, external attention is reserved for an unrecoverable
  stop, verified completion, or critical information, and final delivery names
  the exact result with material changes, review evidence, checks, and limits.
---

# Progress, Authority, And Delivery

Controller is the single user interaction boundary during execution. Managed
Tasks report to their direct parent; only Controller may turn an event into an
external user notification.

Routine progress remains inside Controller's monitoring loop. External
attention is reserved for an unrecoverable stop, verified completion, or other
information that absolutely must not be missed. Primary never bypasses
Controller to contact the user or Slack.

External delivery is an attention aid, initially a one-way Slack reminder. It
contains the minimum useful context and points back to the Root conversation;
the decision remains in Codex rather than moving to Slack.

Final delivery follows Controller's independent verification, leads with the
accepted outcome, and identifies the exact deliverable. It summarizes the
material changes, review result, relevant tests or real-environment checks, and
any remaining limits. Internal Task topology, raw runtime envelopes, and
recovery details stay hidden unless they materially explain a limitation or the
user asks to inspect them.

Users who choose to inspect those retained details locally may use the
[Local Board](/specification/interaction-specification/delivery/local-board.md).
The Board is an observational surface and does not change Controller's single
user interaction boundary or notification rules.

## System Realization

- [Sending User Notifications](/specification/system-specification/skills/sending-user-notifications.md)
- [Authority-Gated Autonomy](/product-concept/authority-gated-autonomy.md)
- [Verified Delivery](/product-concept/verified-delivery.md)
