---
summary: >-
  Define how Codex Small Loop locates and verifies the installed Codex executable,
  maintains a private shared app-server host, and routes direct task turns
  without accepting an unrelated runtime.
---

# Desktop Host And Transport

Codex Small Loop does not bundle or blindly select a general `codex` executable
from `PATH`. A platform-neutral resolver accepts one attested runtime contract.
On macOS its adapter asks LaunchServices for application bundle ID
`com.openai.codex`, canonicalizes the returned bundle and embedded executable,
and validates the expected signed application identity and command version.
On Windows its adapter accepts an explicit absolute
`CODEX_SMALL_LOOP_CODEX_PATH` or the standalone OpenAI installation beneath
`%LOCALAPPDATA%/Programs/OpenAI/Codex/bin/codex.exe`. It rejects packaged
WindowsApps executables, canonicalizes the standalone file, verifies the OpenAI
Authenticode publisher, and reads its command version. Both adapters fail
closed when provenance cannot be established. Resolution is independent of caller process ancestry,
so a detached Recovery Supervisor can cold-start the
host after its originating Task turn has ended.

`runtime.mjs doctor` is a host-level, read-only preflight. It reports the active
`process.execPath` Node runtime, resolves the platform Codex runtime, verifies
authentication through `codex login status`, and requires App Server to
advertise the transport required by the current platform: Unix sockets on
macOS, or capability-token-authenticated loopback WebSockets on Windows. It
emits bounded structured failures and does not return raw command output.

The verified executable starts one Codex Small Loop-owned app-server host. A
private endpoint, owner metadata, project-independent host manager, and bridge
allow later detached runtime processes to reuse that exact host. macOS retains
its Unix socket with mode `0600`. Windows binds only an OS-selected port on
`127.0.0.1`, requires a random capability token for every WebSocket upgrade,
and stores that token only beneath a directory whose inherited ACL is replaced
with explicit Full Control for the current user, SYSTEM, and Administrators.
The token value is never written to host state or diagnostics. Concurrent
callers converge on the same verified instance; stale or contradictory owner
state is rejected or repaired only when absence is proven.

Host state version 2 stores a typed endpoint: `unix` or
`loopback-websocket`. A version 1 macOS Unix-socket owner record is migrated in
place. A live Windows host is accepted only when its PID resolves to the exact
attested executable and an authenticated WebSocket handshake succeeds. The
launcher emits only one bounded PID/endpoint protocol; it drains later stderr
without retaining a growing diagnostic file. WebSocket connect and upgrade
have explicit deadlines before the host is detached.
The Node bridge is also launched directly without a shell and with child-window
creation hidden on Windows. Its JSON-RPC pipes and IPC channel remain identical
across macOS and Windows.

Managed targets whose `threadSource` is `codex-small-loop` receive direct
JSON-RPC task start or steer turns. App-owned targets use the durable temporary
schedule path defined by [Conversations](/specification/technical-specification/runtime/conversations.md).
Missing or unknown source provenance is a routing error rather than permission
to guess another transport.

The adapter bounds messages and results, preserves exact Task and Turn
identities, and reports stable cause codes without exposing raw session data.
Detached callers repeat the same platform resolver when a verified host does
not exist; they never select an unverified process.
Execution-profile inheritance uses read-only `thread/read` plus the matching
session's latest complete `turn_context`; it does not resume an App-owned source
Task merely to discover model or authority settings.
The short race between `thread/start` and rollout visibility is retried only
for Codex's exact `no rollout found for thread id` response, within a two-second
bound. Other resume failures remain fail-closed.

## Implementation And Proof

- [Desktop runtime attestation](/implementation/components/runtime/source/codex-desktop-runtime.mjs)
- [Runtime resolver](/implementation/components/runtime/source/codex-runtime-resolver.mjs)
- [Windows runtime attestation](/implementation/components/runtime/source/codex-windows-runtime.mjs)
- [Runtime doctor](/implementation/components/runtime/source/codex-runtime-doctor.mjs)
- [App-server host manager](/implementation/components/runtime/source/codex-app-server-host.mjs)
- [Host platform adapters](/implementation/components/runtime/source/codex-app-server-host-platform.mjs)
- [WebSocket endpoint](/implementation/components/runtime/source/codex-app-server-websocket.mjs)
- [App-server adapter](/implementation/components/runtime/source/codex-app-server.mjs)
- [Bridge](/implementation/components/runtime/source/codex-app-server-bridge.mjs)
- [Desktop runtime tests](/implementation/components/runtime/tests/codex-desktop-runtime.test.mjs)
- [Windows runtime tests](/implementation/components/runtime/tests/codex-windows-runtime.test.mjs)
- [Runtime doctor tests](/implementation/components/runtime/tests/codex-runtime-doctor.test.mjs)
- [Host manager tests](/implementation/components/runtime/tests/codex-app-server-host.test.mjs)
- [Host platform tests](/implementation/components/runtime/tests/codex-app-server-host-platform.test.mjs)
- [WebSocket tests](/implementation/components/runtime/tests/codex-app-server-websocket.test.mjs)
- [App-server tests](/implementation/components/runtime/tests/codex-app-server.test.mjs)
