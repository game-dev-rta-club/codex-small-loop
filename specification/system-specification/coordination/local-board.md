---
summary: >-
  Define the Board shell, Activity projection, shared local Host boundary, and
  ownership between Controller, browser, runtime state, and retained history.
---

# Local Board System Boundary

## Ownership

Controller owns the one ensure/open action after plan agreement and before
Primary creation. Opening Codex Browser is the complete user-facing action; it
does not require a separate chat notice. Primary, Execute, Review, and
Interviewer never operate the user's Browser. The Board observes retained
runtime evidence but does not participate in execution, Review decisions, task
messaging, or project mutation.

The Browser shell is the Board and owns the top-level Activity Bar state.
Activity and Sonner are separate views, not nested detail tabs. Activity state remains intact while
Sonner loads its Work Graph, Files, and Runtime projection. Sonner owns these three concrete
views; it does not introduce a general renderer for possible future projections.

The browser owns normal Host lifetime through a live SSE lease. CLI commands own
project registration, observational status/URL lookup, and explicit stop. The
Host owns loopback serving and idle exit. No LaunchAgent, Login Item, scheduler,
or Codex shell owns Board persistence.

## Data boundary

The canonical project Root and its valid ledger authorize the only visible Task
forests. Every earliest Controller-to-Primary assignment establishes an
independent Activity root. Earliest descendant assignment Conversations
establish its internal parent/child structure. A Controller never enters an
Activity projection.
Session history, Desktop titles, Review snapshots, and Signal files enrich that
already authorized structure but never create or re-parent Tasks.

History and Signal access remain bounded and fail closed. Raw records are
admitted whole or omitted whole. Every omission of authorized evidence marks the
projection partial and suppresses completeness-dependent metrics. Unauthorized
records remain exclusions rather than omissions.

Activity retains one Agent shell per authorized Task even when bounded history
inspection omits that Task. It derives one interval per retained Turn from
`task_started` and matching terminal `task_complete` or `turn_aborted` records.
An unterminated Turn extends only to the request's current observation; an
arbitrary later history record never becomes a Turn endpoint. Retained visible
Tasks whose history is omitted may use the accepted parent Conversation's
created/replied timestamps solely as a bounded response interval; this does not
recover or synthesize the omitted Task history.
Agent messages are intermediate Think entries except for the Task-wide latest
message whose finality is proven by matching completion evidence. Partial,
truncated, mismatched, or omitted evidence fails closed by exposing no Output.
Hidden reasoning and tool payloads are outside the projection.

Sonner is a separate read-only project projection. One shared builder
serves the Agent-facing CLI and the Browser API. The CLI boundary renders
deterministic text by default and serializes canonical JSON only for explicit
`--json`; the Browser API always uses that same JSON serializer. It admits Git tracked and
non-ignored untracked project files, excludes runtime/dependency/generated/cache
boundaries, never follows symbolic-link targets, and reads only the leading
Atomic Documentation `summary` from Markdown. It never participates in Task
mutation or Activity history projection.

The Runtime portion reads only the current validated project ledger, open Task
relationships, materialized pending launches, latest Codex Turn observations,
and the Recovery Supervisor diagnostic. Accepted relationships and ended Tasks
are omitted. Coarse reason codes replace raw observation or diagnostic details.
Runtime does not publish Root history, counts, coordination records, message
bodies, prose summaries, recommended actions, or historical timelines.

The Host hands the exact identity-verified immutable Project to Sonner. On
macOS, authorization, Git admission, and content inspection share one retained
Root descriptor. On Windows, a platform-owned bounded reader runs Git without a
shell, rejects reparse/symbolic-link traversal, and revalidates Root, ancestor,
and file identities before and after every admitted read. Both paths return the
same projection and never expose file bodies.

Work discovery, XML parsing, complete validation, and deterministic topological
ordering belong to Sonner. A valid public graph contains Work identity, type,
summary, node path, direct inputs, and direct outputs. Missing and invalid
states expose status only, never diagnostics.

