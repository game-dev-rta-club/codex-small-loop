---
summary: >-
  Explicitly start Codex Small Loop from the Codex composer or by asking Codex to
  use Codex Small Loop for the requested outcome. Confirm or change its proposed
  model and speed, answer the interview, approve the execution plan, then
  let Controller supervise one fresh Primary per Milestone through execution,
  review, and delivery.
---

# Run a Task

Codex Small Loop starts only when the user explicitly selects it or directs Codex
to use it for the requested work.

## Step 1. Start Codex Small Loop

Use either explicit entry path:

- In Codex Desktop, choose **Codex Small Loop** from the composer’s **+** menu,
  then enter the outcome.
- In natural language, begin with wording such as **Use Codex Small Loop to ...**
  or **Codex Small Loopを用いて...**.

Mentioning Codex Small Loop while discussing or inspecting it does not start the
workflow. The request must direct Codex to use it for the work.

**You post:**

> Use Codex Small Loop to prepare this project for an open-source release.
> Investigate what is missing, make the necessary changes, and verify the
> result.

This initial message can be brief. Codex shows the setup guide before gathering
project context or asking for details.

## Step 2. Choose The Execution Settings

On this Root Task's first Codex Small Loop turn, Codex always shows one compact
Markdown guide in the language you are using. It includes the bundled hero
image, all four date-stamped model comparisons, Normal speed, and 1.5-times
faster speed, which uses 2.5 times as many tokens. Slack and Obsidian
recommendations always appear in the same guide.

When the request specifies neither model nor speed, Codex proposes the default:

> Terra Medium・標準で始めてよいですか？

If the request supplied exactly one setting, Codex preserves it and asks only
for the missing setting. If it supplied both, Codex accepts them without asking
again. An answer that supplies or changes a setting is already agreement to
that value. Once both settings are known, Codex fixes them for the complete
Root Task.

## Step 3. Answer The Interview

For complex work, Codex first inspects the available project context and then
uses
[`codex-small-loop:interview-me`](/specification/system-specification/skills/interview-me.md)
to ask about material details it could not determine on its own.

**Codex might ask:**

> Who is the first intended user, and what would make the initial release useful
> to them?

**You reply:**

> The first users are individual Codex users. Keep the initial release small and
> optimize for easy installation.

Continue until Codex can restate the intended work without a material gap.

## Step 4. Review And Approve The Plan

**Codex posts a plan:**

> Plan:
> 1. Inspect the current repository and public-facing files.
> 2. Identify the missing release requirements.
> 3. Make the agreed changes.
> 4. Run the relevant checks and report the evidence.

Correct anything that does not match what you want. When the plan is right:

**You approve:**

> This plan matches what I want. Start the work.

## Step 5. Leave The Work To Codex Small Loop

After agreement, Controller forks a fresh Primary for the current Milestone
with the conversation history and approved context. Primary coordinates that
Milestone's implementation and independent review;
Controller monitors it, answers routine questions, safely recovers the existing
task graph when needed, and independently verifies the returned result.

You do not need to open or manage the internal tasks. Codex keeps working inside
the authority you have already provided. When Slack is connected, Whole Job
Loop sends a reminder for verified completion, an unrecoverable stop, or
another item that absolutely must not be missed, while keeping the full
discussion in this conversation.

Controller checks frequently until Primary has started and its initial Execute
work has begun, then less often while it runs. There is no fixed time limit.
Within a Milestone, corrections and Review passes reuse the same Primary and
its managed Tasks. A later Milestone uses a fresh Primary from the same
Controller so each Activity has one clear management boundary. Codex Small Loop
reloads each Task's recorded Role without asking you to repeat or manage Role
names.

Scheduled monitoring belongs to one Milestone at a time. It ends after that
Milestone is verified and its Primary is stopped. Preparation of the next fresh
Primary remains a live exchange without scheduled monitoring; monitoring
restarts only after that Primary is ready to execute. This handoff does not ask
you to manage schedules or approve the internal Milestone transition.

Simple requests that can be answered immediately skip the interview and plan
approval steps.

## Inspect Activity And Sonner With The Board

The complete local page is the **Board**. Its vertical Activity Bar switches
between **Activity** and **Sonner**. Activity lists retained Primary
Milestones and shows the selected Primary and only its descendants through
Agents, Timeline, and Reviews. Controllers do not appear. Sonner inspects the
project Work Graph, Files, and Runtime. Switching back to Activity preserves
its current selection.

