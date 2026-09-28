---
keyPoints: >-
  Notifications deliver information without creating a reply obligation.
  Conversations create one explicit Responder obligation that the Initiator
  continues or accepts; competing incoming obligations and cycles are rejected,
  while daemon-managed and App-owned Tasks use explicit delivery paths.
---

# Conversations And Notifications

`conversation.mjs` is the Agent-facing route for managed exchanges that require
a reply. `message.mjs` owns one-way Notification to any readable Task;
Task launch ancestry and
project membership do not constrain Notification targets.
If an exchange asks for a reply, work, or a decision, use a Conversation. If it
carries information only, use a Notification.

## Notification Model

`notify` sends information to any readable managed or unmanaged Codex Task.
A Conversation is not created, the receiver owes no reply, and no acceptance
or Conversation Recovery follows. Repeated notifications are allowed.

```text
node <plugin-root>/components/commands/message.mjs notify \
  --task <target-task-id> [--message <notification-body>] \
  [--project-root <sender-project-directory>]
```

The command reads the body from the Unicode-safe `--message` argument when it
is present, otherwise from standard input, and renders:

```text
=== Codex Small Loop · Notification ===

No reply or acknowledgement is required.

=== Message ===
<notification body>
```

Notifications end after the message, including queued Desktop delivery.
No schedule or receiver cleanup action is generated.

For direct delivery, success contains the accepted `turnId`, `delivery`, and
`replyExpected: false`. For App-owned delivery, success contains a durable
`messageId`, `delivery: "queued"`, and `replyExpected: false`. The sender does
not wait for the notification Turn to finish.

## Conversation Model

A Conversation records:

- one opaque Conversation ID;
- one Initiator Task and role;
- one Responder Task and role;
- `awaiting_reply`, `replied`, or `accepted`; and
- created, updated, replied, and accepted timestamps.

`start` and `continue` put the Conversation in `awaiting_reply`, which creates
one reply obligation for the Responder. `reply` changes it to `replied` and
clears that obligation. Only the Initiator may `continue` or `accept`; accept
closes only the Conversation. An accepted Conversation cannot continue. Start a
new Conversation with the same Task when more work is needed after acceptance;
the CLI reports `CONVERSATION_ACCEPTED` and the corresponding
`conversation.mjs start --task <responder-task-id>` command when continuation is
attempted.

A Task may initiate multiple Conversations, including while it owes an upstream
reply. A Task may be the Responder of only one active incoming
`awaiting_reply` Conversation. A second attempt fails with
`MESSAGE_TARGET_BUSY`. Cycles are rejected, so the active obligation graph is
always a forest.

## CLI

Natural-language bodies use the Unicode-safe `--message <text>` argument when
present and otherwise retain standard-input compatibility. `--message` is the
normal interactive route on Windows because Windows PowerShell 5.1 may encode
native-command pipelines as ASCII before Node.js receives them.

```text
node <plugin-root>/components/commands/message.mjs notify \
  --task <any-readable-task-id> [--message <text>] [--project-root <directory>]

node <plugin-root>/components/commands/conversation.mjs start \
  --task <managed-target-task-id> [--message <text>] \
  [--reload-role] [--project-root <directory>]

node <plugin-root>/components/commands/conversation.mjs reply \
  --conversation <conversation-id> [--message <text>] [--project-root <directory>]

node <plugin-root>/components/commands/conversation.mjs continue \
  --conversation <conversation-id> [--message <text>] [--project-root <directory>]

node <plugin-root>/components/commands/conversation.mjs accept \
  --conversation <conversation-id> [--project-root <directory>]
```

Accept has no body. The command reads the sender Task ID from
`CODEX_THREAD_ID`. A new Conversation may target any managed Task in the same
project; reply, continue, and accept derive their target from the stored
Conversation. A managed sender uses its ledger role. An unmanaged App-owned
sender is the user-facing Controller, so a Conversation it starts records
`controller` as the Initiator role instead of borrowing the target Primary's
role.

`--reload-role` is valid only for `conversation start`. The runtime derives the
Responder Role from the managed Task Ledger, renders the exact `role.mjs`
command ahead of the assignment, and instructs the Responder to apply the
complete Role output before continuing in the same turn. Callers never repeat
the Role name. Task creation and fork already perform their own dedicated Role
Turn. The Role procedures decide which work-stage entry commands include the
flag.

