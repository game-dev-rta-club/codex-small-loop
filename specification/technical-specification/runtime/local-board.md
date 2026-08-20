---
summary: >-
  Define the Activity history projection, shared Board Host lifecycle, browser
  leases, and loopback HTTP behavior.
---

# Local Board Runtime Contract

## Purpose

The Board is the complete local Browser shell containing Activity and Sonner.
Activity is its read-only observer for Codex Small Loop execution: it shows every
authorized Primary Milestone, its descendant Agents, retained visible activity,
Review Cycles, Signals, and bounded context metrics without mutating task state.

## Project identity and authorization

Every project begins as an explicit absolute directory and resolves to a
canonical path plus device/inode identity. Its public URL key is the SHA-256 of
that canonical path. A Host request is authorized only when the private control
record's key, canonical path, device, and inode all match a fresh resolution.
That resolution returns a frozen Project object to the request handler. Activity
data receives its canonical Root string, while Sonner receives the complete
object and must open a descriptor matching its retained device/inode; the Host
never asks Sonner to reauthorize a pathname.

The valid ledger's earliest Controller-to-Primary assignment Conversations
authorize independent Activity roots. Each Activity begins at that Primary and
contains only its descendants; its Controller is excluded. Session records,
Desktop titles, and Signal files may enrich an authorized forest but cannot
authorize or re-parent Tasks. Malformed, missing,
oversized, or unverifiable records are omitted and produce bounded partial
evidence rather than guessed data.

## Projection

The Activity list and selected Primary detail are loaded on demand. Activities
sort newest-first and retain ended history. Idle server and
health requests perform no history traversal. Only one data load per project
may be in flight; overlapping requests receive `429 BOARD_BUSY` and may retry.
A client disconnect does not release that slot until the loader resolves or
rejects.

After one selected detail completes that full authorization, the Host may keep
one detached memory-only continuation for that Activity. It retains every
authorized selected descendant in a canonical ledger projection, but clones
histories, source descriptors, offsets, fragments, parser state, Signals,
Review chains, titles, diagnostics, and budget state only for the selected
detail and its already-visible Tasks. The browser requests a revision about every two seconds only while
the Activity page is visible. A steady request revalidates the selected ledger
projection—including selected names, roles, lineage, assignment/link identity,
and visible Conversation timestamps—and source identities but reads zero
history bytes; canonical reordering and unrelated Activity progress are ignored.
A changed request reads only bounded appended bytes from the retained offsets
and advances the existing JSONL parser transactionally. Every visible source is
staged against one strict no-omission budget; aggregate source, history JSON,
Timeline, visible text, Signal, partial/counter/key, descriptor and rebuilt-detail
checks precede the single all-source/revision commit. It never refreshes the Activity list or
discovers a new Task automatically. Source replacement, shrink, disappearance,
new authorized descendants, malformed or excessive append data, stale revision,
or Host restart returns `ACTIVITY_REFRESH_REQUIRED` without publishing a partial
append. Explicit Refresh repeats the complete authorized load and resets the
continuation.

Agent activity contains only retained INPUT, visible intermediate Agent messages
as THINK, at most one latest confirmed OUTPUT for the whole Task, and bounded
Conversation transitions. `agent_reasoning`, hidden chain-of-thought, tool calls,
and command payloads are not projected. Every ledger-authorized Task is retained
as an Agent shell; a safety-omitted history marks that shell unavailable without
inventing records. A retained `task_started` opens a Turn interval; a matching
`task_complete` or `turn_aborted` closes it. Running Turns extend to one
request-scoped observation time, while unrelated event timestamps cannot close
them. Turn start time uses valid `task_started.started_at`, then that record's
top-level timestamp; terminal time uses valid `task_complete.completed_at` or
`turn_aborted.completed_at`, then that record's top-level timestamp. A terminal
event never reuses `started_at`, and a start event never reuses `completed_at`;
absent semantic endpoint evidence remains unknown rather than borrowing an
aggregate history bound.

