---
keyPoints: >-
  Keep automated tests fast by testing implementation parts independently and
  reserve real agent/browser workflows for final manual verification.
---

# Testing

Do not build automated E2E tests for agent-driven workflows.
Design so each part can be tested independently. Test each implementation
contract independently, then perform the final real
command, Codex, or browser path manually as completion evidence.
Perform the final end-to-end check manually.

## Skills and task coordination

Skill tests cover installed-file contracts, activation boundaries, namespaces,
command construction, and durable task/message semantics without starting
Codex. Manual checks use a freshly installed plugin and record the observed Task
IDs, commands, and final responses.

## Activity data and Board UI

Focused Activity tests cover:

- canonical project and ledger ownership;
- Controller-to-Primary Activity roots, Primary-only descendant forests,
  newest-first multiple-Primary history, and compacted history;
- ledger-only complete Activity headings and click-selected Primary-subtree
  history loading without unrelated-Milestone budget consumption;
- descriptor-anchored bounded history and Signal reads;
- partial evidence and exact response byte limits;
- one in-flight data load per project, including disconnected clients;
- Cycle ancestry, Reviews, one confirmed OUTPUT with fail-closed intermediate
  THINK classification, and Conversation navigation;
- bounded Desktop-title lookup and safe fallback;
- one rectangle per retained Turn, Conversation-bounded response rectangles for
  unavailable authorized Task shells,
  accessible Timeline/tabs, viewport-internal scrolling,
  responsive containment, and stale-selection races;
- selected-Activity no-change and append-only continuation reads, partial UTF-8
  and JSONL tails, final Output transition, source shrink/replacement/deletion,
  changed Task sets, malformed or bounded deltas, stale revisions and Host
  cache misses;
- detached selected-only cache ownership and deep-equal initial detail,
  canonical selected-ledger relevant/irrelevant mutations, exact/+1 aggregate
  source/projection bounds, and multi-source rollback with same-revision retry;
- visibility-gated one-in-flight polling and preservation of Agent/Review
  selection, active tab, internal scroll, and focus during in-place updates.

Sonner focused tests cover Git tracked and non-ignored untracked discovery,
dependency/generated/cache exclusions, symbolic-link non-following, leading
Markdown `keyPoints` extraction, complete Work Graph XML validation and topological
ordering, version-12 valid/missing/invalid states, key-points-only individual file
projection, direct-parent compact extension counts, active-only Runtime
health and bounded coarse reasons, deterministic default Agent text, JSON-string escaping,
the pinned Unicode 16.0 unsafe-display boundary and ordinary-Unicode
preservation, fixed-token fail-closed behavior, explicit empty states, the
strict default/`--json` option grammar,
and the shared authenticated HTTP JSON
projection, same-origin indexed-file and Work-directory opening, and Activity
Bar/Work Graph/Files/Runtime UI states.
The UI contract also pins Runtime loaded time, health, the empty idle state,
and short visible active Task identities, the
vendored ELK artifact, deterministic node and
edge coordinates, relationship selection, bounded transform-only zoom,
internal graph scrolling, and the viewport-stable detail row.

Board Open tests cover per-path single-flight, typed 400/404/409/503 responses,
and the packaged native file-reference boundary. Test-only native builds
exercise Root/ancestor/final replacement, reference construction and binding
races, directories, hardlinks, Unicode, nonregular entries, malformed output, crash,
timeout, and repeated descriptor cleanup without launching a real default
application.

Sonner project-reader tests compile a test-hook native helper and replace the
Root, ancestor directories, Markdown files, and Work markers at descriptor
transitions. They also verify protocol failures, timeout/crash behavior,
exact/over bounds, descriptor cleanup, and the packaged helper's universal
architecture and signature.

Win32 simulation drives the portable Sonner reader through real Git admission,
Work Graph parsing, Markdown `keyPoints` extraction, Files projection, and Runtime
fallback without executing a packaged Mach-O helper. Portable Signal tests
exercise no-link reads, Root/ancestor/file identity revalidation, bounds, and
typed partial behavior. Windows Open tests prove the API returns a bounded
unavailable result without spawning the macOS opener. These mechanical checks
complement, but do not replace, real Windows-machine E2E.

