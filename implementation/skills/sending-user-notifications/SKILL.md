---
name: sending-user-notifications
description: Use when a Codex Small Loop Controller must send a one-way user attention signal for an unrecoverable stop, verified completion, or another item that absolutely must not be missed. Child trajectories report to their parent instead of notifying the user.
---

# Sending User Notifications

Route managed work upward to Controller. Only Controller sends an external user
attention signal.

## Classify The Event

Classify the reason for notification before choosing a channel:

- **Unrecoverable stop** — existing work cannot be resumed safely, or recovery
  would make the task graph too complex to trust.
- **Completion** — Controller independently verified the exact delivered state.
- **Must-not-be-missed information** — omission would materially mislead or harm
  the user even though the loop can otherwise continue.

Routine activity is not a notification event. Prefer meaningful changes over a
stream of low-value updates.

## Resolve The Recipient

1. When the current trajectory has a parent, send the event to that parent.
2. Let the parent resolve it within its authority or escalate it to its own
   parent.
3. Repeat until the event reaches a trajectory with sufficient authority.
4. Only the user-facing Controller sends an external notification to the user.

Preserve this route even when an external notification provider is available.
A child trajectory reports upward rather than bypassing its parent.

## Keep The Loop Moving

An informational progress or completion notification never pauses the loop.

For an authority request, pause only the specific affected action. Continue
independent work that remains safe and useful inside the current authority. Keep
ownership of the unfinished work while waiting for the decision.

## Compose The Notification

Include only the context needed to act:

- the task or outcome;
- what happened;
- whether a response is required;
- the decision, authority, or external change needed;
- the consequence of each material option when approval is requested; and
- where the user should respond.

Write the notification as an attention signal rather than the start of a second
conversation.

The notification is one-way. Any response or decision remains in the Controller
Codex conversation.

## Deliver External Notifications

Use the notification provider available in the installed Codex Small Loop
environment. The initial provider is a Slack reminder.

Create a reminder for the user instead of posting a conversational Slack
message. Tell the user to respond in the user-facing Codex conversation, including
through a mobile client when convenient. Treat delivery as one-way: the reminder
attracts attention, while the Codex conversation retains context and authority.

For immediate Slack reminder delivery, pass the fixed literal
`"1 minute ago"` as the reminder tool's `time`. Slack accepts this past-time
expression and delivers the reminder immediately. Do not calculate a timestamp
or add a future scheduling delay.

If the required provider is unavailable, preserve the event in the Controller
task, explain the readiness failure there, and request the smallest setup change
needed to restore delivery.

## Completion

Record the successful route or delivery. Then continue the loop unless the
specific work requires authority or an external change that has not arrived.
When waiting on external state, retain ownership and resume when it changes.