For an unavailable Agent shell only, an accepted in-Activity Conversation with
both `createdAt` and `repliedAt` supplies a bounded response interval. It never
supplies records, Output, token metrics, or a fabricated history lifecycle.
A completed turn confirms only its last retained visible Agent message, and the
latest such confirmed message is the Task OUTPUT. If a
budget omission, truncated tail, overlapping or mismatched turn boundary, or
other partial evidence prevents finality from being proven, Activity exposes no
OUTPUT and labels retained Agent messages as THINK. Review snapshot ancestry
defines Cycle identity and ordering. Signals join an existing Cycle and retain
their exact raw text, but cannot create a Cycle.

The Activity client occupies the available `100dvh` Board content area without
vertical page-body scrolling. Timeline and Agents/Reviews list and detail panes
own bounded internal scrolling. This containment does not change selection,
keyboard focus, Conversation navigation, or Activity/Sonner view state.

Responses have an exact byte bound. Errors expose stable codes and bounded
messages, never local paths, arbitrary requested IDs, raw parser failures, or
unverified content.

### Sonner projection

The CLI formats the projection as deterministic Agent text by default. It uses
fixed ASCII headings and record keywords, encodes every projection-derived
string as a JSON-compatible quoted display field, preserves canonical
Work/File/Task order, and writes explicit missing, invalid, and empty states.
Its checked-in Unicode 16.0 display boundary renders
format controls, default-ignorables, noncharacters, and lone surrogates as
lowercase `\\u` escapes without normalizing ordinary Unicode. Plaintext is not a
lossless source-recovery format. `--json` selects the lossless canonical
serialization; `/api/sonner` always returns those same JSON bytes for the same
observation. The formatter records its Unicode data-file provenance beside its
single pinned range table rather than depending on runtime ICU properties.

The version-9 Sonner document has exactly four top-level keys in order:
numeric `version`, `workGraph`, `files`, and `runtime`. A valid `workGraph`
contains `status: "valid"` and topologically
ordered `works`; each Work exposes only `id`, `type`, `summary`, `nodePath`,
direct `inputs`, and direct `outputs`. Missing and invalid
graphs expose only their stable status and never parser diagnostics.

The Browser runs the pinned local ELK layered layout once per projection. It
keeps the returned node positions and route endpoints exact, replacing only
each interior orthogonal corner with a bounded quadratic curve for rendering.
Selection never invokes layout or changes the route geometry. Relationship
controls resolve only IDs already present in the projection and transfer
selection to the corresponding DOM card. Zoom scales the retained graph stage
between 0.5 and 2.0 without another ELK invocation; the stage dimensions expand
with the transform so both native scroll axes remain accurate.

`files` contains a deterministic root tree. Directory nodes have
project-relative `path`, `name`, `type`, and `children`. Individually projected
text files have `path`, `name`, `type`, and a nullable Markdown `summary`.
Non-text files are represented in their direct parent by `binary-files` nodes
containing a lowercase final `extension` (or `null`) and positive `count`;
their individual names and bodies are absent. Directories never expose Work
metadata or graph status. At every level, directories sort before individual
text files and binary groups; each category uses UTF-8 byte order.

Sonner owns Work marker discovery, XML entity decoding, basename/ID matching,
unique Work and input validation, single input-free Overview, existing input
references, reachability, cycle rejection, and deterministic topological
ordering. A second standalone mapper command or implementation does not coexist with
this authority.

The reader retains one verified Root handle across two protocol-v2 phases. Its
first phase adopts fd 3, changes cwd to it, and `execve`s fixed `/usr/bin/git`
with `--work-tree=.`, cached/other/deduplicated/exclude-standard selection,
optional locks and fsmonitor disabled, and an allowlisted non-interactive
environment. A complete bounded NUL result is validated and normalized in
UTF-8 byte order before product exclusions are applied. Its second phase receives
the same Root as fd 3, walks each component with descriptor-relative no-follow calls,
and returns the exact bounded prefixes consumed by Node. Root pathnames are never
sent to or reopened by the helper. A final symbolic link is indexed as a link
and its target is never opened; unsafe, missing, or changed indexed descendants
are omitted. Work discovery and marker reads use the same anchored operation,
with unsafe metadata producing the invalid-graph fallback. Every admitted
regular file contributes at most its first 512 bytes to VS Code-compatible text
detection: BOM-marked UTF-8/UTF-16 is text; otherwise NUL-free content or a
consistent UTF-16 NUL layout is text, and other NUL-bearing content is binary.
Markdown files may contribute at most the first 64 KiB so a leading YAML
frontmatter `summary` scalar or block value can be returned. No body fallback is
allowed.

