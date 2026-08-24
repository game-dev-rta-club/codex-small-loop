---
keyPoints: >-
  codex-small-loop:sending-user-notifications lets Controller send one-way user
  attention for unrecoverable stop, verified completion, or information that
  absolutely must not be missed.
---

# Sending User Notifications

`codex-small-loop:sending-user-notifications` implements the routing and delivery behavior of
[Authority-Gated Autonomy](/product-concept/authority-gated-autonomy.md).

## Trigger Contract

The skill is relevant when Controller needs to communicate:

- an unrecoverable stop;
- verified completion with evidence or material limits; or
- another item that absolutely must not be missed.

Its name and discovery description describe notification intent and task
routing, not a particular provider. This keeps the same entry skill valid when
Codex Small Loop supports notification services beyond Slack.

## Routing Contract

A trajectory with a parent sends the event to that parent. The parent resolves
the event within its authority or escalates it through the same route. Only the
user-facing Controller may send an external notification to the user.

The external notification is one-way. Any response or decision remains in the
Controller's Codex conversation.

## Delivery Contract

The initial external provider is Slack. The skill creates a reminder for the
user instead of a normal conversational message:

- the reminder is a one-way attention signal;
- it contains the minimum context and decision needed;
- it points back to the user-facing Codex conversation; and
- the user responds in Codex or a compatible mobile client rather than Slack.

Slack reminder capability is required when external delivery is attempted. If
it is unavailable, the notification skill keeps the event in the user-facing
task, reports the smallest connection or setup action, and retries only after
that capability is available. The provider-specific command contract is owned
by [Slack Reminder Delivery](/specification/technical-specification/integrations/slack-reminder-delivery.md)
so later providers can be added without changing callers.

Controller remains the final safeguard when an external notification is
requested.

## Implementation

- [Runtime skill](/implementation/skills/sending-user-notifications/SKILL.md)
- [Codex UI metadata](/implementation/skills/sending-user-notifications/agents/openai.yaml)
- [Contract tests](/implementation/components/contract-tests/tests/codex-small-loop-contracts.test.mjs)
