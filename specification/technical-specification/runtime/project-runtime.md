---
summary: >-
  Define the automatically initialized private runtime used by the local
  Recovery Supervisor and task commands.
---

# Project Runtime And Active-State Ledger

Codex Small Loop stores private coordination state under:

```text
<project>/.codex-small-loop/
  state.json
  recovery-supervisor.lock
  recovery-supervisor-error.json
  signals/
    <primary-task-id>/
      <currentSnapshot>/
        <signal-name>.md
```

The directory is private and added to `.gitignore`. On macOS it uses mode
`0700`, with atomically created state files using mode `0600`. On Windows its
inherited ACL is replaced with an inheritable ACL granting full control only
to the current user, SYSTEM, and Administrators; the runtime reads the ACL back
and fails closed unless the owner and exact rule set match. No Runtime Task or
project-wide Automation configuration is created. Temporary App-message
schedules live in the Codex automation directory, outside this project runtime.
Snapshot-scoped Review Signal files are retained inside the ignored directory
for local coordination and retrospective analysis, but they are not Task
Ledger state and repair does not remove them.

Canonical project resolution also retains an immutable bigint device/inode
identity for the resolved Root. The Board uses that identity to verify an
already-open Root descriptor before native Signal inspection. This does not
change or implicitly harden the ledger, session-discovery, or runtime Signal
CRUD pathname contracts; those trust-adjacent surfaces remain separate work.

## Initialization

Task launch and other runtime-dependent commands call
`assertRuntimeAvailable`. When `state.json` is absent, it creates the directory
and empty ledger automatically without asking the Agent or user to perform a
setup flow.

The explicit CLI remains available for inspection and repair:

```text
node <plugin-root>/components/commands/runtime.mjs doctor

node <plugin-root>/components/commands/runtime.mjs status \
  --project-root <directory>

node <plugin-root>/components/commands/runtime.mjs repair \
  --project-root <directory>
```

`doctor` is host-level and takes no project root. It verifies an active Node.js
24 or newer runtime, the attested platform Codex installation, CLI
authentication, and the required App Server transport without creating a
thread or turn. macOS
requires Unix socket support. Windows requires WebSocket listening,
capability-token authentication, and token-file support.

There is no explicit `setup` command. Ordinary use initializes the runtime;
`repair` is the explicit recovery path for missing or damaged state.

## Status

Status reports readiness and current active-work counts:

- pending launches;
- open and stopped links;
- pending lifecycle deliveries; and
- pending App-owned messages.

It does not print conversation text or raw ledger content.

When the Recovery Supervisor records a thrown Heartbeat failure or a
`run: "partial"` result, status returns `readiness: "repair_required"` with a
bounded cause code, consecutive non-ok count, timestamp, and any retained
event types, reasons, and relevant IDs. Those events make a background partial
result inspectable without exposing raw errors or ledger contents. A malformed
or unreadable diagnostic is also reported instead of being ignored.

## Repair

Repair:

- prepares the private directory and `.gitignore`;
- initializes a missing ledger;
- recovers the shared atomic-store lock through its normal transaction path;
- compacts terminal runtime data; and
- removes obsolete project-local Automation TOML files.

It does not create, modify, or require the temporary message schedules.
It also does not erase a Supervisor failure diagnostic or manufacture a ready
result. The returned inspection remains `repair_required` until a successful
Heartbeat clears that evidence.

## Compatibility

Version 10 intentionally has no migration path from earlier prototype ledgers.
An older or future version fails closed with `LEDGER_VERSION_UNSUPPORTED`.
Reinitialize the private `.codex-small-loop/` runtime state before using the
Conversation model. This explicit boundary prevents old Parent/Child
acceptance state from being misread as current reply obligations.

## Active-State Ledger

`state.json` uses schema version 10 and stores the canonical project identity,
revision metadata, managed Tasks, pending launches, launch links,
Conversations, mechanical deliveries, and App messages. Pending launch records
also retain the complete assignment and resolved `model`, `reasoningEffort`,
and `serviceTier` profile needed to continue after process failure.

Conversation states are `awaiting_reply`, `replied`, and `accepted`. Validation
rejects duplicate identities, multiple active incoming obligations for one
Task, and cycles in the active obligation graph. Launch links record lifecycle
ancestry (`open`, `stopped`, and internal `accepted`) but do not determine
message flow.

`AtomicJsonStore` protects the ledger with a private lock, temporary file,
fsync, and atomic rename. Each transaction validates the newest revision,
applies one deterministic transform, validates the complete next state, and
increments the revision only when state changes. Codex, filesystem, and network
effects happen outside the short transaction and are revalidated afterward.
File handles are always synchronized before rename. Directory synchronization
is also required where the host supports it; Windows `EPERM` for directory-only
`fsync` is treated as an unavailable primitive, while file-sync failures and
all other directory errors still fail the commit.

Active state is bounded. Delivered messages, terminal launch records, and
settled lifecycle deliveries are compacted when they no longer protect
dependent work. Accepted Conversations remain durable assignment history in
version 10; the local Board uses each Responder's earliest one as its
compaction-safe membership authority. Review Signals are retained separately
and do not keep the runtime active.

Stable ledger failures include `LEDGER_NOT_FOUND`, `LEDGER_MALFORMED`,
`LEDGER_VERSION_UNSUPPORTED`, `LEDGER_PROJECT_MISMATCH`,
`LEDGER_SCHEMA_INVALID`, `LEDGER_LOCKED`, and `LEDGER_LOCK_INVALID`.