Sonner's internal Work-only loading mode skips Git but retains the same verified
descriptor boundary, so focused validation and non-Git projects remain
supported without a second public command. Standard
linked-worktree and absolute-HOME global-exclude behavior remains Git-owned;
Sonner does not parse or snapshot Git administrative metadata.

`runtime` is independent of Work Graph and Files success. A missing or invalid
project ledger returns only `status: "missing"` or `status: "invalid"`. An
available Runtime contains project-wide `health`, coarse ordered `reasons`, and
a flat `tasks` list. Only Tasks admitted by open relationships or materialized
pending launches are observed. Ended observations are omitted. A Task exposes
only `id`, nullable managed `name`, `role`, and normalized latest `turnState`
(`not_started`, `running`, `aborted`, or `unknown`).
Reason codes distinguish only unavailable history, failed observation, aborted
Tasks, and a current Runtime diagnostic; raw diagnostics are never published.

On macOS, the builder reads the existing validated ledger through the authorized
Project Root descriptor. A packaged Runtime reader performs descriptor-relative,
no-follow, stable bounded reads of the ledger and Recovery Supervisor
diagnostic. A second packaged reader retains the configured active and archive
Codex session-root descriptors, accepts only bounded relative hints lexically
admitted beneath those roots, discovers requested Task histories beneath them,
and streams only a descriptor-anchored, stable, final 2 MiB JSONL window without
returning local pathnames. The native reader discards the initial partial record
and marks truncated windows. Node parses only those returned bytes with the
existing event reducer and reports Unknown unless the window proves the latest
Turn boundary; it never
initializes or mutates Runtime.

On Windows, the same builder selects a portable reader before helper validation.
It discovers Work markers with a bounded recursive traversal that excludes
generated and local-state directories without invoking Git. Files admission
separately runs Git with an argument array and no shell and bounds admitted
paths and bytes. Both paths reject symbolic links and reparse-point traversal
and revalidate Root, ancestor, and file identities around each read. Portable
path detection classifies regular files, symbolic links, and other nodes before
the separate bounded regular-file reader can open content. Fixed
ledger and diagnostic records use the same stable-read rule. Task observation
bounds discovery and reads at most a final 2 MiB JSONL window before applying
the existing reducer. No Windows path validates, executes, or depends on a
Mach-O helper.

The verified Project session is the complete Sonner operation owner. Its
absolute deadline starts before Root acquisition and is never refreshed by a
later Git, content, ledger, history, or diagnostic phase. Files/Work and Runtime
share its AbortSignal. The first fatal branch aborts admission of new phases,
while both branches remain joined until native children are killed and reaped,
streams and parsers settle, and every active/archive history-root handle is
closed. Only then is the Project Root closed and the Host single-flight
released. Active and archive roots are opened sequentially; a late success,
stat failure, unsafe identity, or abort closes the just-acquired handle and any
earlier owner explicitly. Expected missing/invalid Runtime and ordinary
per-Task unknown observation remain fulfilled projections rather than sibling
abort conditions.

Retained links and materialized pending-launch relationships are validated as
one forest before observation. Cycles, multiple parents, reownership of a
retained endpoint, and a 513th unique Task make only Runtime invalid. Exactly
512 Tasks and pending launches without a child ID remain supported. Sonner
repeats this admission defensively before invoking either native observer, so a
malformed injected ledger cannot start unbounded history traversal.
After whole-forest validation, only open relationship endpoints and
materialized pending-launch endpoints are passed to the history reader.
Accepted branches therefore cause no history I/O. Aborted latest Turns or the
existing Recovery Supervisor diagnostic produce attention health; unreadable
observations produce unknown health. No elapsed-time or stale-task inference is
performed. The Browser presents the same single Health value, reasons, and
active-or-uncertain Task list. A healthy empty list is explicit.