When the Work Graph is valid, the Files projection expands Work directories and the
ancestor routes needed to reach them. Other sibling directories are opaque.
When the graph is missing or invalid, only root files and opaque root
directories remain visible. Files directory nodes do not duplicate Work metadata.
Each opaque directory exposes only a stable summary explaining the omission.

The Browser may request opening one visible regular file or a selected Work's
exact validated directory through a narrow local action. The Host repeats canonical
project authorization, requires an exact
same-origin JSON POST, rebuilds the index, rejects unlisted paths and symbolic
links, and sends the authorized Project object and relative path to a packaged
Open-only helper. The helper retains the Root and selected file-or-directory
descriptors, binds a file-reference URL back to that inode, and gives the
reference object—not a pathname—to LaunchServices. Identical project/path
requests are single-flight. macOS performs the identity-bound LaunchServices
handoff. Windows returns a typed bounded unavailable result until an equally
confined native handoff exists; it never executes the packaged Mach-O helper.

The packaged macOS Signal and Sonner project readers are narrowly scoped
descriptor-anchored native boundaries. Windows uses bounded platform-owned
readers with identity revalidation and no native-helper dependency. Board Host
lifecycle itself is ordinary cross-platform Node code and holds no native or
launchd authority.

## Shared Host

One user-private control map registers zero or more canonical projects. Each
record binds its SHA-256 key to canonical path and device/inode identity. One
detached Node Host uses one OS-assigned IPv4 loopback port for all registered
projects. Static assets are shared; data and leases resolve the project key from
the URL and revalidate its Root identity before access.

Atomic JSON stores serialize registration and Host creation. A healthy current
instance is reused. A missing or unhealthy instance is replaced by a child that
must publish candidate runtime state and pass identity-bound health before it
becomes current. Standard streams are ignored, the process is detached and
unreferenced, and it never starts at login.

The private runtime record contains the instance, PID, port, build identity, and
stop token. Only the CLI reads the token. The browser receives no capability to
mutate runtime state.

## Lease and shutdown

Each Board page opens one project-authorized SSE lease. Disconnect releases it
exactly once. The first lease cancels the idle timer; the final disconnect starts
a five-minute grace period. Reconnection cancels the timer. Expiry closes the
Host. Explicit `board stop` unregisters one project and immediately stops the
Host only when the control map becomes empty.

## HTTP and projection

The server binds `127.0.0.1`, validates the exact numeric Host and port, rejects
request bodies, and permits only GET except for its token-authenticated private
stop route. Security headers disable caching, framing, referrers, external
scripts, and broad connection targets.

Only one Activity data request per project may load history at once. Client disconnect
does not release that slot early. The server returns bounded JSON projection;
the browser never reads the ledger, sessions, Signal directory, or Desktop
database directly.

The Host retains at most one selected-Activity continuation per project after a
successful full detail load. That continuation is detached from the full load:
its canonical ledger projection contains every authorized selected descendant
and detail-visible Conversation, while history/parser/source state exists only
for already-visible selected Tasks. Its revision endpoint validates that frozen
selected projection and already-verified source identities, then consumes only
bounded append bytes. One shared staged budget admits no new omission; aggregate
source, projected JSON, Timeline, visible text, Signal, parser, descriptor, and
detached-detail reconstruction checks must all pass before every source and one
revision commit together. A typed Refresh-required response clears the continuation; the
browser preserves its selection and reading position while an explicit Refresh
performs the full load again. Hidden pages do not request revisions.

`GET /api/sonner` uses the same canonical project authorization as Activity data,
the same project single-flight slot, and the same exact response-byte bound.
The CLI and API import the same Files projection builder rather than maintaining
parallel schemas.

## References

- [Interaction](/specification/interaction-specification/delivery/local-board.md)
- [Runtime contract](/specification/technical-specification/runtime/local-board.md)
- [Board implementation](/implementation/components/board/server.mjs)
