---
summary: >-
  Define the local Board shell and its Activity and Sonner views.
---

# Local Board

The complete local Browser surface is the **Board**. It begins with a narrow
vertical Activity Bar whose peer top-level views are **Activity** and
**Sonner**. Activity follows retained loop activity, while Sonner gives a
project overview. Switching views preserves the current Activity selection and
reading position. Keyboard focus is visible, and arrow keys
move between the two Activity Bar choices.

After the user agrees to the plan and before Controller creates Primary,
Controller runs `board ensure` and opens the exact project-scoped loopback URL
in Codex Browser. Opening the Browser is sufficient; no separate chat notice or
URL is added. The page is already present when Primary and its Children begin
appearing. Controller does not poll or reopen a healthy Board. It may ensure
again after the page and Host are no longer available.

One user-scoped Host may serve several projects. The open Board page keeps it
alive. After every Board page closes, the Host waits through a short idle grace
period and exits automatically. It does not start at login, create a macOS
background item, or require an explicit stop in normal use. Users may still run
the status, URL, or stop commands when needed.

If startup or Browser navigation fails, Controller keeps the failure bounded
and continues with Primary creation. Primary and its Children never open or
operate the user's Browser.

## Sonner Work Graph, Files, and Runtime

Selecting Sonner loads the canonical versioned JSON Work Graph, Files, and
Runtime projection also available to machine consumers through the one Sonner
command's explicit `--json` mode. Agents normally read the command's compact,
deterministic text rendering of the same projection. Its accessible tabs are
**Work Graph**, **Files**, then **Runtime**; Work Graph is selected first. Arrow keys move
focus between them without disturbing Activity state.

A valid graph grows from Overview at the top toward downstream Works. A local
layered-graph layout routes visible directed lines from every input to its
downstream Work and reduces avoidable overlaps. Small rounded corners soften
the orthogonal routes without changing their placement. The graph region owns both
scroll axes and consumes the available panel height; the detail row stays
visible below it instead of extending the page. Every compact card shows only
its one-line Work ID. Click or keyboard activation selects it and updates the detail region;
the card coordinates and connections do not move. The detail reveals summary, node path,
direct inputs, and outputs without opening a path. An empty relationship is
shown as `—`; each named input or output is a keyboard-operable link that
selects and reveals that Work without re-running layout. Compact minus,
percentage-reset, and plus controls zoom the rendered graph from 50% through
200% in ten-point steps while preserving the current viewport center. Only its explicit
**Open Folder** action asks the Host to open that validated Work directory in
the operating system's default file browser. Missing
and invalid states remain diagnostic-free and leave Files usable.

The Work Graph, Files, and Runtime tab labels are the only section titles inside the
Sonner panel; their tab panels do not repeat those titles.

The Files tab contains one collapsible tree. Root entries are visible
immediately, folders sort before files, and every
child directory starts collapsed. Folder disclosure toggles and file icons make
their types distinct without badges or graph-status labels. Only files with a
Markdown summary appear by name, with that summary in a single aligned column
that truncates when space is tight. Every other file is absent by name and its
direct parent contains one compact count row such as `53 png, 53 meta`. File
bodies and unsummarized filenames are never exposed.

Clicking a folder toggles it. Clicking a file once asks the local Host to open
that indexed regular-file object with the operating system's default
application. While the request is active its control is disabled and the live
status says Opening. A changed file asks the user to Refresh and explicitly try
again; an unavailable or timed-out request is described as unconfirmed rather
than claiming that no application received it.
Keyboard activation behaves the same way. Sonner has explicit loading, empty,
missing, invalid, opening, unavailable, and retry states. Native disclosure controls
provide keyboard collapse and expansion.

Project inspection is available on both macOS and Windows. macOS Open uses the
identity-bound native reference handoff. Windows currently keeps the same
visible Open control but returns the bounded unavailable state without invoking
a macOS helper; Work Graph, Files, Runtime, Activity, and Board navigation remain
fully available.