Sonner starts on **Work Graph**. Works flow from Overview downward through
automatically routed relationship lines. The graph scrolls inside its own
region, while the selected Work information remains visible below it. Select a
Work card to update that region with its summary, directory path, inputs, and
outputs. A `—` means that relationship is empty. Select a named input or output
to move the selection to that Work. Use the minus and plus buttons to zoom in
ten-percent steps from 50% to 200%, or select the percentage to return to 100%.
Selection and zoom do not re-layout the graph and never open a file.
Use the detail's explicit **Open Folder** button when you want the operating
system's default file browser to open that validated Work directory. The Open control is
disabled while the request is active. If the file changed, refresh Sonner and
explicitly try again; an unconfirmed failure does not assert that no application
received the request. A missing or invalid
graph is stated without diagnostics, and the Files tab remains available.

The **Files** tab shows project-relative paths, file or directory types, and the
`summary` from leading Markdown frontmatter when one exists. It does not show
file bodies. Root entries appear immediately; folders start collapsed and do
not show summaries on their own row. Opening an opaque folder shows `…` and the
reason Sonner omitted its contents. Folders sort before files at every level.
File summaries appear in a single aligned column and shorten
with an ellipsis when space is tight. Click a folder to toggle it, or click an
underlined file once to open it with the operating system's default application.
Only indexed regular files can be opened. Sonner passes an identity-bound
reference to the selected original file rather than reopening a pathname. Use
**Refresh** in the Sonner view to retry a loading error or update the index.

Agents can retrieve the same versioned projection in one command from the
installed plugin:

```sh
node <plugin-root>/components/commands/sonner.mjs \
  --project-root "$PWD"
```

The default output is deterministic Agent text with `Work Graph`, `Files`, and
`Runtime` headings. Every project-derived string is a JSON-compatible quoted
display field, so embedded newlines, tabs, controls, quotes, and backslashes
cannot create a second record or imitate a heading. Invisible Unicode display
controls, default-ignorables, noncharacters, and lone surrogates appear as
visible lowercase `\\u` escapes, while ordinary Japanese, CJK, emoji, RTL
letters, and combining marks remain readable. Missing, invalid, empty, and
opaque omitted states are written explicitly. Plaintext is not the lossless
source format.

Add `--json` for the lossless versioned document. Schema version 8 contains
`version`, `workGraph`, `files`, and `runtime` in that order and is byte-identical
to the authenticated Browser API response at the same observation. Valid Works
include ID, type, summary, node path, direct inputs, and outputs. Missing or
invalid graphs contain status only. Runtime contains mechanical health, coarse
reason codes, and only active or uncertain Tasks admitted by open execution
relationships. Each Task contains ID, name, role, and latest Turn state. A
healthy idle Runtime has an empty `tasks` array. It does not include ended Tasks,
Root history, settlement, counts, coordination records, logs, message bodies,
summaries, or recommended actions.

In the Browser, select **Runtime** after Work Graph and Files. The Browser shows
when the current projection was loaded, one Health value, and active or
uncertain Tasks with short IDs. When none are present it says **No active
Tasks.** Use **Activity** when ended Primary Milestones or their retained
implementation and Review history is needed.

From the project being run, start the read-only Board manually with the plugin
installation path shown by Codex Desktop:

```sh
node <plugin-root>/components/board/server.mjs --project-root "$PWD"
```

The command prints a URL such as `http://127.0.0.1:54321/`. Keep that terminal
open and open the URL locally. The port is selected by the operating system.

Use the one-line Activity sidebar to switch among retained Primary Milestones,
newest first. Each Activity begins at its Primary and excludes its Controller.
The Timeline shows one thin row per individual Agent and one rectangle for each
retained Turn, from `task_started` to its matching completion or abort. A running
Turn extends to the current observation. Cycle bands appear below those rows.
Clock ticks and each rectangle's accessible label provide its time, state, and
duration. Timeline scrolling stays inside the Timeline. Compact metrics
distinguish cumulative token throughput from latest retained context.

In **Agents**, select a Task to read one timestamped chronological feed of its
recorded INPUT, visible intermediate Agent messages as THINK, one latest
confirmed OUTPUT, and durable Conversation
SENT/RECEIVED transitions. Conversation entries contain direction, time, and
counterparty only, not message bodies. Authorized Tasks remain in the Agent list
even when their retained history is safety-omitted; they are labeled unavailable
and remain record-free. If the accepted parent Conversation retains both its
send and reply times, the Timeline can still show that bounded response interval.
Timeline rows and the Agents list are ordered by each Task's earliest displayed
Turn or response interval.
These unavailable Tasks expose no invented history. Selecting an available counterparty
opens and focuses its matching activity. A missing or safety-omitted Agent, or
a Conversation transition whose matching side was not retained, stays plain
text and cannot change the selected Agent. Hidden reasoning and tool payloads
are never displayed. If bounded or partial history cannot prove which response
is final, visible messages remain THINK and Activity reports that no confirmed
Output is available. In **Reviews**,
expand a Cycle and select a retained review file to read its complete raw text.