## Shared Host lifecycle

There is at most one Board Host per local user state directory. `board ensure`
atomically registers a canonical project, serializes creation, reuses a healthy
Host, or starts a replacement. The process is created directly with Node
`spawn` using `detached: true`, `stdio: "ignore"`, `shell: false`, followed by
`unref()`. It is not managed by launchd, Login Items, Codex schedules, or a
background shell.

The operating system assigns one loopback port. Project URLs use:

```text
http://127.0.0.1:<port>/?project=<sha256-project-key>
```

`status` and `url` are observational. `stop` removes the requested project from
the control map; it sends the private authenticated stop request only when no
projects remain. The Host never starts at login.

Private state is stored under `~/.codex/codex-small-loop/board-host/` with
directory mode 0700 and atomically published JSON files mode 0600. The control
map stores project Root identities. Runtime state stores the current instance,
PID, port, build version, server path, start time, and stop token. The stop token
is never sent to browser code or placed in a URL.

## Browser lease

The project page opens `GET /api/lease?project=<key>` as an SSE connection.
Every accepted connection holds one Host lease. Closing or losing a page
releases its lease exactly once. When the active lease count reaches zero, the
Host starts a five-minute idle grace period. A new lease cancels the timer. If
the timer expires, the Host closes and exits. This makes the visible Board page
the lifetime owner without requiring a notification-producing OS service.

## HTTP boundary

The server listens only on `127.0.0.1` and requires the exact
`127.0.0.1:<bound-port>` Host header. Read routes reject request bodies. The
only browser action is a bounded JSON POST that requires the exact same Origin,
reauthorizes the canonical project, accepts one indexed regular-file path or
exact valid Work-directory path, and rejects symbolic links before invoking the Board-owned universal native
opener. The Node wrapper opens and verifies the registered Root once and passes
it as fd 3. Native traversal uses `fstatat`/`openat` no-follow checks, retains
the final file-or-directory descriptor, creates a Core Foundation file-reference
URL, resolves it only for a device/inode binding check, and passes the original
reference object to `LSOpenCFURLRef`. No Root, resolved, or selected pathname is
dispatched. Identical project-key/path Open requests are single-flight; changed
admission is 409 and unavailable, protocol, timeout, or LaunchServices failure
is 503 with no native detail. The other mutation is the token-authenticated
private stop endpoint. Routes are:

- `GET /`, `/index.html`, `/app.js`, `/activity-selection.js`, `/sonner-view.js`,
  `/vendor/elk.bundled.js`, `/styles.css`
- `GET /api/health`
- `GET /api/activities?project=<key>`
- `GET /api/activity?project=<key>&id=<primary-id>`
- `GET /api/activity/updates?project=<key>&id=<primary-id>&revision=<revision>`
- `GET /api/sonner?project=<key>`
- `GET /api/lease?project=<key>`
- `POST /api/sonner/open?project=<key>` with `{"path":"<project-relative-file>"}`

Manual foreground mode may bind one explicit project without a project query
or browser-lease auto-exit. All responses use no-store, restrictive CSP,
no-referrer, nosniff, and frame-denial headers.

## Signal boundary

Signal raw text remains isolated behind the packaged universal macOS
`activity-signal-reader`. It receives an already verified Root descriptor, walks
literal bounded directory names, rejects links and identity changes, and emits
one bounded versioned frame. Node has no path-based fallback and performs no
runtime native compilation.

On Windows, Activity uses a platform-owned bounded reader. It admits only the
authorized Primary directories and valid snapshot/Signal names, rejects links
and non-regular files, retains file handles while reading, and revalidates every
directory and file identity before publishing raw text. Failures preserve
healthy records, mark Activity partial, and never fall back to an unchecked
read.

## References

- [Board Host manager](/implementation/components/board/source/board-host.mjs)
- [Board Host process](/implementation/components/board/source/board-host-server.mjs)
- [Board server](/implementation/components/board/server.mjs)
- [Board CLI](/implementation/components/commands/board.mjs)