## Implementation And Proof

- [Runtime command](/implementation/components/commands/runtime.mjs)
- [Runtime implementation](/implementation/components/runtime/source/project-setup.mjs)
- [Runtime doctor](/implementation/components/runtime/source/codex-runtime-doctor.mjs)
- [Ledger implementation](/implementation/components/runtime/source/task-ledger.mjs)
- [Atomic store](/implementation/components/runtime/source/atomic-json-store.mjs)
- [Conversation state](/implementation/components/runtime/source/conversation.mjs)
- [Project runtime tests](/implementation/components/runtime/tests/project-runtime.test.mjs)
- [Runtime CLI tests](/implementation/components/runtime/tests/runtime-cli.test.mjs)
- [Ledger tests](/implementation/components/runtime/tests/task-ledger.test.mjs)
- [Atomic store tests](/implementation/components/runtime/tests/atomic-json-store.test.mjs)

## Ledger Schema Detailed Contract

The ledger is `<project>/.codex-small-loop/state.json`. `AtomicJsonStore` writes
it with a private lock, temporary file, fsync, and atomic rename.

### Version 10 Schema

Version 10 has these top-level collections:

```text
managedTasks
pendingLaunches
links
conversations
deliveries
appMessages
```

It also stores the canonical project root and key, revision, and timestamps.
Every persisted object uses exact validated keys; nullable fields remain
present.

#### Managed Tasks And Launches

`managedTasks` stores immutable Task ID, explicit name, role, and creation time.
`pendingLaunches` durably records launch or fork phases, assignment, role,
Parent, optional model/reasoning override pair, and independent `serviceTier`
override. Promotion inserts the managed Task, its open launch link, and the
first `awaiting_reply` Conversation atomically.

#### Launch Links

Links retain launch ancestry and Task lifecycle:

```text
open
stopped
accepted
```

Public operations use only open and stopped. Accepted links are retained for
internal archive cleanup. Links are not the communication graph.

#### Conversations

Every Conversation stores:

```json
{
  "id": "conversation-id",
  "initiatorTaskId": "task-a",
  "initiatorRole": "interviewer",
  "responderTaskId": "task-b",
  "responderRole": "review",
  "state": "awaiting_reply",
  "createdAt": "2026-07-30T00:00:00.000Z",
  "updatedAt": "2026-07-30T00:00:00.000Z",
  "repliedAt": null,
  "acceptedAt": null
}
```

States are `awaiting_reply`, `replied`, and `accepted`. Validation rejects
duplicate IDs, multiple active incoming reply obligations for one Task, and
cycles in the active obligation graph.

#### Deliveries

Mechanical deliveries are `recovery`, `resume`, or `interrupt`, with ready,
leased, and delivered states. Every record contains nullable
`conversationId`. Recovery and resume require an exact Conversation ID and
matching Initiator/Responder pair. Interrupt may use a launch relationship.

Recovery dedupes by target Task and observed Turn. Resume and interrupt dedupe
by operation and target. Failed sends return to ready with a bounded error;
expired leases can be reclaimed.

#### App Messages

App-owned targets use ready, leased, scheduled, delivered, or discarded
messages. The source Task ID, target Task ID, and complete rendered text are
persisted. Schedule IDs derive from message IDs and are not stored separately.

### Activity

The local Recovery Supervisor remains active for:

- pending launches;
- an `awaiting_reply` Conversation whose Responder is not stopped;
- ready or leased mechanical deliveries; or
- ready, leased, or scheduled App messages.

A replied or accepted Conversation alone does not keep it running.

### Transactions

`transactTaskLedger`:

1. locks the state file;
2. reads and validates the newest revision;
3. runs one synchronous deterministic transform;
4. validates the complete next state;
5. increments revision and timestamp only when state changed; and
6. atomically commits.

External Codex, filesystem, and network effects occur outside this short
transaction. Callers revalidate state after those effects.

### Compatibility

Version 10 intentionally has no migration from earlier prototype ledgers. An
older or future version fails closed with `LEDGER_VERSION_UNSUPPORTED`.
Reinitialize the private runtime state before using this Conversation model.

### Stable Errors

```text
LEDGER_NOT_FOUND
LEDGER_MALFORMED
LEDGER_VERSION_UNSUPPORTED
LEDGER_PROJECT_MISMATCH
LEDGER_SCHEMA_INVALID
LEDGER_LOCKED
LEDGER_LOCK_INVALID
LEDGER_LOCK_OWNER_ALIVE
LEDGER_WRITE_FAILED
DELIVERY_LEASE_CONFLICT
DELIVERY_NOT_FOUND
APP_MESSAGE_CONFLICT
APP_MESSAGE_LEASE_CONFLICT
APP_MESSAGE_NOT_FOUND
APP_MESSAGE_STATUS_CONFLICT
```

### Implementation

- [Ledger implementation](/implementation/components/runtime/source/task-ledger.mjs)
- [Atomic store](/implementation/components/runtime/source/atomic-json-store.mjs)
- [Conversation state](/implementation/components/runtime/source/conversation.mjs)
- [Ledger tests](/implementation/components/runtime/tests/task-ledger.test.mjs)
- [Atomic store tests](/implementation/components/runtime/tests/atomic-json-store.test.mjs)