Only Tasks authorized by this project's valid Codex Small Loop ledger appear.
An ordinary Codex Task in the same folder is not Activity content. Cycle bands
come from immutable Review snapshots, so a clean Review still has a Cycle and
later Signal edits do not move it. A Signal whose snapshot cannot be verified
remains readable under **Unresolved snapshot** without creating a false band.
When available and exactly matched to the verified Primary session, the one-line
Activity name may use its Codex Desktop thread title. Missing or stale Desktop
metadata keeps the managed or first-input name and never changes access.

Large retained histories are admitted as complete records within shared safety
limits. If Activity says **partial · available records shown**, shown Agents,
Reviews, and responses remain intact, but totals and rates that need omitted
evidence are hidden. If another data request is already loading, use **Refresh**
after the brief busy response.

If no Primary Activity can be verified during a partial read, Activity says that available
records may be incomplete instead of reporting an empty history. It clears old
detail and leaves **Refresh** available. A later successful Refresh opens the
newly verified Primary normally.

The selected Activity checks for new retained Timeline, Think, and Output data
about every two seconds while the page is visible. This reads only bounded
append data for Tasks already shown; it does not refresh the Activity list or
add a newly launched Task. Selection, tabs, scroll position, and focus stay in
place. If a Task source or authorization changes, use **Refresh** for a complete
verified reload.

Controller starts or reuses the Board after plan agreement and before it creates
the current Milestone's Primary, then opens it in Codex Browser. Opening the
page is the complete user-facing action; Controller does not add a separate URL
message. The shared Board Host does no Activity history work while idle and its
open pages own its lease lifetime.

You can inspect or control it from the canonical project:

```sh
node <plugin-root>/components/commands/board.mjs status --project-root "$PWD"
node <plugin-root>/components/commands/board.mjs url --project-root "$PWD"
node <plugin-root>/components/commands/board.mjs ensure --project-root "$PWD"
node <plugin-root>/components/commands/board.mjs stop --project-root "$PWD"
```

`ensure` is safe to repeat and returns the same healthy project URL. Canonical
projects share one user-scoped Host while receiving distinct project-keyed
URLs. An open Board page owns a browser lease. When the final page closes, the
Host exits after a five-minute idle grace period unless another page reconnects.
`stop` remains available for explicit project removal and final-Host shutdown.

The Host is a detached Node child on macOS and Windows. It is not a LaunchAgent,
Login Item, scheduler, Windows service, or shell-background command. Private
state lives under `~/.codex/codex-small-loop/board-host/`; macOS uses owner-only
modes and Windows verifies current-user, SYSTEM, and Administrators ACL
inheritance. Board revalidates the canonical Root path, device, and inode before
serving a project.

On macOS, Activity Signal text and Sonner project/Runtime/history data cross
packaged universal descriptor-anchored helper boundaries. Those helpers are
already built for Apple Silicon and Intel; starting Board does not compile them
or require Xcode. On Windows, platform-owned portable readers perform bounded
no-link reads and revalidate the Root, ancestors, and final file identity. They
never inspect or execute the packaged Mach-O helpers. If a reader cannot prove
its boundary, Board keeps verified healthy data, marks the view partial when
appropriate, and never falls back to an unchecked pathname read.

Opening a validated file or Work directory uses the identity-bound native
macOS handoff. Windows currently reports a bounded unavailable result for this
explicit action instead of invoking a macOS helper or an unverified pathname;
Activity and all read-only Sonner views remain available.

Malformed snapshot or Signal filenames are ignored without hiding healthy
Signals. If a valid-name container exceeds the Board's bounded discovery
ceiling, already verified Signals remain selectable, the view is marked
partial, and complete Signal totals and rates are hidden.

The Board is observational: it does not send messages, run commands, edit
Signals, or mutate Tasks. Tool and command payloads are intentionally absent.
THINK means a visible intermediate Agent message that has not been proven as
the Task-wide latest confirmed OUTPUT. Hidden reasoning remains absent. Only an
open, visible Activity page requests lightweight selected-view updates; the
Host performs no history reads while no page requests them.

The direct `server.mjs` command runs in the foreground. The lifecycle command
uses the shared detached Host, and Controller owns its one-time automatic
ensure/open step.

## If Work Reports A Problem

Codex Small Loop commands return structured results. A result other than
`run: "ok"` is not treated as completion. Codex inspects the bounded error
code, internal cause code when available, operation phase, and relevant IDs.
For a background problem or work that appears stalled, it inspects the retained
project runtime status before choosing a targeted retry or repair.

You should not need to interpret raw runtime JSON or guess a recovery command.
Codex summarizes what failed, what was affected, and what it will do next. It
asks you only when recovery needs new authority, an action outside the project,
or a destructive choice.

## Reference

- [Handling User Requests](/specification/system-specification/skills/handling-user-requests.md)
- [Controller Job Role](/specification/system-specification/roles/controller.md)
- [Authority-Gated Autonomy](/product-concept/authority-gated-autonomy.md)