The Runtime tab is a compact current health check, not a second Board. Sonner
shows the Browser-local time of the last successful projection load beside
Refresh, one labelled Health value, coarse reasons only for Unknown or
Attention, and a flat list of active or uncertain Tasks with short ID, name,
role, and Turn state. Ended Tasks and accepted execution relationships are not
shown. A healthy idle Runtime says **No active Tasks.** It shows no Root
selector, settlement, counts, coordination records, logs, message bodies,
history, generated summary, recommended action, or mutation control.
On a narrow viewport the Activity Bar stays at the left edge while Activity and
Sonner content remain contained within the remaining width.
Hovering or focusing an Activity Bar choice reveals its Activity or Sonner label.

## Activities and Timeline

The sidebar lists every locally retained Primary assignment authorized by the
canonical project's valid ledger, newest first. Each Primary is an independent
Activity, including ended Milestones and multiple Primaries created by one
Controller. Ordinary Codex Tasks that merely share the folder are not included.
Each Activity shows a compact name; verified local Desktop metadata may improve
that display but never changes authorization.

Selecting an Activity replaces the inspected trajectory with that Primary and
only its descendants. Its Controller never appears in titles, counts, Agents,
Timeline, details, or controls. The Timeline gives every included Agent Task a
thin row with one rectangle per retained Turn, from `task_started` to its
matching completion or abort. A Turn still running at the current observation
extends to that observation. Individual message marks do not appear, so parallel
Turn lifetimes remain legible without implying that a message ended a Turn.
Numeric Review Cycle bands appear below the Agents. Compact clock ticks and
accurately derivable elapsed, rate, token, context, and compaction metrics may
accompany the timeline. Each Turn rectangle's accessible label identifies the
Task, Turn, start, completion or running state, and duration. An authorized Task
whose history is safety-omitted retains its Agent row and is labeled unavailable;
when its accepted parent Conversation has both send and reply timestamps, that
bounded evidence still draws the response interval without exposing or inventing
history content. Otherwise no timeline interval or history is fabricated for it.
Timeline rows and the Agents list share the same order: the earliest displayed
Turn or bounded response interval appears first, with Tasks lacking any interval
placed last in deterministic order.

Every Review snapshot creates a Cycle, including a pass with no Signal. Signal
edits never move the Cycle. A Signal without a verified snapshot stays
selectable in an unresolved group without fabricating a Timeline band.

## Agent and Review detail

Below the Timeline, **Agents** and **Reviews** are exclusive accessible tabs.

- Agents shows chronological retained INPUT, visible intermediate Agent messages
  as THINK, one latest confirmed final Agent response as OUTPUT, and SENT/RECEIVED
  Conversation transitions. Activity does not read hidden reasoning or tool
  payloads and does not fabricate message bodies. OUTPUT requires retained Task
  completion evidence; when bounded or partial history cannot prove finality,
  visible Agent messages remain THINK and the detail says that no confirmed
  Output is available. A verified paired counterparty link opens and focuses the
  corresponding activity.
- Reviews groups retained Signal files beneath their Cycle. A compact severity
  marker supports scanning. Selection displays the exact retained file text.

Tool calls, command payloads, and hidden reasoning are not Activity content.

## Partial and responsive behavior

When a safety budget omits an authorized whole record, Activity says
**partial · available records shown**, labels shown counts, and omits totals or
rates that require complete evidence. A partial empty discovery keeps Refresh
available and never claims the project is verified-empty.

Concurrent loads invite retry through Refresh. Loading failures show bounded
diagnostics without paths or raw errors. The selected tab alone participates in
layout. Keyboard tab activation, visible focus, a light report-like surface,
and mobile containment remain intact. Activity consumes the available viewport
height without page-body scrolling; Timeline and Agents/Reviews content scroll
inside their own bounded regions, and only the Timeline owns horizontal
scrolling.

While Activity is visible, the selected Activity updates in place about every
two seconds. Timeline, Think, and Output changes preserve the selected Agent or
Review, active tab, scroll positions, and keyboard focus. The Activity list and
newly launched Tasks do not update automatically. If the retained source set or
Host continuation changes, Activity asks for Refresh instead of guessing or
showing a partial update. Leaving the page hidden pauses update requests.

## System realization

- [Board System Boundary](/specification/system-specification/coordination/local-board.md)
- [Board Runtime Contract](/specification/technical-specification/runtime/local-board.md)
- [Board implementation](/implementation/components/board/server.mjs)