The Conversation transition and an App-owned queued message commit in one
ledger transaction. The Supervisor submits App-owned messages to Codex's queue.
For direct delivery, the transition commits before the external send; failures
retain committed evidence and never fall back to a schedule. A failure before
any durable mutation returns `run: "failed"` and exit status `1`.

## Envelope

Notification has no direction and no next action. Conversation messages contain
only their Conversation action in `Next Actions`. Start and continue render
Initiator → Responder. Reply renders Initiator ← Responder:

```text
=== Codex Small Loop · Interviewer → Review ===

=== Conversation ===
Initiator Task ID: <initiator-task-id>
Responder Task ID: <responder-task-id>
Conversation ID: <conversation-id>

=== Message ===
Please clarify the required Signal.

=== Next Actions ===
1. Reply to this Conversation after completing the requested work.
   Conversation ID: <conversation-id>
   Use Codex Small Loop `conversation reply --conversation <conversation-id>`.

After completing the protocol actions above, resume the currently loaded Role
and perform its next applicable Action for the resulting state.
```

A reply tells the Initiator the exact `conversation continue` and `conversation accept`
commands. Every Conversation ends its `Next Actions` with the same unnumbered
Role-continuation reminder. The reminder returns control to the Role after the
protocol mechanics; it does not define another mechanical action or grant new
authority. Every Conversation renders its Initiator and Responder Task IDs. Task
names, Agent names, and historical `Parent|Child` labels are not rendered. Lines
shaped like `=== ... ===` are reserved and rejected in caller bodies.

System-owned reminders use `=== System Instructions ===`. Resume and Recovery
include the exact Conversation ID and `conversation reply` command.

## Routing

Managed Tasks always use direct runtime transport. For other Tasks, `threadSource` chooses transport:

```text
codex-small-loop
  → observe the exact latest turn
  → steer an active steerable turn, or start after a terminal turn
  → for Notification, use the target Task's own recorded cwd

user or subagent
  → append the exact rendered prompt to appMessages
  → submit through thread/queue/add with the message ID as clientUserMessageId
  → acknowledge delivery when userMessage.clientId appears in target history

missing or unknown
  → fail closed
```

Managed ledger membership keeps a Task on direct runtime delivery. Conversation position does not otherwise choose transport. A new Conversation still requires a managed same-project target;
Notification accepts any readable active Task.

Direct routing uses metadata-only `thread/read`, profile-preserving
`thread/resume`, `turn/steer`, and `turn/start`. Before a new turn, it reads the
persisted Task Run Context and passes the complete model, reasoning effort,
service tier, approval policy, and authority into `thread/resume`; the response
must confirm the same context. This prevents a reused Task from silently
falling back to Codex's default service tier. It waits for externally owned or
non-steerable turns, reobserves races, and passes the confirmed profile
explicitly to every new turn. The WebSocket bridge keeps a 32 MiB bounded
server-response limit.

Notifications obtain the target cwd through read-only `readTaskProfile`, never
through `thread/resume`. Every necessary resume includes persisted authority
from its first request, including implicit resumes before steer or interrupt.
A resume without explicit caller-supplied context first reads that context;
it never asks the server to choose defaults. Direct delivery failures, including
permission mismatches and active-writer conflicts, never enqueue a heartbeat.
Committed Conversation evidence is retained with `delivery: not_queued`.

Daemon callers inside Codex must have a verifiable full-access turn before the
bridge starts or connects. Unknown or restricted authority fails closed with
`DAEMON_FULL_ACCESS_REQUIRED`. Managed creation, fork, and resume likewise
require full access. A standalone shell remains governed by OS permissions.
Custom named profiles are not assumed to grant full access. Permission mismatch
diagnostics retain expected and actual contexts without changing authority.

## Desktop Queue Delivery

`ready → leased → sending → queued → delivered` records local dispatch and
receipt separately. The CLI's `delivery: "queued"` means durably accepted by
Small Loop, not necessarily submitted to Codex yet. The existing Supervisor
performs the send through the same app-server connection.