Sonner Runtime reader tests exercise fixed descriptor-relative ledger and
diagnostic reads, missing records, symlink rejection, abort-before-spawn,
deadline kill/reap, crash, and malformed framing. Task-history reader tests
cover sequential active-before-archive ownership, partial-open and stat-failure
cleanup, abort between roots, ambiguous matches, symlink rejection, parser
failure under backpressure, oversized histories proven from bounded tails,
insufficient-tail fail-closed behavior, and no public pathname. Sonner lifecycle tests prove first-fatal sibling cancellation waits
for cleanup before one Project Root close and that the absolute deadline starts
before Root acquisition. Runtime
projection and canonical ledger tests reject combined retained/pending cycles,
multiple-parent reownership, and the 513th Task before observation while
accepting the exact 512-Task boundary.

Board Host tests keep a failed Sonner request at 429 through its injected
cleanup marker and admit a retry only after the loader promise has fully
settled, fixing the session-cleanup-before-busy-release ordering.

Git-admission fixtures retain one Root fd across pre/during/post-Git
replacement and ABA transitions, reject caller Git/DYLD authority poisoning,
disable project fsmonitor/hooks, and cover malformed/bounded NUL output plus Unicode byte ordering. Positive
fixtures preserve linked-worktree, global-exclude, and Work-only behavior.

Native Signal-reader tests verify the packaged universal macOS executable,
signature/hash, protocol v2, inherited Root descriptor, transition races,
symlink/hard-link rejection, exact-size reads, bounds, timeout/crash handling,
and exact-once child cleanup. The plugin never compiles it at runtime.

## Board Host lifecycle

Automated Host tests start the real detached Node process in a temporary private
state directory. They prove:

- one OS-assigned loopback port and exact Host validation;
- one Host reused by multiple canonical project-scoped URLs;
- atomic project registration and serialized Host creation;
- `ensure`, `status`, `url`, and `stop` CLI semantics;
- read-only data HTTP, same-origin indexed-file opening, and token-authenticated private stop;
- browser SSE lease acquisition and exact-once release;
- idle auto-exit and final-project explicit stop;
- no LaunchAgent, Login Item, scheduler, or shell-background dependency.
- equivalent direct detached-child lifecycle and private-state contracts under
  Win32 simulation, including current-user ACL publication and path identity.

The final manual Board check runs `board ensure`, opens its exact returned URL,
confirms Activity/Sonner switching, Primary/Agent/Review navigation and a clean console, closes every Board
page, and confirms that the Host exits after the grace period. Repeat with two
projects when changing lifecycle behavior to confirm one shared PID and distinct
project URLs. A real Windows Browser run remains an explicit environment LIMIT
when no Windows machine is available.

## Standalone CLI

The CLI package tests pack and extract the actual npm tarball outside the
checkout, then inspect a separate Git project with an empty Codex location.
They cover the shared dispatcher, hidden Work markers, project-only and explicit
Runtime output, portable-reader parity, and invalid arguments. Bootstrap tests
cover initial acquisition, refresh, offline fallback, broken/incompatible
updates, retry delays, and concurrent publication without registry access.
The normal macOS and Windows suites include these tests. Before a release,
manually install the tarball and invoke its `small-loop sonner` executable.

## Completion commands

Tests under `tests/shared/`, and legacy tests directly under `tests/`, form the
host-independent suite. Tests under `tests/darwin/` and `tests/win32/` belong
only to that host. The platform suites always include the shared suite and
refuse to run on a different operating system:

```sh
node implementation/testing/test-runner.mjs shared
node implementation/testing/test-runner.mjs darwin
node implementation/testing/test-runner.mjs win32
```

Pass `--list` to inspect the selected files without running them. Run focused
tests while developing, then the current platform suite before completion.
Keep real Codex Small Loop E2E and browser checks outside the mechanical suite so
ordinary iteration remains fast and deterministic.

## Reference

- [Implementation contracts](/implementation/components/contract-tests/tests/codex-small-loop-contracts.test.mjs)
- [Board server](/implementation/components/board/server.mjs)
