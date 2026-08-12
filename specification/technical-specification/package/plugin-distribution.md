---
summary: >-
  The repository marketplace points to implementation/, which is the complete
  installable Codex plugin and the project's Implementation Work.
---

# Plugin Distribution

`.agents/plugins/marketplace.json` is repository-level marketplace metadata.
Its local source is `./implementation`, making that directory the plugin
distribution boundary.

Inside `implementation/`, `.codex-plugin/plugin.json` identifies the plugin.
Codex discovers Skills from `skills/`; `handling-user-requests` renders initial
setup and then resolves Controller, while the other Skills support later Role
work and CLI commands beneath `components/`. Shared Welcome Board material
lives in `contents/welcome/`, independent of any Role or Skill. Assets, third-party
sources, notices, and tests remain in the same Implementation Work. Installation
therefore needs no copied root-level entry points or generated projection.

The packaged command surface includes `components/commands/sonner.mjs` as the
only Work Graph, Files, and Runtime inspection command. It emits deterministic
Agent text by default and accepts explicit `--json` for the canonical versioned
document shared with the Browser API. Its
implementation lives in `components/sonner/` and is imported by the packaged
Board server, so CLI and Browser installations cannot drift to separate Files
schemas. The same Sonner distribution packages portable Windows readers alongside an
ad-hoc-signed universal macOS helper
that receives the verified project Root as fd 3. Protocol v2 runs fixed
standard-Git admission from that Root cwd and then performs bounded,
descriptor-relative no-follow reads for Markdown summaries and Work markers;
the installed plugin never compiles it at runtime. Windows selects the portable
reader before any Mach-O inspection, runs Git directly without a shell, and
uses bounded no-link reads with Root, ancestor, and final identity
revalidation.

Sonner also packages signed universal Runtime-record and Task-history readers.
The former reads only the fixed ledger and Recovery Supervisor diagnostic
beneath the authorized project Root descriptor. The latter retains separately
configured active and archive Codex session roots and performs bounded
descriptor-relative discovery and stable final-window JSONL reads. Their strict protocols carry
identities, task IDs, statuses, bounded session-root-relative hints, and bounded
bytes plus an internal truncation marker, never project or absolute history pathnames. The readers share the
packaged safe-I/O C source and are not built at runtime. Windows uses the
packaged portable Runtime and history readers with bounded session-root
discovery, stable identity checks, and the same final-window reducer. Their Node wrappers
join Git/content and Runtime work under one absolute-deadline operation,
including abort-safe child reap, parser/stream settlement, and explicit
sequential ownership of active/archive history roots.

The Board distribution also packages an ad-hoc-signed universal Open-only helper.
It receives the authorized Root descriptor, binds the selected indexed regular
file or validated Work directory to a Core Foundation file-reference URL, and
calls LaunchServices with the reference object itself. The C source, Node
wrapper, binary, and BUILD record are part of the plugin distribution and
manifest identity. Windows returns a typed unavailable Open result before
inspecting or spawning this macOS-only helper.

The manifest version identifies every byte in the complete installable
`implementation/` distribution. It is assigned only after packaged bytes are
final, and any later package change requires a newly assigned version. This
identity includes the Sonner schema v8 command and implementation, its default Agent
plaintext formatter and hostile-input tests, the explicit canonical `--json`
serializer shared with the Browser API, and the formatter's pinned Unicode 16.0
display-boundary table and source provenance. It also includes the static Work
Graph and Runtime Browser assets, the Board-owned Signal reader and native
opener, and every Sonner project, Runtime-record, and Task-history reader. It
covers each helper binary, C source, Node wrapper, shared safe-I/O source, BUILD
record, and vendored static dependency. Installed commands only execute the
packaged binaries; they never compile a helper at runtime.
The removed Work Map command and implementation are not parallel package surfaces.
The manifest is the sole version-literal source; marketplace metadata only
points to the distribution.

The bundle includes the upstream `interview-me` source and the pinned
`elkjs` Browser bundle under `third_party/` and Board `public/vendor/`, with its
EPL-2.0 license, provenance, and third-party notice. The Codex Small Loop
interview adapter remains under `skills/`; only that adapter is exposed
as `codex-small-loop:interview-me`. ELK is an internal Sonner layout dependency
and adds no command or plugin surface.

The bundle also includes Codex Small Loop's app-server adapter, bridge, Desktop
runtime attestor, cross-platform host adapter and WebSocket transport,
Windows runtime resolver/doctor, and shared-host manager. It does not package a
Codex executable. On macOS those scripts resolve application bundle ID
`com.openai.codex` through LaunchServices and verify the expected signing
identity and version. On Windows they resolve and attest the installed Codex
Desktop runtime through platform-owned process and executable identity checks.
Detached runtime processes repeat the appropriate platform verification when
cold-starting or replacing the host and never select an unverified `codex`
executable from `PATH`.

## Implementation

- [Marketplace manifest](/.agents/plugins/marketplace.json)
- [Plugin manifest](/implementation/.codex-plugin/plugin.json)
- [Packaged MIT License](/implementation/LICENSE)
- [Root entry Skill](/implementation/skills/handling-user-requests/SKILL.md)
- [Composer icon](/implementation/assets/codex-small-loop.svg)
- [Welcome contents](/implementation/contents/welcome/initialization-guide.md)
- [Repository structure](/specification/technical-specification/package/repository-structure.md)
- [Repository README](/README.md)
- [Third-party notices](/implementation/THIRD_PARTY_NOTICES.md)
- [Interview source metadata](/implementation/third_party/agent-skills/UPSTREAM.md)
- [ELK source metadata](/implementation/third_party/elkjs/UPSTREAM.md)
- [Contract tests](/implementation/components/contract-tests/tests/codex-small-loop-contracts.test.mjs)
- [Sonner implementation](/implementation/components/sonner/source/sonner.mjs)