Before dispatch, `inspectTaskMessage` checks `thread/queue/list` and then
`thread/read` history. Queue pages are followed by cursor. A known queue item
or a matching `userMessage.clientId` is reused without another send. The runtime
persists `sending` before calling `thread/queue/add`, using the ledger message
ID as `clientUserMessageId`. A matching receipt advances it to `queued`.

Preflight failures may retry, at most 50 attempts including the first. Once
sending may have happened, a connection failure or runtime restart triggers
read-only reconciliation, never blind resubmission. Queue absence alone does
not prove receipt: it may mean cancellation. If neither queue nor history
confirms it, `APP_MESSAGE_DELIVERY_UNCONFIRMED` requires inspection of the target
chat. Other inspection errors remain visible and may be checked again.

`delivered` means the message reached the chat history, not that the agent
finished its reply. Conversation handling retains that responsibility. Pending
Desktop messages continue to defer the sender's premature abnormal recovery.
No `thread/resume`, `turn/start`, or `turn/steer` is used for this transport;
Codex Desktop consumes its queue and retains the target's execution settings.
A dormant/not-loaded chat may remain queued until Desktop resumes it.

Requires a Codex runtime exposing the experimental queue API. Unsupported
runtimes surface the API error; there is no schedule fallback. Ledger version
11 is for fresh work; no migration of old delivery state is provided.

## Fail-Closed Rules

- Missing, archived, or unreadable Notification targets fail.
- Unmanaged or cross-project targets are valid only for Notification.
- Unauthorized Conversation operations fail without transition.
- Busy targets and cycles fail without delivery.
- Direct delivery requires a known turn state; queue delivery does not infer live state.
- Caller-authored protocol markers fail.
- Missing Task or Turn IDs in App responses fail.

## Implementation

- [Message command](/implementation/components/commands/message.mjs)
- [Conversation command](/implementation/components/commands/conversation.mjs)
- [Shared communication CLI runtime](/implementation/components/runtime/source/communication-cli.mjs)
- [Conversation state](/implementation/components/runtime/source/conversation.mjs)
- [Message routing](/implementation/components/runtime/source/task-messaging.mjs)
- [Task Ledger](/implementation/components/runtime/source/task-ledger.mjs)
- [Schedule command](/implementation/components/commands/schedule.mjs)
- [Schedule implementation](/implementation/components/runtime/source/schedule.mjs)
- [Conversation CLI tests](/implementation/components/runtime/tests/conversation-cli.test.mjs)
- [Shared communication CLI tests](/implementation/components/runtime/tests/communication-cli.test.mjs)
- [Message routing tests](/implementation/components/runtime/tests/task-messaging.test.mjs)

## Runtime-owned schedule deletion

The receiver's `schedule delete` command publishes an idempotent request under
`<project-root>/.codex-small-loop/schedule-deletions/`. It does not write to
`CODEX_HOME/automations`. The command runs from the project root or takes an
explicit `--project-root`. It still enforces the current target Task and the
Small Loop schedule namespace. There is no restriction to schedules created
by this runtime, and the target need not belong to its task ledger.

The existing heartbeat drains requests before observing Tasks or reconciling
delivery. It supplies its own automation root, and the existing schedule
store verifies target Task and etag before deletion. An absent schedule is
already complete; a changed etag is a terminal conflict. No request can supply
a filesystem destination.

The delete CLI waits up to 120 seconds for the durable receipt, then reads the
exact schedule and requires absence before returning success (`completed: true`,
`present: false`). The receiver waits for the CLI process, then continues its
lifecycle in the same turn. Acceptance alone never returns success. Failures
and timeout return nonzero; timeout leaves the request intact and reports its
ID so the identical command can check the same receipt later.
The runtime retries transient read/write/lock failures at 30-second intervals
up to three attempts and stays active while requests remain pending. It
records failures in the heartbeat report and project-local receipt.

Queued requests survive restart. The CLI wakes the existing supervisor mechanism
after saving a request, subject to its full-access requirement. Startup failure
leaves the request saved and returns nonzero. Completed receipts remain for duplicate suppression.
Delivery acknowledgment still depends on actual schedule absence, never merely
on enqueueing the request. Delete acknowledgment and message execution are
separate; repeated schedule firings before cleanup remain possible.
