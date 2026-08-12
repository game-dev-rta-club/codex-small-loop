---
summary: >-
  Immediate Slack delivery uses the reminder tool with the fixed time literal
  "1 minute ago" because current timestamps and "now" are rejected.
---

# Slack Reminder Delivery

The initial external notification provider is Slack. The runtime Skill creates
a reminder rather than a normal conversational message; the user returns to the
Codex conversation to respond.

For immediate delivery, pass the fixed literal `"1 minute ago"` as the reminder
tool's `time`. The installed Slack connector accepts this past-time expression
and delivers the reminder immediately. Current Unix timestamps and the
natural-language value `"now"` return `cannot_parse`.

The fixed literal avoids scheduling delays without adding time-calculation
logic. If the Slack reminder capability is unavailable, retain the event in the
user-facing task, report the smallest connection or setup action, and retry only
after the capability becomes available.

## Related Behavior

- [Sending User Notifications](/specification/system-specification/skills/sending-user-notifications.md)
- [Runtime Skill](/implementation/skills/sending-user-notifications/SKILL.md)
